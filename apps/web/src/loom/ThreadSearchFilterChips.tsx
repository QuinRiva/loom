import {
  DEFAULT_THREAD_SEARCH_FILTERS,
  isDefaultThreadSearchFilters,
  type ThreadSearchFilters,
} from "@t3tools/client-runtime/state/loom/threadSearch";
import type { ProjectId } from "@t3tools/contracts";
import type { MouseEvent, ReactNode } from "react";

import { Button } from "~/components/ui/button";

// Focus stays in the search box, so typing carries on after a flip.
const keepFocus = (event: MouseEvent) => event.preventDefault();

function Chip(props: { on: boolean; onToggle: () => void; title?: string; children: ReactNode }) {
  return (
    <Button
      size="xs"
      variant={props.on ? "default" : "outline"}
      aria-pressed={props.on}
      onMouseDown={keepFocus}
      onClick={props.onToggle}
      {...(props.title === undefined ? {} : { title: props.title })}
    >
      {props.children}
    </Button>
  );
}

/**
 * What a search reads, beside its box: Sub-threads, Archived and, where the surface offers one, a
 * project. Reset shows while anything is on.
 */
export function ThreadSearchFilterChips(props: {
  readonly filters: ThreadSearchFilters;
  readonly onChange: (filters: ThreadSearchFilters) => void;
  /** The one project this surface offers as a switch; omitted, no project chip. */
  readonly project?: { readonly id: ProjectId; readonly title: string | null } | null;
}) {
  const { filters, onChange, project } = props;
  const projectOn =
    project != null && filters.projectIds?.length === 1 && filters.projectIds[0] === project.id;
  return (
    <div
      role="group"
      aria-label="Search filters"
      className="flex min-w-0 items-center gap-1 overflow-hidden"
    >
      <Chip
        on={filters.subThreads}
        onToggle={() => onChange({ ...filters, subThreads: !filters.subThreads })}
      >
        Sub-threads
      </Chip>
      <Chip
        on={filters.archived}
        onToggle={() => onChange({ ...filters, archived: !filters.archived })}
      >
        Archived
      </Chip>
      {project ? (
        <Chip
          on={projectOn}
          onToggle={() => {
            const { projectIds: _projectIds, ...rest } = filters;
            onChange(projectOn ? rest : { ...rest, projectIds: [project.id] });
          }}
          title={`Only ${project.title ?? "this project"}`}
        >
          <span className="max-w-40 truncate">{project.title ?? "This project"}</span>
        </Chip>
      ) : null}
      {isDefaultThreadSearchFilters(filters) ? null : (
        <span className="ms-auto shrink-0">
          <Button
            variant="ghost-muted"
            size="xs"
            onMouseDown={keepFocus}
            onClick={() => onChange(DEFAULT_THREAD_SEARCH_FILTERS)}
          >
            Reset
          </Button>
        </span>
      )}
    </div>
  );
}
