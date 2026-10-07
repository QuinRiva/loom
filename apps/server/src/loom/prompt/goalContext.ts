/**
 * The once-per-session goal context the composer appends (V1's
 * `activeGoalContextInstruction`, names prefixed). Three variants: a BOUND
 * child gets its branch, the spine it hangs off and a one-line pulse; an
 * UNBOUND child gets the top-level overview and "your brief is your
 * assignment"; the root gets the open plan and the full shaping guidance,
 * since it owns the tree. Every variant says it is a snapshot that
 * `mcp__t3-code__goal_task_list` reads live.
 *
 * @module loom/prompt/goalContext
 */
import type { GoalTaskId, LoomGoal } from "@t3tools/contracts";

import { agentToolName as t } from "../../mcp/toolkits/workstream/families.ts";
import {
  renderGoalPulse,
  renderGoalTaskBranch,
  renderGoalTaskOverview,
  renderOpenGoalTaskTree,
} from "../goals/goalTaskRender.ts";
import { goalTaskSpine, resolveThreadAnchor } from "../goals/goalTaskTree.ts";

export const goalContextInstruction = (
  goal: Pick<LoomGoal, "id" | "slug" | "title" | "description" | "tasks">,
  opts: { readonly asChildBackground: boolean; readonly anchorTaskId: GoalTaskId | null },
): string => {
  const description = goal.description.trim();
  if (opts.asChildBackground) {
    const header = `Background context — your parent orchestrator is working toward this overall goal \`${goal.id}\` (${goal.slug}): ${goal.title}${
      description.length > 0
        ? `\nParent's objective (background only, NOT your task): ${description}`
        : ""
    }`;
    if (goal.tasks.length === 0) return header;
    const anchor = resolveThreadAnchor(goal.tasks, opts.anchorTaskId);
    return anchor !== null
      ? [
          header,
          `\n\nWhat follows is a spawn snapshot of the branch you own; \`${t("goal_task_list")}\` reads it live.\n\n${renderGoalTaskBranch(anchor, goalTaskSpine(goal.tasks, anchor.id))}`,
          `\n\n${renderGoalPulse(goal.tasks, anchor)} — \`${t("goal_task_list")}\` with scope "tree" reads all of it.`,
          `\n\nTick your own tasks with \`${t("goal_task_update")}\` as each lands, and reshape your branch in ONE \`${t("goal_tasks_rewrite")}\` when its shape stops matching the work: submit exactly the branch block above, keeping every retained \`(id)\`; your anchor stays its root line. Tasks outside your branch are read-only — record discovered work with \`${t("goal_task_add")}\` (it lands in your branch by default; pass a parentTaskId to place it elsewhere, and the echo shows where it landed) and say what needs doing in your report. Anything you write is a short plain-language work item naming the outcome and value, for a reader outside this thread (the server rejects text over 300 characters); details, findings and verdicts go in your report or memo.`,
        ].join("")
      : [
          header,
          `\n\nParent's plan at a glance, one line per phase with its subtree's done/total (a spawn snapshot; \`${t("goal_task_list")}\` reads the tree live and in full):\n${renderGoalTaskOverview(goal.tasks)}`,
          `\n\nYou have no task of your own in this tree: your brief is your assignment. Record discovered actionable work with \`${t("goal_task_add")}\` under the phase it belongs to, as a short plain-language item naming the outcome and value for a reader outside this thread (the server rejects text over 300 characters); findings, verdicts and details go in your report or memo. Restructuring belongs to the tree's owner — \`${t("goal_tasks_rewrite")}\` is rejected for a child with no branch of its own, so report a bad shape.`,
        ].join("");
  }
  const header = `Active goal \`${goal.id}\` (${goal.slug}): ${goal.title}${
    description.length > 0 ? `\nObjective: ${description}` : ""
  }`;
  if (goal.tasks.length === 0) return header;
  return [
    header,
    `\n\nCurrent tasks (finished subtrees are elided as "… N done tasks elided"):\n${renderOpenGoalTaskTree(goal.tasks).trimEnd()}`,
    `\n\nThis tree is the human's at-a-glance view of the plan, so keep it shaped — not merely appended to:\n- Write for a reader who has NOT lived this thread: short imperative plain-language tasks (about a dozen words) naming the outcome and value, not the mechanism. The server rejects text over 300 characters.\n- The tree records THAT work exists and whether it is done, never its details: coordinates live in the task's thread; findings, verdicts and decisions in reports or memos; draft content in its artefact. At most one short ticket or artefact pointer belongs in a task. Keep the goal description a short objective, not a journal.\n  Not: "AIT-101 — re-key the Lease Extraction tab off names: tenant_id-FIRST with NAME FALLBACK (002336 bucket keyed by name-hash 13ef806c… ≠ roster id aacbb602…); MUST land before 450112/450117 re-trigger"\n  But: "Fix renamed tenants vanishing from the client's lease tab (re-key by tenant id; AIT-101)"\n- Finish by ticking a task, never by rewriting it into a result record; outcomes go in a report or memo.\n- Nest. Top-level items are phases or themes (aim for 7 or fewer); concrete work hangs under them. A flat list past ~8 items needs restructuring.\n- Update at the seams: when you plan or re-plan, when delegated work lands, when scope changes.\n- The snapshot above is never refreshed, and its elision markers make it unusable as rewrite input on purpose — \`${t("goal_task_list")}\` reads the live tree in full, and every mutation echoes what you changed. \`${t("goal_task_add")}\` appends one item; \`${t("goal_task_update")}\` renames or marks done; \`${t("goal_update")}\` edits the goal. When the shape stops matching the plan, fix it in ONE \`${t("goal_tasks_rewrite")}\` call: submit the whole edited markdown from a fresh \`${t("goal_task_list")}\`, retaining each kept task's \`(id)\`.`,
  ].join("");
};
