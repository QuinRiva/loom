/**
 * `document_query_promote` (plan-query-threads §2.4-2.5; plans/code-query/plan.mdx §4): a query
 * thread records ONE comment for the author; the passage or lines come from the named question, so
 * the model writes only the words. The author's client seeds it as a composer chip; promoting never closes.
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
  if (row?.role !== DOCUMENT_QUERY_ROLE || (row.documentQuery === null && row.codeQuery === null))
    return yield* fail(
      "Only a query thread can promote an exchange: this tool records a comment for the thread a query thread is a fork of.",
    );
  const text = input.text.trim();
  if (!text) return yield* fail("text must be the comment for the author, not empty.");
  const asked = [...(row.documentQuery?.questions ?? []), ...(row.codeQuery?.questions ?? [])].map(
    (q) => q.askedAt,
  );
  const exchangeAt = asked.find((at) => at === input.exchangeAt);
  if (exchangeAt === undefined)
    return yield* fail(
      `exchangeAt ${input.exchangeAt} matches no question in this thread. Copy it exactly from the promote turn; the questions were asked at: ${asked.join(", ")}.`,
    );
  // Resolved before the dispatch: a failure here must not report an error for a promotion that
  // was in fact recorded, which a retry would then duplicate.
  const author = row.forkFromThreadId;
  const authorShell =
    author === null
      ? null
      : yield* asToolError(
          Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
            orchestrator.getThreadShell(author),
          ),
        );
  const promotionId = `promotion:${yield* requestKey(undefined)}`;
  const promotedAt = yield* nowIso;
  const commandId = CommandId.make(`server:loom:query-promoted:${promotionId}`);
  const question = row.documentQuery?.questions.find((q) => q.askedAt === exchangeAt);
  // A code promotion is the words alone: the author's client rebuilds the line comment from its question.
  yield* dispatch(
    question === undefined
      ? {
          type: "thread.code-query.promote",
          commandId,
          threadId: caller.threadId,
          createdAt: promotedAt,
          promotion: { promotionId, promotedAt, exchangeAt, text },
        }
      : {
          type: "thread.document-query.promote",
          commandId,
          threadId: caller.threadId,
          createdAt: promotedAt,
          promotion: {
            promotionId,
            promotedAt,
            exchangeAt,
            comment: {
              text,
              anchor: question.anchor,
              quotedText: question.quotedText,
              sectionId: question.anchor.sectionId?.trim() || "document",
              sectionTitle: question.sectionTitle,
              rangeLabel: "promoted",
            },
          },
        },
  );
  return author === null
    ? "Recorded: the comment is waiting in the author's composer, and the human sends it from there."
    : `Recorded: the comment is waiting in the composer of ${formatThreadLink({ environmentId: null, threadId: author }, authorShell?.title)}, and the human sends it from there.`;
});
