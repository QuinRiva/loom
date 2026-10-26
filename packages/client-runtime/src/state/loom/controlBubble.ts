/**
 * Who a Loom-originated message bubble speaks for. A kickoff, a steer or a short notice is another
 * thread or the control plane talking, never the human: every client labels it and gives it its
 * channel's accent instead of rendering it as the human's own message.
 */
import type { LoomMessageFields, LoomMessageOrigin } from "@t3tools/contracts";

export type ControlChannel = "inter-thread" | "control-plane";

export interface ControlBubble {
  readonly channel: ControlChannel;
  /** Who is talking: the bubble's kicker and accessible author, in place of "You". */
  readonly label: string;
}

export const KICKOFF_BUBBLE: ControlBubble = { channel: "inter-thread", label: "Kickoff brief" };

const BUBBLES: Record<LoomMessageOrigin, ControlBubble> = {
  kickoff: KICKOFF_BUBBLE,
  orchestrator: { channel: "inter-thread", label: "Orchestrator" },
  notify: { channel: "inter-thread", label: "Thread notification" },
  control_notice: { channel: "control-plane", label: "Control plane" },
};

/** The bubble for a message's Loom fields; null for a human's message. */
export const controlBubble = (loom: LoomMessageFields | null | undefined): ControlBubble | null =>
  loom?.origin === undefined ? null : BUBBLES[loom.origin];
