/**
 * The first-turn text a child receives: its brief inside the kickoff wrapper
 * (`workstreamChildPrompt` in `prose.ts`), or the raw brief for a role-less
 * child — led, for a `forkFrom` child either way, by the copied-history clause.
 * The dispatcher's kickoff is its only sender.
 *
 * @module loom/prompt/childPrompt
 */
import type { LoomThreadWorkstream, ThreadId } from "@t3tools/contracts";
import { gateLoopTargetOf } from "@t3tools/shared/workstreamGraph";
import * as Effect from "effect/Effect";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { copiedHistoryClause, type KickoffHandback, workstreamChildPrompt } from "./prose.ts";

/** A thread's pi session file: the native ref of its latest pi provider thread, if it has one. */
export const piSessionPathOf = (threadId: ThreadId) =>
  Effect.flatMap(OrchestratorV2, (orchestrator) =>
    Effect.map(
      orchestrator.getThreadRecords(threadId, ["providerThreads"]),
      ({ providerThreads }) =>
        providerThreads.findLast((providerThread) => providerThread.driver === "pi")
          ?.nativeThreadRef?.nativeId ?? null,
    ),
  );

type KickoffRow = Pick<LoomThreadWorkstream, "role" | "reportPath" | "kickoffBriefPath">;

/**
 * What a kickoff tells a child about the threads it waited on, from the rows
 * the caller holds: its gate target's report, brief and session, and each
 * other dependency's report.
 */
export const kickoffContext = Effect.fn("loom.kickoffContext")(function* (
  row: Pick<LoomThreadWorkstream, "routes" | "blockedBy" | "forkFromThreadId">,
  nodesById: ReadonlyMap<ThreadId, KickoffRow>,
) {
  const handback = (id: ThreadId): KickoffHandback => ({
    id,
    role: nodesById.get(id)?.role ?? null,
    reportPath: nodesById.get(id)?.reportPath ?? null,
  });
  const targetId = gateLoopTargetOf(row);
  return {
    gateTarget:
      targetId === null
        ? null
        : {
            ...handback(targetId),
            briefPath: nodesById.get(targetId)?.kickoffBriefPath ?? null,
            sessionPath: yield* piSessionPathOf(targetId),
          },
    dependencies: row.blockedBy.filter((id) => id !== targetId).map(handback),
    forkedFrom: row.forkFromThreadId,
  };
});

type KickoffInput = {
  readonly role: string | null;
  readonly brief: string;
  readonly gateTarget?: KickoffHandback | null;
  readonly dependencies?: ReadonlyArray<KickoffHandback>;
  readonly forkedFrom?: string | null;
};

export const kickoffText = (input: KickoffInput): string =>
  input.role === null
    ? input.forkedFrom != null
      ? `${copiedHistoryClause(input.forkedFrom)}\n\n${input.brief}`
      : input.brief
    : workstreamChildPrompt({ ...input, role: input.role });
