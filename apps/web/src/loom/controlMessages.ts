import { type MessageOrigin } from "@t3tools/contracts";

import { type ChatMessage } from "~/types";

/**
 * loom: how a control-plane-injected user message is presented in the timeline.
 *
 * A loom thread's transcript mixes three kinds of "user" message: what the human
 * typed, what another thread sent (a parent's steer, a spawn brief, a
 * `notify_thread` push), and what the control plane itself injected (completion
 * digests, yield hand-backs, gate resolutions). They read identically without
 * help, and the machinery ones carry the biggest payloads — so they are the ones
 * that bury the conversation.
 *
 * Two orthogonal decisions come out of the message's `origin`:
 *
 *  - **channel** — the colour accent. `inter-thread` (blue/info) is anything
 *    another thread authored; `control-plane` (emerald/success) is the server's
 *    own notices about this thread's subtree; a human message has no accent at
 *    all and keeps upstream's bubble untouched.
 *  - **payloadChannel** — whether the row may collapse to a one-line card. Only
 *    the payload-heavy arrivals (`control_notice`, `notify`) qualify, and only
 *    when the message is actually bulky. A kickoff brief and an orchestrator
 *    steer are short, actionable, and must stay readable at a glance, so they
 *    keep the bubble and only take the accent.
 */
export type ControlChannel = "inter-thread" | "control-plane";

export interface ControlMessagePresentation {
  readonly channel: ControlChannel;
  /** Short provenance label — the card kicker and the bubble's origin line. */
  readonly label: string;
  /** A channel whose arrivals carry payloads worth collapsing. */
  readonly payloadChannel: boolean;
}

const PRESENTATION: Record<Exclude<MessageOrigin, "human">, ControlMessagePresentation> = {
  kickoff: { channel: "inter-thread", label: "Kickoff brief", payloadChannel: false },
  orchestrator: { channel: "inter-thread", label: "Orchestrator", payloadChannel: false },
  notify: { channel: "inter-thread", label: "Thread notification", payloadChannel: true },
  control_notice: { channel: "control-plane", label: "Control plane", payloadChannel: true },
};

export function classifyControlMessage(
  message: Pick<ChatMessage, "origin">,
): ControlMessagePresentation | null {
  const origin = message.origin;
  return origin === undefined || origin === "human" ? null : PRESENTATION[origin];
}

/**
 * A control arrival becomes a card when it is structured, or when its body is
 * bulky enough that upstream's own user-message collapse would have kicked in
 * (`MAX_COLLAPSED_USER_MESSAGE_LENGTH`/`_LINES`). A three-word "rework round 2"
 * notice is not clutter, so it keeps the bubble and just takes the accent.
 */
export function isCardedControlMessage(
  message: Pick<ChatMessage, "origin" | "controlPayload" | "text">,
): boolean {
  if (classifyControlMessage(message)?.payloadChannel !== true) return false;
  return (
    message.controlPayload !== undefined ||
    message.text.length > 600 ||
    message.text.split("\n").length > 8
  );
}

/** Tailwind classes per channel. One place to retune the two accents. */
export const CHANNEL_CLASSES: Record<
  ControlChannel,
  { card: string; hover: string; divider: string; kicker: string; chip: string; bubble: string }
> = {
  "inter-thread": {
    card: "border-info/25 bg-info/[0.06]",
    hover: "hover:bg-info/10",
    divider: "border-info/15",
    kicker: "text-info-foreground",
    chip: "border-info/30 bg-info/10 text-info-foreground",
    bubble: "border border-info/30 bg-info/10 text-foreground",
  },
  "control-plane": {
    card: "border-success/25 bg-success/[0.06]",
    hover: "hover:bg-success/10",
    divider: "border-success/15",
    kicker: "text-success-foreground",
    chip: "border-success/30 bg-success/10 text-success-foreground",
    bubble: "border border-success/30 bg-success/10 text-foreground",
  },
};

/**
 * The collapsed one-liner for a control message with no structured payload: the
 * first line that carries words, stripped of the markdown that would otherwise
 * read as punctuation. Bounded, because the whole point of the card is that the
 * payload stays out of the timeline until asked for.
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
