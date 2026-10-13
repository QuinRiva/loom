/**
 * The FYI digest (V1 notice-coalescing design §4.2–§5.3), ported with logic
 * unchanged: terminal children, gate resolutions and informational advisories
 * are withheld into one per-parent digest delivered `start_if_idle` (or
 * piggybacked on the next decision-bearing wake). One traversal yields both the
 * model-visible text and the `controlPayload` items, so the two cannot drift.
 * Items carry the seam-6 `kind`: terminal | gate-resolved | recovered |
 * slow-tool | spinning | dead-episode | human-message.
 *
 * @module loom/orchestration/dispatcher/digest
 */
import type {
  ControlPayload,
  ControlPayloadItem,
  LoomControlItemKind,
  LoomThreadWorkstream,
  MessageId,
  ThreadId,
} from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous digest; Effect's Crypto is effectful.
import * as NodeCrypto from "node:crypto";

import {
  formatWakeTimestamp,
  groupBatchForWake,
  isResolvedSource,
  renderWakePair,
  renderWakeSingle,
  reportItemFields,
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
  /** A `human-message` extra's message, carried onto its card item as the told-once key. */
  readonly messageId?: MessageId;
}

const EXTRA_CARD: Record<DigestExtra["kind"], { readonly title: string; readonly icon: string }> = {
  recovered: { title: "Recovered", icon: "♻️" },
  "slow-tool": { title: "Still executing", icon: "⏳" },
  spinning: { title: "No visible progress", icon: "🌀" },
  "dead-episode": { title: "Control message failed", icon: "⚠️" },
  "human-message": { title: "The human wrote to this child", icon: "🧑" },
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
  return {
    kind: resolved ? "gate-resolved" : "terminal",
    threadId: member.id,
    ...(member.role !== null ? { role: member.role } : {}),
    title: `${base}${attentionClause}`,
    status: resolved && verdict !== null ? verdict : member.outcome,
    icon: resolved ? "✅" : member.outcome === "done" ? "☑️" : "🚫",
    ...reportItemFields(member.reportPath, member.report),
    ...(ts !== "" ? { timestamp: ts } : {}),
  };
};

/**
 * A resolved pair's target as a reference-only `terminal` item: only what the
 * pair text states about it (no excerpt, status or timestamp it never
 * received), plus its report's document chips. The gate's resolution is the
 * source's one `gate-resolved` item.
 */
const pairTargetToPayloadItem = (target: WakeMember): ControlPayloadItem => {
  const { excerpt: _excerpt, ...fields } = reportItemFields(target.reportPath, target.report);
  return {
    kind: "terminal",
    threadId: target.id,
    ...(target.role !== null ? { role: target.role } : {}),
    title: "Round report (verified by the gate)",
    ...fields,
  };
};

/** An extra as a card item; its pre-rendered line is also its excerpt. */
const digestExtraToPayloadItem = (extra: DigestExtra): ControlPayloadItem => ({
  kind: extra.kind,
  ...(extra.childId !== undefined ? { threadId: extra.childId } : {}),
  ...(extra.role != null ? { role: extra.role } : {}),
  ...(extra.messageId !== undefined ? { messageId: extra.messageId } : {}),
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
  "No first-pass review is owed: these are status notices — some items still in flight, others already resolved themselves (e.g. an earlier `error` superseded by `done`, its dependents released) — so act only if one reads as genuinely wrong (e.g. a mis-scoped tool call).";

// The closing when the digest relays a human message into a child — alone when
// that is all it carries, else appended, so the status-notice closing above never
// reads as licence to ignore it.
const DIGEST_CLOSING_HUMAN_MESSAGE =
  "A 🧑 line above is not a status notice: what the human said now governs that child, so read it before you next steer that child.";

/** The closing for a digest: completion- or info-shaped, plus the human-message rider when one is relayed. */
const digestClosing = (
  members: ReadonlyArray<WakeMember>,
  extras: ReadonlyArray<DigestExtra>,
): string =>
  members.length === 0 && extras.every((extra) => extra.kind === "human-message")
    ? DIGEST_CLOSING_HUMAN_MESSAGE
    : [
        members.length === 0 ? DIGEST_CLOSING_INFO_ONLY : DIGEST_CLOSING,
        ...(extras.some((extra) => extra.kind === "human-message")
          ? [DIGEST_CLOSING_HUMAN_MESSAGE]
          : []),
      ].join(" ");

/** The standalone digest text a flush delivers as its own turn: marker, intro, items, closing. */
export const buildStandaloneDigest = (
  members: ReadonlyArray<WakeMember>,
  extras: ReadonlyArray<DigestExtra> = [],
): string =>
  [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    "FYI digest — thread updates since you last heard. Nothing below is blocked on you.",
    "",
    digestBodyParts(members, extras).text,
    "",
    digestClosing(members, extras),
  ].join("\n");

/** The piggyback section appended AFTER a decision-bearing wake's own copy (the action leads). */
export const buildDigestPiggyback = (
  members: ReadonlyArray<WakeMember>,
  extras: ReadonlyArray<DigestExtra> = [],
): string =>
  [
    "",
    "---",
    "",
    "**Also, FYI since you last heard:**",
    "",
    digestBodyParts(members, extras).text,
    "",
    digestClosing(members, extras),
  ].join("\n");

/** The digest's `controlPayload`: exactly the traversal's items under the heading the text leads with. */
export const buildDigestPayload = (
  members: ReadonlyArray<WakeMember>,
  extras: ReadonlyArray<DigestExtra> = [],
  opts: { readonly piggyback?: boolean } = {},
): ControlPayload => ({
  kind: "digest",
  heading: opts.piggyback
    ? "Also, FYI since you last heard"
    : "FYI digest — thread updates since you last heard.",
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
