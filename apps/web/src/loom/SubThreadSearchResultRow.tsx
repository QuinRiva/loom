import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  withThreadSearchSubRows,
  type ThreadSearchSubRow,
} from "@t3tools/client-runtime/state/loom/threadSearch";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { CornerDownRightIcon } from "lucide-react";

import { ThreadSearchMatchExcerpt } from "~/components/ThreadSearchMatch";
import { cn } from "~/lib/utils";

import { ArchivedBadge } from "./ArchivedSearchResultRow";

const scrollIntoView = (node: HTMLLIElement | null) => node?.scrollIntoView({ block: "nearest" });

/** A sidebar search row under its top-level thread's row: a matching sub-thread, or the fold. */
export function SubThreadSearchResultRow(props: {
  row: ThreadSearchSubRow;
  isHighlighted: boolean;
  resultId: string;
  searchQuery: string;
  onHighlight: () => void;
  onSelect: () => void;
}) {
  const { row } = props;
  const title = row.kind === "fold" ? null : row.match.title || "Untitled thread";
  return (
    <li
      role="presentation"
      className="list-none"
      ref={props.isHighlighted ? scrollIntoView : undefined}
    >
      <button
        id={props.resultId}
        data-search-result-key={row.key}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={props.isHighlighted}
        aria-label={
          row.kind === "fold"
            ? `${row.omitted} more sub-threads of ${row.root.title}`
            : `${title}, sub-thread of ${row.root.title}`
        }
        onMouseMove={props.onHighlight}
        // Focus stays in the search box, as for the other result rows.
        onPointerDown={(event) => event.preventDefault()}
        onClick={props.onSelect}
        className={cn(
          "flex min-h-7 w-full cursor-pointer items-center gap-2 rounded-md py-1 ps-6 pe-2.5 text-left text-sm outline-none",
          props.isHighlighted
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
      >
        <CornerDownRightIcon className="size-3.5 shrink-0 self-start mt-0.5 opacity-50" />
        {row.kind === "fold" ? (
          <span className="min-w-0 flex-1 truncate text-xs">
            +{row.omitted} more sub-thread{row.omitted === 1 ? "" : "s"}
          </span>
        ) : (
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate">{title}</span>
              {row.match.archivedAt === null ? null : <ArchivedBadge />}
            </span>
            <ThreadSearchMatchExcerpt
              match={{
                source: row.match.source,
                snippet: row.match.snippet,
                matchedThreadId: null,
                matchedThreadTitle: null,
                query: props.searchQuery,
              }}
            />
          </span>
        )}
      </button>
    </li>
  );
}

/** One row of the sidebar's search list; `key` is what the keyboard highlight follows. */
export type SidebarThreadSearchRow<TThread> =
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly matchKey: string;
      readonly thread: TThread;
    }
  | {
      readonly kind: "archived";
      readonly key: string;
      readonly matchKey: string;
      readonly match: EnvironmentThreadSearchMatch;
    }
  | ThreadSearchSubRow;

/**
 * The threads listed by title, then those listed for their messages with the archived roots among
 * them in the order the server ranked them, each followed by its sub-thread rows.
 */
export function sidebarThreadSearchRows<
  TThread extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(
  titleMatches: ReadonlyArray<TThread>,
  contentMatches: ReadonlyArray<TThread>,
  archived: ReadonlyArray<EnvironmentThreadSearchMatch>,
  messageOrder: ReadonlyArray<string>,
  subRows: ReadonlyMap<string, ReadonlyArray<ThreadSearchSubRow>>,
): Array<SidebarThreadSearchRow<TThread>> {
  const threadRow = (thread: TThread) => ({
    kind: "thread" as const,
    key: scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
    matchKey: threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
    thread,
  });
  const rank = new Map(messageOrder.map((key, index) => [key, index]));
  const byRank = (row: { readonly matchKey: string }) =>
    rank.get(row.matchKey) ?? Number.POSITIVE_INFINITY;
  const messageRows = [
    ...contentMatches.map(threadRow),
    ...archived.map((match) => ({
      kind: "archived" as const,
      key: scopedThreadKey(scopeThreadRef(match.environmentId, match.threadId)),
      matchKey: threadSearchMatchKey(match),
      match,
    })),
  ].toSorted((left, right) => byRank(left) - byRank(right));
  return withThreadSearchSubRows<SidebarThreadSearchRow<TThread>>(
    [...titleMatches.map(threadRow), ...messageRows],
    (row) => (row.kind === "thread" || row.kind === "archived" ? row.matchKey : null),
    subRows,
  );
}
