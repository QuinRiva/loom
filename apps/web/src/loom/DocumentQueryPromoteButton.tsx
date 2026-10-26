/**
 * loom: Promote on a query thread's answer: the fork distils that exchange into one comment the
 * author's composer seeds. An answer belongs to the latest question at or before its run; the
 * kickoff era and a promote turn's own reply have nothing to promote.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DOCUMENT_QUERY_ROLE,
  type EnvironmentId,
  type LoomDocumentQueryQuestion,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { isDocumentQueryPromoteMessage } from "@t3tools/shared/documentQuery.loom";
import { Atom } from "effect/reactivity";
import { ArrowUpFromLineIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useAtomCommand } from "../state/use-atom-command";
import { environmentThreadDetails, environmentThreadShells } from "../state/threads";
import { loomCommands } from "./loomGoalState";

/** The `askedAt` of the exchange `runId`'s answer belongs to, or null when it has none. */
export function promotableExchangeAt(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "userMessageId">>,
  questions: ReadonlyArray<Pick<LoomDocumentQueryQuestion, "messageId" | "askedAt">>,
  runId: RunId,
): string | null {
  const run = runs.find((candidate) => candidate.id === runId);
  if (run === undefined || isDocumentQueryPromoteMessage(run.userMessageId)) return null;
  const askedAtOf = new Map(questions.map((question) => [question.messageId, question.askedAt]));
  const asking = runs
    .filter(
      (candidate) => candidate.ordinal <= run.ordinal && askedAtOf.has(candidate.userMessageId),
    )
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  return asking === undefined ? null : askedAtOf.get(asking.userMessageId)!;
}

// A primitive per answer, so a row re-renders only when its exchange changes; only a query
// thread's rows read the projection's runs.
const exchangeAtAtom = Atom.family((key: string) => {
  const [environmentId, threadId, runId] = JSON.parse(key) as [EnvironmentId, ThreadId, RunId];
  const ref = scopeThreadRef(environmentId, threadId);
  return Atom.make((get): string | null => {
    const query = get(environmentThreadShells.quietThreadShellAtom(ref))?.source.workstream;
    if (query?.role !== DOCUMENT_QUERY_ROLE || !query.documentQuery) return null;
    const thread = get(environmentThreadDetails.threadAtom(ref));
    return thread === null
      ? null
      : promotableExchangeAt(thread.projection.runs, query.documentQuery.questions, runId);
  }).pipe(Atom.withLabel(`loom-document-query-exchange:${key}`));
});

export function DocumentQueryPromoteButton(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}) {
  const exchangeAt = useAtomValue(
    exchangeAtAtom(JSON.stringify([props.environmentId, props.threadId, props.runId])),
  );
  const promote = useAtomCommand(loomCommands.documentQueryPromote);
  const [busy, setBusy] = useState(false);
  if (exchangeAt === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={busy}
            data-document-query-promote=""
            onClick={() => {
              setBusy(true);
              void promote({
                environmentId: props.environmentId,
                input: { queryThreadId: props.threadId, exchangeAt },
              }).finally(() => setBusy(false));
            }}
          />
        }
      >
        <ArrowUpFromLineIcon className="size-3" />
        Promote to author
      </TooltipTrigger>
      <TooltipPopup side="top">
        Distil this exchange into one comment in the author's composer, for you to send
      </TooltipPopup>
    </Tooltip>
  );
}
