import {
  type AttentionReason,
  CommandId,
  DEFAULT_GATE_MAX_ROUNDS,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type OrchestrationThreadShell,
  type ThreadId,
  type ThreadPlanLane,
} from "@t3tools/contracts";
import {
  gateLoopTargetOf,
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
import { readWorkstreamReport, readWorkstreamReportAt } from "../workstreamReport.ts";
import { areDependenciesSatisfied } from "@t3tools/shared/workstreamDependencies";
import { isThreadIdle } from "../threadIdle.ts";
import { WorktreeProvisioner } from "../../project/WorktreeProvisioner.ts";

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
 * Both gates (release + dependency) must clear, mirroring the two-gate start
 * model (design §3). Returns only threads that carry both `role` and `purpose`,
 * which are required to build the deferred kick-off prompt (spawn always sets
 * them).
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
      areDependenciesSatisfied(thread, threadsById),
  );
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
 * Pure parent wake-message builder (the wake-message contract): tells the parent
 * which of its sub-threads have reached a terminal plan lane SINCE IT WAS LAST
 * NOTIFIED — a delta, not the whole generation (role + id + lane + any attention
 * flags — the copy never claims a child "finished" beyond its actual lane), for
 * each a reference to its on-disk report plus a BOUNDED excerpt (never the full
 * report), and the instruction to review, decide what needs human escalation
 * vs. what it can act on / accept on the human's behalf, and continue
 * orchestrating (including accepting children that are awaiting acceptance).
 *
 * For conflicted fan-in (isolated child whose merge aborted) the block points
 * at the fan-in reactor's dedicated conflict notice (which carries the branch
 * names + conflict paths) and mirrors its recovery copy — it never invents a
 * paths-less warning or contradictory "re-open with set_lane" advice.
 */
export const buildParentWakeMessage = (
  children: ReadonlyArray<{
    readonly id: ThreadId;
    readonly role: string | null;
    readonly planLane: ThreadPlanLane;
    readonly attention: ReadonlyArray<AttentionReason>;
    readonly reportPath: string | null;
    readonly report: string | null;
    readonly fanInState?: string | null;
  }>,
): string => {
  const sections = children.map((child) => {
    const flags = child.attention.length > 0 ? ` (attention: ${child.attention.join(", ")})` : "";
    const header = `### ${child.role ?? "sub-thread"} \`${child.id}\` — ${child.planLane}${flags}`;
    const reference =
      child.reportPath !== null
        ? `Report reference: \`${child.reportPath}\` (read the full report on demand)`
        : "_No report was filed; status is the trigger, the report is best-effort context._";

    // Conflicted fan-in: the fan-in reactor already delivered a dedicated,
    // receipt-deduped conflict notice (coder id, both branches, conflict paths)
    // and raised `needs_guidance`. Here we only flag it and echo the reactor's
    // recovery copy — no fabricated "paths not yet available" line, no stale
    // "re-open with set_lane" advice that contradicts the reactor.
    const conflictNotice =
      child.fanInState === "conflicted"
        ? [
            "",
            "⚠️  **Fan-in merge conflict.** This child's branch could not be merged into your branch automatically — see the separate fan-in conflict notice for the branch names and conflicting paths.",
            "",
            "**Recovery:** merge the child's branch into your branch yourself (or reopen the coder to resolve the conflict in its worktree and resubmit). Once the branch is contained in your branch, the control plane completes the fan-in and releases its dependents automatically — no need to clear `blockedBy`.",
          ].join("\n")
        : "";

    return `${header}\n\n${reference}${formatReportExcerpt(child.report)}${conflictNotice}`;
  });
  return [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    "The following Workstream sub-thread(s) have reached terminal plan lanes (done/cancelled) since you were last notified. Results:",
    "",
    sections.join("\n\n"),
    "",
    "Review these results. Decide what (if anything) genuinely warrants human escalation versus what you can act on or accept on the human's behalf. For any child awaiting acceptance, you are the first-pass reviewer: either accept it (advance its plan to `done` with `workstream_set_lane`, which releases its dependents) or escalate to the human when human review is genuinely warranted. Then reconcile the task tree and continue orchestrating.",
  ].join("\n");
};

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
 * (`wakeEligibleParents`, which reports children that reached done/cancelled) —
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
    "Reviewer findings are claims, not verdicts: adjudicate each one — implement what survives scrutiny, reject the rest WITH REASONS in your round report (rejecting without reasons and implementing without evaluating are both failures). If the same finding comes back contested a second time, stop looping on it and say so in your report; the reviewer escalates it.",
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
      "), re-plan around it (spawn a replacement and `workstream_set_lane` cancelled on it), or escalate to the human.",
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
 * key still re-arms on `maxSequence`).
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
  /** `wasDelivered(idle:<maxSequence>)` — the attention idle-wake suppression guard. */
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
    // Idle keys on max activity sequence at idle onset (stable while idle → no
    // re-nag; a resumed-then-quiet child advances the sequence → re-arms).
    return { kind: "idle", episode: `idle:${freshness.maxSequence ?? "none"}` };
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
      },
    };
  }

  return { skip: "healthy" };
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
      `Informational notice: your Workstream sub-thread ${who} is still executing, but its current tool call \`${context?.toolName ?? "unknown"}\` has been in flight for ~${mins(context?.inFlightMs ?? 0)} min with no runtime activity for ~${mins(context?.quietMs ?? 0)} min.`,
      "",
      "Nothing has failed and no attention flag was raised. A long tool call is often legitimate (builds, installs, long pipelines) — but a quiet one can also be mis-scoped (e.g. an unscoped filesystem search). This needs your judgement; the control plane will not interrupt or kill it. Your options:",
      "",
      "- Let it run — you will be re-notified at increasing intervals while it stays quiet.",
      "- `workstream_prompt` the child to queue a steer (it is only seen once the current tool call returns — it cannot penetrate a blocked call).",
      "- `workstream_stop` the child to interrupt the stuck call, then `workstream_prompt` it to redirect.",
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
          ? `Your Workstream sub-thread ${who} went quiet without reporting: it finished its turn and is idle, but its plan lane is still in progress (it never advanced its plan or raised attention). It has been flagged \`needs_guidance\` so it surfaces for you.`
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

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;
  const worktreeProvisioner = yield* WorktreeProvisioner;

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

  const promoteThread = Effect.fn("promoteThread")(function* (thread: OrchestrationThreadShell) {
    const { role, purpose, brief } = thread;
    // Guaranteed non-null by selectThreadsToDispatch; this also narrows types.
    if (role === null || purpose === null) return;
    if (worktreeProvisioner.hasPendingProvisionFailure(thread.id)) return;
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
        text: workstreamChildPrompt({ role, brief: brief ?? purpose }),
        attachments: [],
      },
      titleSeed: thread.title,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      setInProgress: true,
      createdAt: now,
    } satisfies OrchestrationCommand);
  });

  const promoteReadyThreads = Effect.fn("promoteReadyThreads")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    for (const thread of selectThreadsToDispatch(snapshot.threads)) {
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
  const deliverWake = Effect.fn("deliverWake")(function* (
    parent: OrchestrationThreadShell,
    children: ReadonlyArray<OrchestrationThreadShell>,
  ) {
    const rendered = yield* Effect.forEach(children, (child) =>
      readReportFor(child).pipe(
        Effect.map((report) => ({
          id: child.id,
          role: child.role,
          planLane: child.planLane,
          attention: child.attention,
          reportPath: child.reportPath,
          report,
          fanInState: child.fanInState,
        })),
      ),
    );
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("delta-wake"),
      threadId: parent.id,
      message: {
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        role: "user",
        text: buildParentWakeMessage(rendered),
        attachments: [],
      },
      titleSeed: parent.title,
      runtimeMode: parent.runtimeMode,
      interactionMode: parent.interactionMode,
      requireIdle: true,
      createdAt: now,
    } satisfies OrchestrationCommand);
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
      childWakeCommandId(child.id, `idle:${freshness.maxSequence ?? "none"}`),
    );
  });

  // Delta-based terminal-child noticing: wake each parent about its terminal
  // (done/cancelled) children that it has NOT already been told about, batching
  // all newly-reportable children of one parent into ONE wake per pass
  // ("everything new since you last heard", promptly — not "everything, once the
  // whole generation ends"). Replaces the old all-members-terminal generation
  // barrier.
  const wakeEligibleParents = Effect.fn("wakeEligibleParents")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const threads = snapshot.threads;
    const threadsById = new Map(threads.map((thread) => [thread.id, thread] as const));

    // Build per-parent batches of newly-reportable terminal children.
    const batches = new Map<
      ThreadId,
      Array<{ child: OrchestrationThreadShell; episode: string; marker: string }>
    >();
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
      const batch = batches.get(child.parentThreadId);
      if (batch) batch.push({ child, episode, marker });
      else batches.set(child.parentThreadId, [{ child, episode, marker }]);
    }
    if (batches.size === 0) return;
    const pendingTurnStartThreadIds = yield* projectionSnapshotQuery.getPendingTurnStartThreadIds();

    for (const [parentId, members] of batches) {
      const parent = threadsById.get(parentId);
      // Parent absent (archived/deleted) → nothing to wake.
      if (parent === undefined) continue;
      // Busy parent → defer; a later thread.session-set (parent going idle)
      // re-triggers this pass. (The engine re-checks idleness atomically too.)
      if (!isThreadIdle(parent, pendingTurnStartThreadIds)) continue;

      const now = yield* Clock.currentTimeMillis;
      if (wakeBudget.wouldTrip(parentId, now)) {
        yield* parkAndEscalate(parent, "delta");
        for (const member of members) yield* dedup.markSuppressed(member.marker);
        continue;
      }
      // Wake-before-markers: deliver the batched wake, then write the durable
      // per-child markers. The delta wake keeps its bespoke shape (a random
      // command id, batched per parent) rather than routing through
      // `deliverOnce` — cross-restart dedup is carried by the per-child markers,
      // not this id. `requireIdle` makes the engine defer (no receipt) if the
      // parent became busy in the race window; treat that as not-yet-delivered so
      // the next idle drain retries with the same batch. Only count the wake +
      // write the markers on real delivery.
      const delivered = yield* deliverWake(
        parent,
        members.map((member) => member.child),
      ).pipe(
        Effect.as(true),
        Effect.catchTag("OrchestrationCommandDeferredError", () => Effect.succeed(false)),
      );
      if (!delivered) continue;
      wakeBudget.recordDelivery(parentId, now);
      // Each marker IS a receipt-bearing command, so record it through the module
      // (delivers + caches). The batch-build loop already established none are
      // handled, so every `deliverOnce` here dispatches.
      for (const member of members) {
        yield* dedup.deliverOnce(
          member.marker,
          dispatchChildReportedMarker(member.child, member.episode),
        );
      }
    }
  });

  // Deliver one per-child wake (§1e). Mirrors `deliverWake`: a deterministic
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
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(commandId),
      threadId: parent.id,
      message: {
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        role: "user",
        text: buildChildWakeMessage(child, kind, report, context),
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
  // terminal-child delta rail (`wakeEligibleParents`) could never carry. Shares
  // `wakeTimestamps` + `parkAndEscalate` so error/idle/recovery/terminal-delta
  // wakes draw on ONE rate budget per parent (C1).
  const wakeIdleAndErroredChildren = Effect.fn("wakeIdleAndErroredChildren")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const));
    const pendingTurnStartThreadIds = yield* projectionSnapshotQuery.getPendingTurnStartThreadIds();

    for (const child of snapshot.threads) {
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
            childWakeCommandId(child.id, `idle:${freshness?.maxSequence ?? "none"}`),
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

      // Phase 2 (§A.5): the whole decision — episode keys AND skip reasons — is
      // pure. The loop keeps only the effectful delivery tail below.
      const decision = classifyChildWakeFull(
        child,
        {
          freshness,
          inFlightTool,
          idleWakeDelivered,
          errorWakeDelivered,
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

      const commandId = childWakeCommandId(child.id, decision.episode);
      if (yield* dedup.alreadyHandled(commandId)) continue;

      // Busy parent → defer; a later thread.session-set re-triggers this pass.
      if (!isThreadIdle(parent, pendingTurnStartThreadIds)) continue;

      if (wakeBudget.wouldTrip(parent.id, now)) {
        yield* parkAndEscalate(
          parent,
          decision.kind === "recovered" ? `child-recovery:${child.id}` : `child-wake:${child.id}`,
        );
        // A park suppresses this command id locally with NO receipt behind it —
        // `wasDelivered` stays false for it, so a later cross-rail "was the parent
        // told?" (e.g. the recovery guard) is not fooled into firing.
        yield* dedup.markSuppressed(commandId);
        continue;
      }
      // `deliverOnce` catches the busy-parent race (C2) exactly like the old
      // manual catch: a deferral records nothing and stays redeliverable.
      const outcome = yield* dedup.deliverOnce(
        commandId,
        deliverChildWake(parent, child, decision.kind, commandId, decision.context),
      );
      if (outcome === "delivered") wakeBudget.recordDelivery(parent.id, now);
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
      if (target.pendingRework) {
        // Rework leg: deliver the source's findings to the target, reopening a
        // round-0-completed (`done`) target atomically in the same transaction.
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
  const wakeYieldedChildren = Effect.fn("wakeYieldedChildren")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const));
    const pendingTurnStartThreadIds = yield* projectionSnapshotQuery.getPendingTurnStartThreadIds();

    for (const child of snapshot.threads) {
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
      const outcome = yield* dedup.deliverOnce(
        commandId,
        orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(commandId),
          threadId: parent.id,
          message: {
            messageId: MessageId.make(yield* crypto.randomUUIDv4),
            role: "user",
            text: buildYieldWakeMessage(child, child.lastOutcome.outcome, report, gateContext),
            attachments: [],
          },
          titleSeed: parent.title,
          runtimeMode: parent.runtimeMode,
          interactionMode: parent.interactionMode,
          requireIdle: true,
          createdAt: nowIso,
        } satisfies OrchestrationCommand),
      );
      if (outcome === "delivered") wakeBudget.recordDelivery(parent.id, now);
    }
  });

  const runPassSafely = Effect.andThen(
    Effect.andThen(
      Effect.andThen(
        Effect.andThen(promoteReadyThreads(), routeGateTraversals()),
        wakeEligibleParents(),
      ),
      wakeIdleAndErroredChildren(),
    ),
    wakeYieldedChildren(),
  ).pipe(
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
        // A failed/reconciled turn-start clears the durable pending-start row,
        // which can be the only thing keeping an otherwise-idle parent busy.
        event.type === "thread.turn-start-failed" ||
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
