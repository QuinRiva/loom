import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import type { ReactNode } from "react";

import { ProjectFavicon, type ProjectFaviconProject } from "~/components/ProjectFavicon";
import { ThreadSearchMatchExcerpt } from "~/components/ThreadSearchMatch";
import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";

/** Sidebar search row for an archived root: the client holds no shell for it,
    so everything shown comes from the search match. */
export function ArchivedSearchResultRow(props: {
  match: EnvironmentThreadSearchMatch;
  project: ProjectFaviconProject | null;
  time: ReactNode;
  isHighlighted: boolean;
  isRouteActive: boolean;
  resultId: string;
  resultKey: string;
  searchQuery: string;
  onHighlight: () => void;
  onSelect: () => void;
}) {
  return (
    <li role="presentation" className="list-none">
      <button
        id={props.resultId}
        data-search-result-key={props.resultKey}
        type="button"
        role="option"
        tabIndex={-1}
        aria-selected={props.isHighlighted}
        aria-current={props.isRouteActive ? "page" : undefined}
        aria-label={`${props.match.title}, archived`}
        onMouseMove={props.onHighlight}
        onClick={props.onSelect}
        className={cn(
          "flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-1 text-left text-sm outline-none",
          props.isHighlighted || props.isRouteActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        )}
      >
        {props.project ? (
          <ProjectFavicon project={props.project} className="size-4 shrink-0 opacity-60" />
        ) : null}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2.5">
            <span className="min-w-0 flex-1 truncate">
              {props.match.title || "Untitled thread"}
            </span>
            <ArchivedBadge />
            <span className="w-8 shrink-0 text-right text-xs text-muted-foreground/55 tabular-nums">
              {props.time}
            </span>
          </span>
          <ThreadSearchMatchExcerpt match={{ ...props.match, query: props.searchQuery }} />
        </span>
      </button>
    </li>
  );
}

export function ArchivedBadge() {
  return (
    <Badge variant="outline" size="sm">
      Archived
    </Badge>
  );
}
