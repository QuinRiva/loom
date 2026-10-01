import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import type { OrchestrationThreadSearchSource } from "@t3tools/contracts";

import { scopedProjectKey } from "../../lib/scopedEntities";

/** A content hit on a root the client holds no live shell for (archived), drawn from the match itself. */
export interface ThreadSearchArchivedItem {
  readonly type: "search-archived";
  readonly key: string;
  readonly match: EnvironmentThreadSearchMatch;
}

/**
 * Orders a searched thread list by the server's rank. Matches resolve to the
 * list's own item when it renders that root, or to an archived row when the
 * client has no live shell for it (and it is inside the project scope); a
 * match whose live shell the list filtered out stays out. Items the server did
 * not return (local title/PR hits, pending tasks) follow in their list order.
 */
export function rankThreadSearchItems<T>(input: {
  readonly items: ReadonlyArray<T>;
  readonly threadOf: (item: T) => Pick<EnvironmentThreadShell, "environmentId" | "id"> | null;
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly liveThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly projectKeys: ReadonlySet<string> | null;
}): Array<T | ThreadSearchArchivedItem> {
  const itemByKey = new Map<string, T>();
  for (const item of input.items) {
    const thread = input.threadOf(item);
    if (thread !== null) {
      itemByKey.set(
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
        item,
      );
    }
  }
  const liveKeys = new Set(
    input.liveThreads.map((thread) =>
      threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
    ),
  );
  const ranked = input.matches.flatMap((match): Array<T | ThreadSearchArchivedItem> => {
    const key = threadSearchMatchKey(match);
    const item = itemByKey.get(key);
    if (item !== undefined) return [item];
    return liveKeys.has(key) ||
      (input.projectKeys !== null &&
        !input.projectKeys.has(scopedProjectKey(match.environmentId, match.projectId)))
      ? []
      : [{ type: "search-archived", key: `search-archived:${key}`, match }];
  });
  const rankedSet = new Set(ranked);
  return [...ranked, ...input.items.filter((item) => !rankedSet.has(item))];
}

const SOURCE_LABEL = {
  user: "You",
  assistant: "Agent",
  title: "Title",
  purpose: "Purpose",
  brief: "Brief",
  goal: "Goal",
  task: "Task",
  report: "Report",
} satisfies Record<OrchestrationThreadSearchSource, string>;

/**
 * What an excerpt says about where a hit came from, or null when there is
 * nothing to add (a hit on the root's own title, which the row already shows).
 */
export function threadSearchExcerptLabel(match: EnvironmentThreadSearchMatch): string | null {
  if (match.matchedThreadId === null) {
    return match.source === "title" ? null : `${SOURCE_LABEL[match.source]}:`;
  }
  // A sub-thread title hit: the snippet is that title, so it carries the label alone.
  return match.source === "title"
    ? "Sub-thread:"
    : `Sub-thread: ${match.matchedThreadTitle ?? "Untitled"} · ${SOURCE_LABEL[match.source]}:`;
}

/** Splits text into runs, highlighting words that start with any query token (the server prefix-matches). */
export function threadSearchHighlightParts(text: string, query: string) {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2)
    .sort((left, right) => right.length - left.length);
  if (tokens.length === 0) return [{ text, highlighted: false, start: 0 }];
  // split() with two capture groups yields [plain, boundary, token, plain, boundary, token, …, plain].
  const pieces = text.split(new RegExp(`(^|[^a-z0-9])(${tokens.join("|")})`, "i"));
  const parts: Array<{
    readonly text: string;
    readonly highlighted: boolean;
    readonly start: number;
  }> = [];
  let start = 0;
  pieces.forEach((piece = "", index) => {
    if (piece.length === 0) return;
    const highlighted = index % 3 === 2;
    const previous = parts.at(-1);
    if (previous !== undefined && !previous.highlighted && !highlighted) {
      parts[parts.length - 1] = { ...previous, text: previous.text + piece };
    } else {
      parts.push({ text: piece, highlighted, start });
    }
    start += piece.length;
  });
  return parts;
}
