import {
  ThreadId,
  type MessageId,
  type OrchestrationSearchThreadsInput,
  type OrchestrationThreadSearchSource,
  type OrchestrationThreadSearchSubThreadMatch,
  type ProjectId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
  type ThreadSearchScope,
} from "../threadSearch.ts";

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

/**
 * The search box's switches. Transient (tier 4 in `docs/architecture/loom-ui-state-tiers.md`): the
 * component that owns the box holds it in `useState` and puts back the default when the box is
 * cleared or closed, so a forgotten switch never hides results from a later search.
 */
export interface ThreadSearchFilters {
  readonly subThreads: boolean;
  readonly archived: boolean;
  /** These projects only; omitted, every project. Which projects to offer is the surface's call. */
  readonly projectIds?: ReadonlyArray<ProjectId>;
}

export const DEFAULT_THREAD_SEARCH_FILTERS: ThreadSearchFilters = {
  subThreads: false,
  archived: false,
};

/** Nothing switched on, so a surface hides its Reset. */
export function isDefaultThreadSearchFilters(filters: ThreadSearchFilters): boolean {
  return !filters.subThreads && !filters.archived && filters.projectIds === undefined;
}

/**
 * The fields `ThreadSearchScope` gains for the switches; a `ThreadSearchFilters` spreads into it.
 * `rootThreadId` unfolds one workstream's sub-thread rows. A scope without `subThreads` and
 * `archived` sends today's request, which the title-only pickers rely on.
 */
export const ThreadSearchFilterScopeFields = {
  subThreads: Schema.optionalKey(Schema.Boolean),
  archived: Schema.optionalKey(Schema.Boolean),
  rootThreadId: Schema.optionalKey(ThreadId),
};

/** What a search request carries for a scope's switches and project choice. */
export function threadSearchFilterInput(
  scope: ThreadSearchScope,
): Pick<
  OrchestrationSearchThreadsInput,
  "includeArchived" | "scope" | "subThreadRows" | "projectIds" | "rootThreadId"
> {
  const subThreads = scope.subThreads === true || scope.rootThreadId !== undefined;
  const switched = scope.subThreads !== undefined || scope.archived !== undefined || subThreads;
  return {
    ...(switched
      ? {
          includeArchived: scope.archived === true,
          scope: subThreads ? "all" : "roots",
          subThreadRows: subThreads,
        }
      : {}),
    ...(scope.projectIds === undefined ? {} : { projectIds: scope.projectIds }),
    ...(scope.rootThreadId === undefined ? {} : { rootThreadId: scope.rootThreadId }),
  };
}

/**
 * Whether a query can search messages: the contract's two characters. A word of one or two letters
 * matches whole words only, which the server does, so `CI` finds messages.
 */
export function isThreadMessageSearchQuery(query: string): boolean {
  return query.trim().length >= 2;
}

/** A row under its top-level thread's row: a matching sub-thread, or the fold that unfolds the rest. */
export type ThreadSearchSubRow =
  | {
      readonly kind: "subThread";
      readonly key: string;
      readonly root: EnvironmentThreadSearchMatch;
      readonly match: OrchestrationThreadSearchSubThreadMatch;
    }
  | {
      readonly kind: "fold";
      readonly key: string;
      readonly root: EnvironmentThreadSearchMatch;
      /** "+N more sub-threads"; choosing it searches again with `rootThreadId: root.threadId`. */
      readonly omitted: number;
    };

/**
 * Each top-level match's sub-thread rows, keyed by `threadSearchMatchKey`. Read from the raw
 * matches before a surface drops the results of threads it lists by title, so those threads keep
 * their rows. `unfolded` is the result of the `rootThreadId` search; its rows replace that
 * workstream's three, with no fold after them.
 */
export function threadSearchSubRows(
  matches: ReadonlyArray<EnvironmentThreadSearchMatch>,
  unfolded: ReadonlyArray<EnvironmentThreadSearchMatch> = [],
): ReadonlyMap<string, ReadonlyArray<ThreadSearchSubRow>> {
  const unfoldedByKey = new Map(unfolded.map((match) => [threadSearchMatchKey(match), match]));
  const rows = new Map<string, ReadonlyArray<ThreadSearchSubRow>>();
  for (const root of matches) {
    const key = threadSearchMatchKey(root);
    const opened = unfoldedByKey.get(key);
    const omitted = opened === undefined ? (root.subThreadsOmitted ?? 0) : 0;
    const subRows: ThreadSearchSubRow[] = ((opened ?? root).subThreads ?? []).map((match) => ({
      kind: "subThread",
      key: threadSearchMatchKey({ environmentId: root.environmentId, threadId: match.threadId }),
      root,
      match,
    }));
    if (omitted > 0) subRows.push({ kind: "fold", key: `${key}:more`, root, omitted });
    if (subRows.length > 0 && !rows.has(key)) rows.set(key, subRows);
  }
  return rows;
}

/**
 * A surface's rows with each top-level thread's sub-thread rows directly after it, wherever it is
 * listed (by title or for its messages), once. `keyOf` gives a row's `threadSearchMatchKey`, or
 * null for rows that carry none. Cut a section to its limit first: sub-thread rows do not count.
 */
export function withThreadSearchSubRows<T>(
  listed: ReadonlyArray<T>,
  keyOf: (row: T) => string | null,
  subRows: ReadonlyMap<string, ReadonlyArray<ThreadSearchSubRow>>,
): Array<T | ThreadSearchSubRow> {
  const placed = new Set<string>();
  return listed.flatMap((row) => {
    const key = keyOf(row);
    const under = key === null || placed.has(key) ? undefined : subRows.get(key);
    if (key === null || under === undefined) return [row];
    placed.add(key);
    return [row, ...under];
  });
}

/**
 * Whether a top-level row draws its own excerpt. It is only a heading when the sub-thread its best
 * hit came from has a row beneath it; a `matchedThreadId` with no row (archived while Archived is
 * off, or holding only some of the words) still needs the excerpt.
 */
export function threadSearchShowsExcerpt(
  match: Pick<EnvironmentThreadSearchMatch, "matchedThreadId" | "subThreads">,
): boolean {
  return (
    match.matchedThreadId === null ||
    !(match.subThreads ?? []).some((row) => row.threadId === match.matchedThreadId)
  );
}

/**
 * What choosing a row opens: navigate to the thread, then find at `find` (web passes it to
 * `findForMessageMatch` with the query; the phone jumps to `find.messageId`) or open `reportPath`
 * in that thread's right panel (web and desktop).
 */
export interface ThreadSearchTarget {
  readonly environmentId: EnvironmentThreadSearchMatch["environmentId"];
  readonly threadId: ThreadId;
  readonly find: { readonly messageId: MessageId; readonly snippet: string } | null;
  readonly reportPath: string | null;
}

/**
 * A top-level row opens the thread its excerpt is from: the sub-thread that wrote a "Report:"
 * excerpt, say. A heading opens the top-level thread. No find in an archived thread, as today.
 */
export function threadSearchTarget(
  row: EnvironmentThreadSearchMatch | Extract<ThreadSearchSubRow, { kind: "subThread" }>,
): ThreadSearchTarget {
  if ("kind" in row) {
    const archived = row.match.archivedAt !== null || row.root.archivedAt !== null;
    return {
      environmentId: row.root.environmentId,
      threadId: row.match.threadId,
      find:
        archived || row.match.messageId === undefined
          ? null
          : { messageId: row.match.messageId, snippet: row.match.snippet },
      reportPath: row.match.reportPath ?? null,
    };
  }
  if (!threadSearchShowsExcerpt(row)) {
    return {
      environmentId: row.environmentId,
      threadId: row.threadId,
      find: null,
      reportPath: null,
    };
  }
  return {
    environmentId: row.environmentId,
    threadId: row.matchedThreadId ?? row.threadId,
    // The server sets `messageId` only for the top-level thread's own message.
    find:
      row.archivedAt !== null || row.messageId === undefined
        ? null
        : { messageId: row.messageId, snippet: row.snippet },
    reportPath: row.reportPath ?? null,
  };
}
