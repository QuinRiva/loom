import {
  withThreadSearchSubRows,
  type ThreadSearchSubRow,
} from "@t3tools/client-runtime/state/loom/threadSearch";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";

import { scopedThreadKey } from "../../lib/scopedEntities";
import type { CommandPaletteResult } from "./commandPaletteItems";

/**
 * The palette's results with each top-level thread's sub-thread rows directly after it, in the
 * threads group and under "In messages" alike. Their `run` does nothing: the palette opens a
 * sub-thread row's target and unfolds a fold row in place, without closing.
 */
export function withPaletteSubThreadRows(
  results: ReadonlyArray<CommandPaletteResult>,
  matches: ReadonlyArray<EnvironmentThreadSearchMatch>,
  subRows: ReadonlyMap<string, ReadonlyArray<ThreadSearchSubRow>>,
): ReadonlyArray<CommandPaletteResult> {
  if (subRows.size === 0) return results;
  const rootKeyByItemKey = new Map(
    matches.map((match) => [
      scopedThreadKey(match.environmentId, match.threadId),
      threadSearchMatchKey(match),
    ]),
  );
  return withThreadSearchSubRows(
    results,
    (item) => (item.kind === "thread" ? (rootKeyByItemKey.get(item.key) ?? null) : null),
    subRows,
  ).map((row): CommandPaletteResult =>
    "root" in row
      ? {
          key: `sub:${row.key}`,
          kind: "thread",
          title: row.kind === "subThread" ? row.match.title : "",
          searchTerms: [],
          subThreadRow: row,
          run: () => undefined,
        }
      : row,
  );
}
