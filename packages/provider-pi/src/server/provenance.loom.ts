// LOOM-ONLY. In-band author labels: the pi adapter sends text verbatim and authorship lives only in
// metadata. `labelledForModel` runs on every turn and steer, so labels reach pi's session and forks
// without touching the stored record. Non-human messages get a bracketed author line (the human's
// only in a child thread); self-framed origins and slash commands (pi must expand them) stay bare.

/** The author labels, each the first line of the message it heads. */
export const AUTHOR_LABELS = {
  /** A human-authored message in a thread that has a parent. */
  human: "[From the human]",
  /** `mcp__t3-code__workstream_prompt` and the dispatcher's kickoff, in a child. */
  parent: "[From your parent orchestrator (an agent)]",
  /** A root whose first message another agent wrote (`goal_handoff`, `goal_continue`). */
  agentRoot: (senderThreadId: string) =>
    `[Brief from another agent (thread ${senderThreadId}), not from the human]`,
  /** A scheduled-task fire; `createdBy` on the message is the task's creator. */
  scheduledByHuman: "[Scheduled-task prompt, written earlier by the human]",
  scheduledByAgent: "[Scheduled-task prompt, written earlier by an agent]",
  /** Upstream's restart and usage-limit "Continue where you left off." */
  automatedResume: "[Automated resume by T3 Code, not from the human]",
  /** Anything else the server sent that no rule above names. */
  automation: "[Sent by automation, not from the human]",
} as const;

/** The metadata the label is derived from; every field is already on the message record. */
export interface AuthoredMessage {
  readonly messageId: string;
  readonly text: string;
  readonly createdBy: "user" | "agent" | "system";
  readonly creationSource: string;
  readonly scheduledTaskId?: string | undefined;
  readonly senderThreadId?: string | undefined;
  readonly loom?:
    | {
        readonly origin?: "kickoff" | "orchestrator" | "control_notice" | "notify" | undefined;
        readonly humanAuthored?: boolean | undefined;
      }
    | undefined;
  /** The receiving thread has a parent (it is a child). */
  readonly hasParent: boolean;
}

/**
 * Upstream's two resumes, by the message ids their senders give them: the restart continuation
 * (`message:restart-continuation:<runId>`) and the usage-limit resume (`limit-resume:…`). Loom's
 * own resumes are `control_notice`s, framed in their text.
 */
const UPSTREAM_RESUME_MESSAGE_ID = /^(message:restart-continuation:|limit-resume:)/;

/**
 * The label a message carries, or null when it goes bare (the human's in a root, `control_notice`,
 * `notify`). Order matters: a scheduled fire is automation whoever made the task, `humanAuthored`
 * beats `createdBy`, and a root kickoff with no sender is the server's own (`/handoff`, `/retro`).
 */
export const authorLabel = (message: AuthoredMessage): string | null => {
  const origin = message.loom?.origin;
  if (origin === "control_notice" || origin === "notify") return null;
  if (message.scheduledTaskId !== undefined)
    return message.createdBy === "user"
      ? AUTHOR_LABELS.scheduledByHuman
      : AUTHOR_LABELS.scheduledByAgent;
  // Every dispatched message carries the stamp; one without a `loom` field never passed the
  // orchestrator (an upstream fixture), so `createdBy` is all there is to go on.
  if (message.loom?.humanAuthored ?? message.createdBy === "user")
    return message.hasParent ? AUTHOR_LABELS.human : null;
  if ((origin === "orchestrator" || origin === "kickoff") && message.hasParent)
    return AUTHOR_LABELS.parent;
  if (message.senderThreadId !== undefined) return AUTHOR_LABELS.agentRoot(message.senderThreadId);
  return UPSTREAM_RESUME_MESSAGE_ID.test(message.messageId)
    ? AUTHOR_LABELS.automatedResume
    : AUTHOR_LABELS.automation;
};

/**
 * Text whose first token is a pi command or skill reference — `/compact`,
 * `/handoff …`, `/skill:review …` — as opposed to text that merely starts with
 * a path (`/home/x/y.ts is wrong`): a slash, a name with no further slash, then
 * the end or whitespace.
 */
export const isSlashCommand = (text: string): boolean => /^\/[^\s/]+(?:\s|$)/.test(text);

/**
 * The label, a blank line, then the message. A slash command goes bare so pi's expansion sees it
 * first (its arguments are the rest of the text, so no trailing label either).
 */
export const labelledForModel = (message: AuthoredMessage): string => {
  const label = authorLabel(message);
  return label === null || isSlashCommand(message.text)
    ? message.text
    : `${label}\n\n${message.text}`;
};
