/**
 * loom: how a control-plane message renders (3d-3, seam 6).
 *
 * A Loom thread's transcript mixes what the human typed, what another thread
 * sent (a parent's steer, a kickoff brief, a `notify_thread` push) and what
 * the control plane injected (digests, yields, notices). The control payload
 * rides `message.loom.controlPayload` on the thread projection's message (the
 * turn item carries only the text), and is the card's source of truth; the
 * text stays the exact bytes the model received, behind "show raw payload".
 *
 * Fallback rule (DL-434): anything this module does not know — a payload
 * kind, a notice, an item kind added after this build — renders the
 * message's raw text as markdown instead of a card. Never throw on payload
 * shape: the text is always a faithful rendering.
 */
import type {
  ControlPayload,
  LoomControlItemKind,
  LoomControlNoticeKind,
  LoomMessageFields,
} from "@t3tools/contracts";

export type ControlChannel = "inter-thread" | "control-plane";

/** Tailwind classes per channel (upstream theme tokens only). */
export const CHANNEL_CLASSES: Record<
  ControlChannel,
  { card: string; hover: string; divider: string; kicker: string; chip: string }
> = {
  "inter-thread": {
    card: "border-info/25 bg-info/[0.06]",
    hover: "hover:bg-info/10",
    divider: "border-info/15",
    kicker: "text-info-foreground",
    chip: "border-info/30 bg-info/10 text-info-foreground",
  },
  "control-plane": {
    card: "border-success/25 bg-success/[0.06]",
    hover: "hover:bg-success/10",
    divider: "border-success/15",
    kicker: "text-success-foreground",
    chip: "border-success/30 bg-success/10 text-success-foreground",
  },
};

const NOTICE_LABELS: Record<LoomControlNoticeKind, string> = {
  "gate-rework": "Rework round",
  "gate-reverify": "Re-verify",
  "brief-needed": "Brief needed",
  deadlock: "Deadlock",
  "stall-nudge": "Stall nudge",
  attention: "Attention",
  notify: "Thread notification",
};

const ITEM_KIND_LABELS: Record<LoomControlItemKind, string> = {
  terminal: "finished",
  "gate-resolved": "gate resolved",
  recovered: "recovered",
  "slow-tool": "slow tool",
  spinning: "spinning",
  "dead-episode": "dead",
};

/** The synthesised-yield marker (seam 8's wording). */
export const SYNTHESISED_MARKER = "went quiet; report synthesised";

export interface ControlCardItem {
  readonly item: ControlPayload["items"][number];
  /** The item kind's label; null when the item carries no kind. */
  readonly kindLabel: string | null;
}

export type ControlCardModel =
  | {
      readonly kind: "card";
      readonly channel: ControlChannel;
      /** The kicker: what arrived. */
      readonly label: string;
      readonly summary: string;
      /** Present on a dispatcher-synthesised yield. */
      readonly marker: string | null;
      readonly items: ReadonlyArray<ControlCardItem>;
    }
  | { readonly kind: "raw"; readonly channel: ControlChannel; readonly label: string };

const has = <K extends string>(record: Record<K, string>, key: unknown): key is K =>
  typeof key === "string" && Object.hasOwn(record, key);

/**
 * The card for a message's Loom fields, or null when it is not a control
 * arrival at all (a human message, a kickoff or a steer keeps the bubble).
 */
export function controlCardModel(
  loom: LoomMessageFields | null | undefined,
  text: string,
): ControlCardModel | null {
  const payload = loom?.controlPayload;
  if (payload === undefined) {
    // A payload-less `notify` push or a bulky control notice still collapses.
    if (loom?.origin !== "notify" && loom?.origin !== "control_notice") return null;
    if (text.length <= 600 && text.split("\n").length <= 8) return null;
    return loom.origin === "notify"
      ? { kind: "raw", channel: "inter-thread", label: "Thread notification" }
      : { kind: "raw", channel: "control-plane", label: "Control plane" };
  }
  const raw = { kind: "raw", channel: "control-plane", label: "Control message" } as const;
  const items = payload.items ?? [];
  if (items.some((item) => item.kind !== undefined && !has(ITEM_KIND_LABELS, item.kind))) {
    return raw;
  }
  const cardItems = items.map((item) => ({
    item,
    kindLabel: item.kind === undefined ? null : ITEM_KIND_LABELS[item.kind],
  }));
  const summary = payload.heading ?? controlSummaryLine(text);
  switch (payload.kind) {
    case "digest":
      return {
        kind: "card",
        channel: "control-plane",
        label: "Digest",
        summary,
        marker: null,
        items: cardItems,
      };
    case "yield":
      return {
        kind: "card",
        channel: "control-plane",
        label: "Yield",
        summary,
        marker: payload.synthesised === true ? SYNTHESISED_MARKER : null,
        items: cardItems,
      };
    case "notice":
      return has(NOTICE_LABELS, payload.notice)
        ? {
            kind: "card",
            channel: payload.notice === "notify" ? "inter-thread" : "control-plane",
            label: NOTICE_LABELS[payload.notice],
            summary,
            marker: null,
            items: cardItems,
          }
        : raw;
    default:
      return raw;
  }
}

/**
 * The collapsed one-liner when a payload has no heading: the first line that
 * carries words, stripped of markdown punctuation, bounded.
 */
export function controlSummaryLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((candidate) => candidate.replace(/^\s*(?:[#>*-]+\s+|#{1,6}\s*)/, "").trim())
      .find((candidate) => /\w/.test(candidate))
      ?.replace(/[*`]/g, "") ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
