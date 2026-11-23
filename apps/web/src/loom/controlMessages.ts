/**
 * loom: how a control-plane card or bubble looks on web. Which messages become cards, and what
 * each says, is `controlCardModel` in client-runtime, shared with the phone.
 */
import type { ControlChannel } from "@t3tools/client-runtime/state/loom/controlBubble";
import type { ControlSeverity } from "@t3tools/client-runtime/state/loom/controlCard";
import { InboxIcon, MessagesSquareIcon, type LucideIcon } from "lucide-react";

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
