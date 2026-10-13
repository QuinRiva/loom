/**
 * Shared wake vocabulary for the dispatcher's composers, ported from V1's
 * `WorkstreamDispatcher.ts` with logic unchanged and inputs retyped onto the
 * Loom sidecar (`LoomThreadWorkstream`). V1's plan lane is derived here
 * (`workstreamLane`); fan-in and isolation are gone (shared checkout only).
 *
 * @module loom/orchestration/dispatcher/wakes
 */
import type {
  ControlPayloadItem,
  LoomAttentionReason,
  LoomOutcome,
  ThreadId,
  WorkOutcomeRecord,
  WorkstreamRoute,
} from "@t3tools/contracts";
import { type StartNode, dependenciesSatisfied } from "@t3tools/shared/workstreamStart.loom";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/**
 * Maximum report characters embedded inline in a wake (P3-22: 400, down from
 * V1's 600). A wake carries a bounded excerpt plus the on-disk reference; the
 * parent reads the full report on demand.
 */
export const WAKE_REPORT_EXCERPT_LIMIT = 400;

/**
 * Leading line of every control message: wakes arrive as user-role turns, so
 * without it a parent cannot tell an automated notice from a human message.
 */
export const WORKSTREAM_CONTROL_PLANE_MARKER =
  "[T3 Workstream control plane — automated notice, not from the human]";

/** The board column a sidecar row sits in; V1's plan lane, derived (contract docstring on `LoomThreadWorkstream`). */
export type WorkstreamLane = "held" | "blocked" | "ready" | "in_progress" | LoomOutcome;

/** Derives a row's board column for wake copy and the quiet-workstream check; siblings must include archived rows (DL-211). */
export const workstreamLane = (
  node: StartNode,
  siblingsById: ReadonlyMap<ThreadId, StartNode>,
): WorkstreamLane =>
  node.outcome !== null
    ? node.outcome
    : node.held
      ? "held"
      : node.kickoffAt !== null
        ? "in_progress"
        : dependenciesSatisfied(node, siblingsById)
          ? "ready"
          : "blocked";

/**
 * Bounded inline report excerpt shared by every wake text: empty when there is
 * no report, the trimmed report when it fits, else a truncated prefix plus a
 * pointer to the reference. Leads with a blank line so callers append it
 * directly after the reference.
 */
export const formatReportExcerpt = (report: string | null): string => {
  const trimmed = report?.trim() ?? "";
  if (trimmed.length === 0) return "";
  return trimmed.length > WAKE_REPORT_EXCERPT_LIMIT
    ? `\n\n${trimmed.slice(0, WAKE_REPORT_EXCERPT_LIMIT)}…\n\n_[excerpt truncated — read the full report via the reference above]_`
    : `\n\n${trimmed}`;
};

/** The same excerpt un-framed, for a payload item — so a card and the text carry identical report content. */
export const boundedExcerpt = (report: string | null | undefined): string | undefined => {
  const trimmed = report?.trim() ?? "";
  if (trimmed.length === 0) return undefined;
  return trimmed.length > WAKE_REPORT_EXCERPT_LIMIT
    ? `${trimmed.slice(0, WAKE_REPORT_EXCERPT_LIMIT)}…`
    : trimmed;
};

// A backticked span or a markdown link target, in report order.
const REPORT_REFERENCE = /`([^`\n]+)`|\]\(\s*<?([^)\s>]+)/g;

/**
 * The `.md` / `.mdx` / `.html` files a report names — backticked paths and
 * markdown link targets — for its card item's document chips (the excerpt is
 * cut before the "Full review: …" line reports usually end with). Kept as
 * written: absolute, or relative to the child's workspace, which the parent
 * shares and the client resolves against. Only paths with a directory part: a
 * bare `AGENTS.md` / `plan.mdx` is a mention, not a hand-back. URLs, `~`,
 * globs and placeholders are dropped, as are files beside the report itself
 * (the workstream-reports directory: other threads' reports, never shown by name).
 */
const HANDBACK_DIR = /(?:^|\/)(?:\.artifacts|plans|recaps|workbench)\//;

export const reportDocuments = (report: string | null, reportPath: string | null): string[] => {
  const reportsDir = reportPath?.slice(0, reportPath.lastIndexOf("/") + 1);
  const paths = [...(report ?? "").matchAll(REPORT_REFERENCE)].flatMap(([, code, link]) => {
    const path = (code ?? link ?? "")
      .trim()
      .replace(/(?::\d+)+$|#.*$/, "")
      .replace(/^\.\//, "");
    return /^(?!~)[^\s*?<>{}[\]$|…]*\/[^\s*?<>{}[\]$|…/]+\.(?:mdx?|html)$/i.test(path) &&
      !/^[a-z][\w+.-]*:/i.test(path) &&
      !(reportsDir && path.startsWith(reportsDir))
      ? [path]
      : [];
  });
  // Hand-back folders first, so the plan/review a child produced is never behind "+n more"
  // when the report also cites repo files it edited (a stable sort keeps report order otherwise).
  return [...new Set(paths)].sort(
    (a, b) => Number(!HANDBACK_DIR.test(a)) - Number(!HANDBACK_DIR.test(b)),
  );
};

/** A card item's report carriers: the reference, the bounded excerpt and the named documents. */
export const reportItemFields = (
  reportPath: string | null,
  report: string | null,
): Pick<ControlPayloadItem, "reportPath" | "excerpt" | "documents"> => {
  const excerpt = boundedExcerpt(report);
  const documents = reportDocuments(report, reportPath);
  return {
    ...(reportPath !== null ? { reportPath } : {}),
    ...(excerpt !== undefined ? { excerpt } : {}),
    ...(documents.length > 0 ? { documents } : {}),
  };
};

/** Formats an event time for a rendered wake item as `2026-07-07 14:32Z`; null/unparseable → "". */
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

/** Age of a stalled episode for rungs ≥ 1: `6h`, `3d`. */
export const formatStalledFor = (ageMs: number): string =>
  ageMs >= 86_400_000
    ? `${Math.floor(ageMs / 86_400_000)}d`
    : `${Math.max(1, Math.floor(ageMs / 3_600_000))}h`;

/**
 * One terminal child as the digest sees it: status fields, the gate context the
 * pair grouper reads, the durable event time, and the dependents its `done`
 * released (omitted when none).
 */
export interface WakeMember {
  readonly id: ThreadId;
  readonly role: string | null;
  readonly outcome: LoomOutcome;
  readonly attention: ReadonlyArray<LoomAttentionReason>;
  readonly reportPath: string | null;
  readonly report: string | null;
  readonly lastOutcome?: WorkOutcomeRecord | null;
  readonly gateRounds?: number;
  readonly routes?: ReadonlyArray<WorkstreamRoute>;
  readonly eventAt?: string | null;
  readonly releasedDependents?: ReadonlyArray<{
    readonly id: ThreadId;
    readonly role: string | null;
  }>;
}

/** A resolved gate pair: the verdict-carrying source and its loop target. */
export interface WakePair {
  readonly source: WakeMember;
  readonly target: WakeMember;
}

const loopTargetOf = (member: WakeMember): ThreadId | null =>
  member.routes?.find((route) => route.kind === "loop" && route.to !== undefined)?.to ?? null;

/** A member whose last outcome resolved a gate (`clean` / `fixed_inline`). */
export const isResolvedSource = (member: WakeMember): boolean =>
  member.lastOutcome?.decision === "resolve";

/**
 * Partitions a parent's batch into resolved gate pairs and singles. A pair is a
 * member whose last outcome RESOLVED the gate and whose loop target is also in
 * the batch. A force-dissolved gate (a parent set the reviewer's outcome) is not
 * paired — that would fabricate a verdict and strip the target of its
 * first-look excerpt. Pure and order-preserving.
 */
export const groupBatchForWake = (
  members: ReadonlyArray<WakeMember>,
): { readonly pairs: ReadonlyArray<WakePair>; readonly singles: ReadonlyArray<WakeMember> } => {
  const byId = new Map(members.map((member) => [member.id, member] as const));
  const claimed = new Set<ThreadId>();
  const pairs: WakePair[] = [];
  for (const member of members) {
    if (claimed.has(member.id) || !isResolvedSource(member)) continue;
    const targetId = loopTargetOf(member);
    const target = targetId === null ? undefined : byId.get(targetId);
    if (target === undefined || claimed.has(target.id)) continue;
    pairs.push({ source: member, target });
    claimed.add(member.id);
    claimed.add(target.id);
  }
  return { pairs, singles: members.filter((member) => !claimed.has(member.id)) };
};

const timestampLine = (member: WakeMember): string => {
  const ts = formatWakeTimestamp(member.eventAt ?? null);
  return ts === "" ? "" : `_${ts}_`;
};

const releasedClause = (member: WakeMember): string => {
  const released = member.releasedDependents ?? [];
  return released.length === 0
    ? ""
    : `released: ${released.map((dep) => `${dep.role ?? "sub-thread"} \`${dep.id}\``).join(", ")}`;
};

const roundsClause = (member: WakeMember): string => {
  const rounds = member.gateRounds ?? 0;
  return rounds > 0 ? ` (${rounds} rework round${rounds === 1 ? "" : "s"})` : "";
};

/**
 * Renders one resolved gate pair as a single section: the verdict, both
 * parties, rounds used, released dependents, and one report reference each —
 * an excerpt only for the source's verdict report (the target's round report
 * was already verified by the gate).
 */
export const renderWakePair = (pair: WakePair): string => {
  const { source, target } = pair;
  const verdict = source.lastOutcome?.outcome ?? "resolved";
  const header = `### ✅ Gate resolved \`${verdict}\` — ${source.role ?? "reviewer"} \`${source.id}\` + ${target.role ?? "coder"} \`${target.id}\`${roundsClause(source)}`;
  const meta = [timestampLine(source), releasedClause(source)]
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
  return [header, meta, "", sourceRef, "", targetRef].filter((part) => part !== "").join("\n");
};

/**
 * Renders one non-paired terminal child. A resolved source whose target already
 * reported keeps its verdict header; every other child renders the plain status
 * section (role, id, outcome, attention, reference and bounded excerpt).
 */
export const renderWakeSingle = (member: WakeMember): string => {
  const meta = [timestampLine(member), releasedClause(member)]
    .filter((part) => part !== "")
    .join(" · ");
  if (isResolvedSource(member)) {
    const verdict = member.lastOutcome?.outcome ?? "resolved";
    const header = `### ✅ Gate resolved \`${verdict}\` — ${member.role ?? "reviewer"} \`${member.id}\`${roundsClause(member)}`;
    const reference =
      member.reportPath !== null
        ? `Verdict report: \`${member.reportPath}\` — excerpt:${formatReportExcerpt(member.report)}`
        : "_No verdict report was filed._";
    return [header, meta, "", reference].filter((part) => part !== "").join("\n");
  }
  const flags = member.attention.length > 0 ? ` (attention: ${member.attention.join(", ")})` : "";
  // An unreviewed completion is marked ☑️ so the closing can point at "the usual first look".
  const marker = member.outcome === "done" ? "☑️ " : "";
  const header = `### ${marker}${member.role ?? "sub-thread"} \`${member.id}\` — ${member.outcome}${flags}`;
  const reference =
    member.reportPath !== null
      ? `Report reference: \`${member.reportPath}\` (read the full report on demand)`
      : "_No report was filed; status is the trigger, the report is best-effort context._";
  return [header, meta, "", `${reference}${formatReportExcerpt(member.report)}`]
    .filter((part) => part !== "")
    .join("\n");
};

// ---------------------------------------------------------------------------
// Slow-tool ladder (informational; the notice joins the parent's FYI digest).
// ---------------------------------------------------------------------------

/** First notice after 5 min of quiet, again at 15 and 30, then every 30 min. */
const SLOW_TOOL_NOTICE_STEPS_MS: ReadonlyArray<number> = [300_000, 900_000, 1_800_000];
const SLOW_TOOL_NOTICE_REPEAT_MS = 1_800_000;
/** A declared estimate defers the ladder to `estimate × 1.2`. */
const SLOW_TOOL_DEFERRAL_BUFFER = 1.2;
/** Cap on an honoured estimate, so a child cannot self-silence indefinitely. */
export const SLOW_TOOL_ESTIMATE_CAP_MS = 7_200_000;

/**
 * Parses an intentional `# eta: <n>[m|h]` shell-comment marker from a command
 * (the `#` keeps incidental text like `echo eta 90m` out); ms, or null.
 */
export const parseEtaMarkerMs = (commandText: string | null | undefined): number | null => {
  if (commandText === null || commandText === undefined) return null;
  const match = /#\s*eta\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)?/i.exec(
    commandText,
  );
  if (match === null) return null;
  const value = Number.parseFloat(match[1]!);
  if (!Number.isFinite(value) || value <= 0) return null;
  const isHours = (match[2] ?? "m").toLowerCase().startsWith("h");
  return Math.round(value * (isHours ? 3_600_000 : 60_000));
};

/** The declared duration of an in-flight call: the `# eta` marker, else the bash `timeout` (s); null when undeclared. */
export const declaredEstimateMs = (input: {
  readonly commandText: string | null | undefined;
  readonly timeoutSeconds: number | null | undefined;
}): number | null => {
  const eta = parseEtaMarkerMs(input.commandText);
  if (eta !== null) return eta;
  const timeout = input.timeoutSeconds;
  return timeout !== null && timeout !== undefined && Number.isFinite(timeout) && timeout > 0
    ? Math.round(timeout * 1_000)
    : null;
};

/** The quiet duration below which slow-tool notices are deferred: 5 min, or `max(5 min, capped estimate × 1.2)`. */
export const slowToolDeferralMs = (estimateMs: number | null): number => {
  const first = SLOW_TOOL_NOTICE_STEPS_MS[0]!;
  return estimateMs === null
    ? first
    : Math.max(first, Math.min(estimateMs, SLOW_TOOL_ESTIMATE_CAP_MS) * SLOW_TOOL_DEFERRAL_BUFFER);
};

/**
 * The highest ladder step this quiet duration has crossed (0-based; -1 below
 * the first). `deferralMs` shifts the whole ladder later, preserving spacing;
 * the step keys the notice's episode so each fires at most once per call.
 */
export const slowToolNoticeIndex = (
  quietMs: number,
  deferralMs: number = SLOW_TOOL_NOTICE_STEPS_MS[0]!,
): number => {
  const first = SLOW_TOOL_NOTICE_STEPS_MS[0]!;
  const adjusted = quietMs - (deferralMs - first);
  const last = SLOW_TOOL_NOTICE_STEPS_MS[SLOW_TOOL_NOTICE_STEPS_MS.length - 1]!;
  return adjusted >= last
    ? SLOW_TOOL_NOTICE_STEPS_MS.length -
        1 +
        Math.floor((adjusted - last) / SLOW_TOOL_NOTICE_REPEAT_MS)
    : SLOW_TOOL_NOTICE_STEPS_MS.filter((step) => adjusted >= step).length - 1;
};

/**
 * The honest estimate clause for a slow-tool line: an overrun only once the
 * call has run at least as long as the estimate (exact ms); otherwise the early
 * notice is the 2 h cap on the estimate. Null when undeclared.
 */
export const slowToolEstimateClause = (input: {
  readonly estimateMs: number | undefined;
  readonly inFlightMs: number;
}): string | null => {
  if (input.estimateMs === undefined) return null;
  const estimateMinutes = Math.round(input.estimateMs / 60_000);
  const capMinutes = Math.round(SLOW_TOOL_ESTIMATE_CAP_MS / 60_000);
  return input.inFlightMs >= input.estimateMs
    ? `child estimated ~${estimateMinutes} min, now overrun`
    : `child estimated ~${estimateMinutes} min, not yet reached — the honoured estimate was capped at the ${capMinutes}-min safety ceiling`;
};

// ---------------------------------------------------------------------------
// Per-child notices (the attention rail's). V1's `idle` ("forgot to finish") is
// gone: the quiescence rail replaces it and reaches the parent as a synthesised
// yield (`yield.ts`); slow tools and recoveries are digest items (`digest.ts`).
// ---------------------------------------------------------------------------

/**
 * Composes a per-child notice: which child errored or paused, a reference to
 * its report with a bounded excerpt, and how the parent may proceed. An
 * attention notice is a PAUSE notice — it never says the child finished.
 * `wedgedSince` (ISO) marks a `needs_guidance` the deferred-wake rail raised on
 * a child that reads busy but has been silent since then (#312).
 */
export const buildChildWakeMessage = (
  child: {
    readonly id: ThreadId;
    readonly role: string | null;
    readonly lane: WorkstreamLane;
    readonly attention: ReadonlyArray<LoomAttentionReason>;
    readonly reportPath: string | null;
  },
  kind: "error" | "attention",
  report: string | null,
  wedgedSince?: string,
): string => {
  const who = `${child.role ?? "sub-thread"} \`${child.id}\``;
  const flags = `\`${child.attention.join("`, `")}\``;
  const lead =
    kind === "error"
      ? `Your Workstream sub-thread ${who} raised an \`error\` attention flag (the liveness sweep detected it dead, stalled, looping, or repeatedly failing) and did not report success.`
      : wedgedSince !== undefined
        ? `Your Workstream sub-thread ${who} looks wedged: it reads busy (it is still \`${child.lane}\`) yet has shown no activity since ${formatWakeTimestamp(wedgedSince)}, while control-plane notices wait on it undelivered. The control plane flagged it \`needs_guidance\` for that reason — neither a human nor the child raised it. It has NOT finished, and it is not working.`
        : `Your Workstream sub-thread ${who} is paused and needs attention: it carries the attention flag(s) ${flags} and is not executing, while it is still \`${child.lane}\`. It has NOT finished — this is a pause notice, not a result.`;
  const reference =
    child.reportPath !== null
      ? `Report reference: \`${child.reportPath}\` (read the full report on demand).`
      : "_No report was filed._";
  const tail =
    kind === "error"
      ? "Investigate via its report above (or `mcp__t3-code__consult_thread` for a read-only Q&A), then either set its outcome (`mcp__t3-code__workstream_set_outcome` done/cancelled) or re-dispatch it (`mcp__t3-code__workstream_prompt`). Its dependents stay gated until it reaches `done`; nothing was auto-cascaded."
      : wedgedSince !== undefined
        ? "Do not wait on it or treat its work as complete. A `mcp__t3-code__workstream_prompt` alone only queues behind the stuck turn. Close that turn with `mcp__t3-code__workstream_stop`, then `mcp__t3-code__workstream_prompt` it to resume — the prompt's turn also clears the flag. If the stop does not free it (it reports nothing was stopped, or the child stays silent after your prompt), cancel it (`mcp__t3-code__workstream_set_outcome` cancelled) and spawn a replacement for its work. A human has also been alerted on the board. Its dependents stay gated until it reaches `done`."
        : "Do not treat its work as complete. If it is `awaiting_acceptance`, it stopped short of `done` on purpose because a human's word is owed on its output: accepting it yourself (`mcp__t3-code__workstream_set_outcome` done, which releases its dependents) IS giving that word, so do it only when you already hold the human's decision — otherwise leave the flag standing, put the decision to the human, and let the branch wait. If it is `needs_guidance` (e.g. a human stopped it, or it cannot proceed), a human is in the loop — plan around the pause rather than resuming it yourself. Its dependents stay gated until it reaches `done`.";
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
