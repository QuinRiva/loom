import type { ComposerThreadItem } from "@t3tools/client-runtime/composerThreadItems";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { basenameOfPath } from "../pierre-icons";
import { isVisibleHandoffDrafter } from "./handoffDrafter";

/** Max threads the `!` menu lists (titles are non-unique). */
const THREAD_MENTION_MATCH_LIMIT = 8;

/**
 * The `!` thread-reference menu (DL-750): threads whose title contains the whole
 * multi-word query, case-insensitively (an empty query lists them all). Threads
 * that start with the query rank first, then the most recently updated. Only the
 * composer's own environment is listed, because the agent reads threads from its
 * own server. The live shells already exclude archived threads (V1 did the same)
 * and include children. Healthy `/handoff` drafters stay hidden. Titles are
 * non-unique, so each item's description is `role · outcome · branch`.
 */
export const matchThreadMentionItems = (input: {
  shells: ReadonlyArray<EnvironmentThreadShell>;
  environmentId: EnvironmentId;
  excludeThreadId: ThreadId | null;
  query: string;
}): ComposerThreadItem[] => {
  const query = input.query.trim().toLowerCase();
  return input.shells
    .filter(
      (shell) =>
        shell.environmentId === input.environmentId &&
        shell.id !== input.excludeThreadId &&
        shell.title.trim().length > 0 &&
        isVisibleHandoffDrafter(shell),
    )
    .flatMap((shell) => {
      const rank = shell.title.toLowerCase().indexOf(query);
      return rank < 0 ? [] : [{ shell, rank }];
    })
    .sort((a, b) => a.rank - b.rank || b.shell.updatedAt.localeCompare(a.shell.updatedAt))
    .slice(0, THREAD_MENTION_MATCH_LIMIT)
    .map(({ shell }) => ({
      id: `thread:${shell.environmentId}:${shell.id}`,
      type: "thread",
      thread: { environmentId: shell.environmentId, threadId: shell.id },
      label: shell.title,
      description: [
        shell.source.workstream?.role,
        shell.source.workstream?.outcome,
        shell.branch ?? (shell.worktreePath ? basenameOfPath(shell.worktreePath) : null),
      ]
        .filter(Boolean)
        .join(" · "),
    }));
};
