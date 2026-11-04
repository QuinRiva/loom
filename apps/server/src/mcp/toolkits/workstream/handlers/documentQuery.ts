/**
 * `document_query_promote` (plan-query-threads §2.4-2.5): a query thread records ONE comment for
 * the author; anchor, passage and section come from the named question, so the model writes
 * only the words. The author's client seeds it as a composer chip; promoting never closes.
 */
import { CommandId, DOCUMENT_QUERY_ROLE } from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import * as Effect from "effect/Effect";

import * as LoomStore from "../../../../loom/projection/LoomStore.ts";
import * as Orchestrator from "../../../../orchestration-v2/Orchestrator.ts";
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
  const author = row.forkFromThreadId;
  if (author === null)
    return "Recorded: the comment is waiting in the author's composer, and the human sends it from there.";
  const authorShell = yield* asToolError(
    Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.getThreadShell(author),
    ),
  );
  return `Recorded: the comment is waiting in the composer of ${formatThreadLink({ environmentId: null, threadId: author }, authorShell?.title)}, and the human sends it from there.`;
});
