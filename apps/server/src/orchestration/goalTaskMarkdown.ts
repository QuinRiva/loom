/**
 * The markdown seam of the declarative whole-tree rewrite (`goal_tasks_rewrite`
 * / `t3 goal task rewrite`): read format IS write format. `goalTaskRender.ts`
 * turns a tree into the indented `- [x] text (id)` checklist every read surface
 * emits; this module turns that checklist back into a fully-resolved flat list
 * ready for `goal.tasks.rewrite`.
 *
 * The contract both directions must honour is ROUND-TRIP IDENTITY: parsing
 * `renderGoalTaskTree(tree)` reproduces that tree's tasks exactly, so an
 * unedited `goal_task_list` output resubmitted verbatim changes nothing.
 *
 * Pure functions only — id minting and clock live at the edge that calls these.
 */
import { GoalTaskId, type GoalTaskRewriteEntry } from "@t3tools/contracts";

import type { FlatGoalTask } from "./goalTaskTree.ts";

/**
 * One parsed checklist line. `taskId` is set only when the line carried an
 * `(id)` of an existing task (id-only matching — a line without one is always a
 * new task); `parentIndex` points at the parent's index in this same list, so
 * parents always precede their children as the decider requires.
 */
export interface ParsedGoalTaskLine {
  readonly taskId: GoalTaskId | null;
  readonly parentIndex: number | null;
  readonly text: string;
  readonly done: boolean;
  readonly position: number;
}

/** Either the parsed lines, or the 400-worthy reason nothing can be applied. */
export type ParsedGoalTaskMarkdown =
  | { readonly lines: ReadonlyArray<ParsedGoalTaskLine> }
  | { readonly error: string };

// `- ` / `* ` bullet, optional `[ ]`/`[x]`/`[X]` checkbox (absent => open), text.
const TASK_LINE = /^([ \t]*)[-*][ \t]+(?:\[([ xX])\][ \t]*)?(.*\S)[ \t]*$/;
// A trailing `(token)` is an id when it names a task of this goal — that is the
// authority, so a task id of any shape round-trips. Uuid shape only decides
// what an UNKNOWN token means: a well-formed uuid is a stale read (400),
// anything else ("(WP2)") is just part of the task text.
const TRAILING_TOKEN = /^(.*?)[ \t]*\(([^\s()]+)\)$/;
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Two spaces per level; a tab counts as one whole level. */
const indentDepth = (indent: string): number =>
  [...indent].reduce((units, char) => units + (char === "\t" ? 2 : 1), 0) >> 1;

/**
 * Parse an indented markdown checklist into a flat, topologically ordered list.
 * Tolerant on whitespace, strict on meaning: an unparseable line, an `(id)` that
 * is not a task of this goal (a stale read), a repeated id, or a submission with
 * no task lines all fail the whole submission.
 */
export const parseGoalTaskMarkdown = (
  markdown: string,
  knownTaskIds: ReadonlySet<string>,
): ParsedGoalTaskMarkdown => {
  const lines: ParsedGoalTaskLine[] = [];
  const openAncestors: Array<{ readonly depth: number; readonly index: number }> = [];
  const nextPosition = new Map<number, number>();
  const seen = new Set<string>();

  // CRLF is ordinary in file/stdin submissions (the WP4 CLI reads both); a
  // trailing `\r` would otherwise fail every line on a presentation detail.
  for (const raw of markdown.split(/\r?\n/)) {
    if (raw.trim().length === 0) continue;
    const match = TASK_LINE.exec(raw);
    if (!match) {
      return {
        error: `Could not parse this line as a task: "${raw.trim()}". Every line must be a checklist item like "- [ ] Do the thing" or "- [x] Done thing (task-id)", indented two spaces per level of nesting.`,
      };
    }
    const [, indent = "", checkbox, body = ""] = match;

    const trailing = TRAILING_TOKEN.exec(body);
    const id = trailing?.[2];
    let taskId: GoalTaskId | null = null;
    let text = body;
    if (id !== undefined && (knownTaskIds.has(id) || UUID_SHAPE.test(id))) {
      if (!knownTaskIds.has(id)) {
        return {
          error: `Line "${raw.trim()}" carries task id ${id}, which is not a task in this goal — your view of the tree is stale (or the id was mistyped). Re-read the tree (goal_task_list, or \`t3 goal show\`) and rewrite from what it returns; drop the "(id)" to submit the line as a new task.`,
        };
      }
      if (seen.has(id)) {
        return {
          error: `Task id ${id} appears on more than one line; each existing task may appear at most once in a rewrite.`,
        };
      }
      seen.add(id);
      taskId = GoalTaskId.make(id);
      text = trailing![1]!.trim();
    }
    if (text.length === 0) {
      return { error: `Line "${raw.trim()}" has no task text.` };
    }

    // Depth binds to the nearest shallower preceding line.
    const depth = indentDepth(indent);
    while (openAncestors.length > 0 && openAncestors.at(-1)!.depth >= depth) openAncestors.pop();
    const parentIndex = openAncestors.at(-1)?.index ?? null;
    const position = nextPosition.get(parentIndex ?? -1) ?? 0;
    nextPosition.set(parentIndex ?? -1, position + 1);
    openAncestors.push({ depth, index: lines.length });
    lines.push({ taskId, parentIndex, text, done: checkbox === "x" || checkbox === "X", position });
  }

  if (lines.length === 0) {
    return {
      error:
        "The submitted tree is empty. Wiping the whole task tree must be deliberate: submit at least one task line.",
    };
  }
  return { lines };
};

/**
 * Resolve parsed lines against the current tree into command entries: mint ids
 * for new lines, copy `createdAt` from retained tasks, and summarise the diff
 * for the caller's echo (added / edited / moved / removed).
 *
 * `current` must be in tree order (i.e. `flattenGoalTasks(goal.tasks)`): the
 * rewrite re-derives positions densely from document order, so "moved" compares
 * a task's RANK among its siblings, not the stored position integer — otherwise
 * resubmitting an unedited tree whose stored positions are sparse (an append
 * after a delete leaves gaps) would report phantom moves.
 */
export const resolveGoalTaskRewrite = (input: {
  readonly lines: ReadonlyArray<ParsedGoalTaskLine>;
  readonly current: ReadonlyArray<FlatGoalTask>;
  readonly mintTaskId: () => GoalTaskId;
  readonly now: string;
}): {
  readonly tasks: ReadonlyArray<GoalTaskRewriteEntry>;
  readonly summary: string;
  /** False when the submission restates the current tree — nothing to dispatch. */
  readonly changed: boolean;
} => {
  const currentById = new Map(input.current.map((task) => [task.id as string, task]));
  const ids = input.lines.map((line) => line.taskId ?? input.mintTaskId());
  const tasks = input.lines.map(
    (line, index): GoalTaskRewriteEntry => ({
      taskId: ids[index]!,
      parentTaskId: line.parentIndex === null ? null : ids[line.parentIndex]!,
      text: line.text,
      done: line.done,
      position: line.position,
      createdAt: currentById.get(ids[index]!)?.createdAt ?? input.now,
    }),
  );

  const siblingsSeen = new Map<string, number>();
  const currentRank = new Map<string, number>();
  for (const task of input.current) {
    const rank = siblingsSeen.get(task.parentTaskId ?? "") ?? 0;
    siblingsSeen.set(task.parentTaskId ?? "", rank + 1);
    currentRank.set(task.id, rank);
  }

  const submitted = new Set<string>(ids);
  const counts = { added: 0, edited: 0, moved: 0, removed: 0 };
  for (const task of tasks) {
    const existing = currentById.get(task.taskId);
    if (!existing) counts.added += 1;
    else {
      if (existing.text !== task.text || existing.done !== task.done) counts.edited += 1;
      if (
        existing.parentTaskId !== task.parentTaskId ||
        currentRank.get(task.taskId) !== task.position
      ) {
        counts.moved += 1;
      }
    }
  }
  counts.removed = input.current.filter((task) => !submitted.has(task.id)).length;

  const parts = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${count} ${label}`);
  return {
    tasks,
    changed: parts.length > 0,
    summary:
      parts.length === 0
        ? "Rewrote the task tree: no changes (the submitted tree matches the current one)."
        : `Rewrote the task tree: ${parts.join(", ")}.`,
  };
};
