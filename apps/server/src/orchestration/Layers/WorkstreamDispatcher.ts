import {
  type AttentionReason,
  CommandId,
  type ControlPayload,
  type ControlPayloadItem,
  DEFAULT_GATE_MAX_ROUNDS,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type OrchestrationThreadShell,
  type ThreadId,
  type ThreadPlanLane,
  type WorkOutcomeRecord,
  type WorkstreamRoute,
} from "@t3tools/contracts";
import {
  gateLoopTargetOf,
  isHeldForCounterpartFanIn,
  isMemberOfUnresolvedGate,
  isTerminalForJoin,
  isWaitingInGate,
} from "@t3tools/shared/workstreamGraph";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { isFanInPending } from "@t3tools/shared/workstreamIsolation";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { makeReceiptDedupedDelivery, makeWakeRateBudget } from "../receiptDedup.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionActivityFreshness,
  type ProjectionInFlightTool,
} from "../Services/ProjectionSnapshotQuery.ts";
import {
  WorkstreamDispatcher,
  type WorkstreamDispatcherShape,
} from "../Services/WorkstreamDispatcher.ts";
import { workstreamChildPrompt } from "../workstreamChildPrompt.ts";
import { readWorkstreamBriefAt } from "../workstreamBrief.ts";
import { readWorkstreamReport, readWorkstreamReportAt } from "../workstreamReport.ts";
import { areDependenciesSatisfied } from "@t3tools/shared/workstreamDependencies";
import {
  notifyDeliverCommandId,
  notifyExpireCommandId,
  notifyMarkCommandId,
} from "@t3tools/shared/notify";
import { isThreadIdle, shouldRefuseForkLaunch } from "../threadIdle.ts";
// loom: forkFrom (D2/D7) — fork-source-idle promotion gate + captured-selection
// persistence.
import { ModelSelection } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../../config.ts";
import { readLaunchIdentity } from "../workstreamLaunchIdentity.ts";
import { WorktreeProvisioner } from "../../project/WorktreeProvisioner.ts";
import {
  ProcessResourceMonitor,
  type ProcessTreeActivity,
} from "../../diagnostics/ProcessResourceMonitor.ts";
import { piSessionIdForThread, resolveSessionFilePath } from "../../provider/piSessionFiles.ts";

/**
 * Pure "promote ready" selection: every un-started sub-thread whose `blockedBy`
 * dependencies are all satisfied.
 *
 * - Sub-thread: has a `parentThreadId` (root threads start via the normal flow).
 * - Released: plan lane is `ready` (the intentional release gate). A `planned`
 *   child is a deliberate hold — it sits even with deps clear until released.
 * - Un-started: no provider session **and** no started turn (no user message).
 * - Deps satisfied: per the shared `areDependenciesSatisfied` predicate — every
 *   `blockedBy` entry that names a known sibling must be `done` (`cancelled`
 *   does not release); self-refs, dangling ids, and non-siblings never gate.
 *   Sharing the predicate keeps execution gating and the client board in
 *   agreement.
 *
 * THREE gates now clear before dispatch (scaffold plan §1): release + dependency
 * (design §3) **plus a brief gate** — `kickoffBriefPath !== null`. A scaffolded
 * node is created with no brief; it becomes dispatchable only once
 * `workstream_brief` attaches one, so deps-satisfied and brief-present are two
 * orthogonal launch preconditions. Returns only threads that carry both `role`
 * and `purpose`, which are required to build the deferred kick-off prompt (spawn
 * always sets them).
 */
export const selectThreadsToDispatch = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
): ReadonlyArray<OrchestrationThreadShell> => {
  const threadsById = new Map(threads.map((thread) => [thread.id, thread] as const));
  return threads.filter(
    (thread) =>
      thread.parentThreadId !== null &&
      thread.role !== null &&
      thread.purpose !== null &&
      thread.planLane === "ready" &&
      thread.session === null &&
      thread.latestUserMessageAt === null &&
      thread.kickoffBriefPath !== null &&
      areDependenciesSatisfied(thread, threadsById),
  );
};

/**
 * Brief-needed eligibility (scaffold plan §2/§3): an un-started sub-thread whose
 * release + dependency gates are all clear but which has NO kickoff brief yet —
 * the new "awaiting brief" stall state. Exactly {@link selectThreadsToDispatch}'s
 * gates with the brief gate INVERTED (`kickoffBriefPath === null`): the two sets
 * are disjoint and partition the ready-and-unstarted children into dispatchable
 * (briefed) and brief-needed (unbriefed). Drives both the brief-needed parent
 * wake and the liveness backstop.
 */
export const isBriefNeeded = (
  thread: OrchestrationThreadShell,
  threadsById: ReadonlyMap<ThreadId, OrchestrationThreadShell>,
): boolean =>
  thread.parentThreadId !== null &&
  thread.role !== null &&
  thread.purpose !== null &&
  thread.planLane === "ready" &&
  thread.session === null &&
  thread.latestUserMessageAt === null &&
  thread.kickoffBriefPath === null &&
  areDependenciesSatisfied(thread, threadsById);

/**
 * The `briefNeededSince` eligibility-episode clock (scaffold plan §3): the ms
 * timestamp of the LATEST transition that made this node brief-eligible. Three
 * transitions can be the latest one, and all three feed the max below:
 *   - its scaffold time (`createdAt`) when it was born eligible;
 *   - its OWN `planned → ready` release (`planLaneSince`) — a staged node held
 *     then released dates from the release, not scaffold time, and a re-release
 *     starts a FRESH episode (new receipt key, new grace window);
 *   - a dependency reaching `done`, whether by a submit outcome (`lastOutcome.at`)
 *     OR a lane-only `workstream_set_lane(done)` that records no outcome
 *     (`dep.planLaneSince` while the dep is `done`).
 * NOT `createdAt` alone: a node scaffolded early but unblocked only much later
 * must date from the unblock, else an age-based clock would trip the liveness
 * grace the instant the node is created.
 *
 * Only STABLE, transition-derived sources feed it — `createdAt`, a
 * `plan-lane-set` timestamp (`planLaneSince`, bumped ONLY by real lane
 * transitions), and a dependency's `lastOutcome.at` (fixed for the life of that
 * outcome) — never a mutable `updatedAt`. This matters because the derived value
 * keys the wake's durable receipt: an `updatedAt`-based clock would drift under
 * any unrelated thread event (a receipt-marker/activity append bumps
 * `updatedAt`) and re-arm the wake in a loop. `planLaneSince` is immune to that
 * because activity appends do not emit a `plan-lane-set`.
 */
export const briefNeededSinceMs = (
  thread: OrchestrationThreadShell,
  threadsById: ReadonlyMap<ThreadId, OrchestrationThreadShell>,
): number => {
  const parseIso = (iso: string | null | undefined): number =>
    iso === null || iso === undefined ? NaN : Date.parse(iso);
  let sinceMs = parseIso(thread.createdAt);
  if (Number.isNaN(sinceMs)) sinceMs = 0;
  const bump = (iso: string | null | undefined) => {
    const ms = parseIso(iso);
    if (!Number.isNaN(ms) && ms > sinceMs) sinceMs = ms;
  };
  // Gap (a): the node's own release to `ready`.
  bump(thread.planLaneSince);
  // Gap (c): a `set_dependencies` that re-enters eligibility (removes/replaces a
  // dep). Only counts while the CURRENT set is satisfied — a set that added an
  // unfinished dep leaves the node ineligible (isBriefNeeded is false), and its
  // stamp must not seed a phantom episode; once the set is satisfied again the
  // stamp is the true re-entry transition, later than any pre-existing dep
  // outcome (which may predate the prior episode).
  if (areDependenciesSatisfied(thread, threadsById)) bump(thread.dependenciesSince);
  for (const depId of thread.blockedBy) {
    if (depId === thread.id) continue;
    const dep = threadsById.get(depId);
    if (dep === undefined || dep.parentThreadId !== thread.parentThreadId) continue;
    // A dependency's completion time: its submit outcome, or — gap (b) — the
    // lane transition that carried it to `done` with no recorded outcome.
    bump(dep.lastOutcome?.at ?? null);
    if (dep.planLane === "done") bump(dep.planLaneSince);
    // Gap (d): fan-in settlement. `areDependenciesSatisfied` requires more than
    // `done` for an isolated dep (`fanInState === "completed"`), and for a node
    // behind an attached reviewer, the gated isolated coder's fan-in. When that
    // is load-bearing, the `fanin-set` that reached `completed` is the true
    // eligibility transition — it can land long after the dep's `done`. Mirror
    // the predicate's two fan-in branches exactly (incl. the `attached`
    // dependent short-circuit, which releases on `done` alone and needs no
    // fan-in), so the clock and the gate never disagree.
    if (thread.isolation === "attached") continue;
    if (dep.isolation === "attached") {
      // Two-hop: the reviewer itself never fans in; the merged output belongs to
      // the isolated coder(s) it gates, whose fan-in fires at gate resolution.
      for (const gatedId of dep.blockedBy) {
        const gated = threadsById.get(gatedId);
        if (
          gated !== undefined &&
          gated.parentThreadId === dep.parentThreadId &&
          gated.isolation === "isolated" &&
          gated.fanInState === "completed"
        )
          bump(gated.faninSince);
      }
    } else if (dep.isolation === "isolated" && dep.fanInState === "completed") {
      bump(dep.faninSince);
    }
  }
  return sinceMs;
};

// The per-parent runaway guard primitives live in the shared receipt-dedup
// module (the `WakeRateBudget` composes them). Re-exported here because they are
// tested pure exports and historically part of the dispatcher's public surface.
export {
  DEFAULT_WAKE_RATE_GUARD,
  wakeRateGuardTrips,
  type WakeRateGuardConfig,
} from "../receiptDedup.ts";

/**
 * Maximum number of report characters embedded inline in a wake message. The
 * wake carries a *bounded* excerpt plus the on-disk reference, never the full
 * report text (the signed contract: "compact bounded summary + reference"); the
 * parent pulls the full report on demand via its `reportPath`.
 */
export const WAKE_REPORT_EXCERPT_LIMIT = 600;

/**
 * Control-plane attribution marker. The dispatcher injects wake/notice texts as
 * `role:"user"` turns (pi has no separate channel), so without this leading line
 * a parent cannot tell an automated workstream notice from a real human message.
 * Shared by both wake builders so they can't drift; the work-model system prompt
 * teaches the agent to treat a marked turn as a control-plane signal, not the
 * user's directive.
 */
export const WORKSTREAM_CONTROL_PLANE_MARKER =
  "[T3 Workstream control plane — automated notice, not from the user]";

/**
 * Bounded inline report excerpt shared by both wake-message builders: empty when
 * there is no report, the trimmed report when it fits, else a truncated prefix
 * plus a pointer to the on-disk reference. Leads with a blank line so callers
 * append it directly after the reference.
 */
const formatReportExcerpt = (report: string | null): string => {
  const trimmed = report?.trim() ?? "";
  if (trimmed.length === 0) return "";
  return trimmed.length > WAKE_REPORT_EXCERPT_LIMIT
    ? `\n\n${trimmed.slice(0, WAKE_REPORT_EXCERPT_LIMIT)}…\n\n_[excerpt truncated — read the full report via the reference above]_`
    : `\n\n${trimmed}`;
};

/**
 * Format a durable event time for a rendered wake/digest item (design §5.4):
 * `2026-07-07 14:32Z`. Null/unparseable → empty string (the caller drops the
 * timestamp clause). Zero contract cost — the time is already in the read model.
 */
export const formatWakeTimestamp = (iso: string | null): string => {
  if (iso === null) return "";
  const parsed = DateTime.make(iso);
  if (Option.isNone(parsed)) return "";
  const parts = DateTime.toPartsUtc(parsed.value);
  const pad = (n: number) => `${n}`.padStart(2, "0");
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(
    parts.minute,
  )}Z`;
};

/**
 * One newly-terminal child as the delta/digest rail sees it: the flat status
 * fields plus the projected gate context (`lastOutcome`, `gateRounds`, `routes`)
 * the pair grouper reads, the durable event time (§5.4), and the names of any
 * dependents this child's `done` released (computed from the snapshot at
 * delivery; omitted when none).
 */
export interface WakeMember {
  readonly id: ThreadId;
  readonly role: string | null;
  readonly planLane: ThreadPlanLane;
  readonly attention: ReadonlyArray<AttentionReason>;
  readonly reportPath: string | null;
  readonly report: string | null;
  readonly fanInState?: string | null;
  readonly lastOutcome?: WorkOutcomeRecord | null;
  readonly gateRounds?: number;
  readonly routes?: ReadonlyArray<WorkstreamRoute>;
  readonly eventAt?: string | null;
  readonly releasedDependents?: ReadonlyArray<{
    readonly id: ThreadId;
    readonly role: string | null;
  }>;
}

/** A resolved gate pair (design §4.1): the verdict-carrying source + its loop target. */
export interface WakePair {
  readonly source: WakeMember;
  readonly target: WakeMember;
}

const loopTargetOf = (member: WakeMember): ThreadId | null =>
  member.routes?.find((route) => route.kind === "loop" && route.to !== undefined)?.to ?? null;

/** A member whose last outcome resolved a gate (`clean`/`fixed_inline`). */
const isResolvedSource = (member: WakeMember): boolean =>
  member.lastOutcome?.decision === "resolve";

/**
 * Partition a parent's batch into resolved gate pairs and singles (design §4.1).
 * A pair is a member whose last outcome actually RESOLVED the gate
 * (`clean`/`fixed_inline` → `decision === "resolve"`) carrying a loop route
 * whose target is ALSO in the batch — the two render as one "✅ Gate resolved"
 * section. A gate DISSOLVED out-of-band (a parent force-`done`/`cancelled` on
 * the reviewer, whose `lastOutcome` is not a resolve, or none) is deliberately
 * NOT paired: pairing it would fabricate a verdict that never happened and
 * strip the target of its unreviewed-completion first-look excerpt. Both parties
 * then fall through to singles and render their honest plain-status sections. A
 * resolved source whose target is absent (already reported before resolution)
 * stays a single and renders a source-only verdict section. Pure and
 * order-preserving.
 */
export const groupBatchForWake = (
  members: ReadonlyArray<WakeMember>,
): { readonly pairs: ReadonlyArray<WakePair>; readonly singles: ReadonlyArray<WakeMember> } => {
  const byId = new Map(members.map((member) => [member.id, member] as const));
  const claimed = new Set<ThreadId>();
  const pairs: WakePair[] = [];
  for (const member of members) {
    if (claimed.has(member.id)) continue;
    // Only an actual resolve verdict makes a pair — never a force-dissolved gate.
    if (!isResolvedSource(member)) continue;
    const targetId = loopTargetOf(member);
    if (targetId === null) continue;
    const target = byId.get(targetId);
    if (target === undefined || claimed.has(target.id)) continue;
    pairs.push({ source: member, target });
    claimed.add(member.id);
    claimed.add(target.id);
  }
  const singles = members.filter((member) => !claimed.has(member.id));
  return { pairs, singles };
};

const timestampLine = (member: WakeMember): string => {
  const ts = formatWakeTimestamp(member.eventAt ?? null);
  return ts === "" ? "" : `_${ts}_`;
};

const releasedClause = (member: WakeMember): string => {
  const released = member.releasedDependents ?? [];
  if (released.length === 0) return "";
  return `released: ${released
    .map((dep) => `${dep.role ?? "sub-thread"} \`${dep.id}\``)
    .join(", ")}`;
};

// Conflicted fan-in recovery copy (shared by the plain single + pair renderers):
// the fan-in reactor already delivered a dedicated conflict notice (branch names
// + conflict paths) and raised `needs_guidance`, so this only flags it and
// echoes the recovery copy — no fabricated paths line, no stale set_lane advice.
const conflictBlock = (fanInState: string | null | undefined): string =>
  fanInState === "conflicted"
    ? [
        "",
        "⚠️  **Fan-in merge conflict.** This child's branch could not be merged into your branch automatically — see the separate fan-in conflict notice for the branch names and conflicting paths.",
        "",
        "**Recovery:** merge the child's branch into your branch yourself (or reopen the coder to resolve the conflict in its worktree and resubmit). Once the branch is contained in your branch, the control plane completes the fan-in and releases its dependents automatically — no need to clear `blockedBy`.",
      ].join("\n")
    : "";

/**
 * Render one resolved gate pair as a single section (design §4.1/§5.1): the
 * verdict + both parties' roles/ids/lanes on the header, rounds used and whether
 * rework happened, the target's fan-in status, released dependents, and ONE
 * report reference each — but an excerpt only for the source's verdict report.
 * The target's round report was already consumed by the gate protocol (the
 * reviewer verified it), so its reference suffices — the single biggest
 * per-pair token saving.
 */
export const renderWakePair = (pair: WakePair): string => {
  const { source, target } = pair;
  const verdict = source.lastOutcome?.outcome ?? "resolved";
  const rounds = source.gateRounds ?? 0;
  const roundsClause = rounds > 0 ? ` (${rounds} rework round${rounds === 1 ? "" : "s"})` : "";
  const header = `### ✅ Gate resolved \`${verdict}\` — ${source.role ?? "reviewer"} \`${source.id}\` + ${target.role ?? "coder"} \`${target.id}\`${roundsClause}`;
  const fanInClause =
    target.fanInState === "conflicted"
      ? "branch fan-in CONFLICTED (see below)"
      : target.fanInState === "completed"
        ? `${target.role ?? "coder"} branch merged into yours`
        : "";
  const meta = [timestampLine(source), fanInClause, releasedClause(source)]
    .filter((part) => part !== "")
    .join(" · ");
  const sourceRef =
    source.reportPath !== null
      ? `Verdict report: \`${source.reportPath}\` — excerpt:${formatReportExcerpt(source.report)}`
      : "_No verdict report was filed._";
  const targetRef =
    target.reportPath !== null
      ? `${target.role ?? "coder"} round report: \`${target.reportPath}\` (reference only — verified by the gate).`
      : `_No ${target.role ?? "coder"} round report was filed._`;
  return [header, meta, "", sourceRef, "", targetRef, conflictBlock(target.fanInState)]
    .filter((part) => part !== "")
    .join("\n");
};

/** Render one non-paired terminal child. A resolved source whose target already
 *  reported keeps its verdict header; every other child renders the plain
 *  status section (role + id + lane + attention, reference + bounded excerpt). */
export const renderWakeSingle = (member: WakeMember): string => {
  const ts = timestampLine(member);
  const released = releasedClause(member);
  if (isResolvedSource(member)) {
    const verdict = member.lastOutcome?.outcome ?? "resolved";
    const rounds = member.gateRounds ?? 0;
    const roundsClause = rounds > 0 ? ` (${rounds} rework round${rounds === 1 ? "" : "s"})` : "";
    const header = `### ✅ Gate resolved \`${verdict}\` — ${member.role ?? "reviewer"} \`${member.id}\`${roundsClause}`;
    const meta = [ts, released].filter((part) => part !== "").join(" · ");
    const reference =
      member.reportPath !== null
        ? `Verdict report: \`${member.reportPath}\` — excerpt:${formatReportExcerpt(member.report)}`
        : "_No verdict report was filed._";
    return [header, meta, "", reference].filter((part) => part !== "").join("\n");
  }
  const flags = member.attention.length > 0 ? ` (attention: ${member.attention.join(", ")})` : "";
  // A plain (unreviewed) completion is marked ☑️ so the digest copy can point at
  // "completions marked ☑️ deserve the usual first look"; cancellations are not.
  const marker = member.planLane === "done" ? "☑️ " : "";
  const header = `### ${marker}${member.role ?? "sub-thread"} \`${member.id}\` — ${member.planLane}${flags}`;
  const meta = [ts, released].filter((part) => part !== "").join(" · ");
  const reference =
    member.reportPath !== null
      ? `Report reference: \`${member.reportPath}\` (read the full report on demand)`
      : "_No report was filed; status is the trigger, the report is best-effort context._";
  return [
    header,
    meta,
    "",
    `${reference}${formatReportExcerpt(member.report)}${conflictBlock(member.fanInState)}`,
  ]
    .filter((part) => part !== "")
    .join("\n");
};

// ---------------------------------------------------------------------------
// Two-tier delivery: the FYI digest (notice-coalescing design §4.2–§5.3). The
// action-required rails stay immediate; terminal deltas, `recovered`, and
// `slow-tool` are FYI — withheld into a per-parent digest and delivered by
// piggyback on the next action wake, by a quiet-window flush, or immediately
// when the workstream goes quiet.
// ---------------------------------------------------------------------------

/**
 * Quiet-window flush threshold (design §4.3): a parent's pending FYI items flush
 * once the oldest is older than this. 120 s — longer than intra-burst gaps (a
 * resolve transaction, its fan-in, and sibling completions land within a pass or
 * two), negligible against child task durations. Exported so a deployment that
 * wants today's immediate behaviour can set it to 0.
 */
export const FYI_DIGEST_FLUSH_MS = 120_000;

/** A non-terminal FYI item that rides the digest as a one-to-three-line entry
 *  (no excerpt): `recovered` (error→done supersession) or `slow-tool`. */
export interface DigestExtra {
  readonly kind: "recovered" | "slow-tool";
  readonly line: string;
  // Structured carriers for the collapsed-card payload (the flattened `line`
  // stays the model-visible text). Optional so nothing else has to change.
  readonly childId?: ThreadId;
  readonly role?: string | null;
}

/** Bounded plain (un-framed) report excerpt for a payload item — same limit and
 *  slice as the inline text excerpt (`formatReportExcerpt`) so a card item and
 *  the flattened text carry byte-identical report content. */
const boundedExcerpt = (report: string | null | undefined): string | undefined => {
  const trimmed = report?.trim() ?? "";
  if (trimmed.length === 0) return undefined;
  return trimmed.length > WAKE_REPORT_EXCERPT_LIMIT
    ? `${trimmed.slice(0, WAKE_REPORT_EXCERPT_LIMIT)}…`
    : trimmed;
};

/**
 * Map one terminal wake member to a structured card item, mirroring the icon,
 * status, and — crucially — the excerpt-inclusion decision the flattened
 * section makes. `includeExcerpt` is `false` for a resolved gate PAIR's target,
 * whose report the text deliberately sends as reference-only (see
 * `renderWakePair`); every other section carries the member's bounded excerpt.
 */
export const wakeMemberToPayloadItem = (
  member: WakeMember,
  opts: { readonly includeExcerpt?: boolean } = {},
): ControlPayloadItem => {
  const includeExcerpt = opts.includeExcerpt ?? true;
  const resolved = isResolvedSource(member);
  const verdict = member.lastOutcome?.outcome ?? null;
  const conflicted = member.fanInState === "conflicted";
  const icon = conflicted
    ? "⚠️"
    : resolved
      ? "✅"
      : member.planLane === "done"
        ? "☑️"
        : member.planLane === "cancelled"
          ? "🚫"
          : "•";
  const status = resolved && verdict !== null ? verdict : member.planLane;
  const attentionClause =
    member.attention.length > 0 ? ` · attention: ${member.attention.join(", ")}` : "";
  const conflictClause = conflicted ? " · fan-in conflict" : "";
  const base = resolved
    ? `Gate resolved${verdict !== null ? ` (${verdict})` : ""}`
    : member.planLane === "done"
      ? "Completed"
      : member.planLane === "cancelled"
        ? "Cancelled"
        : member.planLane;
  const ts = formatWakeTimestamp(member.eventAt ?? null);
  const excerpt = includeExcerpt ? boundedExcerpt(member.report) : undefined;
  return {
    threadId: member.id,
    ...(member.role !== null ? { role: member.role } : {}),
    title: `${base}${attentionClause}${conflictClause}`,
    status,
    icon,
    ...(member.reportPath !== null ? { reportPath: member.reportPath } : {}),
    ...(excerpt !== undefined ? { excerpt } : {}),
    ...(ts !== "" ? { timestamp: ts } : {}),
  };
};

/**
 * A resolved gate PAIR's target (the coder) as a reference-only card item.
 * Carries ONLY what the flattened pair section (`renderWakePair`) states about
 * the target: its role, id, the "verified by the gate" round-report reference,
 * and — when the fan-in conflicted (the text says CONFLICTED) — the conflict
 * glyph. It deliberately omits `excerpt`, `status` (the pair header never states
 * the target's lane), and `timestamp` (the pair meta carries only the SOURCE's
 * timestamp), so the card cannot show target detail the model never received.
 */
const pairTargetToPayloadItem = (target: WakeMember): ControlPayloadItem => {
  const conflicted = target.fanInState === "conflicted";
  return {
    threadId: target.id,
    ...(target.role !== null ? { role: target.role } : {}),
    title: "Round report (verified by the gate)",
    ...(conflicted ? { icon: "⚠️" } : {}),
    ...(target.reportPath !== null ? { reportPath: target.reportPath } : {}),
  };
};

/** Map one informational extra (recovered / slow-tool) to a card item. The
 *  pre-rendered `line` is exactly what the flattened text carries, so it also
 *  becomes the item's excerpt — no independent serialisation. */
const digestExtraToPayloadItem = (extra: DigestExtra): ControlPayloadItem => {
  const recovered = extra.kind === "recovered";
  return {
    ...(extra.childId !== undefined ? { threadId: extra.childId } : {}),
    ...(extra.role != null ? { role: extra.role } : {}),
    title: recovered ? "Recovered" : "Still executing",
    status: extra.kind,
    icon: recovered ? "♻️" : "⏳",
    excerpt: extra.line.replace(/^-\s*/, "").trim(),
  };
};

/**
 * ONE canonical traversal of a digest body. `groupBatchForWake` partitions the
 * members exactly once; each section yields BOTH its flattened `text` and the
 * structured card `items` it represents, so the model-visible text and the
 * persisted `controlPayload` can never diverge (same grouping, same members,
 * same excerpt-inclusion). `renderDigestBody` and `buildDigestPayload` are thin
 * projections of this result.
 */
export const digestBodyParts = (
  members: ReadonlyArray<WakeMember>,
  extras: ReadonlyArray<DigestExtra>,
): { readonly text: string; readonly items: ReadonlyArray<ControlPayloadItem> } => {
  const { pairs, singles } = groupBatchForWake(members);
  const sections: Array<{ text: string; items: ReadonlyArray<ControlPayloadItem> }> = [];
  for (const pair of pairs) {
    sections.push({
      text: renderWakePair(pair),
      items: [
        wakeMemberToPayloadItem(pair.source, { includeExcerpt: true }),
        pairTargetToPayloadItem(pair.target),
      ],
    });
  }
  for (const single of singles) {
    sections.push({
      text: renderWakeSingle(single),
      items: [wakeMemberToPayloadItem(single, { includeExcerpt: true })],
    });
  }
  for (const extra of extras) {
    sections.push({ text: extra.line, items: [digestExtraToPayloadItem(extra)] });
  }
  return {
    text: sections.map((section) => section.text).join("\n\n"),
    items: sections.flatMap((section) => [...section.items]),
  };
};

/** Render the shared digest body: resolved pairs, then singles, then extras.
 *  A thin projection of {@link digestBodyParts} so the text can never drift
 *  from the structured items. */
const renderDigestBody = (
  members: ReadonlyArray<WakeMember>,
  extras: ReadonlyArray<DigestExtra>,
): string => digestBodyParts(members, extras).text;

const DIGEST_CLOSING =
  "No first-pass review is owed on gate-resolved items (their reviewers verified the work). Update your task tree / scoreboard, pull anything useful from the reports (follow-up work, findings worth acting on), and continue orchestrating. Unreviewed completions (marked ☑️) deserve the usual first look.";

// When a digest carries ZERO terminal members (only informational extras), the
// completion-framed closing would misfire. But the extras are heterogeneous — a
// `slow-tool` line is still in flight, a `recovered` line is an error→`done`
// supersession that DID complete (dependents released). So the info-only copy
// must stay neutral: it may not claim "nothing completed" (false for recovered)
// nor "the following completed" (false for slow-tool). It just says these are
// status notices needing no first-pass review.
const DIGEST_CLOSING_INFO_ONLY =
  "These are status notices, not completions to review — some items are still in flight, others already resolved themselves (e.g. an earlier `error` superseded by `done`, its dependents released). No first-pass review is owed; act only if a notice reads as genuinely wrong (e.g. a mis-scoped tool call).";

/**
 * Standalone FYI digest (design §5.3): delivered by a quiet-window / quiet-
 * workstream flush as its own turn-start. Fully framed — control-plane marker,
 * the "nothing below is blocked on you" intro, the items, and the scoreboard-
 * and-follow-up closing (never first-pass-review deliberation).
 */
export const buildStandaloneDigest = (
  members: ReadonlyArray<WakeMember>,
  extras: ReadonlyArray<DigestExtra> = [],
): string => {
  // Intro + closing must reflect the actual content: a digest of only
  // informational extras (no terminal members) must not claim anything
  // "completed".
  const infoOnly = members.length === 0;
  const intro = infoOnly
    ? "FYI digest — status notices from the control plane since you last heard. Nothing below is blocked on you."
    : "FYI digest — the following items completed and were fully routed by the control plane since you last heard. Nothing below is blocked on you.";
  return [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    intro,
    "",
    renderDigestBody(members, extras),
    "",
    infoOnly ? DIGEST_CLOSING_INFO_ONLY : DIGEST_CLOSING,
  ].join("\n");
};

/**
 * Piggyback digest section (design §5.3): appended AFTER an action-required
 * wake's own copy (action first — the decision the parent must make leads).
 * A separator, the "no action required" header, the items, and the same closing.
 */
export const buildDigestPiggyback = (
  members: ReadonlyArray<WakeMember>,
  extras: ReadonlyArray<DigestExtra> = [],
): string =>
  [
    "",
    "---",
    "",
    "**Also, FYI since you last heard** (no action required):",
    "",
    renderDigestBody(members, extras),
    "",
    members.length === 0 ? DIGEST_CLOSING_INFO_ONLY : DIGEST_CLOSING,
  ].join("\n");

// ---------------------------------------------------------------------------
// Structured payload builders. Each is a thin PROJECTION of the same canonical
// traversal (`digestBodyParts`) / the same excerpt helper the flattened text
// uses, so the persisted `controlPayload` and the model-visible `text` are two
// views of ONE composition and cannot diverge. `WorkstreamDispatcher.test.ts`
// locks this with parity tests (resolved pair, yield-with-piggyback).
// ---------------------------------------------------------------------------

/**
 * Structured FYI-digest payload (companion to `buildStandaloneDigest` /
 * `buildDigestPiggyback`): the items are exactly `digestBodyParts(...).items`
 * for the same members/extras the text flattens (pair target excerpt-omission
 * included), with the same heading the flattened text leads with.
 */
export const buildDigestPayload = (
  members: ReadonlyArray<WakeMember>,
  extras: ReadonlyArray<DigestExtra> = [],
  opts: { readonly piggyback?: boolean } = {},
): ControlPayload => {
  const infoOnly = members.length === 0;
  const heading = opts.piggyback
    ? "Also, FYI since you last heard (no action required)"
    : infoOnly
      ? "FYI digest — status notices from the control plane since you last heard."
      : "FYI digest — the following items completed and were fully routed since you last heard.";
  return {
    kind: "digest",
    heading,
    items: [...digestBodyParts(members, extras).items],
  };
};

/**
 * Structured yield-wake payload (companion to `buildYieldWakeMessage`): the
 * yielding child, then the gate counterpart (if any), then — when the yield
 * text piggybacks a pending FYI digest — that digest's items too, so the card
 * represents everything the appended `yieldText` carries. Excerpts use the same
 * `boundedExcerpt` slice as the text's `formatReportExcerpt`.
 */
export const buildYieldPayload = (
  child: {
    readonly id: ThreadId;
    readonly role: string | null;
    readonly reportPath: string | null;
  },
  outcome: string,
  report: string | null,
  gate?: YieldGateContext,
  piggyback?: {
    readonly members: ReadonlyArray<WakeMember>;
    readonly extras: ReadonlyArray<DigestExtra>;
  },
): ControlPayload => {
  const lead: ControlPayloadItem = {
    threadId: child.id,
    ...(child.role !== null ? { role: child.role } : {}),
    title: `Yielded to you — outcome \`${outcome}\``,
    status: "yielded",
    icon: "↩️",
    ...(child.reportPath !== null ? { reportPath: child.reportPath } : {}),
    ...(boundedExcerpt(report) !== undefined ? { excerpt: boundedExcerpt(report)! } : {}),
  };
  const counterpart = gate?.counterpart ?? null;
  const items: ControlPayloadItem[] = [lead];
  if (counterpart !== null) {
    items.push({
      threadId: counterpart.id,
      ...(counterpart.role !== null ? { role: counterpart.role } : {}),
      title: "Gate counterpart — latest round report",
      status: "counterpart",
      icon: "🔁",
      ...(counterpart.reportPath !== null ? { reportPath: counterpart.reportPath } : {}),
      ...(boundedExcerpt(counterpart.report) !== undefined
        ? { excerpt: boundedExcerpt(counterpart.report)! }
        : {}),
    });
  }
  if (piggyback !== undefined && (piggyback.members.length > 0 || piggyback.extras.length > 0)) {
    items.push(...digestBodyParts(piggyback.members, piggyback.extras).items);
  }
  return {
    kind: "yield",
    heading: gate
      ? `A sub-thread yielded to you (review-gate round cap exhausted, ${gate.rounds}/${gate.maxRounds}).`
      : "A sub-thread yielded to you (unmatched outcome).",
    items,
  };
};

/** Render a `recovered` digest one-liner (design §5.2): reference + timestamp,
 *  no excerpt — the child is done and its dependents already released. */
export const renderRecoveredDigestLine = (child: {
  readonly id: ThreadId;
  readonly role: string | null;
  readonly reportPath: string | null;
  readonly eventAt: string | null;
}): string => {
  const ts = formatWakeTimestamp(child.eventAt);
  const tsClause = ts === "" ? "" : ` _${ts}_`;
  const ref = child.reportPath !== null ? ` — report: \`${child.reportPath}\`` : "";
  return `- ♻️ ${child.role ?? "sub-thread"} \`${child.id}\` recovered (earlier \`error\` superseded by \`done\`; dependents already released)${ref}.${tsClause}`;
};

/** Render a `slow-tool` digest one-liner (design §5.2): informational, no flag,
 *  no report — a tool call has gone quiet while the child still executes. */
export const renderSlowToolDigestLine = (child: {
  readonly id: ThreadId;
  readonly role: string | null;
  readonly toolName: string;
  readonly inFlightMinutes: number;
  readonly quietMinutes: number;
  /** Optional process-health evidence (see {@link formatProcessHealthLine}), appended as a nested sub-bullet when present. */
  readonly processHealth?: string | undefined;
}): string =>
  `- ⏳ ${child.role ?? "sub-thread"} \`${child.id}\` still executing — long-running tool \`${child.toolName}\` in flight ~${child.inFlightMinutes} min, no agent-visible output ~${child.quietMinutes} min (informational, not a hang; the control plane will not interrupt it).${child.processHealth ? `\n  - ${child.processHealth}` : ""}`;

/**
 * Quiet-workstream flush condition (design §4.3, condition 3): true when the
 * parent has no child in lane `in_progress` or a briefed `ready` — nothing is
 * running or about to run, so the orchestrator's next move is due now. `planned`
 * (deliberately held), `yielded`, `done`, and `cancelled` children do not count.
 * A `ready` child with no `kickoffBriefPath` is NOT imminent work either (plan
 * §5): it cannot dispatch until the orchestrator writes its brief, so it must
 * not keep the workstream "busy".
 */
export const parentWorkstreamQuiet = (
  parentId: ThreadId,
  threads: ReadonlyArray<{
    readonly parentThreadId: ThreadId | null;
    readonly planLane: ThreadPlanLane;
    readonly kickoffBriefPath?: string | null;
  }>,
): boolean =>
  !threads.some(
    (thread) =>
      thread.parentThreadId === parentId &&
      (thread.planLane === "in_progress" ||
        (thread.planLane === "ready" && thread.kickoffBriefPath != null)),
  );

/**
 * Digest flush predicate (design §4.3): flush when the workstream is quiet
 * (condition 3) or the oldest pending item has aged past `flushMs` (condition
 * 2). Age is computed from durable event times, so it survives restarts.
 * Piggyback (condition 1) is handled by the action rails directly, not here.
 */
export const digestShouldFlush = (input: {
  readonly oldestEventAtMs: number | null;
  readonly now: number;
  readonly quiet: boolean;
  readonly flushMs: number;
}): boolean =>
  input.quiet ||
  (input.oldestEventAtMs !== null && input.now - input.oldestEventAtMs >= input.flushMs);

/**
 * Durable per-child "already reported to the parent through the delta rail"
 * marker. The delta wake batches every newly-terminal child of a parent into
 * ONE message, then dispatches one of these receipt-bearing markers per included
 * child — the durable truth that survives restarts (the receipt store has no
 * prefix enumeration, only exact-id lookup, so the marker id must be
 * recomputable from thread state). Keyed by `(childId, episode)` where the
 * episode is the child's current terminal episode: a reopened-then-re-done child
 * gets a fresh episode (new outcome event, or a re-stamped `spawnGeneration`)
 * and so re-arms as news.
 */
export const childReportedCommandId = (childId: ThreadId, episode: string): string =>
  `server:workstream-notify:child-reported:${childId}:${episode}`;

/**
 * The child's current terminal episode key: the id of its latest
 * `thread.outcome-recorded` event where present (each submit is a distinct
 * episode), else its `spawnGeneration` (re-stamped on a lane-set re-engage, so a
 * reopened-then-re-cancelled child with no fresh submit still re-arms), else a
 * constant fallback.
 */
export const terminalEpisodeKey = (child: {
  readonly lastOutcome: { readonly recordedByEventId: EventId } | null;
  readonly spawnGeneration: string | null;
}): string => child.lastOutcome?.recordedByEventId ?? child.spawnGeneration ?? "terminal";

/**
 * Per-child wake (D-liveness §1e). All per-child kinds (`error`, paused
 * `attention`, forgot-to-finish `idle`, `recovered`, informational `slow-tool`)
 * wake the parent through THIS rail, distinct from the terminal-child delta rail
 * (`collectTerminalDeltas`, which reports children that reached done/cancelled) —
 * these are the non-terminal / transitional states a delta could never carry.
 * The command id is keyed by `(childId, episode)` so each
 * distinct quiet episode notifies exactly once; for idle the episode is the
 * child's max activity *sequence* at idle onset (NOT `turnId`, which is null
 * while idle), so a child that resumes then goes quiet again re-arms while an
 * unacted-on idle child is not re-nagged every pass.
 */
export const childWakeCommandId = (childId: ThreadId, episode: string): string =>
  `server:workstream-liveness:child-wake:${childId}:${episode}`;

/**
 * Yield wake (review-gates design §6): a child whose submit routed to `yielded`
 * hands its turn to the live orchestrator. Keyed by the triggering
 * `thread.outcome-recorded` event id (carried on the shell as
 * `lastOutcome.recordedByEventId`), so each yield episode wakes the parent
 * exactly once — a later resume + re-yield records a new outcome event and
 * re-arms.
 */
export const yieldWakeCommandId = (childId: ThreadId, episode: string): string =>
  `server:workstream-yield:wake:${childId}:${episode}`;

/**
 * Gate traversal (review-gates design §4.3/§6): the deterministic, receipt-
 * deduped command id for one loop leg. Keyed by (gate source, round, leg) so a
 * crash between the `thread.route-taken` event and the resume redelivers
 * idempotently: `rework` resumes the loop target with the source's findings,
 * `reverify` resumes the source with the target's rework.
 */
export const gateCommandId = (
  sourceId: ThreadId,
  round: number,
  leg: "rework" | "reverify",
): string => `server:workstream-gate:${sourceId}:${round}:${leg}`;

/**
 * Pure rework resume-message builder (design §4.3): delivered to the loop
 * target (the coder) when the gate source routes findings back. Carries the
 * control-plane marker, the round, a bounded report excerpt + on-disk
 * reference, the adjudication protocol reminder, and explicit routing
 * visibility (risk R5: the coder must know its next submit is NOT `done`).
 */
export const buildGateReworkMessage = (
  reviewer: {
    readonly id: ThreadId;
    readonly role: string | null;
    readonly reportPath: string | null;
  },
  round: number,
  report: string | null,
): string => {
  const reference =
    reviewer.reportPath !== null
      ? `Report reference: \`${reviewer.reportPath}\` (read the full findings on demand).`
      : "_No report file was found for the findings._";
  return [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    `Review round ${round}: the ${reviewer.role ?? "reviewer"} \`${reviewer.id}\` returned findings on your work — your review gate looped it back to you for rework.`,
    "",
    reference + formatReportExcerpt(report),
    "",
    "Reviewer findings are claims, not verdicts: adjudicate each one — implement what survives scrutiny, reject the rest WITH REASONS in your round report (rejecting without reasons and implementing without evaluating are both failures). Scrutiny means asking: what concretely fails if I don't act, and what does recovery cost? Accurate evidence of what the code does is not validation of the reviewer's prescribed fix — reaching `clean` is not the goal; the right change is. If the same finding comes back contested a second time, stop looping on it and say so in your report; the reviewer escalates it.",
    "",
    "When you finish, end with one `workstream_submit` as usual. Routing notice: your next submit routes back to the reviewer for re-verification, NOT to done — write it as a round report (per finding: what you did, or why you rejected it).",
  ].join("\n");
};

/**
 * Pure re-verify resume-message builder (design §4.3): delivered to the gate
 * source (the reviewer) when the loop target routes its rework back. Reminds
 * the reviewer of delta-review discipline and of how each verdict routes.
 */
export const buildGateReverifyMessage = (
  coder: {
    readonly id: ThreadId;
    readonly role: string | null;
    readonly reportPath: string | null;
  },
  round: number,
  report: string | null,
): string => {
  const reference =
    coder.reportPath !== null
      ? `Report reference: \`${coder.reportPath}\` (read the full round report on demand).`
      : "_No report file was found for the rework._";
  return [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    `Review round ${round}: the ${coder.role ?? "coder"} \`${coder.id}\` returned its rework — your review gate routed it to you for re-verification.`,
    "",
    reference + formatReportExcerpt(report),
    "",
    "This is a DELTA review: scope to the changes plus your previously flagged items — raising brand-new findings on unchanged code in a rework round is a review failure unless the rework itself exposed them. Where the coder rejected a finding with reasons, adjudicate: contest it at most once; a twice-contested finding is escalated, never re-looped.",
    "",
    "Submit your verdict with `workstream_submit`: `clean` or `fixed_inline` resolves the gate (both threads complete), `needs_rework` loops again while rounds remain (then yields you to the orchestrator), any other outcome yields you to the orchestrator.",
  ].join("\n");
};

/**
 * Gate context for a cap-breach yield wake (design §6): the wake carries BOTH
 * parties' latest reports plus the round count so the orchestrator can decide
 * without spelunking.
 */
export interface YieldGateContext {
  readonly rounds: number;
  readonly maxRounds: number;
  readonly counterpart: {
    readonly id: ThreadId;
    readonly role: string | null;
    readonly reportPath: string | null;
    readonly report: string | null;
  } | null;
}

/**
 * Pure yield wake-message builder. Tells the parent the child yielded (turn
 * over, NOT done, dependents still gated), why (unknown outcome, or a review
 * gate's exhausted round cap — then with the counterpart's report too), points
 * at the report(s) with bounded excerpts, and lays out the decision menu.
 */
export const buildYieldWakeMessage = (
  child: {
    readonly id: ThreadId;
    readonly role: string | null;
    readonly reportPath: string | null;
  },
  outcome: string,
  report: string | null,
  gate?: YieldGateContext,
): string => {
  const who = child.role === null ? `\`${child.id}\`` : `${child.role} \`${child.id}\``;
  const reference =
    child.reportPath !== null
      ? `Report reference: \`${child.reportPath}\` (read the full report on demand).`
      : "_No report was filed._";
  const lead = gate
    ? `Your Workstream sub-thread ${who} YIELDED to you: it submitted \`${outcome}\` but its review gate's round cap is exhausted (${gate.rounds}/${gate.maxRounds} rework rounds used), so the control plane handed its turn to you instead of looping again. Its plan lane is \`yielded\` — the gate is NOT resolved and dependents stay gated.`
    : `Your Workstream sub-thread ${who} YIELDED to you: it submitted its work with outcome \`${outcome}\`, which matched no route, so the control plane handed its turn to you instead of completing it. Its plan lane is \`yielded\` — it has NOT finished and its dependents stay gated.`;
  const counterpartSection =
    gate?.counterpart != null
      ? [
          "",
          `Gate counterpart ${gate.counterpart.role === null ? `\`${gate.counterpart.id}\`` : `${gate.counterpart.role} \`${gate.counterpart.id}\``} — latest round report:`,
          "",
          (gate.counterpart.reportPath !== null
            ? `Report reference: \`${gate.counterpart.reportPath}\` (read the full report on demand).`
            : "_No report was filed._") + formatReportExcerpt(gate.counterpart.report),
        ]
      : [];
  return [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    lead,
    "",
    reference + formatReportExcerpt(report),
    ...counterpartSection,
    "",
    "The decision is yours: resume it with guidance (`workstream_prompt` — any turn-start clears `yielded` back to `in_progress`), accept its work as-is (`workstream_set_lane` done, which releases dependents" +
      (gate ? " and dissolves the gate" : "") +
      "), re-plan around it (spawn a replacement and `workstream_set_lane` cancelled on it), or escalate to the human." +
      (gate
        ? " Adjudicate the open findings yourself before choosing: they are claims, not verdicts — judge each by what concretely fails without it and what recovery costs at this project's posture, and accept over the reviewer's objection where that bar isn't met."
        : ""),
  ].join("\n");
};

/**
 * Brief-needed wake (scaffold plan §2): the deterministic, receipt-deduped
 * per-child marker id for the batched brief-needed rail. Keyed by the
 * eligibility episode `(childId, briefNeededSince)` (see {@link briefNeededSinceMs}),
 * NOT child id alone — so a node that leaves and re-enters the brief-needed
 * state on a fresh episode (re-gating that adds a later-completing dependency)
 * re-arms as news. The `workstream.` prefix keeps the durable marker out of the
 * child's activity-freshness episode keys.
 */
export const briefNeededCommandId = (childId: ThreadId, sinceMs: number): string =>
  `server:workstream-brief-needed:${childId}:${sinceMs}`;

/**
 * Pure brief-needed wake-message builder (scaffold plan §2): ONE notice naming
 * every simultaneously-eligible unbriefed child of a parent by graph key
 * (falling back to thread id) + role + title, and instructing the orchestrator
 * to attach each brief with `workstream_brief`. This is deliberately the moment
 * the orchestrator holds the upstream reports, so the late-bound brief can
 * reference what actually happened upstream.
 */
export const buildBriefNeededMessage = (
  children: ReadonlyArray<{
    readonly id: ThreadId;
    readonly graphKey: string | null;
    readonly role: string | null;
    readonly title: string;
  }>,
): string => {
  const lines = children.map((child) => {
    const handle =
      child.graphKey !== null ? `\`${child.graphKey}\` (\`${child.id}\`)` : `\`${child.id}\``;
    return `- ${handle} — ${child.role ?? "child"}: ${child.title}`;
  });
  const lead =
    children.length === 1
      ? "One of your Workstream sub-threads is scaffolded and unblocked (its dependencies are satisfied and it is released) but has NO kickoff brief yet, so it cannot launch:"
      : `${children.length} of your Workstream sub-threads are scaffolded and unblocked (dependencies satisfied, released) but have NO kickoff brief yet, so they cannot launch:`;
  return [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    lead,
    "",
    ...lines,
    "",
    "Attach each one's brief with `workstream_brief` (node = its graph key or thread id); the node launches as soon as its brief lands. This is the moment to write it — any upstream results it should build on are now in hand. Leave a node unbriefed only if you intend it not to run yet.",
  ].join("\n");
};

/**
 * The per-child wake kinds. `error`/`attention`/`idle` are classified purely
 * from thread state by `classifyChildWake`; `recovered` (a child the parent was
 * told had `error`ed that later reached `done`) and `slow-tool` (an executing
 * child whose in-flight tool call has gone quiet — informational only) are
 * decided in the dispatcher loop because they need a durable receipt lookup /
 * freshness + in-flight-tool queries, not just current shell state.
 */
export type ChildWakeKind = "error" | "attention" | "idle" | "recovered" | "slow-tool";

/**
 * Extra evidence for wake kinds that carry runtime measurements: `slow-tool`
 * always sets `toolName`/`inFlightMs`/`quietMs`; a frozen-executing `attention`
 * wake (a stall-escalated child whose open turn is wedged, so the idle-gated
 * rail would never fire) sets `frozen` + `quietMs`.
 */
export interface ChildWakeContext {
  readonly quietMs: number;
  readonly frozen?: boolean;
  readonly toolName?: string;
  readonly inFlightMs?: number;
  /**
   * One honest line of cheap process-health evidence for a `slow-tool` notice,
   * derived from the {@link ProcessResourceMonitor}'s already-collected samples
   * for the child's provider process subtree (e.g. "process tree: 87% peak CPU
   * over the last 30s across 3 processes (working)"). Absent when the process
   * is not locally observable (remote/SSH provider, exited, or no samples yet),
   * so the notice degrades to its plain wording with no evidence line.
   */
  readonly processHealth?: string;
  /**
   * The child's `needs_guidance` came from a pre-first-turn worktree
   * provisioning failure (a transient environment/git error, e.g. index.lock
   * contention), not an agent stall. Switches the `attention` copy to say so
   * and to instruct re-prompting to retry provisioning.
   */
  readonly provisionFailed?: boolean;
}

/**
 * Slow-tool notice schedule (class-2 liveness): informational per-child notices
 * while a tool call is in flight and the child has emitted no runtime activity.
 * First notice after 5 minutes of quiet, again at 15 and 30, then every 30
 * minutes — each step keyed into the receipt-deduped wake command id so every
 * step fires at most once per in-flight call. Purely informational: no
 * attention flag is raised and the call is never interrupted — long tool calls
 * are often legitimate, and only the parent agent has the judgement to
 * intervene.
 */
export const SLOW_TOOL_NOTICE_STEPS_MS: ReadonlyArray<number> = [300_000, 900_000, 1_800_000];
export const SLOW_TOOL_NOTICE_REPEAT_MS = 1_800_000;

/**
 * Pure notice-step selector: the highest schedule step this quiet duration has
 * crossed (0-based), continuing every `SLOW_TOOL_NOTICE_REPEAT_MS` past the
 * last step; `-1` while below the first step (no notice due yet).
 */
export const slowToolNoticeIndex = (quietMs: number): number => {
  const last = SLOW_TOOL_NOTICE_STEPS_MS[SLOW_TOOL_NOTICE_STEPS_MS.length - 1]!;
  return quietMs >= last
    ? SLOW_TOOL_NOTICE_STEPS_MS.length -
        1 +
        Math.floor((quietMs - last) / SLOW_TOOL_NOTICE_REPEAT_MS)
    : SLOW_TOOL_NOTICE_STEPS_MS.filter((step) => quietMs >= step).length - 1;
};

/**
 * Pure per-child wake classification (§1e). Returns the wake kind for a child
 * that should wake its parent, or `null`:
 * - `error` — the liveness sweep raised the child's `error` attention flag
 *   (crash/stall/loop/cap).
 * - `attention` — "paused, needs attention": the child carries a raised
 *   attention flag (`needs_guidance`/`awaiting_acceptance` — a human stop, a
 *   self-raise, a stall escalation), is not executing, and its plan lane is
 *   still pre-terminal. The terminal-child delta rail is plan-lane-only, so this
 *   rail is the ONLY way the parent agent hears about a paused child; the copy
 *   is honest ("paused", never "finished").
 * - `idle`  — "forgot to finish": the child ran (has a session now `ready`/
 *   `stopped`) and went idle, but its plan lane is still pre-terminal
 *   (`ready`/`in_progress`) AND it carries no attention flag (a `done`/
 *   `cancelled` child is terminal and is reported by the delta rail instead).
 *
 * Idleness reuses the shared `isThreadIdle` predicate (no pending turn-start,
 * session not `running`, no active turn) so a freshly-promoted child mid-kickoff
 * — or a just-resumed paused child whose turn-start is pending — is never
 * misclassified. A never-started `planned` child has no session and is excluded
 * from the idle kind (it is waiting on deps/release, not stuck).
 */
export const classifyChildWake = (
  child: OrchestrationThreadShell,
  pendingTurnStartThreadIds: ReadonlySet<ThreadId>,
): ChildWakeKind | null => {
  if (child.parentThreadId === null) return null;
  if (child.attention.includes("error")) return "error";
  if (
    child.attention.length > 0 &&
    child.planLane !== "done" &&
    child.planLane !== "cancelled" &&
    isThreadIdle(child, pendingTurnStartThreadIds)
  ) {
    return "attention";
  }
  if (
    child.attention.length === 0 &&
    (child.planLane === "ready" || child.planLane === "in_progress") &&
    child.session !== null &&
    (child.session.status === "ready" || child.session.status === "stopped") &&
    isThreadIdle(child, pendingTurnStartThreadIds)
  ) {
    return "idle";
  }
  return null;
};

/**
 * Idle-wake grace window (ms): the activity-freshness corroboration the idle
 * ("forgot to finish") rail previously lacked. The mid-turn stall detector is
 * graced (it only judges while a turn is open and waits out a no-progress
 * window); the instant `activeTurnId` flips to null, ownership passes to the idle
 * rail, which used to fire on the very next pass with ZERO corroboration. That
 * mislabels a multi-turn child that briefly has no open turn between turns (it
 * just completed turn N and is continuing / about to start turn N+1) as
 * "forgot to finish".
 *
 * Set equal to the liveness sweep's no-progress window (`staleActivityWindowMs`,
 * 10m) so the active-turn (stall) and idle rails share ONE inactivity threshold
 * — "no new activity for 10m → wake the parent", whether or not a turn is open.
 * No dead zone, and a normal between-turns gap (seconds) never trips it.
 */
export const DEFAULT_IDLE_WAKE_GRACE_MS = 600_000;

/**
 * How often to re-run the dispatcher pass independent of domain events. The
 * passes are otherwise event-driven; a child that goes quiet and emits no
 * further event would never have its idle wake re-evaluated once the grace above
 * elapses (the pass that observed it ran while its activity was still fresh and
 * correctly suppressed the wake). This periodic tick re-evaluates suppressed idle
 * children so a genuinely-idle one is still woken once its grace passes. Matches
 * the liveness sweep cadence (`sweepIntervalMs`).
 */
export const IDLE_WAKE_REPASS_INTERVAL_MS = 60_000;

const parseIsoMs = (iso: string | null): number | null => {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Last-progress timestamp (ms) for an idle child: the newest activity row, else
 * the latest turn's completion (the moment it went idle), else its start. `null`
 * only when nothing is known (a session-bearing child with no activity and no
 * turn — pathological), in which case the caller withholds the wake.
 */
export const idleLastProgressMs = (
  maxActivityCreatedAt: string | null,
  latestTurn: OrchestrationLatestTurn | null,
): number | null =>
  parseIsoMs(maxActivityCreatedAt) ??
  parseIsoMs(latestTurn?.completedAt ?? latestTurn?.startedAt ?? null);

/**
 * Activity-freshness grace gate for the idle wake: `true` ⇒ withhold (the child
 * has shown activity within `graceWindowMs`, or its last-progress time is
 * unknown). The idle wake fires only once this returns `false`. A grace only
 * delays *onset*; it does not change the one-wake-per-episode dedup (the episode
 * key still re-arms on `maxCreatedAt`).
 */
export const idleWakeWithinGrace = (
  lastProgressMs: number | null,
  now: number,
  graceWindowMs: number,
): boolean => lastProgressMs === null || now - lastProgressMs < graceWindowMs;

/** Executing-child predicate: an open turn on a released, pre-terminal child. */
const isChildExecuting = (child: OrchestrationThreadShell): boolean =>
  child.session !== null &&
  child.session.activeTurnId !== null &&
  (child.planLane === "ready" || child.planLane === "in_progress");

/**
 * Quiet duration (ms) for an EXECUTING child: `now` minus the newest of its
 * runtime heartbeat, activity row, and turn start. `null` when none is known (no
 * baseline → the caller withholds). Shared by {@link classifyChildWakeFull} and
 * by the wake loop's lazy in-flight-tool fetch gate so both read ONE definition
 * of "how long has this open turn been silent".
 */
const executingQuietMs = (
  child: OrchestrationThreadShell,
  freshness: ProjectionActivityFreshness,
  now: number,
): number | null => {
  const lastKnown = [
    freshness.heartbeatAt,
    freshness.maxCreatedAt,
    child.latestTurn?.startedAt ?? child.latestTurn?.requestedAt ?? null,
  ]
    .map(parseIsoMs)
    .filter((ms): ms is number => ms !== null);
  return lastKnown.length === 0 ? null : now - Math.max(...lastKnown);
};

/** The async evidence kinds the wake loop fetches on demand (§A.5). */
export type ChildWakeEvidenceKind =
  | "freshness"
  | "inFlightTool"
  | "idleWakeDelivered"
  | "errorWakeDelivered";

const EMPTY_EVIDENCE_NEEDS: ReadonlySet<ChildWakeEvidenceKind> = new Set();

/**
 * The per-child evidence {@link classifyChildWakeFull} needs to decide. The four
 * async fields are fetched lazily by the wake loop — only those
 * {@link childWakeEvidenceNeeds} names for the child's shape, in the exact order
 * the inline loop used before the extraction. The two synchronous fields are
 * always known from the snapshot.
 */
export interface ChildWakeEvidence {
  /** Activity freshness — present iff `"freshness"` was in the needs set. */
  readonly freshness?: ProjectionActivityFreshness | undefined;
  /** In-flight tool row (`null` when none) — present iff it was fetched. */
  readonly inFlightTool?: ProjectionInFlightTool | null | undefined;
  /**
   * Pre-formatted process-health evidence line for a due slow-tool notice
   * (from {@link formatProcessHealthLine} over the monitor's samples for the
   * child's provider subtree). Absent when the process is not locally
   * observable (remote/SSH, exited, no samples, or no monitor) — the notice
   * then degrades to its plain wording.
   */
  readonly processHealth?: string | undefined;
  /** `wasDelivered(idle:<maxCreatedAt>)` — the attention idle-wake suppression guard. */
  readonly idleWakeDelivered?: boolean | undefined;
  /** `wasDelivered(error)` — the `recovered`-wake precondition. */
  readonly errorWakeDelivered?: boolean | undefined;
  /** The child's `needs_guidance` came from a pre-first-turn provisioning park. */
  readonly provisionFailurePending: boolean;
  /** The child is a gate party the protocol has parked (not "forgot to finish"). */
  readonly waitingInGate: boolean;
}

/**
 * Why a child produced NO wake this pass — every previously comment-only
 * suppression is now an assertable variant.
 */
export type ChildWakeSkipReason =
  | "healthy"
  | "gate-waiting"
  | "within-grace"
  | "already-notified"
  | "never-errored"
  | "no-activity-baseline"
  | "frozen-within-grace"
  | "no-notice-due"
  | "no-in-flight-tool";

/**
 * The full wake decision: either a wake `kind` with its episode key (and any
 * measured `context`), or a `skip` reason. `suppressEpisode` is set on the two
 * skips that record a local suppression (attention already-notified, done
 * never-errored) — the loop `markSuppressed`s that episode's command id.
 */
export type ChildWakeDecision =
  | {
      readonly kind: ChildWakeKind;
      readonly episode: string;
      readonly context?: ChildWakeContext | undefined;
    }
  | { readonly skip: ChildWakeSkipReason; readonly suppressEpisode?: string };

/**
 * Phase 1 (pure): which async evidence the wake loop must fetch for this child,
 * so quiet/healthy children cost no queries. Mirrors the inline branch fetches
 * exactly: `error` needs nothing; `idle` needs freshness UNLESS it is a parked
 * gate party (short-circuited before any fetch — hence the `waitingInGate`
 * argument); `attention` needs freshness + the idle-wake delivery lookup; a
 * `done` child needs the error-wake delivery lookup; an executing child needs
 * freshness, plus the in-flight-tool query when unflagged (the loop still gates
 * that fetch behind the freshness-derived notice schedule, so a not-yet-quiet
 * call is never queried).
 */
export const childWakeEvidenceNeeds = (
  child: OrchestrationThreadShell,
  pendingTurnStartThreadIds: ReadonlySet<ThreadId>,
  waitingInGate: boolean,
): ReadonlySet<ChildWakeEvidenceKind> => {
  const kind = classifyChildWake(child, pendingTurnStartThreadIds);
  if (kind === "error") return EMPTY_EVIDENCE_NEEDS;
  if (kind === "idle")
    return waitingInGate ? EMPTY_EVIDENCE_NEEDS : new Set<ChildWakeEvidenceKind>(["freshness"]);
  if (kind === "attention")
    return new Set<ChildWakeEvidenceKind>(["freshness", "idleWakeDelivered"]);
  if (child.planLane === "done") return new Set<ChildWakeEvidenceKind>(["errorWakeDelivered"]);
  if (isChildExecuting(child))
    return child.attention.length > 0
      ? new Set<ChildWakeEvidenceKind>(["freshness"])
      : new Set<ChildWakeEvidenceKind>(["freshness", "inFlightTool"]);
  return EMPTY_EVIDENCE_NEEDS;
};

/**
 * Phase 2 (pure): the whole per-child wake decision. Composes the shape
 * classifier {@link classifyChildWake} and layers on the evidence-dependent
 * decisions (idle grace, attention idle-wake suppression, `recovered` error
 * precondition, frozen-attention vs slow-tool split) the loop used to inline.
 * Every branch's episode-key construction lives here; the loop keeps only the
 * effectful delivery tail.
 */
export const classifyChildWakeFull = (
  child: OrchestrationThreadShell,
  evidence: ChildWakeEvidence,
  now: number,
  pendingTurnStartThreadIds: ReadonlySet<ThreadId>,
): ChildWakeDecision => {
  const kind = classifyChildWake(child, pendingTurnStartThreadIds);

  // `error` fires once, keyed on nothing but the child.
  if (kind === "error") return { kind: "error", episode: "error" };

  if (kind === "idle") {
    // Gate-waiting is not "forgot to finish": a parked gate party (source after a
    // loop verdict, or routed-back target awaiting re-verify) is where it
    // belongs. A cancelled counterpart un-suppresses so the dead gate surfaces.
    if (evidence.waitingInGate) return { skip: "gate-waiting" };
    const freshness = evidence.freshness!;
    // Activity-freshness grace: a child only briefly between turns is not yet
    // "forgot to finish"; the periodic re-pass re-evaluates once the grace ends.
    if (
      idleWakeWithinGrace(
        idleLastProgressMs(freshness.maxCreatedAt, child.latestTurn),
        now,
        DEFAULT_IDLE_WAKE_GRACE_MS,
      )
    )
      return { skip: "within-grace" };
    // Idle keys on the newest activity-row timestamp at idle onset (stable while
    // idle → no re-nag; a resumed-then-quiet child emits a fresher row → the key
    // advances → the episode re-arms). This replaces the old `maxSequence` key,
    // which was permanently `none` (the feeding `sessionSequence` field was
    // never populated), so an idle wake once delivered was never re-armed and
    // every later terminal delta was suppressed forever (2026-07-08 incident).
    return { kind: "idle", episode: `idle:${freshness.maxCreatedAt ?? "none"}` };
  }

  if (kind === "attention") {
    // Attention keys on the latest turn at pause time (a resume clears attention
    // AND starts a new turn, so a later re-pause re-arms).
    const episode = `attention:${child.latestTurn?.turnId ?? "none"}`;
    // The idle backstop raises `needs_guidance` right before its "went quiet"
    // wake, which re-classifies the child as `attention` next pass. If this quiet
    // episode was already surfaced by a DELIVERED idle wake (never poisoned by a
    // park → `wasDelivered`), the parent was told once — suppress, don't re-nag.
    if (evidence.idleWakeDelivered) return { skip: "already-notified", suppressEpisode: episode };
    // A pre-first-turn provisioning park wears the same flag as an agent pause;
    // the provisioner's marker switches the copy to "provisioning failed".
    const context: ChildWakeContext | undefined = evidence.provisionFailurePending
      ? { quietMs: 0, provisionFailed: true }
      : undefined;
    return { kind: "attention", episode, context };
  }

  // `recovered` — a done child the parent was DURABLY told had errored (its
  // frozen error verdict is superseded). Fires once per child.
  if (child.planLane === "done") {
    // A done child with no error-wake DELIVERY never errored (error precedes
    // done) → suppress the recovery id so the receipt is not re-read every pass.
    // `wasDelivered` is correct even if a park added the error id to the
    // suppressed set: recovery fires only for a GENUINELY-told error.
    if (!evidence.errorWakeDelivered)
      return { skip: "never-errored", suppressEpisode: "recovered" };
    return { kind: "recovered", episode: "recovered" };
  }

  // Executing child (class-2 liveness): frozen-attention or slow-tool notice.
  if (isChildExecuting(child)) {
    const quietMs = executingQuietMs(child, evidence.freshness!, now);
    if (quietMs === null) return { skip: "no-activity-baseline" };
    if (child.attention.length > 0) {
      // Flagged mid-turn AND frozen (stall escalation on a wedged-open turn): the
      // idle-gated attention rail never fires because the turn never closes, so
      // this is the ONLY path that tells the parent. A mid-turn self-raise keeps
      // emitting activity, stays within grace, and is caught by the idle-gated
      // rail moments later.
      if (quietMs < DEFAULT_IDLE_WAKE_GRACE_MS) return { skip: "frozen-within-grace" };
      // Same episode key as the idle-gated attention rail: one notice per pause.
      return {
        kind: "attention",
        episode: `attention:${child.latestTurn?.turnId ?? "none"}`,
        context: { quietMs, frozen: true },
      };
    }
    // Unflagged + executing + quiet: an in-flight tool call is a slow-but-alive
    // call (informational, no flag, never interrupted). Quiet with no in-flight
    // tool is State-C territory (the sweep's ladder), not ours.
    const noticeIndex = slowToolNoticeIndex(quietMs);
    if (noticeIndex < 0) return { skip: "no-notice-due" };
    const inFlight = evidence.inFlightTool ?? null;
    if (inFlight === null) return { skip: "no-in-flight-tool" };
    return {
      kind: "slow-tool",
      // Keyed by the started row's id + schedule step: each step fires at most
      // once per in-flight call; a new call re-arms the episode.
      episode: `slow-tool:${inFlight.activityId}:${noticeIndex}`,
      context: {
        quietMs,
        toolName: inFlight.toolName,
        inFlightMs: Math.max(0, now - (parseIsoMs(inFlight.startedAt) ?? now)),
        ...(evidence.processHealth !== undefined ? { processHealth: evidence.processHealth } : {}),
      },
    };
  }

  return { skip: "healthy" };
};

/**
 * Pure formatter for the slow-tool notice's process-health evidence line from a
 * {@link ProcessTreeActivity} read. Honest and hedged: a working subtree is
 * stated plainly; an idle one is flagged "may be stuck" but allows for I/O- or
 * network-blocked work (which shows no CPU yet is not hung). `null` in ⇒ no
 * line (the notice degrades to its plain wording).
 */
export const formatProcessHealthLine = (
  activity: ProcessTreeActivity | null,
): string | undefined => {
  if (activity === null) return undefined;
  const secs = Math.round(activity.windowMs / 1_000);
  const cpu = `${Math.round(activity.peakCpuPercent)}% peak CPU over the last ${secs}s`;
  const across = activity.processCount === 1 ? "" : ` across ${activity.processCount} processes`;
  return activity.active
    ? `Process health: its tool process tree shows ${cpu}${across} — it is actively working, not hung.`
    : `Process health: its tool process tree shows ${cpu}${across} — no measurable CPU, so it may be genuinely stuck (or blocked on slow I/O or network, which also shows no CPU).`;
};

/**
 * Pure per-child wake-message builder. Tells the parent which child went
 * `error` / paused / quiet, points at its on-disk report (with a bounded
 * excerpt), and instructs it how to proceed. The `attention` copy is a PAUSE
 * notice — it names the child's plan lane + attention flags and explicitly says
 * the child has not finished.
 */
export const buildChildWakeMessage = (
  child: {
    readonly id: ThreadId;
    readonly role: string | null;
    readonly planLane: ThreadPlanLane;
    readonly attention: ReadonlyArray<AttentionReason>;
    readonly reportPath: string | null;
    readonly lastOutcome?: { readonly outcome: string; readonly decision: string } | null;
  },
  kind: ChildWakeKind,
  report: string | null,
  context?: ChildWakeContext,
): string => {
  const who = `${child.role ?? "sub-thread"} \`${child.id}\``;
  const mins = (ms: number) => Math.round(ms / 60_000);
  if (kind === "slow-tool") {
    // Informational only — nothing failed, no flag raised, no report expected.
    return [
      WORKSTREAM_CONTROL_PLANE_MARKER,
      "",
      `Informational notice: your Workstream sub-thread ${who} has a long-running tool call \`${context?.toolName ?? "unknown"}\` in flight for ~${mins(context?.inFlightMs ?? 0)} min, with no agent-visible output for ~${mins(context?.quietMs ?? 0)} min. This is NOT a hang verdict — the child's tool process may be working the whole time (builds, installs, long pipelines, test suites emit nothing to the agent until they return).`,
      ...(context?.processHealth ? ["", context.processHealth] : []),
      "",
      "No attention flag was raised and the control plane will not interrupt or kill it. A long, quiet call is usually legitimate, but occasionally one is mis-scoped (e.g. an unscoped filesystem search) — only you have the context to tell. Your options:",
      "",
      "- Let it run — you will be re-notified at increasing intervals while it stays quiet.",
      "- `workstream_prompt` the child to queue a steer (it is only seen once the current tool call returns — it cannot penetrate an in-flight call).",
      "- `workstream_stop` the child to interrupt the call, then `workstream_prompt` it to redirect.",
    ].join("\n");
  }
  const lead =
    kind === "error"
      ? `Your Workstream sub-thread ${who} raised an \`error\` attention flag (the liveness sweep detected it dead, stalled, looping, or repeatedly failing) and did not report success.`
      : kind === "attention"
        ? context?.provisionFailed
          ? `Your Workstream sub-thread ${who} never started: creating its isolated worktree failed with an environment/git error (a transient snapshot-commit race, NOT an agent stall) so it was parked with \`needs_guidance\` before its first turn. Its plan lane is still \`${child.planLane}\` and no turn has run.`
          : context?.frozen
            ? `Your Workstream sub-thread ${who} needs attention: it carries the attention flag(s) \`${child.attention.join("`, `")}\` and its open turn appears frozen — no runtime activity for ~${mins(context.quietMs)} min (this typically follows a liveness stall escalation whose recovery nudge did not unstick it). Its plan lane is still \`${child.planLane}\`; it has NOT finished.`
            : `Your Workstream sub-thread ${who} is paused and needs attention: it carries the attention flag(s) \`${child.attention.join("`, `")}\` and is not executing, while its plan lane is still \`${child.planLane}\`. It has NOT finished — this is a pause notice, not a result.`
        : kind === "idle"
          ? child.lastOutcome != null &&
            (child.lastOutcome.decision === "loop" || child.lastOutcome.decision === "yield")
            ? `Your Workstream sub-thread ${who} submitted but its routing never landed: it ran \`workstream_submit\` (outcome \`${child.lastOutcome.outcome}\`, routed as \`${child.lastOutcome.decision}\`) and is now idle, yet its plan lane is still in progress — the routed hand-back to its gate counterpart was never delivered, so the review loop is wedged. It has been flagged \`needs_guidance\` so it surfaces for you. Check the gate counterpart (the reviewer/coder it loops with): resume it (\`workstream_prompt\`) or dissolve the gate (\`workstream_set_lane\` done/cancelled on the reviewer).`
            : `Your Workstream sub-thread ${who} went quiet without reporting: it finished its turn and is idle, but its plan lane is still in progress (it never submitted — it never advanced its plan or raised attention). It has been flagged \`needs_guidance\` so it surfaces for you.`
          : `Your Workstream sub-thread ${who} recovered: you were told it raised an \`error\` flag (often a false-positive liveness verdict), but its plan has since reached \`done\`. The earlier error verdict is superseded — treat it as having completed successfully.`;
  const reference =
    child.reportPath !== null
      ? `Report reference: \`${child.reportPath}\` (read the full report on demand).`
      : "_No report was filed._";
  const tail =
    kind === "recovered"
      ? "Its dependents have already been released by the `done` transition (nothing is gated on it now). Read its report (referenced above), fold its result into your orchestration, and continue."
      : kind === "attention"
        ? context?.provisionFailed
          ? "This is an infrastructure failure, not the agent — nothing ran, so there is no report. `workstream_prompt` the child to retry provisioning (a transient snapshot-commit race normally clears on retry). Its dependents stay gated until it reaches `done`."
          : context?.frozen
            ? "Do not treat its work as complete. A human has also been alerted on the board, but you can act on their behalf: `workstream_stop` it to close the wedged turn, then `workstream_prompt` it to redirect — or plan around it. Its dependents stay gated until it reaches `done`."
            : "Do not treat its work as complete. If it is `awaiting_acceptance`, review its report and either accept it (`workstream_set_lane` done, which releases its dependents) or escalate to the human. If it is `needs_guidance` (e.g. a human stopped it, or it cannot proceed), a human is in the loop — plan around the pause rather than resuming it yourself. Its dependents stay gated until it reaches `done`."
        : "Investigate via its report above (or `consult_thread` for a read-only Q&A), then either advance its plan lane (`workstream_set_lane` done/cancelled) or re-dispatch it. Its dependents stay gated until it reaches `done`; nothing was auto-cascaded.";
  return [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    lead,
    "",
    reference + formatReportExcerpt(report),
    "",
    tail,
  ].join("\n");
};
// Deterministic park command ids (shared by every wake rail): `parkAndEscalate`
// writes the `needs_guidance` attention.raise under `parkBlockCommandId` and the
// activity marker under `parkCommandId`, both receipt-deduped so a re-run never
// double-raises. The `episode` is a per-rail key (e.g. `child-wake:<id>` or
// `delta` for a whole terminal-child batch).
const parkCommandId = (parentId: ThreadId, episode: string): string =>
  `server:workstream-notify:park:${parentId}:${episode}`;
const parkBlockCommandId = (parentId: ThreadId, episode: string): string =>
  `${parkCommandId(parentId, episode)}:block`;

// loom: forkFrom (D2) — hoisted decoder (no per-call inline schema compile).
const decodeCapturedSelection = Schema.decodeUnknownEffect(ModelSelection);

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const worktreeProvisioner = yield* WorktreeProvisioner;
  // loom: forkFrom (D2/D7) — launch-identity records live under this dir.
  const serverConfig = yield* ServerConfig;
  const launchIdentityDir = serverConfig.workstreamLaunchIdentityDir;

  // Does a command id have an accepted receipt? Backs the durable handled-check,
  // so a fresh process (empty cache) still recomputes the true handled set from
  // the receipt store rather than re-firing a wake/park.
  const hasAcceptedReceipt = (commandId: string) =>
    commandReceiptRepository
      .getByCommandId({ commandId: CommandId.make(commandId) })
      .pipe(Effect.map(Option.isSome));

  // Shared receipt-dedup delivery (decision 4): ONE instance backs both the
  // per-child `child-reported` delta markers and the per-child / yield / gate
  // wake command ids (all disjoint by prefix). Its two caches — `delivered`
  // (local record ∪ accepted receipt) and `suppressed` (park/skip, no receipt) —
  // are process-local caches of the recomputable durable state: a miss falls
  // through to the receipt store, so a fresh process recomputes the true
  // delivered set. Crucially `wasDelivered` never consults the suppressed set,
  // so a park path can no longer poison a cross-rail "was the parent told?"
  // question — the hazard the old raw-set discipline defended by comment.
  const dedup = yield* makeReceiptDedupedDelivery({ hasAcceptedReceipt });
  // Per-parent wake-rate budget backing the interim runaway guard, shared by the
  // delta, per-child, and yield rails so they draw on ONE budget per parent.
  const wakeBudget = makeWakeRateBudget();

  // ------------------------------------------------------------------------
  // FYI digest accumulator (design §4.3). One entry per withheld FYI item; the
  // map is rebuilt every pass (recomputable from lanes + receipts, no new
  // persistence). The delta rail stashes terminal-delta items; the per-child
  // rail stashes `recovered`/`slow-tool` items; the action rails piggyback the
  // per-parent digest onto their wakes; a final step flushes leftovers standalone
  // when the workstream is quiet or the oldest item has aged past the window.
  // ------------------------------------------------------------------------
  interface PendingDigestEntry {
    readonly child: OrchestrationThreadShell;
    /** Command id whose receipt records "this item was digested". */
    readonly marker: string;
    readonly kind: "terminal" | "recovered" | "slow-tool";
    /** Terminal-episode key (terminal items only) — the reported-marker payload. */
    readonly episode: string;
    readonly slowTool?: {
      readonly toolName: string;
      readonly inFlightMs: number;
      readonly quietMs: number;
      /** One honest process-health line (see {@link formatProcessHealthLine}); absent when not locally observable. */
      readonly processHealth?: string | undefined;
    };
    /** Durable event time (ms) driving the quiet-window age flush. */
    readonly eventAtMs: number | null;
  }
  type PendingDigests = Map<ThreadId, PendingDigestEntry[]>;

  const stashPending = (
    pending: PendingDigests,
    parentId: ThreadId,
    entry: PendingDigestEntry,
  ): void => {
    const list = pending.get(parentId);
    if (list) list.push(entry);
    else pending.set(parentId, [entry]);
  };

  // Render a parent's pending entries into the digest member/extra inputs (reads
  // each terminal item's report on demand). Order: terminals first, extras last.
  const renderPending = (
    entries: ReadonlyArray<PendingDigestEntry>,
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ) =>
    Effect.gen(function* () {
      const members: WakeMember[] = [];
      const extras: DigestExtra[] = [];
      const mins = (ms: number) => Math.round(ms / 60_000);
      for (const entry of entries) {
        if (entry.kind === "terminal") {
          const report = yield* readReportFor(entry.child);
          members.push(toWakeMember(entry.child, report, threads));
        } else if (entry.kind === "recovered") {
          extras.push({
            kind: "recovered",
            childId: entry.child.id,
            role: entry.child.role,
            line: renderRecoveredDigestLine({
              id: entry.child.id,
              role: entry.child.role,
              reportPath: entry.child.reportPath,
              eventAt: entry.child.lastOutcome?.at ?? entry.child.updatedAt,
            }),
          });
        } else {
          extras.push({
            kind: "slow-tool",
            childId: entry.child.id,
            role: entry.child.role,
            line: renderSlowToolDigestLine({
              id: entry.child.id,
              role: entry.child.role,
              toolName: entry.slowTool?.toolName ?? "unknown",
              inFlightMinutes: mins(entry.slowTool?.inFlightMs ?? 0),
              quietMinutes: mins(entry.slowTool?.quietMs ?? 0),
              ...(entry.slowTool?.processHealth !== undefined
                ? { processHealth: entry.slowTool.processHealth }
                : {}),
            }),
          });
        }
      }
      return { members, extras };
    });

  // Oldest pending event time (ms) for the age flush; null when none is known.
  const oldestPendingMs = (entries: ReadonlyArray<PendingDigestEntry>): number | null => {
    const times = entries.map((entry) => entry.eventAtMs).filter((ms): ms is number => ms !== null);
    return times.length === 0 ? null : Math.min(...times);
  };

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:workstream-dispatcher:${tag}:${uuid}`)),
    );

  // Latest-report read that honours the event-sourced pointer: inside a gate
  // loop the latest report lives in a per-round file (risk R2) the fixed-name
  // read would miss. Falls back to the by-id read when no pointer exists.
  const readReportFor = (thread: { readonly id: ThreadId; readonly reportPath: string | null }) =>
    (thread.reportPath !== null
      ? readWorkstreamReportAt(thread.reportPath)
      : readWorkstreamReport(thread.id)
    ).pipe(Effect.map(Option.getOrNull));

  // Provision the child's workspace at promotion (plan §2/§4). Isolated children
  // get their own worktree + `ws/…` branch (parent dirty state auto-committed
  // first); an attached gated reviewer copies its gate target's worktree/branch;
  // shared children keep the parent's provisional values (today's behaviour).
  // Returns false when provisioning failed (skip the kick-off turn this pass).
  const provisionWorkspace = Effect.fn("provisionWorkspace")(function* (
    thread: OrchestrationThreadShell,
    role: string,
  ) {
    if (thread.isolation === "isolated") {
      // Delegated to the shared provisioner (item 4): idempotent on an already
      // -provisioned `ws/…` child, and it parks (needs_guidance) on failure. The
      // reactor's turn-start guard shares this exact path, so a later prompt on a
      // parked child re-provisions rather than running in the parent's worktree.
      return yield* worktreeProvisioner.ensureIsolatedChildProvisioned({
        threadId: thread.id,
        role,
        projectId: thread.projectId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
      });
    }
    if (thread.isolation === "attached") {
      const targetId = gateLoopTargetOf(thread);
      if (targetId === null) return true;
      const target = yield* projectionSnapshotQuery
        .getThreadDetailById(targetId)
        .pipe(Effect.map(Option.getOrUndefined));
      if (target === undefined) return true;
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("attach-meta-update"),
        threadId: thread.id,
        branch: target.branch,
        worktreePath: target.worktreePath,
      } satisfies OrchestrationCommand);
      return true;
    }
    return true;
  });

  // Park an un-launchable child (needs_guidance) — the same posture as a
  // worktree-provision failure. Used when the brief file cannot be read at
  // kickoff time: launching with a stale/empty prompt is worse than parking and
  // surfacing it. Receipt-deduped (deterministic id) so a re-run never re-raises.
  const parkThreadForBriefReadFailure = Effect.fn("parkThreadForBriefReadFailure")(function* (
    thread: OrchestrationThreadShell,
  ) {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine.dispatch({
      type: "thread.attention.raise",
      commandId: CommandId.make(`server:workstream-dispatcher:brief-read-failed:${thread.id}`),
      threadId: thread.id,
      reason: "needs_guidance",
      createdAt: now,
    } satisfies OrchestrationCommand);
  });

  const promoteThread = Effect.fn("promoteThread")(function* (thread: OrchestrationThreadShell) {
    const { role, purpose, kickoffBriefPath } = thread;
    // Guaranteed non-null by selectThreadsToDispatch; this also narrows types.
    if (role === null || purpose === null || kickoffBriefPath === null) return;
    if (worktreeProvisioner.hasPendingProvisionFailure(thread.id)) return;
    // Read-at-kickoff (scaffold plan §1): the brief lives on disk (event store
    // holds only the pointer), so the kick-off content is the file's CURRENT
    // bytes — honouring any pre-launch edit without a further tool call. A read
    // failure parks the node rather than launching with an empty/stale prompt,
    // the same posture as a provision failure below.
    const briefContent = yield* readWorkstreamBriefAt(kickoffBriefPath);
    if (Option.isNone(briefContent)) {
      yield* parkThreadForBriefReadFailure(thread);
      return;
    }
    const brief = briefContent.value;
    // Provision the workspace before the kick-off turn so the child's provider
    // session resolves its cwd to the new worktree from its first turn.
    if (!(yield* provisionWorkspace(thread, role))) return;
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    // Atomic kickoff: `setInProgress` makes the decider emit the `in_progress`
    // plan-lane-set in the SAME command as the turn-start, so both events are
    // appended in one engine transaction. A crash can never leave the child with
    // a started turn but a lane stuck at `ready`, and the next promote pass sees
    // a started thread and never double-starts it.
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("start-turn"),
      threadId: thread.id,
      message: {
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        role: "user",
        origin: "kickoff",
        text: workstreamChildPrompt({ role, brief }),
        attachments: [],
      },
      titleSeed: thread.title,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      setInProgress: true,
      createdAt: now,
    } satisfies OrchestrationCommand);
  });

  // loom: forkFrom (D2 authority) — persist the SOURCE's captured
  // instance/model/options onto a fork child BEFORE its kickoff turn-start, so
  // the reactor's per-turn selection reassertion and the exhaustion sweep's
  // readiness check both key off the model that actually consumed the shared
  // prefix rather than the fork child's inherited placeholder selection. Safe
  // against the reactor's started-thread model guard because the fork child has
  // no session yet. A missing/model-less record is left to the driver's
  // fork-launch refusal (D2) — nothing to persist here.
  // Returns:
  //  - "missing": no captured record on disk — promotion proceeds so the DRIVER
  //    issues its loud missing-record fork-launch refusal (D2 deterministic
  //    refusal), which is strictly better than a silent stale-selection launch.
  //  - "ok": the captured selection was durably persisted onto the fork child.
  //  - "defer": a record EXISTS but the captured selection could not be built
  //    or persisted (invalid record / model-less / meta.update failed). The
  //    driver would NOT refuse (the record exists), so launching would silently
  //    apply the child's stale placeholder selection and forfeit the cache.
  //    Do NOT kick this pass; log and retry on the next pass.
  const persistForkSelection = Effect.fn("persistForkSelection")(function* (
    thread: OrchestrationThreadShell,
  ) {
    if (thread.forkFromThreadId === null) return "ok" as const;
    const record = readLaunchIdentity(launchIdentityDir, thread.forkFromThreadId);
    if (record === undefined) return "missing" as const;
    if (record.model === undefined) return "defer" as const;
    const captured = yield* decodeCapturedSelection({
      instanceId: record.providerInstanceId,
      model: record.model,
      ...(record.options && record.options.length > 0 ? { options: record.options } : {}),
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (captured === undefined) return "defer" as const;
    return yield* orchestrationEngine
      .dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("fork-selection"),
        threadId: thread.id,
        modelSelection: captured,
      } satisfies OrchestrationCommand)
      .pipe(
        Effect.as("ok" as const),
        Effect.catch(() => Effect.succeed("defer" as const)),
      );
  });

  // loom: forkFrom (D2/D7) — a fork whose captured selection could not be built
  // or persisted (invalid/model-less record, or a meta.update failure) must not
  // launch on its stale placeholder selection, but must NOT sit silently `ready`
  // either. Raise a deduped needs_guidance flag (deterministic id → receipt-
  // deduped, so re-runs never re-raise) so the parent/board sees it and can
  // repair (re-spawn the fork). The periodic dispatch re-pass keeps retrying, so
  // a transient meta.update failure self-heals (the flag clears when the child
  // finally launches).
  const parkForkForUnpersistedSelection = Effect.fn("parkForkForUnpersistedSelection")(function* (
    thread: OrchestrationThreadShell,
  ) {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine
      .dispatch({
        type: "thread.attention.raise",
        commandId: CommandId.make(
          `server:workstream-dispatcher:fork-selection-unpersisted:${thread.id}`,
        ),
        threadId: thread.id,
        reason: "needs_guidance",
        createdAt: now,
      } satisfies OrchestrationCommand)
      .pipe(Effect.ignoreCause({ log: true }));
  });

  const promoteReadyThreads = Effect.fn("promoteReadyThreads")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const selected = selectThreadsToDispatch(snapshot.threads);
    // loom: forkFrom (D7) — a fork child whose own pi session file does not yet
    // exist may only be promoted once its SOURCE is idle; otherwise `pi --fork`
    // would copy a mid-turn transcript and the persisted kickoff would strand it
    // (the provider guard fires too late to retry). Sharing shouldRefuseForkLaunch's
    // exact predicate keeps this dispatch gate and the provider backstop from
    // drifting. A deferred fork stays ready/un-kicked; the source going idle
    // emits thread.session-set, which re-runs this pass — no new trigger wiring.
    const hasForkPending = selected.some((thread) => thread.forkFromThreadId !== null);
    const pendingTurnStartThreadIds = hasForkPending
      ? yield* projectionSnapshotQuery.getPendingTurnStartThreadIds()
      : new Set<ThreadId>();
    const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const));
    for (const thread of selected) {
      if (thread.forkFromThreadId !== null) {
        const source = threadsById.get(thread.forkFromThreadId);
        if (
          shouldRefuseForkLaunch({
            forkFromThreadId: thread.forkFromThreadId,
            childSessionFileExists:
              resolveSessionFilePath(piSessionIdForThread(thread.id)) !== undefined,
            source,
            pendingTurnStartThreadIds,
          })
        )
          continue; // source mid-turn — defer; re-runs on the source's thread.session-set
        // loom: forkFrom (D2 authority) — never kick on an unpersisted selection.
        const persisted = yield* persistForkSelection(thread);
        if (persisted === "defer") {
          yield* Effect.logWarning(
            "forkFrom: captured selection not durably persisted; deferring fork kickoff",
            { threadId: thread.id, forkFromThreadId: thread.forkFromThreadId },
          );
          // Surface it (deduped) so it is not silently stuck; the periodic
          // re-pass retries and clears the flag on eventual launch.
          yield* parkForkForUnpersistedSelection(thread);
          continue; // do NOT launch on the stale placeholder selection
        }
        // "ok" (persisted) or "missing" (driver issues the loud D2 refusal).
      }
      yield* promoteThread(thread);
    }
  });

  // Deliver ONE batched delta wake carrying every newly-terminal child of a
  // parent. The command id is a fresh server uuid: cross-restart / re-eval dedup
  // is carried by the per-child `child-reported` markers (written after the
  // wake), NOT by this id, so a crash between wake and markers risks at most a
  // rare duplicate mention on the next pass — strictly better than losing the
  // notice. `requireIdle` makes the engine re-check parent idleness atomically
  // at the serialized command boundary; a busy parent defers (fails without a
  // receipt) and is retried on the next idle drain.
  // Siblings whose `blockedBy` names this now-`done` child (design §4.1): the
  // dependents its terminal transition released. Only `done` releases; a
  // cancelled child releases nothing.
  const releasedDependentsOf = (
    child: OrchestrationThreadShell,
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ): ReadonlyArray<{ readonly id: ThreadId; readonly role: string | null }> =>
    child.planLane !== "done"
      ? []
      : threads
          .filter((other) => other.id !== child.id && other.blockedBy.includes(child.id))
          .map((other) => ({ id: other.id, role: other.role }));

  // Assemble the extended wake record for one terminal child: status fields +
  // report + gate context (lastOutcome/gateRounds/routes for the pair grouper) +
  // the durable event time (§5.4) + released dependents (§4.1).
  const toWakeMember = (
    child: OrchestrationThreadShell,
    report: string | null,
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ): WakeMember => ({
    id: child.id,
    role: child.role,
    planLane: child.planLane,
    attention: child.attention,
    reportPath: child.reportPath,
    report,
    fanInState: child.fanInState,
    lastOutcome: child.lastOutcome,
    gateRounds: child.gateRounds,
    routes: child.routes,
    eventAt: child.lastOutcome?.at ?? child.updatedAt,
    releasedDependents: releasedDependentsOf(child, threads),
  });

  // Deliver a parent's pending FYI items as a STANDALONE digest turn-start
  // (design §5.3). Its own control-plane marker + "nothing below is blocked on
  // you" framing. `requireIdle`, so a busy parent defers (no receipt) and the
  // items stay pending for the next pass. Returns true only on real delivery.
  const deliverStandaloneDigest = Effect.fn("deliverStandaloneDigest")(function* (
    parent: OrchestrationThreadShell,
    entries: ReadonlyArray<PendingDigestEntry>,
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ) {
    const { members, extras } = yield* renderPending(entries, threads);
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    return yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: yield* serverCommandId("fyi-digest"),
        threadId: parent.id,
        message: {
          messageId: MessageId.make(yield* crypto.randomUUIDv4),
          role: "user",
          origin: "control_notice",
          controlPayload: buildDigestPayload(members, extras),
          text: buildStandaloneDigest(members, extras),
          attachments: [],
        },
        titleSeed: parent.title,
        runtimeMode: parent.runtimeMode,
        interactionMode: parent.interactionMode,
        requireIdle: true,
        createdAt: now,
      } satisfies OrchestrationCommand)
      .pipe(
        Effect.as(true),
        Effect.catchTag("OrchestrationCommandDeferredError", () => Effect.succeed(false)),
      );
  });

  // Durable per-child "reported through the delta rail" marker (an activity row
  // whose deterministic command id yields the recomputable receipt). Appended to
  // the CHILD under kind `workstream.child-reported`, which the activity-
  // freshness query excludes (`kind NOT LIKE 'workstream.%'`), so it never
  // perturbs the child's idle/stall episode keys. Dispatched after the wake
  // (wake-before-markers); idempotent — a re-dispatch under the same id is a
  // no-op that writes no second row.
  const dispatchChildReportedMarker = Effect.fn("dispatchChildReportedMarker")(function* (
    child: OrchestrationThreadShell,
    episode: string,
  ) {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(childReportedCommandId(child.id, episode)),
      threadId: child.id,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "info",
        kind: "workstream.child-reported",
        summary: `Terminal status (${child.planLane}) reported to the parent orchestrator.`,
        payload: { parentId: child.parentThreadId, episode, planLane: child.planLane },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    } satisfies OrchestrationCommand);
  });

  // Durable marker for a `recovered`/`slow-tool` FYI item delivered through the
  // digest. Keyed by the SAME `childWakeCommandId` the immediate rail used, so
  // the recovered/slow-tool episode dedup (`alreadyHandled`/`wasDelivered`) is
  // unchanged; only the delivery vehicle moved to the digest. Written on the
  // child after the digest turn-start succeeds (wake-before-markers).
  const dispatchDigestExtraMarker = Effect.fn("dispatchDigestExtraMarker")(function* (
    child: OrchestrationThreadShell,
    kind: "recovered" | "slow-tool",
    commandId: string,
  ) {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(commandId),
      threadId: child.id,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "info",
        kind: "workstream.child-reported",
        summary: `Informational ${kind} status folded into the parent's FYI digest.`,
        payload: { parentId: child.parentThreadId, kind },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    } satisfies OrchestrationCommand);
  });

  // Record the durable marker for one delivered digest entry (wake-before-
  // markers). Terminal items reuse the `child-reported` marker; FYI extras reuse
  // their `childWakeCommandId`. Idempotent via `deliverOnce`.
  const recordDigestMarker = (entry: PendingDigestEntry) =>
    entry.kind === "terminal"
      ? dedup.deliverOnce(entry.marker, dispatchChildReportedMarker(entry.child, entry.episode))
      : dedup.deliverOnce(
          entry.marker,
          dispatchDigestExtraMarker(entry.child, entry.kind, entry.marker),
        );

  // The parent's pending entries not yet durably delivered this pass (or by a
  // prior process). Filters out any whose marker receipt already exists so a
  // piggyback and the standalone flush never double-deliver the same item.
  const deliverablePending = (entries: ReadonlyArray<PendingDigestEntry>) =>
    Effect.gen(function* () {
      const out: PendingDigestEntry[] = [];
      for (const entry of entries) {
        if (!(yield* dedup.alreadyHandled(entry.marker))) out.push(entry);
      }
      return out;
    });

  const PARK_SUMMARY =
    "Workstream wake rate guard tripped: this parent is being woken too frequently (likely a spawn spin-loop). Parked and escalated for human review.";

  // The activity marker — the SECOND durable park write (under `parkCommandId`).
  const dispatchParkMarker = Effect.fn("dispatchParkMarker")(function* (
    parent: OrchestrationThreadShell,
    episode: string,
  ) {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(parkCommandId(parent.id, episode)),
      threadId: parent.id,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "error",
        kind: "workstream.runaway-guard.tripped",
        summary: PARK_SUMMARY,
        payload: { reason: "wake-rate-guard", episode },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    } satisfies OrchestrationCommand);
  });

  // Park-and-escalate (decision 5): on a tripped rate guard, do not kill and do
  // not deliver — raise the parent's `needs_guidance` attention flag (the single
  // notification surface) and surface it to the human (the stub for the future
  // investigator agent). Both writes are receipt-deduped by their deterministic
  // ids so re-running the pass never double-raises. The rate guard itself is an
  // in-memory runaway catch (backed by `wakeTimestamps`), so after a restart a
  // genuine runaway simply re-trips and re-parks — the human was already alerted.
  const parkAndEscalate = Effect.fn("parkAndEscalate")(function* (
    parent: OrchestrationThreadShell,
    episode: string,
  ) {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine.dispatch({
      type: "thread.attention.raise",
      commandId: CommandId.make(parkBlockCommandId(parent.id, episode)),
      threadId: parent.id,
      reason: "needs_guidance",
      createdAt: now,
    } satisfies OrchestrationCommand);
    yield* dispatchParkMarker(parent, episode);
  });

  // Has the parent ALREADY heard about this terminal child's current state
  // through one of the other wake rails, with no new work since? Each check is an
  // exact-id receipt lookup on the child's CURRENT episode key, so it re-arms
  // automatically: a child that ran again after the earlier wake carries a fresh
  // outcome event / turn id / activity sequence, so the old receipt no longer
  // matches and the child is news again.
  //  - yield: the parent got this exact submitted outcome (accept/cancel adds
  //    nothing); a re-run changes `recordedByEventId`.
  //  - error: the parent was told it errored — an error→done flip is re-notified
  //    by the dedicated `recovered` rail, and error→cancelled is a parent action,
  //    so either way the delta must not double-report.
  //  - attention: the parent got the pause notice + report at that turn; going
  //    terminal without a new turn adds nothing.
  //  - idle: the parent got the forgot-to-finish notice + report at that activity
  //    sequence; going terminal without new activity adds nothing.
  const alreadyNoticedByPriorRail = Effect.fn("alreadyNoticedByPriorRail")(function* (
    child: OrchestrationThreadShell,
  ) {
    // Each check is a DURABLE-delivery question ("was the parent actually told
    // through the other rail?"), so it goes through `wasDelivered` — which reads
    // only the delivered set (∪ receipt), never a park-path suppression.
    if (
      child.lastOutcome !== null &&
      (yield* dedup.wasDelivered(yieldWakeCommandId(child.id, child.lastOutcome.recordedByEventId)))
    )
      return true;
    if (yield* dedup.wasDelivered(childWakeCommandId(child.id, "error"))) return true;
    if (
      yield* dedup.wasDelivered(
        childWakeCommandId(child.id, `attention:${child.latestTurn?.turnId ?? "none"}`),
      )
    )
      return true;
    const freshness = yield* projectionSnapshotQuery.getActivityFreshnessByThreadId(child.id);
    return yield* dedup.wasDelivered(
      childWakeCommandId(child.id, `idle:${freshness.maxCreatedAt ?? "none"}`),
    );
  });

  // Terminal-child delta collection (two-tier, design §4.2/§4.3): terminal
  // children are now FYI, so instead of an immediate wake this stashes every
  // newly-reportable terminal child into the per-pass pending-digest map. The
  // holdbacks (unresolved gate, fan-in pending, pair coherence) and prior-rail
  // suppression are unchanged — only the delivery vehicle moved to the digest.
  const collectTerminalDeltas = Effect.fn("collectTerminalDeltas")(function* (
    threads: ReadonlyArray<OrchestrationThreadShell>,
    threadsById: ReadonlyMap<ThreadId, OrchestrationThreadShell>,
    pending: PendingDigests,
  ) {
    for (const child of threads) {
      if (child.parentThreadId === null) continue;
      if (!isTerminalForJoin(child)) continue;
      // Per-child holdbacks (were per-generation, now per child): a member of an
      // unresolved gate is not reportable until the gate resolves — the nice
      // consequence is that a cleanly-resolved coder+reviewer pair becomes
      // reportable together in ONE wake at resolution, which the old barrier only
      // managed when the pair happened to be its own generation. A `done`
      // isolated child whose fan-in is still in flight (`none`) waits until it
      // settles; `conflicted` IS settled-for-wake (the wake carries the conflict
      // block so the orchestrator can resolve it).
      if (isMemberOfUnresolvedGate(child, threads)) continue;
      if (isFanInPending(child)) continue;
      // Pair fan-in coherence (notice-coalescing §4.1): hold a resolved gate
      // source back while its loop target's fan-in is still in flight, so the
      // pair reports together in one wake rather than splitting (reviewer now,
      // coder after the merge). Releases on `thread.fanin-set` when the target
      // settles `completed`/`conflicted`.
      if (isHeldForCounterpartFanIn(child, threadsById)) continue;
      const episode = terminalEpisodeKey(child);
      const marker = childReportedCommandId(child.id, episode);
      // `alreadyHandled` folds the in-memory cache and the durable marker receipt
      // into one check (caching a receipt hit).
      if (yield* dedup.alreadyHandled(marker)) continue;
      if (yield* alreadyNoticedByPriorRail(child)) {
        // Suppress locally so we don't re-run the prior-rail lookups every pass;
        // the durable truth is the OTHER rail's receipt, recomputed on a fresh
        // process. Not a delivery of THIS marker — so `markSuppressed`, not
        // `deliverOnce`.
        yield* dedup.markSuppressed(marker);
        continue;
      }
      stashPending(pending, child.parentThreadId, {
        child,
        marker,
        kind: "terminal",
        episode,
        eventAtMs: parseIsoMs(child.lastOutcome?.at ?? child.updatedAt),
      });
    }
  });

  // Deliver one per-child wake (§1e). Mirrors the delta wake: a deterministic
  // command id (receipt-dedup across restarts), `requireIdle` so a busy parent
  // defers atomically at the command boundary. The child's PLAN is left untouched
  // (the parent decides done/cancelled/re-dispatch); the only state it writes is
  // the idle backstop's `needs_guidance` flag (design §4.7) so a forgot-to-finish
  // child cannot sit silently halted.
  const deliverChildWake = Effect.fn("deliverChildWake")(function* (
    parent: OrchestrationThreadShell,
    child: OrchestrationThreadShell,
    kind: ChildWakeKind,
    commandId: string,
    context?: ChildWakeContext,
    // Piggyback digest text appended AFTER the action copy (design §5.3): the
    // decision the parent must make leads; the FYI scoreboard rides along.
    digestText?: string,
  ) {
    // No-silent-halt backstop (design §4.7/§6): a forgot-to-finish child is
    // halted non-terminal with no resumer, so raise its `needs_guidance` flag —
    // the board must SHOW it carries the flag, not merely generate a wake.
    // Idempotent (deterministic `server:` id, receipt-deduped) and raised BEFORE
    // the wake so the flag lands even if the parent wake later defers — in that
    // race the now-flagged child is picked up by the `attention` rail on the
    // next pass, so the parent is still woken. The `error`/`attention` kinds
    // already carry their flags and `recovered` reached `done` (terminal) —
    // none of those raise here.
    if (kind === "idle") {
      yield* orchestrationEngine.dispatch({
        type: "thread.attention.raise",
        commandId: CommandId.make(`${commandId}:flag`),
        threadId: child.id,
        reason: "needs_guidance",
        createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      } satisfies OrchestrationCommand);
    }
    const report = yield* readReportFor(child);
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const actionText = buildChildWakeMessage(child, kind, report, context);
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(commandId),
      threadId: parent.id,
      message: {
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        role: "user",
        origin: "control_notice",
        text: digestText === undefined ? actionText : `${actionText}\n${digestText}`,
        attachments: [],
      },
      titleSeed: parent.title,
      runtimeMode: parent.runtimeMode,
      interactionMode: parent.interactionMode,
      requireIdle: true,
      createdAt: now,
    } satisfies OrchestrationCommand);
  });

  // Per-child wake pass (§1e): wake the parent of every `error`, paused
  // (attention-flagged and halted — idle or frozen mid-turn), forgot-to-finish,
  // recovered (`error`→`done`), or slow-tool (executing, in-flight tool call
  // gone quiet — informational) child through the shared rail, so a single
  // failed/paused/quiet/recovered child is surfaced promptly (B1) even while its
  // siblings still run — these are the non-terminal / transitional states the
  // terminal-child delta rail (`collectTerminalDeltas`) could never carry. Shares
  // `wakeTimestamps` + `parkAndEscalate` so error/idle/recovery/terminal-delta
  // wakes draw on ONE rate budget per parent (C1).
  const wakeIdleAndErroredChildren = Effect.fn("wakeIdleAndErroredChildren")(function* (
    threads: ReadonlyArray<OrchestrationThreadShell>,
    threadsById: ReadonlyMap<ThreadId, OrchestrationThreadShell>,
    pending: PendingDigests,
  ) {
    const pendingTurnStartThreadIds = yield* projectionSnapshotQuery.getPendingTurnStartThreadIds();

    for (const child of threads) {
      // Top-level threads have no agent parent to wake; the board surfaces them
      // (error lane / activity) as escalate-to-human.
      if (child.parentThreadId === null) continue;
      const parent = threadsById.get(child.parentThreadId);
      if (parent === undefined) continue;

      const now = yield* Clock.currentTimeMillis;
      // Gate-waiting (review-gates design §6) is asked only of an idle-kind child
      // and needs the counterpart map, so it is computed here (matching the
      // pre-extraction fetch pattern — never for a non-idle child) and fed to
      // both evidence-planning and classification.
      const waitingInGate =
        classifyChildWake(child, pendingTurnStartThreadIds) === "idle" &&
        isWaitingInGate(child, threadsById);

      // Phase 1 (§A.5): fetch exactly the async evidence this child's shape needs
      // — quiet/healthy children cost no queries. The fetch ORDER preserves the
      // inline rail's lazy pattern verbatim: freshness before the freshness-keyed
      // idle-wake lookup; the in-flight-tool query gated behind the notice
      // schedule so a not-yet-quiet executing call is never queried.
      const needs = childWakeEvidenceNeeds(child, pendingTurnStartThreadIds, waitingInGate);
      const freshness = needs.has("freshness")
        ? yield* projectionSnapshotQuery.getActivityFreshnessByThreadId(child.id)
        : undefined;
      const idleWakeDelivered = needs.has("idleWakeDelivered")
        ? yield* dedup.wasDelivered(
            childWakeCommandId(child.id, `idle:${freshness?.maxCreatedAt ?? "none"}`),
          )
        : undefined;
      // A done child's wake episode is always "recovered" (both the delivered
      // recovery and the never-errored suppression use that id), so — exactly as
      // the inline branch did — the recovered already-handled/suppressed check
      // short-circuits BEFORE the receipt-store error-delivery read. Without it a
      // never-errored done child (which `markSuppressed`s "recovered" once) would
      // re-read the receipt store on EVERY later pass; with it, later passes cost
      // only an in-memory suppressed-set hit.
      let errorWakeDelivered: boolean | undefined;
      if (needs.has("errorWakeDelivered")) {
        if (yield* dedup.alreadyHandled(childWakeCommandId(child.id, "recovered"))) continue;
        errorWakeDelivered = yield* dedup.wasDelivered(childWakeCommandId(child.id, "error"));
      }
      let inFlightTool: ProjectionInFlightTool | null | undefined;
      if (
        needs.has("inFlightTool") &&
        freshness !== undefined &&
        child.session !== null &&
        child.session.activeTurnId !== null
      ) {
        const quietMs = executingQuietMs(child, freshness, now);
        if (quietMs !== null && slowToolNoticeIndex(quietMs) >= 0)
          inFlightTool = yield* projectionSnapshotQuery.getInFlightToolByThreadId(
            child.id,
            child.session.activeTurnId,
          );
      }
      // Cheap process-health evidence for a due slow-tool notice, fetched ONLY
      // once a tool call is confirmed in flight (zero steady-state cost): the
      // monitor already samples the descendant tree every 5s, so this is a pure
      // read over retained samples for the child's provider subtree (matched by
      // its pi `--session-id` in the sampled command line). Optional dependency
      // (`serviceOption`): absent in tests / degrades to no evidence line when
      // the process is not locally observable (remote/SSH provider, exited, or
      // no samples yet).
      let processHealth: string | undefined;
      if (inFlightTool != null) {
        const monitor = yield* Effect.serviceOption(ProcessResourceMonitor);
        const activity = Option.isSome(monitor)
          ? yield* monitor.value.recentActivityFor(piSessionIdForThread(child.id))
          : null;
        processHealth = formatProcessHealthLine(activity);
      }

      // Phase 2 (§A.5): the whole decision — episode keys AND skip reasons — is
      // pure. The loop keeps only the effectful delivery tail below.
      const decision = classifyChildWakeFull(
        child,
        {
          freshness,
          inFlightTool,
          idleWakeDelivered,
          errorWakeDelivered,
          processHealth,
          provisionFailurePending: worktreeProvisioner.hasPendingProvisionFailure(child.id),
          waitingInGate,
        },
        now,
        pendingTurnStartThreadIds,
      );
      if ("skip" in decision) {
        // The two locally-suppressing skips (attention already-notified, done
        // never-errored) record the episode id with NO receipt behind it, so a
        // later cross-rail `wasDelivered` is not fooled — exactly what
        // `markSuppressed` exists for.
        if (decision.suppressEpisode !== undefined)
          yield* dedup.markSuppressed(childWakeCommandId(child.id, decision.suppressEpisode));
        continue;
      }

      const { kind, episode, context } = decision;
      const commandId = childWakeCommandId(child.id, episode);
      if (yield* dedup.alreadyHandled(commandId)) continue;

      // Two-tier redirect (design §4.2): `recovered` and `slow-tool` are FYI —
      // stash them into the per-parent digest instead of an immediate wake
      // (episode keys/receipts unchanged; explicitly exempt from losslessness).
      // A quiet-window/quiet-workstream flush or a piggyback delivers them.
      if (kind === "recovered" || kind === "slow-tool") {
        stashPending(pending, parent.id, {
          child,
          marker: commandId,
          kind,
          episode,
          ...(kind === "slow-tool"
            ? {
                slowTool: {
                  toolName: context?.toolName ?? "unknown",
                  inFlightMs: context?.inFlightMs ?? 0,
                  quietMs: context?.quietMs ?? 0,
                  ...(context?.processHealth !== undefined
                    ? { processHealth: context.processHealth }
                    : {}),
                },
              }
            : {}),
          // Recovered: stable durable event time. Slow-tool: anchor the age to
          // quiet ONSET (now - quietMs) so the quiet-window flush fires — the
          // child is in_progress, so the quiet-workstream condition never does.
          eventAtMs:
            kind === "recovered"
              ? parseIsoMs(child.lastOutcome?.at ?? child.updatedAt)
              : now - (context?.quietMs ?? 0),
        });
        continue;
      }

      // Busy parent → defer; a later thread.session-set re-triggers this pass.
      if (!isThreadIdle(parent, pendingTurnStartThreadIds)) continue;

      if (wakeBudget.wouldTrip(parent.id, now)) {
        yield* parkAndEscalate(parent, `child-wake:${child.id}`);
        // A park suppresses this command id locally with NO receipt behind it —
        // `wasDelivered` stays false for it, so a later cross-rail "was the parent
        // told?" (e.g. the recovery guard) is not fooled into firing.
        yield* dedup.markSuppressed(commandId);
        continue;
      }
      // Action-required wake: piggyback this parent's pending FYI digest (action
      // copy first, FYI after) and, on real delivery, write the digest items'
      // durable markers and clear them from the pending map so the standalone
      // flush and other action wakes never re-deliver them.
      const piggyback = yield* deliverablePending(pending.get(parent.id) ?? []);
      const digestText =
        piggyback.length === 0
          ? undefined
          : buildDigestPiggyback(
              ...(yield* renderPending(piggyback, threads).pipe(
                Effect.map((r) => [r.members, r.extras] as const),
              )),
            );
      // `deliverOnce` catches the busy-parent race (C2) exactly like the old
      // manual catch: a deferral records nothing and stays redeliverable.
      const outcome = yield* dedup.deliverOnce(
        commandId,
        deliverChildWake(parent, child, kind, commandId, context, digestText),
      );
      if (outcome === "delivered") {
        wakeBudget.recordDelivery(parent.id, now);
        for (const entry of piggyback) yield* recordDigestMarker(entry);
        pending.set(
          parent.id,
          (pending.get(parent.id) ?? []).filter(
            (entry) => !piggyback.some((done) => done.marker === entry.marker),
          ),
        );
      }
    }
  });

  // Gate traversal pass (review-gates design §4.3/§6): execute the loop legs
  // the decider's routing decided. Recomputed purely from shell state — an open
  // rework round (`target.pendingRework`) owes the target a rework resume with
  // the source's findings; a routed-back target (`lastOutcome.decision ===
  // "loop"`, round open on the source) owes the source a re-verify resume with
  // the target's round report. Deterministic command ids make redelivery
  // idempotent across crashes/restarts (the receipt is the durable "this leg
  // was resumed" marker). No `requireIdle`: the gate serialises its parties by
  // construction (exactly one is ever active), and a mid-loop parent prompt is
  // the parent's prerogative (last-write-wins, as with any steer).
  const routeGateTraversals = Effect.fn("routeGateTraversals")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const));

    for (const source of snapshot.threads) {
      const loopTo = gateLoopTargetOf(source);
      if (loopTo === null) continue;
      // A terminal source resolves/dissolves the gate (derived, not stored):
      // parent set_lane done/cancelled on the reviewer stops all traversal.
      if (source.planLane === "done" || source.planLane === "cancelled") continue;
      const target = threadsById.get(loopTo);
      // R4: a cancelled (or missing) loop target gets no traversal — the
      // waiting source's un-suppressed idle wake surfaces the dead gate.
      if (target === undefined || target.planLane === "cancelled") continue;

      // Site 3: `deliverOnce` only — no idle gate, no rate budget. The gate
      // serialises its parties by construction, so the dispatch passes straight
      // through; `deliverOnce` swallows nothing but the deferred error (which
      // these commands never raise), and a genuine dispatch failure still
      // propagates to the pass-level `catchCause`, exactly as before.
      if (target.pendingRework && source.lastOutcome?.decision === "loop") {
        // Rework leg: deliver the source's findings to the target, reopening a
        // round-0-completed (`done`) target atomically in the same transaction.
        // Guarded on the SOURCE having actually issued the round
        // (`lastOutcome.decision === "loop"`), not merely on the target's open
        // round: a replacement reviewer spawned over a coder whose
        // `pendingRework` lingered from a now-cancelled predecessor gate
        // (2026-07-07 incident) has `lastOutcome === null` and must NOT deliver
        // a rework leg "from" a reviewer that never reviewed. (The projector
        // also dissolves that residual round on the predecessor's cancel, so
        // this is defence-in-depth against any un-dissolved residue.)
        const commandId = gateCommandId(source.id, source.gateRounds, "rework");
        // Skip-check first so the report read + message build are only done when
        // a delivery is actually owed (mirrors the old ordering).
        if (yield* dedup.alreadyHandled(commandId)) continue;
        const report = yield* readReportFor(source);
        const messageId = MessageId.make(yield* crypto.randomUUIDv4);
        const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        yield* dedup.deliverOnce(
          commandId,
          orchestrationEngine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(commandId),
            threadId: target.id,
            message: {
              messageId,
              role: "user",
              origin: "control_notice",
              text: buildGateReworkMessage(source, source.gateRounds, report),
              attachments: [],
            },
            titleSeed: target.title,
            runtimeMode: target.runtimeMode,
            interactionMode: target.interactionMode,
            ...(target.planLane === "done" ? { reopen: true } : {}),
            createdAt: now,
          } satisfies OrchestrationCommand),
        );
      } else if (source.gateRounds > 0 && target.lastOutcome?.decision === "loop") {
        // Re-verify leg: the target routed its rework back; resume the source
        // (in_progress-idle, so a plain turn-start resumes it — no reopen).
        const commandId = gateCommandId(source.id, source.gateRounds, "reverify");
        if (yield* dedup.alreadyHandled(commandId)) continue;
        const report = yield* readReportFor(target);
        const messageId = MessageId.make(yield* crypto.randomUUIDv4);
        const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        yield* dedup.deliverOnce(
          commandId,
          orchestrationEngine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(commandId),
            threadId: source.id,
            message: {
              messageId,
              role: "user",
              origin: "control_notice",
              text: buildGateReverifyMessage(target, source.gateRounds, report),
              attachments: [],
            },
            titleSeed: source.title,
            runtimeMode: source.runtimeMode,
            interactionMode: source.interactionMode,
            createdAt: now,
          } satisfies OrchestrationCommand),
        );
      }
    }
  });

  // Yield rail (review-gates design §6): wake the parent of every `yielded`
  // child once per yield episode. Mirrors the per-child rail: deterministic
  // command id (receipt-deduped across restarts), `requireIdle`, and the shared
  // per-parent wake-rate budget. The child's lane is left untouched — clearing
  // `yielded` is the resume's job (any turn-start reverts it to `in_progress`).
  const wakeYieldedChildren = Effect.fn("wakeYieldedChildren")(function* (
    threads: ReadonlyArray<OrchestrationThreadShell>,
    threadsById: ReadonlyMap<ThreadId, OrchestrationThreadShell>,
    pending: PendingDigests,
  ) {
    const pendingTurnStartThreadIds = yield* projectionSnapshotQuery.getPendingTurnStartThreadIds();

    for (const child of threads) {
      if (child.parentThreadId === null || child.planLane !== "yielded") continue;
      // The lane is only ever set by a submit's routing decision, whose
      // transaction also records the outcome — so a yielded child always
      // carries `lastOutcome`. Guard anyway rather than crash the pass.
      if (child.lastOutcome == null) continue;
      const parent = threadsById.get(child.parentThreadId);
      if (parent === undefined) continue;

      const commandId = yieldWakeCommandId(child.id, child.lastOutcome.recordedByEventId);
      if (yield* dedup.alreadyHandled(commandId)) continue;

      // Busy parent → defer; a later thread.session-set re-triggers this pass.
      if (!isThreadIdle(parent, pendingTurnStartThreadIds)) continue;

      const now = yield* Clock.currentTimeMillis;
      if (wakeBudget.wouldTrip(parent.id, now)) {
        yield* parkAndEscalate(parent, `child-yield:${child.id}`);
        yield* dedup.markSuppressed(commandId);
        continue;
      }
      const report = yield* readReportFor(child);
      // Cap breach (design §4.3): the wake carries BOTH parties' latest reports
      // and the round count — the orchestrator decides without spelunking.
      let gateContext: YieldGateContext | undefined;
      if (child.lastOutcome.decision === "cap-breach") {
        const loopRoute = child.routes.find(
          (route) => route.kind === "loop" && route.to !== undefined,
        );
        const counterpart =
          loopRoute?.to !== undefined ? (threadsById.get(loopRoute.to) ?? null) : null;
        gateContext = {
          rounds: child.gateRounds,
          maxRounds: loopRoute?.maxRounds ?? DEFAULT_GATE_MAX_ROUNDS,
          counterpart:
            counterpart === null
              ? null
              : {
                  id: counterpart.id,
                  role: counterpart.role,
                  reportPath: counterpart.reportPath,
                  report: yield* readReportFor(counterpart),
                },
        };
      }
      const nowIso = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      // Piggyback this parent's pending FYI digest onto the yield wake (action
      // copy first, FYI after — design §5.3).
      const piggyback = yield* deliverablePending(pending.get(parent.id) ?? []);
      // Render the piggyback ONCE and feed the same members/extras to BOTH the
      // appended text and the payload, so the yield card represents exactly what
      // `yieldText` carries (no dropped piggyback items).
      const piggybackRendered =
        piggyback.length === 0
          ? { members: [], extras: [] }
          : yield* renderPending(piggyback, threads);
      const actionText = buildYieldWakeMessage(
        child,
        child.lastOutcome.outcome,
        report,
        gateContext,
      );
      const yieldText =
        piggyback.length === 0
          ? actionText
          : `${actionText}\n${buildDigestPiggyback(piggybackRendered.members, piggybackRendered.extras)}`;
      const outcome = yield* dedup.deliverOnce(
        commandId,
        orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(commandId),
          threadId: parent.id,
          message: {
            messageId: MessageId.make(yield* crypto.randomUUIDv4),
            role: "user",
            origin: "control_notice",
            controlPayload: buildYieldPayload(
              child,
              child.lastOutcome.outcome,
              report,
              gateContext,
              piggybackRendered,
            ),
            text: yieldText,
            attachments: [],
          },
          titleSeed: parent.title,
          runtimeMode: parent.runtimeMode,
          interactionMode: parent.interactionMode,
          requireIdle: true,
          createdAt: nowIso,
        } satisfies OrchestrationCommand),
      );
      if (outcome === "delivered") {
        wakeBudget.recordDelivery(parent.id, now);
        for (const entry of piggyback) yield* recordDigestMarker(entry);
        pending.set(
          parent.id,
          (pending.get(parent.id) ?? []).filter(
            (entry) => !piggyback.some((done) => done.marker === entry.marker),
          ),
        );
      }
    }
  });

  // Durable per-child "brief-needed notice delivered" marker (scaffold plan §2).
  // Appended to the CHILD under a `workstream.` kind (excluded from activity-
  // freshness), keyed by the eligibility episode so a re-entry on a fresh episode
  // re-arms. Written AFTER the wake (wake-before-markers), idempotent via the
  // deterministic id.
  const dispatchBriefNeededMarker = Effect.fn("dispatchBriefNeededMarker")(function* (
    child: OrchestrationThreadShell,
    commandId: string,
    sinceMs: number,
  ) {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(commandId),
      threadId: child.id,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "info",
        kind: "workstream.brief-needed",
        summary: "Brief-needed notice for this node delivered to the parent orchestrator.",
        payload: { parentId: child.parentThreadId, briefNeededSince: sinceMs },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    } satisfies OrchestrationCommand);
  });

  // Deliver the ONE batched brief-needed notice for a parent (scaffold plan §2).
  // `requireIdle` so a busy parent defers atomically at the command boundary
  // (fails without a receipt, retried next pass); the command id is a fresh
  // server uuid because cross-restart dedup is carried by the per-child episode
  // markers, not this id. Returns true only on real delivery.
  const deliverBriefNeededWake = Effect.fn("deliverBriefNeededWake")(function* (
    parent: OrchestrationThreadShell,
    children: ReadonlyArray<OrchestrationThreadShell>,
  ) {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    return yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: yield* serverCommandId("brief-needed"),
        threadId: parent.id,
        message: {
          messageId: MessageId.make(yield* crypto.randomUUIDv4),
          role: "user",
          origin: "control_notice",
          text: buildBriefNeededMessage(
            children.map((child) => ({
              id: child.id,
              graphKey: child.graphKey,
              role: child.role,
              title: child.title,
            })),
          ),
          attachments: [],
        },
        titleSeed: parent.title,
        runtimeMode: parent.runtimeMode,
        interactionMode: parent.interactionMode,
        requireIdle: true,
        createdAt: now,
      } satisfies OrchestrationCommand)
      .pipe(
        Effect.as(true),
        Effect.catchTag("OrchestrationCommandDeferredError", () => Effect.succeed(false)),
      );
  });

  // Brief-needed wake pass (scaffold plan §2): a batched action-required rail.
  // Collect EVERY child of a parent currently in the brief-needed state (deps-
  // satisfied + ready + unbriefed), deliver ONE idle-gated notice naming them
  // all, and write one durable receipt marker per included child only AFTER
  // delivery (wake-before-markers), keyed by eligibility episode. Batching is the
  // point: the per-child pattern would wake the parent, make it busy, then
  // serially re-wake it for each remaining node. Shares the per-parent wake-rate
  // budget with the other rails.
  const wakeBriefNeededChildren = Effect.fn("wakeBriefNeededChildren")(function* (
    threads: ReadonlyArray<OrchestrationThreadShell>,
    threadsById: ReadonlyMap<ThreadId, OrchestrationThreadShell>,
  ) {
    const pendingTurnStartThreadIds = yield* projectionSnapshotQuery.getPendingTurnStartThreadIds();
    const byParent = new Map<
      ThreadId,
      Array<{
        readonly child: OrchestrationThreadShell;
        readonly marker: string;
        readonly sinceMs: number;
      }>
    >();
    for (const child of threads) {
      if (child.parentThreadId === null) continue;
      if (!isBriefNeeded(child, threadsById)) continue;
      const sinceMs = briefNeededSinceMs(child, threadsById);
      const marker = briefNeededCommandId(child.id, sinceMs);
      // Already notified for this exact episode (durable receipt or local
      // suppression) → nothing owed for this child this episode.
      if (yield* dedup.alreadyHandled(marker)) continue;
      const list = byParent.get(child.parentThreadId);
      if (list) list.push({ child, marker, sinceMs });
      else byParent.set(child.parentThreadId, [{ child, marker, sinceMs }]);
    }
    for (const [parentId, entries] of byParent) {
      const parent = threadsById.get(parentId);
      if (parent === undefined) continue;
      // Busy parent → defer; a later thread.session-set re-triggers this pass.
      if (!isThreadIdle(parent, pendingTurnStartThreadIds)) continue;
      const now = yield* Clock.currentTimeMillis;
      if (wakeBudget.wouldTrip(parentId, now)) {
        yield* parkAndEscalate(parent, "brief-needed");
        for (const entry of entries) yield* dedup.markSuppressed(entry.marker);
        continue;
      }
      const delivered = yield* deliverBriefNeededWake(
        parent,
        entries.map((entry) => entry.child),
      );
      if (!delivered) continue;
      wakeBudget.recordDelivery(parentId, now);
      for (const entry of entries)
        yield* dedup.deliverOnce(
          entry.marker,
          dispatchBriefNeededMarker(entry.child, entry.marker, entry.sinceMs),
        );
    }
  });

  // Standalone digest flush (design §4.3, conditions 2 & 3): after the action
  // rails have had their piggyback chance, deliver each parent's still-pending
  // FYI items as their own digest turn-start when the workstream is quiet or the
  // oldest item has aged past `FYI_DIGEST_FLUSH_MS`. Wake-before-markers, rate-
  // guarded, `requireIdle`. Leftovers that neither flush nor piggyback simply
  // stay pending and are recomputed next pass.
  const flushPendingDigests = Effect.fn("flushPendingDigests")(function* (
    threads: ReadonlyArray<OrchestrationThreadShell>,
    threadsById: ReadonlyMap<ThreadId, OrchestrationThreadShell>,
    pending: PendingDigests,
  ) {
    const pendingTurnStartThreadIds = yield* projectionSnapshotQuery.getPendingTurnStartThreadIds();
    for (const [parentId, rawEntries] of pending) {
      const entries = yield* deliverablePending(rawEntries);
      if (entries.length === 0) continue;
      const parent = threadsById.get(parentId);
      if (parent === undefined) continue;
      const now = yield* Clock.currentTimeMillis;
      const quiet = parentWorkstreamQuiet(parentId, threads);
      if (
        !digestShouldFlush({
          oldestEventAtMs: oldestPendingMs(entries),
          now,
          quiet,
          flushMs: FYI_DIGEST_FLUSH_MS,
        })
      )
        continue;
      if (!isThreadIdle(parent, pendingTurnStartThreadIds)) continue;
      if (wakeBudget.wouldTrip(parentId, now)) {
        yield* parkAndEscalate(parent, "fyi-digest");
        for (const entry of entries) yield* dedup.markSuppressed(entry.marker);
        continue;
      }
      const delivered = yield* deliverStandaloneDigest(parent, entries, threads);
      if (!delivered) continue;
      wakeBudget.recordDelivery(parentId, now);
      for (const entry of entries) yield* recordDigestMarker(entry);
    }
  });

  // notify_thread deferred-delivery rail (D4). Patterned on the digest flush +
  // `deliverOnce` receipt-dedup: for each target with pending notifications, take
  // the OLDEST pending row and either expire it (target terminal/archived),
  // reconcile the crash window (`wasDelivered` = the deliver turn-start committed
  // but the mark never landed), or deliver it on idle (`requireIdle`) and mark it
  // delivered. Only the oldest per target is attempted per pass — the accepted
  // delivery makes the target busy, and its next `thread.session-set` re-runs the
  // pass for the next one (strict FIFO, one notification per target turn).
  const deliverPendingNotifications = Effect.fn("deliverPendingNotifications")(function* (
    threadsById: ReadonlyMap<ThreadId, OrchestrationThreadShell>,
  ) {
    const pending = yield* projectionSnapshotQuery.listPendingPeerMessages();
    const attemptedTargets = new Set<ThreadId>();
    for (const row of pending) {
      // Rows come oldest-first; skip a target once its oldest was handled so at
      // most one notify turn-start per target is ever in flight (review #3).
      if (attemptedTargets.has(row.targetThreadId)) continue;
      attemptedTargets.add(row.targetThreadId);
      const target = threadsById.get(row.targetThreadId);
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      // Terminal/archived target (archived threads are absent from the active
      // shell snapshot, so `undefined` here) -> expire: sticky-terminal holds
      // even for a queued message; the edge survives marked `expired`.
      if (
        target === undefined ||
        target.planLane === "done" ||
        target.planLane === "cancelled" ||
        target.archivedAt !== null
      ) {
        yield* orchestrationEngine.dispatch({
          type: "thread.peer-message.expire",
          commandId: CommandId.make(notifyExpireCommandId(row.recordId)),
          threadId: row.senderThreadId,
          recordId: row.recordId,
          createdAt: now,
        } satisfies OrchestrationCommand);
        continue;
      }
      const deliverId = notifyDeliverCommandId(row.recordId);
      // Crash-window reconciliation: the deliver turn-start committed (receipt
      // exists) but the mark never landed. Mark it delivered without re-
      // delivering (idempotent).
      if (yield* dedup.wasDelivered(deliverId)) {
        yield* orchestrationEngine.dispatch({
          type: "thread.peer-message.mark-delivered",
          commandId: CommandId.make(notifyMarkCommandId(row.recordId)),
          threadId: row.senderThreadId,
          recordId: row.recordId,
          createdAt: now,
        } satisfies OrchestrationCommand);
        continue;
      }
      // Deliver on idle. `requireIdle` defers a busy target atomically (no
      // receipt); `deliverOnce` reports that as `deferred` and records nothing,
      // so the deterministic id stays redeliverable on the target's next idle.
      const outcome = yield* dedup.deliverOnce(
        deliverId,
        orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(deliverId),
          threadId: target.id,
          message: {
            messageId: MessageId.make(yield* crypto.randomUUIDv4),
            role: "user",
            origin: "notify",
            text: row.framedMessage,
            attachments: [],
          },
          titleSeed: target.title,
          requireIdle: true,
          runtimeMode: target.runtimeMode,
          interactionMode: target.interactionMode,
          createdAt: now,
        } satisfies OrchestrationCommand),
      );
      if (outcome === "delivered") {
        yield* orchestrationEngine.dispatch({
          type: "thread.peer-message.mark-delivered",
          commandId: CommandId.make(notifyMarkCommandId(row.recordId)),
          threadId: row.senderThreadId,
          recordId: row.recordId,
          createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        } satisfies OrchestrationCommand);
      }
    }
  });

  // One dispatcher pass. The FYI-digest rails share a per-pass pending map
  // (rebuilt each pass, recomputable from lanes + receipts): the delta rail and
  // the per-child rail STASH FYI items into it, the action rails piggyback it
  // onto their wakes, and the final flush delivers any leftovers standalone.
  // Rails run serially on the drainable worker, so the plain mutable map needs
  // no synchronisation.
  const runPass = Effect.fn("runPass")(function* () {
    yield* promoteReadyThreads();
    yield* routeGateTraversals();
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const threads = snapshot.threads;
    const threadsById = new Map(threads.map((thread) => [thread.id, thread] as const));
    const pending: PendingDigests = new Map();
    yield* collectTerminalDeltas(threads, threadsById, pending);
    yield* wakeIdleAndErroredChildren(threads, threadsById, pending);
    yield* wakeYieldedChildren(threads, threadsById, pending);
    yield* wakeBriefNeededChildren(threads, threadsById);
    yield* flushPendingDigests(threads, threadsById, pending);
    yield* deliverPendingNotifications(threadsById);
  });

  const runPassSafely = runPass().pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logWarning("workstream dispatcher pass failed", {
        cause: Cause.pretty(cause),
      });
    }),
  );

  const worker = yield* makeDrainableWorker((_trigger: void) => runPassSafely);

  const start: WorkstreamDispatcherShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.created" ||
        // A child reaching a terminal lane (plan-lane-set) releases dependents
        // and makes it reportable via the delta rail; an `error`/`needs_guidance`
        // raise (attention-raised) surfaces a child needing a human. Both must
        // re-run the pass.
        event.type === "thread.plan-lane-set" ||
        event.type === "thread.attention-raised" ||
        // A submit's routing decision (review gates): drives the yield rail
        // (and, in Phase 3, the gate-traversal pass).
        event.type === "thread.outcome-recorded" ||
        event.type === "thread.route-taken" ||
        // A settled fan-in (`completed`/`conflicted`) can release dependents and
        // unblock a held terminal-child delta wake — re-run the pass immediately
        // instead of waiting for the periodic tick (review finding 2).
        event.type === "thread.fanin-set" ||
        event.type === "thread.dependencies-set" ||
        // Scaffold plan §2: attaching a brief makes a node dispatchable (drop it
        // from the brief-needed rail) and can complete/stale a sibling batch's
        // notice — re-run the pass so promotion + the brief-needed wake reconcile.
        event.type === "thread.kickoff-brief-set" ||
        // A failed/reconciled turn-start clears the durable pending-start row,
        // which can be the only thing keeping an otherwise-idle parent busy.
        event.type === "thread.turn-start-failed" ||
        // notify_thread: a fresh queue entry runs a pass promptly so the deferred-
        // delivery rail drains it even when the handler's immediate attempt found
        // the target busy (`thread.session-set` covers the drain-on-idle case).
        event.type === "thread.peer-message-recorded" ||
        // The parent going idle surfaces as a durable thread.session-set (no
        // turn-completion domain event exists); this drains deferred wakes.
        event.type === "thread.session-set"
          ? worker.enqueue()
          : Effect.void,
      ),
    );
    // Startup reconciliation pass (decision 4): streamDomainEvents has no replay,
    // so a child that went terminal before this reactor subscribed (e.g. a
    // restart mid-flight) would otherwise strand both downstream promotion and
    // the parent wake. Recompute eligibility from the read model and deliver.
    yield* worker.enqueue();
    // Scheduled re-pass (idle-wake grace): the subscriptions above are
    // event-driven, but a child that goes quiet and emits no further event would
    // never have its idle wake re-evaluated once the activity-freshness grace
    // (DEFAULT_IDLE_WAKE_GRACE_MS) elapses — the pass that observed it ran while
    // its activity was still fresh and correctly suppressed the wake. This
    // periodic tick re-runs the pass so a genuinely-idle child is still woken
    // once its grace passes. Passes are idempotent (receipt + handled-set dedup),
    // so the extra runs are harmless. Mirrors the liveness sweep's spaced
    // schedule.
    yield* Effect.forkScoped(
      worker
        .enqueue()
        .pipe(Effect.repeat(Schedule.spaced(Duration.millis(IDLE_WAKE_REPASS_INTERVAL_MS)))),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies WorkstreamDispatcherShape;
});

export const WorkstreamDispatcherLive = Layer.effect(WorkstreamDispatcher, make);
