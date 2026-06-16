/**
 * Shared client access to the file-centric goal index (`GET /api/goals`).
 *
 * The server scans each project's worktrees for `goals/<slug>/goal.md`
 * packages and returns the parsed index. This module is the single client-side
 * definition of that wire shape plus the fetch/poll helpers and the shared
 * `TaskTree` renderer, consumed by the sidebar, the home goal overview, and the
 * Tasks right-panel surface.
 */
import { useQuery } from "@tanstack/react-query";
import type { ProjectId } from "@t3tools/contracts";

import { resolvePrimaryEnvironmentHttpUrl } from "../environments/primary";

export interface GoalTaskNode {
  readonly text: string;
  readonly done: boolean;
  readonly children: ReadonlyArray<GoalTaskNode>;
}

export interface GoalIndexEntry {
  readonly projectId: ProjectId;
  readonly slug: string;
  readonly title: string;
  readonly goalParagraph: string;
  readonly tasks: ReadonlyArray<GoalTaskNode>;
  readonly progress: { readonly done: number; readonly total: number };
}

export async function fetchGoalIndex(): Promise<ReadonlyArray<GoalIndexEntry>> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/goals"));
  if (!response.ok) throw new Error(`Failed to load goals (${response.status})`);
  return ((await response.json()) as { goals?: ReadonlyArray<GoalIndexEntry> }).goals ?? [];
}

/** Live-polling read of the goal index (5s), shared across goal surfaces. */
export function useGoalIndex() {
  return useQuery({ queryKey: ["goals"], queryFn: fetchGoalIndex, refetchInterval: 5_000 });
}

export function TaskTree({ tasks }: { tasks: ReadonlyArray<GoalTaskNode> }) {
  return (
    <ul className="space-y-1 pl-1 text-sm text-foreground/85">
      {tasks.map((task, index) => (
        <li key={`${task.text}:${index}`}>
          <div className="flex gap-2">
            <span className="font-mono text-muted-foreground">{task.done ? "[x]" : "[ ]"}</span>
            <span className={task.done ? "text-muted-foreground line-through" : undefined}>
              {task.text}
            </span>
          </div>
          {task.children.length > 0 ? (
            <div className="ml-5 mt-1 border-l border-border/50 pl-3">
              <TaskTree tasks={task.children} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
