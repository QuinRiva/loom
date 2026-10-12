// LOOM-ONLY. The digest and report lines that name a human author. The author labels the
// pi adapter prepends to every message live with the adapter, in
// `@t3tools/provider-pi/server/loom` (provenance.loom.ts).

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
