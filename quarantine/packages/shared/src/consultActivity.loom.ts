/**
 * loom: the `consult_thread` exchange, as it crosses the wire.
 *
 * A consult is a conversation between two threads: this thread's question and
 * the other thread's answer are the content, and the timeline renders them as
 * a card rather than a tool row. Neither survives upstream's activity payload
 * projection, which keeps only the fields a generic tool row reads and drops
 * the rest (`ActivityPayloadProjection.projectActivityPayload`) — so the card
 * needs a carve-out, exactly as `projectQuestionToolInput` is one for the
 * question tool.
 *
 * The projection happens server-side and ships this small object rather than
 * the raw result: the wire carries the six fields the card renders and nothing
 * else (answers average ~4 KB, far less than the messages already shipped).
 */

/** Where a consult got to. `unresolved` = the name matched several threads. */
export type ConsultStatus = "pending" | "answered" | "unresolved" | "failed";

export interface ConsultActivityFields {
  status: ConsultStatus;
  /** The consulted thread, when the call resolved to one. */
  targetThreadId: string | null;
  /** Title stamped into the result; the client resolves the live one from the id. */
  targetTitle: string | null;
  question: string | null;
  /** The oracle's reply — only ever set on an `answered` consult. */
  answer: string | null;
  /** Why an unresolved or failed consult returned no answer (candidates, error). */
  note: string | null;
}

const CONSULT_TOOL_NAME = "consult_thread";
const STATUSES = new Set<string>(["pending", "answered", "unresolved", "failed"]);

/**
 * Server side: the consult fields worth putting on the wire, or `{}` for any
 * other tool. `toolName` is the activity's own tool name — the payload title
 * where the provider set one, else the activity summary, which older rows are
 * the only carrier of. The lifecycle's `"consult_thread started"` marker (an
 * empty payload the timeline already hides) is not a consult and must not
 * become a second card.
 *
 * Idempotent, because the payload is projected twice on the way out (the
 * snapshot builder projects each row, then the wire projection runs over the
 * result): a second pass sees its own output, whose raw `details`/`rawInput`
 * are gone, so it must hand back what the first pass derived rather than
 * re-deriving an empty consult from it.
 */
export function projectConsultToolFields(
  data: Record<string, unknown>,
  toolName: unknown,
): { consult?: ConsultActivityFields } {
  const projected = readConsultActivityFields(data);
  if (projected) return { consult: projected };
  if (toolName !== CONSULT_TOOL_NAME) return {};
  const details = asRecord(data.details);
  const input = asRecord(data.rawInput);
  const resolved = details?.resolved;
  const status: ConsultStatus =
    details === null
      ? "pending"
      : resolved === true
        ? "answered"
        : resolved === false
          ? "unresolved"
          : "failed";
  return {
    consult: {
      status,
      targetThreadId: asTrimmedString(details?.threadId) ?? asTrimmedString(input?.threadId),
      targetTitle: asTrimmedString(details?.title),
      question: asTrimmedString(input?.question),
      answer: status === "answered" && typeof details?.answer === "string" ? details.answer : null,
      note:
        status === "answered" || status === "pending"
          ? null
          : // The tool's own content text is the best note there is: for an
            // ambiguous name it lists the candidate threads, for a failure it
            // says what broke ("Timed out waiting for the fork to answer.").
            (firstContentText(data) ?? asTrimmedString(asRecord(details?.response)?.message)),
    },
  };
}

/** Client side: the consult a projected activity payload's `data` carries. */
export function readConsultActivityFields(
  data: Record<string, unknown> | null,
): ConsultActivityFields | null {
  const consult = asRecord(data?.consult);
  return consult && typeof consult.status === "string" && STATUSES.has(consult.status)
    ? (consult as unknown as ConsultActivityFields)
    : null;
}

function firstContentText(data: Record<string, unknown>): string | null {
  const content = Array.isArray(data.content) ? data.content : null;
  return asTrimmedString(asRecord(content?.[0])?.text);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function asTrimmedString(value: unknown): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : null;
}
