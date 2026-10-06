/**
 * `mcp__t3-code__goal_continue`: THIS goal continued in a fresh-context session — a staged
 * root (one of `held`'s two writers, P3-19b) created by one `thread.spawn`
 * with no parent: the caller's goal, project, worktree, branch, model and
 * modes, `held: true`, `continuesThreadId` = the caller, and the brief (with a
 * predecessor pointer) as its kickoff brief. Nothing starts until a human
 * sends; that first send clears `held` (Phase 2 D10). Ported from V1's
 * `GoalHandoffHttp.ts` continue path.
 *
 * @module mcp/toolkits/workstream/handlers/goalContinue
 */
import * as Effect from "effect/Effect";

import { writeWorkstreamBrief } from "../../../../loom/workstream/brief.ts";
import type { WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { agentToolName as t } from "../families.ts";
import { requestKey, stableCommandId, stableThreadId } from "../idempotency.ts";
import { asToolError, dispatch, fail, nowIso, requireActiveGoal, requireShell } from "./shared.ts";

export const goalContinue = Effect.fn("LoomToolkit.goalContinue")(function* (
  input: LoomToolInput<"goal_continue">,
  caller: WorkstreamCaller,
) {
  const brief = input.brief.trim();
  if (!brief) return yield* fail("brief is required.");
  const self = yield* requireShell(caller.threadId);
  const { goal } = yield* requireActiveGoal(caller.threadId).pipe(
    Effect.catchTags({
      LoomToolError: () =>
        fail(`This thread has no active goal to continue (use ${t("goal_handoff")} instead).`),
    }),
  );
  const title = input.threadTitle?.trim() || `${goal.title} (continued)`;
  const key = yield* requestKey(input.clientRequestId);
  const threadId = stableThreadId(caller, key, "goal_continue");
  // The successor can drill into the spent session without the brief carrying everything.
  const kickoffBriefPath = yield* asToolError(
    writeWorkstreamBrief(
      threadId,
      `${brief}\n\n---\nPredecessor: this brief hands off from thread ${caller.threadId} ("${self.title}") on the same goal; ${t("consult_thread")} it for any detail not carried above.`,
    ),
  );
  yield* dispatch({
    type: "thread.spawn",
    commandId: stableCommandId(caller, key, "goal_continue"),
    threadId,
    createdAt: yield* nowIso,
    createdBy: "agent",
    creationSource: "mcp",
    parentThreadId: null,
    projectId: self.projectId,
    title,
    modelSelection: self.modelSelection,
    runtimeMode: self.runtimeMode,
    interactionMode: self.interactionMode,
    branch: self.branch,
    worktreePath: self.worktreePath,
    role: null,
    purpose: title,
    goalId: goal.id,
    kickoffBriefPath,
    held: true,
    continuesThreadId: caller.threadId,
  });
  return `Staged continuation session ${threadId} (${title}) on this goal, sharing this thread's worktree. The human launches it with one send.`;
});
