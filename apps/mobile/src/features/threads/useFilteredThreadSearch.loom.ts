import {
  DEFAULT_THREAD_SEARCH_FILTERS,
  threadSearchSubRows,
  type ThreadSearchFilters,
  type ThreadSearchTarget,
} from "@t3tools/client-runtime/state/loom/threadSearch";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ProjectId } from "@t3tools/contracts";
import { useMemo, useState } from "react";

import { scopedThreadKey } from "../../lib/scopedEntities";
import { useThreadSearch } from "../../state/queries";
import { requestThreadMessageJump } from "./threadMessageJump";

/**
 * `useThreadSearch` with the search field's switches and one workstream's unfolded sub-thread
 * rows. Both are transient (tier 4, `docs/architecture/loom-ui-state-tiers.md`): clearing the
 * field puts back the default, so a forgotten switch never hides results from a later search.
 * `projectIds` is the surface's own picker; a project chip in `filters` overrides it.
 */
export function useFilteredThreadSearch(
  environmentIds: Parameters<typeof useThreadSearch>[0],
  query: string,
  scope: {
    readonly projectIds?: ReadonlyArray<ProjectId>;
    readonly environmentLabels?: Record<string, string>;
  },
) {
  const [filters, setFilters] = useState<ThreadSearchFilters>(DEFAULT_THREAD_SEARCH_FILTERS);
  const [unfolded, setUnfolded] = useState<{
    readonly root: Pick<EnvironmentThreadSearchMatch, "environmentId" | "threadId">;
    /** The results it was chosen from; null until the next render binds it. */
    readonly key: string | null;
  } | null>(null);
  if (query.trim() === "" && (filters !== DEFAULT_THREAD_SEARCH_FILTERS || unfolded !== null)) {
    setFilters(DEFAULT_THREAD_SEARCH_FILTERS);
    setUnfolded(null);
  }
  const searchScope = {
    ...scope,
    subThreads: filters.subThreads,
    archived: filters.archived,
    ...(filters.projectIds === undefined ? {} : { projectIds: filters.projectIds }),
  };
  const search = useThreadSearch(environmentIds, query, searchScope);
  // Bound here, not in `unfold`: a recycled list cell can call an `unfold` from an older render.
  if (unfolded !== null && unfolded.key === null && search.key !== "") {
    setUnfolded({ root: unfolded.root, key: search.key });
  }
  // An unfold belongs to the results it was chosen from; new words or switches fold it again.
  const open = unfolded !== null && unfolded.key === search.key ? unfolded.root : null;
  const unfoldSearch = useThreadSearch(
    open === null ? [] : [open.environmentId],
    query,
    open === null ? searchScope : { ...searchScope, rootThreadId: open.threadId },
  );
  const subRows = useMemo(
    () => threadSearchSubRows(search.matches, unfoldSearch.matches),
    [search.matches, unfoldSearch.matches],
  );
  return {
    search,
    filters,
    setFilters,
    subRows,
    unfold: (root: EnvironmentThreadSearchMatch) => setUnfolded({ root, key: null }),
  };
}

/** Opens what a search row targets; the phone opens a report's sub-thread without the report. */
export function openThreadSearchTarget(
  target: ThreadSearchTarget,
  onSelectThread: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void,
) {
  if (target.find) {
    requestThreadMessageJump(
      scopedThreadKey(target.environmentId, target.threadId),
      target.find.messageId,
    );
  }
  onSelectThread({ environmentId: target.environmentId, id: target.threadId });
}
