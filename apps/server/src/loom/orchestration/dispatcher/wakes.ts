/**
 * Shared wake vocabulary for the dispatcher's composers, ported from V1 onto the Loom sidecar
 * (`LoomThreadWorkstream`). V1's plan lane is derived here (`workstreamLane`); fan-in and isolation
 * are gone (shared checkout only).
 */
import type {
  ControlPayloadItem,
  LoomAttentionReason,
  LoomGoalTask,
  LoomOutcome,
  ThreadId,
  WorkOutcomeRecord,
  WorkstreamRoute,
} from "@t3tools/contracts";
import { type StartNode, dependenciesSatisfied } from "@t3tools/shared/workstreamStart.loom";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { renderAnchorState } from "../../goals/goalTaskRender.ts";
import { reportResponse } from "../../workstream/report.ts";

/**
 * Leading line of every control message: wakes arrive as user-role turns, so
 * without it a parent cannot tell an automated notice from a human message.
 */
export const WORKSTREAM_CONTROL_PLANE_MARKER =
  "[T3 Workstream control plane: automated notice, not from the human]";

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
 * The inline report excerpt shared by every wake text (`reportResponse`):
 * empty when there is no report, else the response block or the head cut,
 * with a pointer to the reference when it was cut. Leads with a blank line so
 * callers append it directly after the reference.
 */
export const formatReportExcerpt = (report: string | null): string => {
  const response = responseOf(report);
  if (response === undefined) return "";
  return response.truncated
    ? `\n\n${response.text}\n\n_[excerpt truncated: read the full report via the reference above]_`
    : `\n\n${response.text}`;
};

const responseOf = (report: string | null | undefined) =>
  report == null || report.trim() === "" ? undefined : reportResponse(report);

/** The same excerpt un-framed, for a payload item — so a card and the text carry identical report content. */
const boundedExcerpt = (report: string | null | undefined): string | undefined =>
  responseOf(report)?.text;

// A backticked span or a markdown link target, in report order.
const REPORT_REFERENCE = /`([^`\n]+)`|\]\(\s*<?([^)\s>]+)/g;

/**
 * The `.md` / `.mdx` / `.html` paths a report names (backticked or link targets) for its card's
 * document chips, kept as written since the parent shares the child's workspace. Only paths with a
 * directory part count (a bare `plan.mdx` is a mention); URLs, `~`, globs, placeholders and files
 * in the workstream-reports directory are dropped.
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

/**
 * Formats an event time for prose a human or model reads as `2026-07-08 00:32 AEST`, in the
 * server's local zone (the human's clock, `date` and git all read local); `timeZone` pins it in
 * tests. Null/unparseable → "".
 */
export const formatWakeTimestamp = (iso: string | null, timeZone?: string): string => {
  if (iso === null) return "";
  const parsed = DateTime.make(iso);
  if (Option.isNone(parsed)) return "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-AU", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    })
      .formatToParts(DateTime.toEpochMillis(parsed.value))
      .map((part) => [part.type, part.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} ${p.timeZoneName}`;
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
  /** The child's live anchor task with its subtree, as the notice states it; absent when unanchored. */
  readonly anchor?: LoomGoalTask | null;
}

/** A resolved gate: the verdict-carrying source and the loop targets in the batch with it. */
export interface WakePair {
  readonly source: WakeMember;
  readonly targets: ReadonlyArray<WakeMember>;
}

/** A member whose last outcome resolved a gate (`clean` / `fixed_inline`). */
export const isResolvedSource = (member: WakeMember): boolean =>
  member.lastOutcome?.decision === "resolve";

/**
 * Partitions a parent's batch, order-preserving, into resolved gates and singles. A gate is a
 * member whose last outcome RESOLVED it plus every loop target of its also in the batch. A
 * force-dissolved gate is not grouped: that would fabricate a verdict and strip the targets of
 * their first-look excerpt.
 */
export const groupBatchForWake = (
  members: ReadonlyArray<WakeMember>,
): { readonly pairs: ReadonlyArray<WakePair>; readonly singles: ReadonlyArray<WakeMember> } => {
  const byId = new Map(members.map((member) => [member.id, member] as const));
  const claimed = new Set<ThreadId>();
  const pairs: WakePair[] = [];
  for (const member of members) {
    if (claimed.has(member.id) || !isResolvedSource(member)) continue;
    const targets = (member.routes ?? []).flatMap((route) => {
      const target =
        route.kind === "loop" && route.to !== undefined ? byId.get(route.to) : undefined;
      return target === undefined || claimed.has(target.id) ? [] : [target];
    });
    if (targets.length === 0) continue;
    pairs.push({ source: member, targets });
    claimed.add(member.id);
    for (const target of targets) claimed.add(target.id);
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

const anchorLine = (member: WakeMember): string =>
  member.anchor == null ? "" : renderAnchorState(member.anchor);

const roundsClause = (member: WakeMember): string => {
  const rounds = member.gateRounds ?? 0;
  return rounds > 0 ? ` (${rounds} rework round${rounds === 1 ? "" : "s"})` : "";
};

/**
 * Renders one resolved gate as a single section: the verdict, every party,
 * rounds used, released dependents, and one report reference each — an excerpt
 * only for the source's verdict report (each target's round report was already
 * verified by the gate).
 */
export const renderWakePair = (pair: WakePair): string => {
  const { source, targets } = pair;
  const verdict = source.lastOutcome?.outcome ?? "resolved";
  const parties = targets.map((target) => ` + ${target.role ?? "coder"} \`${target.id}\``).join("");
  const header = `### ✅ Gate resolved \`${verdict}\`: ${source.role ?? "reviewer"} \`${source.id}\`${parties}${roundsClause(source)}`;
  const meta = [timestampLine(source), releasedClause(source)]
    .filter((part) => part !== "")
    .join(" · ");
  const sourceRef =
    source.reportPath !== null
      ? `Verdict report: \`${source.reportPath}\`, excerpt:${formatReportExcerpt(source.report)}`
      : "_No verdict report was filed._";
  const targetRefs = targets.map((target) =>
    target.reportPath !== null
      ? `${target.role ?? "coder"} round report: \`${target.reportPath}\` (reference only; verified by the gate).`
      : `_No ${target.role ?? "coder"} round report was filed._`,
  );
  // A gate's parties may share one anchor; state each once.
  const anchored = [source, ...targets].filter(
    (member, i, all) => all.findIndex((other) => other.anchor?.id === member.anchor?.id) === i,
  );
  return [header, meta, ...anchored.map(anchorLine), "", sourceRef, "", ...targetRefs]
    .filter((part) => part !== "")
    .join("\n");
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
    const header = `### ✅ Gate resolved \`${verdict}\`: ${member.role ?? "reviewer"} \`${member.id}\`${roundsClause(member)}`;
    const reference =
      member.reportPath !== null
        ? `Verdict report: \`${member.reportPath}\`, excerpt:${formatReportExcerpt(member.report)}`
        : "_No verdict report was filed._";
    return [header, meta, anchorLine(member), "", reference]
      .filter((part) => part !== "")
      .join("\n");
  }
  const flags = member.attention.length > 0 ? ` (attention: ${member.attention.join(", ")})` : "";
  // An unreviewed completion is marked ☑️ so the closing can point at "the usual first look".
  const marker = member.outcome === "done" ? "☑️ " : "";
  const header = `### ${marker}${member.role ?? "sub-thread"} \`${member.id}\`: ${member.outcome}${flags}`;
  const reference =
    member.reportPath !== null
      ? `Report reference: \`${member.reportPath}\` (read the full report on demand)`
      : "_No report was filed; status is the trigger, the report is best-effort context._";
  return [header, meta, anchorLine(member), "", `${reference}${formatReportExcerpt(member.report)}`]
    .filter((part) => part !== "")
    .join("\n");
};

// Slow-tool ladder (informational; the notice joins the parent's FYI digest).

/** First notice after 5 min of quiet, again at 15 and 30, then every 30 min. */
const SLOW_TOOL_NOTICE_STEPS_MS: ReadonlyArray<number> = [300_000, 900_000, 1_800_000];
const SLOW_TOOL_NOTICE_REPEAT_MS = 1_800_000;
/** A declared estimate defers the ladder to `estimate × 1.2`. */
const SLOW_TOOL_DEFERRAL_BUFFER = 1.2;
/** Cap on an honoured estimate, so a child cannot self-silence indefinitely. */
const SLOW_TOOL_ESTIMATE_CAP_MS = 7_200_000;

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
    : `child estimated ~${estimateMinutes} min, not yet reached; the honoured estimate was capped at the ${capMinutes}-min safety ceiling`;
};

// Per-child notices (the attention rail's). V1's `idle` ("forgot to finish") is
// gone: the quiescence rail replaces it and reaches the parent as a synthesised
// yield (`yield.ts`); slow tools and recoveries are digest items (`digest.ts`).

/**
 * Composes a per-child notice: which child errored or paused, a reference to its report with a
 * bounded excerpt, and how the parent may proceed. An attention notice is a PAUSE notice: it never
 * says the child finished. `wedgedSince` (ISO) marks a `needs_guidance` the deferred-wake rail
 * raised on a child that reads busy but has been silent since then.
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
        ? `Your Workstream sub-thread ${who} looks wedged: it reads busy (it is still \`${child.lane}\`) yet has shown no activity since ${formatWakeTimestamp(wedgedSince)}, while control-plane notices wait on it undelivered. The control plane flagged it \`needs_guidance\` for that reason; neither a human nor the child raised it. It has NOT finished, and it is not working.`
        : `Your Workstream sub-thread ${who} is paused and needs attention: it carries the attention flag(s) ${flags} and is not executing, while it is still \`${child.lane}\`. It has NOT finished; this is a pause notice, not a result.`;
  const reference =
    child.reportPath !== null
      ? `Report reference: \`${child.reportPath}\` (read the full report on demand).`
      : "_No report was filed._";
  const tail =
    kind === "error"
      ? "Investigate via its report above (or `mcp__t3-code__consult_thread` for a read-only Q&A), then either set its outcome (`mcp__t3-code__workstream_set_outcome` done/cancelled) or re-dispatch it (`mcp__t3-code__workstream_prompt`). Its dependents stay gated until it reaches `done`; nothing was auto-cascaded."
      : wedgedSince !== undefined
        ? "Do not wait on it or treat its work as complete. A `mcp__t3-code__workstream_prompt` alone only queues behind the stuck turn. Close that turn with `mcp__t3-code__workstream_stop`, then `mcp__t3-code__workstream_prompt` it to resume; the prompt's turn also clears the flag. If the stop does not free it (it reports nothing was stopped, or the child stays silent after your prompt), cancel it (`mcp__t3-code__workstream_set_outcome` cancelled) and spawn a replacement for its work. A human has also been alerted on the board. Its dependents stay gated until it reaches `done`."
        : "Do not treat its work as complete. It is `needs_guidance` (a human stopped it, or it cannot proceed), so a human is in the loop: plan around the pause rather than resuming it yourself. Its dependents stay gated until it reaches `done`.";
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

/**
 * The one notice a parent gets for a child's held hand-back (`awaiting_acceptance`): what it holds,
 * the read against the brief, and the link that points the human at the child, who corrects and
 * approves it there.
 */
export const buildHeldHandbackMessage = (
  child: {
    readonly id: string;
    readonly role: string | null;
    readonly title: string;
    readonly reportPath: string | null;
  },
  report: string | null,
): string =>
  [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    `Your Workstream sub-thread ${child.role ?? "sub-thread"} \`${child.id}\` has finished its work and handed it back held \`awaiting_acceptance\`: a human must accept it before it is done, and its dependents stay gated until then.`,
    "",
    `Report reference: \`${child.reportPath}\` (read the full report on demand).${formatReportExcerpt(report)}`,
    "",
    `Read what it handed back against your brief. If something is plainly wrong, send it back with \`mcp__t3-code__workstream_prompt\`: it stays held and hands back again. Otherwise tell the human it is waiting for them, with this link: [${child.title}](t3-thread://v1/${child.id}). They correct and approve it in that thread, not in yours: you hear nothing of their rounds, and the ordinary finished notice when they approve. Setting it done yourself (\`mcp__t3-code__workstream_set_outcome\`) gives the human's word for them, so do it only when they have already given it to you.`,
  ].join("\n");
