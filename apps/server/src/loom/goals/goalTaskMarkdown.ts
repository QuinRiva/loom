/**
 * The markdown seam of the declarative whole-tree rewrite (`mcp__t3-code__goal_tasks_rewrite`
 * / `t3 goal task rewrite`): read format IS write format. `goalTaskRender.ts`
 * turns a tree into the indented `- [x] text (id)` checklist every read surface
 * emits; this module turns that checklist back into the entries
 * `LoomStoreV2.tasks.replaceTree` takes.
 *
 * The contract both directions honour is ROUND-TRIP IDENTITY: parsing
 * `renderGoalTaskTree(tree)` reproduces that tree's tasks exactly, so an
 * unedited `mcp__t3-code__goal_task_list` output resubmitted verbatim changes nothing.
 *
 * Pure functions only — id minting lives at the edge that calls these.
 *
 * @module loom/goals/goalTaskMarkdown
 */
import { GoalTaskId } from "@t3tools/contracts";

import { agentToolName } from "../../mcp/toolkits/workstream/families.ts";
import type { LoomGoalTaskInput } from "../projection/LoomStore.ts";
import type { FlatGoalTask, GoalTaskLine } from "./goalTaskTree.ts";

export const MAX_GOAL_TASK_TEXT_LENGTH = 300;

/**
 * One parsed checklist line. `taskId` is set only when the line carried an
 * `(id)` of an existing task (a line without one is always a new task);
 * `parentIndex` points at the parent's index in this same list, so parents
 * always precede their children.
 */
export interface ParsedGoalTaskLine extends GoalTaskLine {
  readonly position: number;
}

/** Either the parsed lines, or the reason nothing can be applied. */
export type ParsedGoalTaskMarkdown =
  | { readonly lines: ReadonlyArray<ParsedGoalTaskLine> }
  | { readonly error: string };

/** Validates text written by add/update, where every supplied text is new. */
export const validateGoalTaskText = (text: string): string | undefined =>
  text.length > MAX_GOAL_TASK_TEXT_LENGTH
    ? `Task text is ${text.length.toLocaleString("en-US")} characters; the limit is ${MAX_GOAL_TASK_TEXT_LENGTH}. The tree is the human's at-a-glance view of the plan — a task records THAT work exists, never its details. State the work as a short plain-language item (e.g. "Fix renamed tenants vanishing from the client's lease tab (re-key by tenant id; AIT-101)"); put coordinates in the task's thread, findings and verdicts in a report or memo, and draft content in its artefact. Keep the goal description a short objective, not a journal.`
    : undefined;

/**
 * Validates a whole-tree rewrite without stranding historic walls: retained
 * text is grandfathered, while every new or renamed line must fit the cap.
 */
export const validateGoalTaskRewriteText = (
  lines: ReadonlyArray<ParsedGoalTaskLine>,
  current: ReadonlyArray<Pick<FlatGoalTask, "id" | "text">>,
): string | undefined => {
  const currentById = new Map<string, string>(current.map((task) => [task.id, task.text]));
  const index = lines.findIndex(
    (line) =>
      (line.taskId === null || currentById.get(line.taskId) !== line.text) &&
      validateGoalTaskText(line.text) !== undefined,
  );
  if (index < 0) return undefined;
  const line = lines[index]!;
  return `Line ${index + 1} ("${line.text}") was rejected. ${validateGoalTaskText(line.text)} Nothing was applied.`;
};

// `- ` / `* ` bullet, optional `[ ]`/`[x]`/`[X]` checkbox (absent => open), text.
const TASK_LINE = /^([ \t]*)[-*][ \t]+(?:\[([ xX])\][ \t]*)?(.*\S)[ \t]*$/;
// A trailing `(token)` is an id when it names a task of this goal — that is the
// authority, so a task id of any shape round-trips. Uuid shape only decides
// what an UNKNOWN token means: a well-formed uuid is a stale read, anything
// else ("(WP2)") is just part of the task text.
const TRAILING_TOKEN = /^(.*?)[ \t]*\(([^\s()]+)\)$/;
const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Two spaces per level; a tab counts as one whole level. */
const indentDepth = (indent: string): number =>
  [...indent].reduce((units, char) => units + (char === "\t" ? 2 : 1), 0) >> 1;

/**
 * Parses an indented markdown checklist into a flat, topologically ordered
 * list. Tolerant on whitespace, strict on meaning: an unparseable line, an
 * `(id)` that is not a task of this goal (a stale read), a repeated id, or a
 * submission with no task lines all fail the whole submission.
 */
export const parseGoalTaskMarkdown = (
  markdown: string,
  knownTaskIds: ReadonlySet<string>,
): ParsedGoalTaskMarkdown => {
  const lines: Array<ParsedGoalTaskLine> = [];
  const openAncestors: Array<{ readonly depth: number; readonly index: number }> = [];
  const nextPosition = new Map<number, number>();
  const seen = new Set<string>();

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
          error: `Line "${raw.trim()}" carries task id ${id}, which is not a task in this goal — your view of the tree is stale (or the id was mistyped). Re-read the tree (${agentToolName("goal_task_list")}, or \`t3 goal show\`) and rewrite from what it returns; drop the "(id)" to submit the line as a new task.`,
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
    if (text.length === 0) return { error: `Line "${raw.trim()}" has no task text.` };

    // Depth binds to the nearest shallower preceding line.
    const depth = indentDepth(indent);
    while (openAncestors.length > 0 && openAncestors.at(-1)!.depth >= depth) openAncestors.pop();
    const parentIndex = openAncestors.at(-1)?.index ?? null;
    const position = nextPosition.get(parentIndex ?? -1) ?? 0;
    nextPosition.set(parentIndex ?? -1, position + 1);
    openAncestors.push({ depth, index: lines.length });
    lines.push({ taskId, parentIndex, text, done: checkbox === "x" || checkbox === "X", position });
  }

  return lines.length === 0
    ? {
        error:
          "The submitted tree is empty. Wiping the whole task tree must be deliberate: submit at least one task line.",
      }
    : { lines };
};

/**
 * Resolves parsed lines against the current tree into store entries — minting
 * ids for new lines — and summarises the diff (added / edited / moved /
 * removed). `current` is in tree order (`flattenGoalTasks`): positions are
 * re-derived densely from document order, so "moved" compares a task's RANK
 * among its siblings, never the stored position integer.
 */
export const resolveGoalTaskRewrite = (input: {
  readonly lines: ReadonlyArray<GoalTaskLine & { readonly position: number }>;
  readonly current: ReadonlyArray<FlatGoalTask>;
  readonly mintTaskId: () => GoalTaskId;
}): {
  readonly tasks: ReadonlyArray<LoomGoalTaskInput>;
  readonly summary: string;
  /** False when the submission restates the current tree — nothing to write. */
  readonly changed: boolean;
} => {
  const currentById = new Map<string, FlatGoalTask>(input.current.map((task) => [task.id, task]));
  const ids = input.lines.map((line) => line.taskId ?? input.mintTaskId());
  const tasks = input.lines.map((line, index): LoomGoalTaskInput => ({
    id: ids[index]!,
    parentTaskId: line.parentIndex === null ? null : ids[line.parentIndex]!,
    text: line.text,
    done: line.done,
    position: line.position,
  }));

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
    const existing = currentById.get(task.id);
    if (!existing) counts.added += 1;
    else {
      if (existing.text !== task.text || existing.done !== task.done) counts.edited += 1;
      if (
        existing.parentTaskId !== task.parentTaskId ||
        currentRank.get(task.id) !== task.position
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
