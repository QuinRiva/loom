import type {
  EnvironmentId,
  OrchestrationThreadSearchSource,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";

import { type EnvironmentThreadSearchMatch, threadSearchMatchKey } from "../threadSearch.ts";

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
 * The kind of text an excerpt matched, or null when there is nothing to add:
 * a hit on the root's own title, which the row already shows. A sub-thread
 * hit names its sub-thread apart (`threadSearchMatchedSubThreadTitle`), so the
 * snippet keeps the excerpt line.
 */
export function threadSearchExcerptLabel(
  match: Pick<EnvironmentThreadSearchMatch, "source" | "matchedThreadId">,
): string | null {
  if (match.source !== "title") return `${SOURCE_LABEL[match.source]}:`;
  // A sub-thread title hit: the snippet is that title.
  return match.matchedThreadId === null ? null : "Sub-thread:";
}

/** The sub-thread a non-title hit came from, for a line of its own; null for a root's own text. */
export function threadSearchMatchedSubThreadTitle(
  match: Pick<EnvironmentThreadSearchMatch, "source" | "matchedThreadId" | "matchedThreadTitle">,
): string | null {
  return match.matchedThreadId === null || match.source === "title"
    ? null
    : (match.matchedThreadTitle ?? "Untitled");
}

/**
 * Splits text into runs, highlighting words that start with any query token:
 * the server stems and prefix-matches, so the literal query rarely appears.
 * ASCII word characters and no `toSorted`, because mobile runs this on Hermes.
 */
export function threadSearchHighlightParts(text: string, query: string) {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2)
    .sort((left, right) => right.length - left.length);
  if (tokens.length === 0) return [{ text, highlighted: false, start: 0 }];
  // Two capture groups: split yields [plain, boundary, token, plain, boundary, token, …, plain].
  const pieces = text.split(new RegExp(`(^|[^a-z0-9])(${tokens.join("|")})`, "i"));
  const parts: Array<{ text: string; highlighted: boolean; start: number }> = [];
  let start = 0;
  pieces.forEach((piece = "", index) => {
    if (piece.length === 0) return;
    const highlighted = index % 3 === 2;
    const previous = parts.at(-1);
    if (previous !== undefined && !previous.highlighted && !highlighted) {
      previous.text += piece;
    } else {
      parts.push({ text: piece, highlighted, start });
    }
    start += piece.length;
  });
  return parts;
}

/**
 * Content hits on roots the client holds no shell for. Archived roots are the
 * only such roots (the shell stream drops them); a live root missing from the
 * list was filtered out by the list itself and stays out.
 */
export function shelllessArchivedMatches(input: {
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly isInScope: (match: EnvironmentThreadSearchMatch) => boolean;
}): EnvironmentThreadSearchMatch[] {
  return input.matches.filter((match) => match.archivedAt !== null && input.isInScope(match));
}

export type ThreadSearchResult<T> = { readonly threadRef: ScopedThreadRef } & (
  | { readonly thread: T; readonly match: EnvironmentThreadSearchMatch | null }
  | { readonly thread: null; readonly match: EnvironmentThreadSearchMatch }
);

/**
 * A searched list in the server's fused order (roots only), each hit paired
 * with its listed shell or, for an archived root, drawn from the match alone.
 * Local title/PR hits the server did not return follow: a query under the
 * server's two-character floor, a request in flight, a disconnected server.
 */
export function rankThreadSearchResults<
  T extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly localMatches: ReadonlyArray<T>;
  readonly matches: ReadonlyArray<EnvironmentThreadSearchMatch>;
  readonly isInScope: (match: EnvironmentThreadSearchMatch) => boolean;
}): ThreadSearchResult<T>[] {
  const keyOf = (thread: T) =>
    threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id });
  const threadByKey = new Map(input.threads.map((thread) => [keyOf(thread), thread]));
  const archived = new Set(shelllessArchivedMatches(input));
  const ranked = input.matches.flatMap((match): ThreadSearchResult<T>[] => {
    const threadRef = { environmentId: match.environmentId, threadId: match.threadId };
    const thread = threadByKey.get(threadSearchMatchKey(match));
    if (thread !== undefined) return [{ threadRef, thread, match }];
    return archived.has(match) ? [{ threadRef, thread: null, match }] : [];
  });
  const rankedKeys = new Set(ranked.map((result) => threadSearchMatchKey(result.threadRef)));
  return [
    ...ranked,
    ...input.localMatches.flatMap((thread) =>
      rankedKeys.has(keyOf(thread))
        ? []
        : [
            {
              threadRef: { environmentId: thread.environmentId, threadId: thread.id },
              thread,
              match: null,
            },
          ],
    ),
  ];
}
