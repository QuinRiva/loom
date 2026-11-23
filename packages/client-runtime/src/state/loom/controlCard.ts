/**
 * Which control-plane messages become cards and what each says, for web and phone alike. The
 * payload (`message.loom.controlPayload`) drives the card; the text stays the exact bytes the model
 * received. A payload, notice or item kind this does not know renders the raw text; never throw.
 */
import type {
  ControlPayload,
  LoomControlItemKind,
  LoomControlNoticeKind,
  LoomMessageFields,
} from "@t3tools/contracts";
import { fileBasename } from "@t3tools/shared/path";

import type { ControlChannel } from "./controlBubble.ts";

/** Colour says whether the human must act: neutral unless they must. */
export type ControlSeverity = "neutral" | "warning" | "destructive";

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

export interface ControlCardItem {
  readonly item: ControlPayload["items"][number];
  /** Kind and status as two facts ("Finished · done"), a snake_case status as words; null when neither. */
  readonly facts: string | null;
}

interface ControlCardHeader {
  readonly channel: ControlChannel;
  readonly severity: ControlSeverity;
  /** The kicker: what arrived. */
  readonly label: string;
  /** The collapsed one-liner. */
  readonly summary: string;
}

/** A `raw` card shows only the message itself when expanded: its shape is not one this knows. */
export type ControlCardModel =
  | (ControlCardHeader & { readonly kind: "card"; readonly items: ReadonlyArray<ControlCardItem> })
  | (ControlCardHeader & { readonly kind: "raw" });

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
  const raw = (channel: ControlChannel, label: string) =>
    ({
      kind: "raw",
      channel,
      severity: "neutral",
      label,
      summary: controlSummaryLine(text),
    }) as const;
  if (payload === undefined) {
    // A payload-less `notify` push or a bulky control notice still collapses.
    if (loom?.origin !== "notify" && loom?.origin !== "control_notice") return null;
    if (text.length <= 600 && text.split("\n").length <= 8) return null;
    return loom.origin === "notify"
      ? raw("inter-thread", "Thread notification")
      : raw("control-plane", "Control plane");
  }
  const items = payload.items ?? [];
  if (items.some((item) => item.kind !== undefined && !has(ITEM_KIND_LABELS, item.kind))) {
    return raw("control-plane", "Control message");
  }
  const cardItems = items.map((item) => {
    const facts = [item.kind && ITEM_KIND_LABELS[item.kind], item.status?.replaceAll("_", " ")]
      .filter(Boolean)
      .join(" · ");
    return { item, facts: facts ? facts.charAt(0).toUpperCase() + facts.slice(1) : null };
  });
  const summary = payload.heading ?? controlSummaryLine(text);
  switch (payload.kind) {
    case "digest":
      return {
        kind: "card",
        channel: "control-plane",
        severity: "neutral",
        label: "Digest",
        summary,
        items: cardItems,
      };
    case "yield":
      return {
        kind: "card",
        channel: "control-plane",
        severity: "neutral",
        label: "Yield",
        summary,
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
            items: cardItems,
          }
        : raw("control-plane", "Control message");
    default:
      return raw("control-plane", "Control message");
  }
}

/**
 * The collapsed one-liner when a payload has no heading: the first line that
 * carries words, stripped of markdown punctuation, bounded.
 */
function controlSummaryLine(text: string): string {
  const line =
    text
      .split("\n")
      .map((candidate) => candidate.replace(/^\s*(?:[#>*-]+\s+|#{1,6}\s*)/, "").trim())
      .find((candidate) => /\w/.test(candidate))
      ?.replace(/[*`]/g, "") ?? "";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

/**
 * A document chip's label: the file name, led by its folder when the name alone (`plan.mdx`,
 * `README.md`) says what kind of file, not which.
 */
export function controlDocumentLabel(path: string): string {
  const basename = fileBasename(path);
  return /^[A-Za-z]+\.\w+$/.test(basename)
    ? `${path.split("/").at(-2) ?? ""}/${basename}`.replace(/^\//, "")
    : basename;
}
