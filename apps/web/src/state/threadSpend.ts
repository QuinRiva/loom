/**
 * loom: top-consuming threads for the Usage page's Cost tab.
 *
 * Upstream's summary comes from provider transcripts, which carry no thread
 * identity, so this window reads loom's own `projection_usage_ledger` instead —
 * one grouped query per environment, merged here the way `useUsage` merges
 * summaries.
 *
 * @module state/threadSpend
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadSpendRow, UsageSummaryInput } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentThreadSpendRow extends ThreadSpendRow {
  readonly environmentId: EnvironmentId;
}

export interface ThreadSpendView {
  readonly threads: readonly EnvironmentThreadSpendRow[];
  readonly isPending: boolean;
  readonly failed: boolean;
}

/** Rows shown; the server caps its own read at the same number. */
const TOP_THREAD_COUNT = 10;

/**
 * The window as UTC instants. `timeZone` is always the browser's own zone
 * (`makeWindow` resolves it from `Intl`), so a local-midnight `Date` is the
 * day boundary the page is showing — and `new Date(y, m, d + 1)` crosses a
 * daylight-saving change correctly where adding 24 hours would not.
 */
function windowBounds(input: UsageSummaryInput): { sinceTime: string; untilTime: string } {
  if (input.sinceTime !== undefined && input.untilTime !== undefined) {
    return { sinceTime: input.sinceTime, untilTime: input.untilTime };
  }
  const [sinceYear = 0, sinceMonth = 1, sinceDay = 1] = input.sinceDay.split("-").map(Number);
  const [untilYear = 0, untilMonth = 1, untilDay = 1] = input.untilDay.split("-").map(Number);
  return {
    sinceTime: new Date(sinceYear, sinceMonth - 1, sinceDay).toISOString(),
    untilTime: new Date(untilYear, untilMonth - 1, untilDay + 1).toISOString(),
  };
}

const threadSpendByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): ThreadSpendView => {
    const input = JSON.parse(windowKey) as { sinceTime: string; untilTime: string };
    const rows: EnvironmentThreadSpendRow[] = [];
    let isPending = false;
    let failed = false;
    for (const [environmentId] of get(environmentPresentations.presentationsAtom)) {
      const result = get(serverEnvironment.threadSpend({ environmentId, input }));
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
  }).pipe(Atom.withLabel(`web-thread-spend:window:${windowKey}`)),
);

export function useThreadSpend(
  input: UsageSummaryInput,
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
): ThreadSpendView {
  const { sinceTime, untilTime } = windowBounds(input);
  const view = useAtomValue(threadSpendByWindowAtom(JSON.stringify({ sinceTime, untilTime })));
  // Selection narrows before the top-N cut, so a filtered view still shows ten
  // rows when that environment has them.
  return useMemo(
    () => ({
      ...view,
      threads: view.threads
        .filter(
          (row) => selectedEnvironmentIds === null || selectedEnvironmentIds.has(row.environmentId),
        )
        .slice(0, TOP_THREAD_COUNT),
    }),
    [selectedEnvironmentIds, view],
  );
}
