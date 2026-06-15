// @effect-diagnostics nodeBuiltinImport:off
/**
 * Goal package = the source-of-truth files in a worktree (§1.2). The canonical
 * file is `goals/<slug>/goal.md`, anchored by three sections:
 *
 *   # <title>
 *   ## Goal      -> the north-star paragraph (human-facing)
 *   ## Tasks     -> a nested `- [ ]` / `- [x]` checklist (the TODO tree)
 *
 * This module is the SOLE reader of that convention: it parses one goal.md and
 * discovers all goals across a project's worktrees (`git worktree list` then
 * scan each worktree for `goals/<slug>/goal.md`). The DB goal aggregate is a derived
 * index of the metadata returned here — a re-read always wins (§1.1).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface GoalTaskNode {
  readonly text: string;
  readonly done: boolean;
  readonly children: ReadonlyArray<GoalTaskNode>;
}

export interface ParsedGoalPackage {
  readonly title: string;
  readonly goalParagraph: string;
  readonly tasks: ReadonlyArray<GoalTaskNode>;
}

export interface DiscoveredGoal extends ParsedGoalPackage {
  /** Directory name under `goals/` — the goal's stable slug. */
  readonly slug: string;
  /** Absolute path to the hosting worktree. */
  readonly worktreePath: string;
  /** The worktree's checked-out branch (or `(detached)`). */
  readonly branch: string;
  /** `goals/<slug>` relative to the worktree. */
  readonly packagePath: string;
}

const HEADING_2 = /^##\s+(.+?)\s*$/;
const TASK_LINE = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*\S)\s*$/;

/** Parse a `goal.md` body into its three pinned anchors. */
export function parseGoalMarkdown(markdown: string): ParsedGoalPackage {
  const lines = markdown.split(/\r?\n/);
  const titleLine = lines.find((line) => /^#\s+\S/.test(line));
  const title = titleLine ? titleLine.replace(/^#\s+/, "").trim() : "Untitled goal";

  const sectionLines = (name: string): string[] => {
    const start = lines.findIndex((line) => HEADING_2.exec(line)?.[1]?.toLowerCase() === name);
    if (start === -1) return [];
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^#{1,2}\s+\S/.test(line));
    return end === -1 ? rest : rest.slice(0, end);
  };

  const goalParagraph = sectionLines("goal").join("\n").trim();
  return { title, goalParagraph, tasks: parseTaskTree(sectionLines("tasks")) };
}

/** Build a nested task tree from checklist lines; nesting = indentation width. */
function parseTaskTree(lines: ReadonlyArray<string>): GoalTaskNode[] {
  const roots: GoalTaskNode[] = [];
  // Stack of { indent, children } frames; children arrays are mutated in place.
  const stack: Array<{ indent: number; children: GoalTaskNode[] }> = [
    { indent: -1, children: roots },
  ];
  for (const line of lines) {
    const match = TASK_LINE.exec(line);
    if (!match) continue;
    const indent = match[1]!.replace(/\t/g, "  ").length;
    const node: GoalTaskNode = {
      text: match[3]!,
      done: match[2]!.toLowerCase() === "x",
      children: [],
    };
    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) stack.pop();
    stack[stack.length - 1]!.children.push(node);
    stack.push({ indent, children: node.children as GoalTaskNode[] });
  }
  return roots;
}

/** Flattened task progress for overview "progress-at-a-glance" rendering. */
export function taskProgress(tasks: ReadonlyArray<GoalTaskNode>): {
  done: number;
  total: number;
} {
  return tasks.reduce(
    (acc, task) => {
      const child = taskProgress(task.children);
      return { done: acc.done + (task.done ? 1 : 0) + child.done, total: acc.total + 1 + child.total };
    },
    { done: 0, total: 0 },
  );
}

export interface WorktreeEntry {
  readonly path: string;
  readonly branch: string;
}

/** Parse `git worktree list --porcelain` from a project's workspace root. */
export function listWorktrees(workspaceRoot: string): WorktreeEntry[] {
  const porcelain = execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  });
  const entries: WorktreeEntry[] = [];
  let path: string | undefined;
  let branch = "(detached)";
  const flush = () => {
    if (path) entries.push({ path, branch });
    path = undefined;
    branch = "(detached)";
  };
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).replace(/^refs\/heads\//, "").trim();
    }
  }
  flush();
  return entries;
}

/** Discover goal packages (goals/<slug>/goal.md) inside a single worktree. */
export function discoverGoalsInWorktree(worktree: WorktreeEntry): DiscoveredGoal[] {
  const goalsDir = join(worktree.path, "goals");
  if (!existsSync(goalsDir)) return [];
  return readdirSync(goalsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const goalFile = join(goalsDir, entry.name, "goal.md");
      if (!existsSync(goalFile)) return [];
      return [
        {
          slug: basename(entry.name),
          worktreePath: worktree.path,
          branch: worktree.branch,
          packagePath: join("goals", entry.name),
          ...parseGoalMarkdown(readFileSync(goalFile, "utf8")),
        },
      ];
    });
}

/** Discover all goal packages across every worktree of a project. */
export function discoverGoals(workspaceRoot: string): DiscoveredGoal[] {
  return listWorktrees(workspaceRoot).flatMap(discoverGoalsInWorktree);
}
