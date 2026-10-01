import {
  type EnvironmentThreadSearchMatch,
  threadSearchMatchKey,
} from "@t3tools/client-runtime/state/thread-search";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  OrchestrationThreadSearchSource,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

import { searchSidebarThreads } from "../components/Sidebar.logic";

/** Excerpt label for each indexed text unit (plans/thread-content-search). */
export const THREAD_SEARCH_SOURCE_LABEL: Record<OrchestrationThreadSearchSource, string> = {
  user: "You:",
  assistant: "Agent:",
  title: "Title:",
  purpose: "Purpose:",
  brief: "Brief:",
  goal: "Goal:",
  task: "Task:",
  report: "Report:",
};

/** Matches any query word (2+ chars, case-insensitive) — content hits are
    stemmed or semantic, so the whole query rarely appears verbatim. */
export function threadSearchHighlightPattern(query: string): RegExp | null {
  const words = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2);
  return words.length === 0
    ? null
    : new RegExp(
        `(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
        "giu",
      );
}

/** A sidebar search row: a visible root shell (with its content hit, if any),
    or an archived root the client holds no shell for, drawn from the match. */
export type SidebarSearchResult<T> = { readonly threadRef: ScopedThreadRef } & (
  | { readonly thread: T; readonly match: EnvironmentThreadSearchMatch | null }
  | { readonly thread: null; readonly match: EnvironmentThreadSearchMatch }
);

/**
 * Sidebar search results in the server's fused order (roots only). A match
 * whose root is not among the visible shells is kept only when the root is
 * archived and inside the project scope; local title/PR matches the server did
 * not return (query under the server's 2-char floor, request in flight,
 * disconnected environment) follow.
 */
export function rankSidebarSearchResults<
  T extends Parameters<typeof searchSidebarThreads>[0][number] & {
    readonly environmentId: EnvironmentId;
    readonly id: ThreadId;
  },
>(input: {
  readonly threads: readonly T[];
  readonly query: string;
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly isInScope: (match: EnvironmentThreadSearchMatch) => boolean;
}): SidebarSearchResult<T>[] {
  const shellByKey = new Map(
    input.threads.map((thread) => [
      threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      thread,
    ]),
  );
  const results = input.matches.flatMap((match): SidebarSearchResult<T>[] => {
    const threadRef = scopeThreadRef(match.environmentId, match.threadId);
    const thread = shellByKey.get(threadSearchMatchKey(match));
    if (thread) return [{ threadRef, thread, match }];
    return match.archivedAt !== null && input.isInScope(match)
      ? [{ threadRef, thread: null, match }]
      : [];
  });
  const returned = new Set(results.map((result) => result.thread));
  return [
    ...results,
    ...searchSidebarThreads(input.threads, input.query)
      .filter((thread) => !returned.has(thread))
      .map((thread) => ({
        threadRef: scopeThreadRef(thread.environmentId, thread.id),
        thread,
        match: null,
      })),
  ];
}
