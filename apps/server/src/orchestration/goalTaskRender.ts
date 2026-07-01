/**
 * Shared rendering for a goal's task tree. Both the once-per-session prompt
 * injection (`ProviderCommandReactor`), the human-facing `t3 goal show` CLI
 * (`cli/goal.ts`), and the on-demand `goal_task_list` read tool
 * (`mcp/GoalTaskHttp.ts`) render the SAME `- [x] text (id)` indented form — this
 * is the single place that shape lives.
 */
import type { OrchestrationGoalTask } from "@t3tools/contracts";

/** Indented `- [x] text (id)` tree, one line per task, deepest last. */
export const renderGoalTaskTree = (
  tasks: ReadonlyArray<OrchestrationGoalTask>,
  depth = 0,
): string =>
  tasks
    .map(
      (task) =>
        `${"  ".repeat(depth)}- [${task.done ? "x" : " "}] ${task.text} (${task.id})\n` +
        renderGoalTaskTree(task.children, depth + 1),
    )
    .join("");

export interface GoalTaskNode {
  readonly id: string;
  readonly text: string;
  readonly done: boolean;
  readonly position: number;
  readonly children: ReadonlyArray<GoalTaskNode>;
}

/** Structured tree carrying only the fields an agent acts on. */
export const toGoalTaskNodes = (
  tasks: ReadonlyArray<OrchestrationGoalTask>,
): ReadonlyArray<GoalTaskNode> =>
  tasks.map((task) => ({
    id: task.id,
    text: task.text,
    done: task.done,
    position: task.position,
    children: toGoalTaskNodes(task.children),
  }));
