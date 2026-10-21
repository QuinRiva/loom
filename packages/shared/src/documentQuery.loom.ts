/**
 * loom: a query thread's first turn is ONE human message, the overlay then the first question
 * (plans/plan-query-threads/plan.mdx §7's fallback): a separate kickoff turn drew a reply of its
 * own before the question ran. The server joins the two here and the transcript splits them back,
 * so the overlay still renders as a kickoff bubble and the question as the human's, with no new
 * contract field. Only a query thread's question 1 carries the overlay, so the split keys on its id.
 */

const DIVIDER = "\n\n---\n\n";

/** The `<n>`th question's command id (1-based); its message id is `message:<this>`. */
export const documentQueryQuestionId = (threadId: string, n: number) =>
  `server:loom:query:${threadId}:${n}`;

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
