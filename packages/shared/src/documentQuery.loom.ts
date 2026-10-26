/**
 * loom: a query thread's first turn is ONE human message, overlay then first question (a
 * separate kickoff turn drew a reply of its own). The server joins them and the transcript
 * splits them back with no new contract field; only question 1 carries the overlay, so the
 * split keys on its id.
 */

const DIVIDER = "\n\n---\n\n";

/** The `<n>`th question's command id (1-based); its message id is `message:<this>`. */
export const documentQueryQuestionId = (threadId: string, n: number) =>
  `server:loom:query:${threadId}:${n}`;

/** A Promote turn's command id; its message id is `message:<this>`. */
export const documentQueryPromoteId = (threadId: string, key: string) =>
  `server:loom:query-promote:${threadId}:${key}`;

/** A Promote turn's own answer is the tool call's receipt, never an exchange to promote. */
export const isDocumentQueryPromoteMessage = (messageId: string) =>
  messageId.startsWith("message:server:loom:query-promote:");

const FIRST_QUESTION_MESSAGE = /^message:server:loom:query:.+:1$/;

export const joinDocumentQueryKickoff = (overlay: string, question: string) =>
  `${overlay}${DIVIDER}${question}`;

/** A query thread's first message as its overlay and question, or null for any other message. */
export function splitDocumentQueryKickoff(
  messageId: string,
  text: string,
): { readonly overlay: string; readonly question: string } | null {
  if (!FIRST_QUESTION_MESSAGE.test(messageId)) return null;
  const at = text.indexOf(DIVIDER);
  return at < 0 ? null : { overlay: text.slice(0, at), question: text.slice(at + DIVIDER.length) };
}
