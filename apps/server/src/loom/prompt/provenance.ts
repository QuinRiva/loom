// LOOM-ONLY. Who wrote each message a model reads, said in-band. Loom records
// authorship as server-stamped metadata (`createdBy`, `creationSource`,
// `scheduledTaskId`, `senderThreadId`, `loom.origin`, `loom.humanAuthored`); the
// pi adapter sends message text verbatim, so until the text itself says who
// wrote it the model cannot tell a parent's steer from the human's correction.
// This module is the one source of the label strings and the one derivation
// from metadata to label: the adapter calls `labelledForModel` on every turn
// and steer message it sends, so the label lands in pi's session (and so in
// consult forks, `forkFrom` children and the steer stash) without being stored
// on the message record the UI renders. Authoring doctrine:
// docs/architecture/prompt-surface-authoring.md.
//
// Scheme: a bare message is the human's. Every message that is NOT the human's
// carries a bracketed first line naming its author; the human's own messages are
// labelled only in a child thread (where every other message is an agent's or
// the control plane's, the human writes rarely, and the cost of confusing the
// two is highest). Origins that already frame themselves in their text — the
// control-plane marker, the notify wrapper, the consult question turn — are
// left alone, so no message carries two headers. Known gap: a slash command is
// always sent bare, so an agent-sent one (only `/compact`, which the adapter
// diverts before this) would read as the human's.

/** The author labels, each the first line of the message it heads. */
export const AUTHOR_LABELS = {
  /** A human-authored message in a thread that has a parent. */
  human: "[From the human]",
  /** `mcp__t3-code__workstream_prompt` and the dispatcher's kickoff, in a child. */
  parent: "[From your parent orchestrator (an agent)]",
  /** A root whose first message another agent wrote (`goal_handoff`, `goal_continue`). */
  agentRoot: (senderThreadId: string | undefined) =>
    `[Brief from another agent${senderThreadId === undefined ? "" : ` (thread ${senderThreadId})`}, not from the human]`,
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
 * The label a message carries, or null when it goes bare: the human's message
 * in a root, and the two origins whose text is already framed at composition
 * (`control_notice`, `notify`). Order matters: a scheduled fire is automation
 * whoever created the task; `humanAuthored` is the server's predicate and wins
 * over `createdBy`.
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
  if (origin === "orchestrator" || origin === "kickoff")
    return message.hasParent
      ? AUTHOR_LABELS.parent
      : AUTHOR_LABELS.agentRoot(message.senderThreadId);
  if (message.senderThreadId !== undefined) return AUTHOR_LABELS.agentRoot(message.senderThreadId);
  return UPSTREAM_RESUME_MESSAGE_ID.test(message.messageId)
    ? AUTHOR_LABELS.automatedResume
    : AUTHOR_LABELS.automation;
};

/**
 * The text the adapter sends: the label, a blank line, the message. A message
 * beginning with `/` is sent bare so pi's slash-command expansion still sees the
 * command first (its arguments are the rest of the text, so a trailing label is
 * not an option either); the only such messages are commands, and nearly all of
 * them are typed by the human.
 */
export const labelledForModel = (message: AuthoredMessage): string => {
  const label = authorLabel(message);
  return label === null || message.text.startsWith("/")
    ? message.text
    : `${label}\n\n${message.text}`;
};

/**
 * The FYI-digest line a parent gets when the human writes into one of its
 * children: one per human message, with a bounded excerpt. The excerpt is what
 * lets the parent avoid steering against an instruction it never saw.
 */
export const renderHumanInChildDigestLine = (input: {
  readonly role: string | null;
  readonly id: string;
  readonly timestamp: string;
  readonly excerpt: string;
}): string =>
  `- 🧑 The human wrote to ${input.role ?? "sub-thread"} \`${input.id}\`${input.timestamp === "" ? "" : ` _${input.timestamp}_`}: “${input.excerpt}” — what they said outranks your brief and your steers; read the full message before steering it again.`;

/**
 * Appended to `QUIESCENT_REPORT_HEADER` when the turn the quiet child ended was
 * started by the human: the parent otherwise reads the last message as the
 * child's own stopping point.
 */
export const QUIESCENT_HUMAN_STARTED_LINE =
  "> The turn it ended was started by a message from the human, which this file does not quote; read the thread before acting on it.";
