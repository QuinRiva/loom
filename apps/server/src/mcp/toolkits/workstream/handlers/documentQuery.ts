/**
 * `mcp__t3-code__document_query_promote` (plans/plan-query-threads/plan.mdx §2.4-2.5): a query
 * thread records ONE comment for its document's author. The anchor, quoted passage and section
 * come from the question the promote turn names (`exchangeAt`), so the model writes only the
 * words. The promotion is an event on the query thread; the author's client seeds it into the
 * author's composer as a chip the human sends. Promoting never closes the thread.
 *
 * @module mcp/toolkits/workstream/handlers/documentQuery
 */
import { CommandId, DOCUMENT_QUERY_ROLE } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as LoomStore from "../../../../loom/projection/LoomStore.ts";
import type { WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { requestKey } from "../idempotency.ts";
import { asToolError, dispatch, fail, nowIso } from "./shared.ts";

export const documentQueryPromote = Effect.fn("LoomToolkit.documentQueryPromote")(function* (
  input: LoomToolInput<"document_query_promote">,
  caller: WorkstreamCaller,
) {
  const row = yield* asToolError(
    Effect.flatMap(LoomStore.LoomStoreV2, (store) => store.getWorkstream(caller.threadId)),
  );
  if (row?.role !== DOCUMENT_QUERY_ROLE || row.documentQuery === null)
    return yield* fail(
      "Only a query thread can promote an exchange: this tool records a comment for the author of the document the query thread is about.",
    );
  const text = input.text.trim();
  if (!text) return yield* fail("text must be the comment for the author, not empty.");
  const question = row.documentQuery.questions.find((q) => q.askedAt === input.exchangeAt);
  if (question === undefined)
    return yield* fail(
      `exchangeAt ${input.exchangeAt} matches no question in this thread. Copy it exactly from the promote turn; the questions were asked at: ${row.documentQuery.questions.map((q) => q.askedAt).join(", ")}.`,
    );
  const promotionId = `promotion:${yield* requestKey(undefined)}`;
  const promotedAt = yield* nowIso;
  yield* dispatch({
    type: "thread.document-query.promote",
    commandId: CommandId.make(`server:loom:query-promoted:${promotionId}`),
    threadId: caller.threadId,
    createdAt: promotedAt,
    promotion: {
      promotionId,
      promotedAt,
      exchangeAt: question.askedAt,
      comment: {
        text,
        anchor: question.anchor,
        quotedText: question.quotedText,
        sectionId: question.anchor.sectionId?.trim() || "document",
        sectionTitle: question.sectionTitle,
        rangeLabel: "promoted",
      },
    },
  });
  return "Recorded. The comment will appear in the author's composer; the human sends it.";
});
