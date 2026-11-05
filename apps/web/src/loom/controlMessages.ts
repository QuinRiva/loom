/**
 * loom: how a control-plane message renders. Its payload rides `message.loom.controlPayload` (the
 * turn item carries only text) and is the card's source of truth; the text stays the exact bytes the
 * model received. Anything this module does not know (a payload, notice or item kind added later)
 * renders the raw text as markdown instead of a card; never throw on payload shape.
 */
import type { ControlChannel } from "@t3tools/client-runtime/state/loom/controlBubble";
import type {
  ControlPayload,
  LoomControlItemKind,
  LoomControlNoticeKind,
  LoomMessageFields,
} from "@t3tools/contracts";
import { InboxIcon, MessagesSquareIcon, type LucideIcon } from "lucide-react";

export type ControlSeverity = "neutral" | "warning" | "destructive";

/** Which channel a card or bubble came from: an icon plus a word, never a colour. */
export const CHANNEL_ICONS: Record<ControlChannel, { icon: LucideIcon; word: string }> = {
  "control-plane": { icon: InboxIcon, word: "Control plane" },
  "inter-thread": { icon: MessagesSquareIcon, word: "Thread" },
};

/** Colour says whether Carl must act: neutral unless he must (upstream theme tokens only). */
export const SEVERITY_CLASSES: Record<ControlSeverity, { border: string; text: string }> = {
  neutral: { border: "border-border/80", text: "text-muted-foreground" },
  warning: { border: "border-warning/50", text: "text-warning-foreground" },
  destructive: { border: "border-destructive/50", text: "text-destructive-foreground" },
};

const NOTICE_SEVERITY: Record<LoomControlNoticeKind, ControlSeverity> = {
  "gate-rework": "warning",
  "gate-reverify": "neutral",
  "brief-needed": "neutral",
  deadlock: "destructive",
  "stall-nudge": "neutral",
  attention: "warning",
  notify: "neutral",
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
      readonly severity: ControlSeverity;
      /** The kicker: what arrived. */
      readonly label: string;
      readonly summary: string;
      /** Present on a dispatcher-synthesised yield. */
      readonly marker: string | null;
      readonly items: ReadonlyArray<ControlCardItem>;
    }
  | {
      readonly kind: "raw";
      readonly channel: ControlChannel;
      readonly severity: ControlSeverity;
      readonly label: string;
    };

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
      ? { kind: "raw", channel: "inter-thread", severity: "neutral", label: "Thread notification" }
      : { kind: "raw", channel: "control-plane", severity: "neutral", label: "Control plane" };
  }
  const raw = {
    kind: "raw",
    channel: "control-plane",
    severity: "neutral",
    label: "Control message",
  } as const;
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
        severity: "neutral",
        label: "Digest",
        summary,
        marker: null,
        items: cardItems,
      };
    case "yield":
      return {
        kind: "card",
        channel: "control-plane",
        severity: "neutral",
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
            severity: NOTICE_SEVERITY[payload.notice],
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
