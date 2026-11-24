import {
  DEFAULT_THREAD_SEARCH_FILTERS,
  isDefaultThreadSearchFilters,
  threadSearchSubRows,
  type ThreadSearchFilters,
  type ThreadSearchTarget,
} from "@t3tools/client-runtime/state/loom/threadSearch";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { useThreadSearch } from "../state/queries";
import { isAbsolutePreviewablePath } from "../markdown-links";
import { useRightPanelStore } from "../rightPanelStore";
import { findForMessageMatch, openThreadFindOnQuery } from "../components/chat/threadFindStore";

/**
 * A search box's switches and its one unfolded workstream. Tier 4 (transient): both return to the
 * default when the box is cleared; a closing palette drops them with its mount.
 */
export function useThreadSearchSwitches(query: string) {
  const [filters, setFilters] = useState<ThreadSearchFilters>(DEFAULT_THREAD_SEARCH_FILTERS);
  const [unfolded, setUnfolded] = useState<{
    readonly root: EnvironmentThreadSearchMatch;
    readonly query: string;
    readonly filters: ThreadSearchFilters;
  } | null>(null);
  if (query.trim().length === 0 && (!isDefaultThreadSearchFilters(filters) || unfolded !== null)) {
    setFilters(DEFAULT_THREAD_SEARCH_FILTERS);
    setUnfolded(null);
  }
  // An unfold holds for the words and switches it was chosen under.
  const open =
    unfolded !== null && unfolded.query === query && unfolded.filters === filters
      ? unfolded.root
      : null;
  const unfoldSearch = useThreadSearch(
    open === null ? [] : [open.environmentId],
    query,
    open === null ? {} : { ...filters, rootThreadId: open.threadId },
  );
  return {
    filters,
    setFilters,
    unfold: (root: EnvironmentThreadSearchMatch) => setUnfolded({ root, query, filters }),
    /** Each listed top-level thread's sub-thread rows; pass the raw `matches` of the main search. */
    subRows: (matches: ReadonlyArray<EnvironmentThreadSearchMatch>) =>
      threadSearchSubRows(matches, open === null ? [] : unfoldSearch.matches),
  };
}

/** Opens what a search row targets: navigate, then find at the message or the report beside it. */
export async function openThreadSearchTarget(
  target: ThreadSearchTarget,
  query: string,
  navigateTo: (ref: ScopedThreadRef) => Promise<unknown> | void,
) {
  const ref = scopeThreadRef(target.environmentId, target.threadId);
  await navigateTo(ref);
  if (target.find) {
    openThreadFindOnQuery(scopedThreadKey(ref), findForMessageMatch(target.find, query));
  }
  if (target.reportPath !== null && isAbsolutePreviewablePath(target.reportPath)) {
    useRightPanelStore.getState().openFileAbsolute(ref, target.reportPath);
  }
}
