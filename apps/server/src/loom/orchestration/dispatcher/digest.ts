/**
 * The FYI digest (V1 notice-coalescing design §4.2–§5.3), ported with logic
 * unchanged: terminal children, gate resolutions and informational advisories
 * are withheld into one per-parent digest delivered `start_if_idle` (or
 * piggybacked on the next decision-bearing wake). One traversal yields both the
 * model-visible text and the `controlPayload` items, so the two cannot drift.
 * Items carry the seam-6 `kind`: terminal | gate-resolved | recovered |
 * slow-tool | spinning | dead-episode.
 *
 * @module loom/orchestration/dispatcher/digest
 */
import type {
  ControlPayload,
  ControlPayloadItem,
  LoomControlItemKind,
  LoomThreadWorkstream,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";

import {
  boundedExcerpt,
  formatWakeTimestamp,
  groupBatchForWake,
  isResolvedSource,
  renderWakePair,
  renderWakeSingle,
  slowToolEstimateClause,
  WORKSTREAM_CONTROL_PLANE_MARKER,
  type WakeMember,
  type WorkstreamLane,
} from "./wakes.ts";

/**
 * Quiet-window flush: a parent's pending items flush once the oldest is older
 * than this — longer than intra-burst gaps, negligible against child durations.
 */
export const FYI_DIGEST_FLUSH_MS = 120_000;

/** A non-terminal digest entry: one pre-rendered line plus its card carriers. */
export interface DigestExtra {
  readonly kind: Exclude<LoomControlItemKind, "terminal" | "gate-resolved">;
  readonly line: string;
  readonly childId?: ThreadId;
  readonly role?: string | null;
}

const EXTRA_CARD: Record<DigestExtra["kind"], { readonly title: string; readonly icon: string }> = {
  recovered: { title: "Recovered", icon: "♻️" },
  "slow-tool": { title: "Still executing", icon: "⏳" },
  spinning: { title: "No visible progress", icon: "🌀" },
  "dead-episode": { title: "Control message failed", icon: "⚠️" },
};

/** One terminal member as a card item, mirroring the text section's icon, status and excerpt decision. */
const wakeMemberToPayloadItem = (member: WakeMember): ControlPayloadItem => {
  const resolved = isResolvedSource(member);
  const verdict = member.lastOutcome?.outcome ?? null;
  const attentionClause =
    member.attention.length > 0 ? ` · attention: ${member.attention.join(", ")}` : "";
  const base = resolved
    ? `Gate resolved${verdict !== null ? ` (${verdict})` : ""}`
    : member.outcome === "done"
      ? "Completed"
      : "Cancelled";
  const ts = formatWakeTimestamp(member.eventAt ?? null);
  const excerpt = boundedExcerpt(member.report);
  return {
    kind: resolved ? "gate-resolved" : "terminal",
    threadId: member.id,
    ...(member.role !== null ? { role: member.role } : {}),
    title: `${base}${attentionClause}`,
    status: resolved && verdict !== null ? verdict : member.outcome,
    icon: resolved ? "✅" : member.outcome === "done" ? "☑️" : "🚫",
    ...(member.reportPath !== null ? { reportPath: member.reportPath } : {}),
    ...(excerpt !== undefined ? { excerpt } : {}),
    ...(ts !== "" ? { timestamp: ts } : {}),
  };
};

/**
 * A resolved pair's target as a reference-only `terminal` item: only what the
 * pair text states about it (no excerpt, status or timestamp it never
 * received). The gate's resolution is the source's one `gate-resolved` item.
 */
const pairTargetToPayloadItem = (target: WakeMember): ControlPayloadItem => ({
  kind: "terminal",
  threadId: target.id,
  ...(target.role !== null ? { role: target.role } : {}),
  title: "Round report (verified by the gate)",
  ...(target.reportPath !== null ? { reportPath: target.reportPath } : {}),
});

/** An extra as a card item; its pre-rendered line is also its excerpt. */
const digestExtraToPayloadItem = (extra: DigestExtra): ControlPayloadItem => ({
  kind: extra.kind,
  ...(extra.childId !== undefined ? { threadId: extra.childId } : {}),
  ...(extra.role != null ? { role: extra.role } : {}),
  title: EXTRA_CARD[extra.kind].title,
  status: extra.kind,
  icon: EXTRA_CARD[extra.kind].icon,
  excerpt: extra.line.replace(/^-\s*/, "").trim(),
});

/** The one canonical traversal: resolved pairs, then singles, then extras, each as text and items. */
const digestBodyParts = (
  members: ReadonlyArray<WakeMember>,
  extras: ReadonlyArray<DigestExtra>,
): { readonly text: string; readonly items: ReadonlyArray<ControlPayloadItem> } => {
  const { pairs, singles } = groupBatchForWake(members);
  const sections = [
    ...pairs.map((pair) => ({
      text: renderWakePair(pair),
      items: [wakeMemberToPayloadItem(pair.source), pairTargetToPayloadItem(pair.target)],
    })),
    ...singles.map((single) => ({
      text: renderWakeSingle(single),
      items: [wakeMemberToPayloadItem(single)],
    })),
    ...extras.map((extra) => ({ text: extra.line, items: [digestExtraToPayloadItem(extra)] })),
  ];
  return {
    text: sections.map((section) => section.text).join("\n\n"),
    items: sections.flatMap((section) => section.items),
  };
};

const DIGEST_CLOSING =
  "No first-pass review is owed on gate-resolved items (their reviewers verified the work). Update your task tree / scoreboard, pull anything useful from the reports (follow-up work, findings worth acting on), and continue orchestrating. Unreviewed completions (marked ☑️) deserve the usual first look.";

// A digest of only extras must stay neutral: a slow-tool line is still in
// flight, a recovered line DID complete — so it claims neither.
const DIGEST_CLOSING_INFO_ONLY =
  "These are status notices, not completions to review — some items are still in flight, others already resolved themselves (e.g. an earlier `error` superseded by `done`, its dependents released). No first-pass review is owed; act only if a notice reads as genuinely wrong (e.g. a mis-scoped tool call).";

/** The standalone digest text a flush delivers as its own turn: marker, intro, items, closing. */
export const buildStandaloneDigest = (
  members: ReadonlyArray<WakeMember>,
  extras: ReadonlyArray<DigestExtra> = [],
): string => {
  const infoOnly = members.length === 0;
  return [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    infoOnly
      ? "FYI digest — status notices from the control plane since you last heard. Nothing below is blocked on you."
      : "FYI digest — the following items completed and were fully routed by the control plane since you last heard. Nothing below is blocked on you.",
    "",
    digestBodyParts(members, extras).text,
    "",
    infoOnly ? DIGEST_CLOSING_INFO_ONLY : DIGEST_CLOSING,
  ].join("\n");
};

/** The piggyback section appended AFTER a decision-bearing wake's own copy (the action leads). */
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
    digestBodyParts(members, extras).text,
    "",
    members.length === 0 ? DIGEST_CLOSING_INFO_ONLY : DIGEST_CLOSING,
  ].join("\n");

/** The digest's `controlPayload`: exactly the traversal's items under the heading the text leads with. */
export const buildDigestPayload = (
  members: ReadonlyArray<WakeMember>,
  extras: ReadonlyArray<DigestExtra> = [],
  opts: { readonly piggyback?: boolean } = {},
): ControlPayload => ({
  kind: "digest",
  heading: opts.piggyback
    ? "Also, FYI since you last heard (no action required)"
    : members.length === 0
      ? "FYI digest — status notices from the control plane since you last heard."
      : "FYI digest — the following items completed and were fully routed since you last heard.",
  items: [...digestBodyParts(members, extras).items],
});

/** The items a piggybacked digest adds to a yield payload (`yield.ts`). */
export const digestItems = (
  members: ReadonlyArray<WakeMember>,
  extras: ReadonlyArray<DigestExtra>,
): ReadonlyArray<ControlPayloadItem> => digestBodyParts(members, extras).items;

/** A `recovered` digest line: reference and timestamp, no excerpt (the child is done). */
export const renderRecoveredDigestLine = (child: {
  readonly id: ThreadId;
  readonly role: string | null;
  readonly reportPath: string | null;
  readonly eventAt: string | null;
}): string => {
  const ts = formatWakeTimestamp(child.eventAt);
  const ref = child.reportPath !== null ? ` — report: \`${child.reportPath}\`` : "";
  return `- ♻️ ${child.role ?? "sub-thread"} \`${child.id}\` recovered (earlier \`error\` superseded by \`done\`; dependents already released)${ref}.${ts === "" ? "" : ` _${ts}_`}`;
};

/** A `slow-tool` digest line: informational, no flag, no report. */
export const renderSlowToolDigestLine = (child: {
  readonly id: ThreadId;
  readonly role: string | null;
  readonly toolName: string;
  readonly inFlightMs: number;
  readonly quietMs: number;
  readonly estimateMs?: number | undefined;
}): string => {
  const mins = (ms: number) => Math.round(ms / 60_000);
  const clause = slowToolEstimateClause({
    estimateMs: child.estimateMs,
    inFlightMs: child.inFlightMs,
  });
  return `- ⏳ ${child.role ?? "sub-thread"} \`${child.id}\` still executing — long-running tool \`${child.toolName}\` in flight ~${mins(child.inFlightMs)} min, no agent-visible output ~${mins(child.quietMs)} min${clause ? ` (${clause})` : ""} (informational, not a hang; the control plane will not interrupt it).`;
};

/**
 * A `dead-episode` digest line: a `server:` control command was rejected, so
 * its episode is receipted dead and will not be retried — the parent is the
 * only actor left.
 */
export const renderDeadEpisodeDigestLine = (input: {
  readonly threadId: ThreadId;
  readonly commandId: string;
  readonly commandType: string;
  readonly error: string;
}): string =>
  `- ⚠️ \`${input.commandType}\` on \`${input.threadId}\` was rejected and will not be retried (\`${input.commandId}\`): ${input.error}`;

/**
 * Quiet-workstream flush condition: true when no child of the parent is in
 * progress or briefed-and-ready — nothing is running or about to, so the
 * parent's next move is due now. A ready child with no brief cannot start and
 * does not keep the workstream busy.
 */
export const parentWorkstreamQuiet = (
  parentId: ThreadId,
  children: ReadonlyArray<{
    readonly parentThreadId: ThreadId | null;
    readonly lane: WorkstreamLane;
    readonly kickoffBriefPath: string | null;
  }>,
): boolean =>
  !children.some(
    (child) =>
      child.parentThreadId === parentId &&
      (child.lane === "in_progress" || (child.lane === "ready" && child.kickoffBriefPath !== null)),
  );

/** Flush when the workstream is quiet or the oldest pending item has aged past `flushMs` (durable times, restart-safe). */
export const digestShouldFlush = (input: {
  readonly oldestEventAtMs: number | null;
  readonly now: number;
  readonly quiet: boolean;
  readonly flushMs: number;
}): boolean =>
  input.quiet ||
  (input.oldestEventAtMs !== null && input.now - input.oldestEventAtMs >= input.flushMs);

/**
 * A terminal child's episode for the digest: its `outcome-set` event (a reopen
 * and re-finish mints a fresh one), else its last submit, else a constant.
 */
export const terminalEpisodeKey = (
  child: Pick<LoomThreadWorkstream, "outcomeEventId" | "lastOutcome">,
): string => child.outcomeEventId ?? child.lastOutcome?.eventId ?? "terminal";

/** The digest's episode hash over its items' episode keys (order-independent), for `digestCommandId`. */
export const digestEpisodeHash = (episodeKeys: ReadonlyArray<string>): string =>
  NodeCrypto.createHash("sha256")
    .update([...episodeKeys].sort().join("|"))
    .digest("hex")
    .slice(0, 24);
