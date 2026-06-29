import type { ThreadId } from "@t3tools/contracts";

import type { ComposerCommandItem } from "../components/chat/ComposerCommandMenu";
import type { SidebarThreadSummary } from "../types";
import { basenameOfPath } from "../vscode-icons";

/** Max thread suggestions surfaced in the `@` menu (titles are non-unique). */
export const THREAD_MENTION_MATCH_LIMIT = 8;

/**
 * Secondary disambiguation line for a thread suggestion: titles are non-unique
 * and truncated, so pair each with `role · status · location` (branch, else the
 * worktree basename).
 */
export const describeThreadSummary = (thread: SidebarThreadSummary): string => {
  const location =
    thread.branch ?? (thread.worktreePath ? basenameOfPath(thread.worktreePath) : null);
  return [thread.role, thread.planLane, location].filter(Boolean).join(" · ");
};

/**
 * Local filter over the threads the sidebar already holds — no new RPC. Matches
 * titles by case-insensitive substring (an empty query lists all), ranks by
 * match position then title, excludes the active thread and untitled threads,
 * and caps the result. Selection still resolves to the exact thread id.
 */
export const matchThreadMentionItems = (
  threads: ReadonlyArray<SidebarThreadSummary>,
  query: string,
  excludeThreadId: ThreadId | null,
): Array<Extract<ComposerCommandItem, { type: "thread" }>> => {
  const normalizedQuery = query.trim().toLowerCase();
  return threads
    .filter((thread) => thread.id !== excludeThreadId && thread.title.trim().length > 0)
    .flatMap((thread) => {
      const rank = normalizedQuery ? thread.title.toLowerCase().indexOf(normalizedQuery) : 0;
      return rank < 0 ? [] : [{ thread, rank }];
    })
    .sort(
      (left, right) =>
        left.rank - right.rank || left.thread.title.localeCompare(right.thread.title),
    )
    .slice(0, THREAD_MENTION_MATCH_LIMIT)
    .map(({ thread }) => ({
      id: `thread:${thread.id}`,
      type: "thread",
      threadId: thread.id,
      label: thread.title,
      description: describeThreadSummary(thread),
    }));
};
