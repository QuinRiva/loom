/**
 * loom: per-thread spend from seam 11's usage ledger (`loom.threadSpend`) and
 * the Cost tab's top-spenders window (`loom.topSpend`), 3d-4. Cost is never a
 * shell field: board cards, quick facts and the active strip each ask for one
 * thread, and the shared batched store coalesces every mounted ask into one RPC
 * per environment (revalidated on its TTL).
 *
 * @module loom/threadSpend
 */
import { useAtomValue } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, LoomThreadSpend, LoomTopSpendRow, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "../state/presentation";
import { createBatchedLookupStore } from "./batchedLookupStore";
import { loomCommands } from "./loomGoalState";

/** `null` = the ledger has no rows for the thread (an answer, not a failure). */
const spendStore = createBatchedLookupStore<LoomThreadSpend | null>({
  fetch: async (environmentId, threadIds) => {
    const result = await executeAtomQuery(
      appAtomRegistry,
      loomCommands.threadSpend({
        environmentId,
        input: { threadIds: threadIds as ThreadId[] },
      }),
      // Freshness is the store's job (TTL, coalescing, backoff): bypass the cache.
      { refresh: true, reportDefect: false, reportFailure: false },
    );
    return result._tag === "Success"
      ? new Map(threadIds.map((id) => [id, result.value.spend[id as ThreadId] ?? null]))
      : new Map();
  },
  batchMax: 200,
});

/** One thread's lifetime spend: undefined until answered, null when it has none. */
export function useThreadSpend(
  environmentId: EnvironmentId | null,
  threadId: ThreadId,
): LoomThreadSpend | null | undefined {
  return spendStore.useLookup(environmentId, [threadId])(threadId);
}

export interface EnvironmentTopSpendRow extends LoomTopSpendRow {
  readonly environmentId: EnvironmentId;
}

export interface TopSpendView {
  readonly threads: ReadonlyArray<EnvironmentTopSpendRow>;
  readonly isPending: boolean;
  readonly failed: boolean;
}

/** Rows shown; each environment is asked for the same number. */
export const TOP_THREAD_COUNT = 10;

/** Every environment's top spenders since `since`, merged and re-ranked. */
const topSpendAtom = Atom.family((since: string) =>
  Atom.make((get): TopSpendView => {
    const rows: EnvironmentTopSpendRow[] = [];
    let isPending = false;
    let failed = false;
    for (const [environmentId] of get(environmentPresentations.presentationsAtom)) {
      const result = get(
        loomCommands.topSpend({ environmentId, input: { limit: TOP_THREAD_COUNT, since } }),
      );
      if (result.waiting) isPending = true;
      if (result._tag === "Failure") failed = true;
      for (const row of Option.getOrNull(AsyncResult.value(result))?.threads ?? []) {
        rows.push({ ...row, environmentId });
      }
    }
    return {
      threads: rows.toSorted((left, right) => right.costUsd - left.costUsd),
      isPending,
      failed,
    };
  }).pipe(Atom.withLabel(`loom-top-spend:${since}`)),
);

export function useTopSpend(since: string): TopSpendView {
  return useAtomValue(topSpendAtom(since));
}
