/**
 * `workstream_spawn`: one child through `thread.spawn`, locked on the caller.
 * The child shares the caller's project, worktree and modes (DL-228), carries
 * its kickoff brief from birth (`brief`, else its purpose — so a spawn starts
 * once its dependencies are done), and a `forkFrom` child inherits its source's
 * role, model and anchor and waits on it; the session fork itself is written
 * at promotion by the control plane (`thread.fork.prepare`, P3-28).
 *
 * @module mcp/toolkits/workstream/handlers/spawn
 */
import { GoalTaskId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { writeWorkstreamBrief } from "../../../../loom/workstream/brief.ts";
import { authoriseTarget, type WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { requestKey, stableCommandId, stableThreadId } from "../idempotency.ts";
import { resolveChildModel, withUpstreamOptionIds } from "../modelSelection.ts";
import { appendWarnings } from "../render.ts";
import { anchorError, gateRoutes, nodeShapeError, trimmed, withImpliedEdges } from "./childNode.ts";
import { asToolError, childrenOf, dispatch, fail, nowIso, requireShell } from "./shared.ts";

const NOTHING = "Nothing was spawned.";

export const workstreamSpawn = Effect.fn("LoomToolkit.workstreamSpawn")(function* (
  input: LoomToolInput<"workstream_spawn">,
  caller: WorkstreamCaller,
) {
  const shapeError = nodeShapeError(input, NOTHING);
  if (shapeError !== undefined) return yield* fail(shapeError);
  const parent = yield* requireShell(caller.threadId);
  const parentRow = yield* authoriseTarget(caller);
  const children = yield* childrenOf(caller.threadId);
  const forkFrom = input.forkFrom === undefined ? undefined : ThreadId.make(input.forkFrom.trim());
  const source = children.find((child) => child.threadId === forkFrom);
  if (forkFrom !== undefined && (source === undefined || source.archivedAt !== null))
    return yield* fail(
      source === undefined
        ? `forkFrom must name an active direct child of this thread — ${forkFrom} is not one. ${NOTHING}`
        : `forkFrom names ${forkFrom}, which is archived and no longer active — an archived thread cannot be forked. ${NOTHING}`,
    );

  const anchorRejection = yield* anchorError(
    parentRow,
    input.anchorTaskId === undefined ? [] : [input.anchorTaskId],
    NOTHING,
  );
  if (anchorRejection !== undefined) return yield* fail(anchorRejection);

  const model =
    source === undefined
      ? yield* resolveChildModel({
          role: trimmed(input.role)!,
          modelSelection: input.modelSelection,
          modelPreset: input.modelPreset,
          taskShape: input.taskShape,
          sensitive: input.sensitive,
          parentSelection: parent.modelSelection,
        })
      : {
          selection: withUpstreamOptionIds((yield* requireShell(source.threadId)).modelSelection),
          warnings: [],
        };
  const gateRework = input.gate === undefined ? undefined : ThreadId.make(input.gate.rework.trim());
  const edges = withImpliedEdges({
    blockedBy: (input.blockedBy ?? []).map((id) => ThreadId.make(id.trim())),
    gateRework,
    forkFrom,
  });

  const key = yield* requestKey(input.clientRequestId);
  const threadId = stableThreadId(caller, key, "workstream-spawn");
  const title = trimmed(input.title)!;
  const purpose = trimmed(input.purpose)!;
  const kickoffBriefPath = yield* asToolError(
    writeWorkstreamBrief(threadId, trimmed(input.brief) ?? purpose),
  );
  yield* dispatch({
    type: "thread.spawn",
    commandId: stableCommandId(caller, key, "workstream-spawn"),
    threadId,
    createdAt: yield* nowIso,
    createdBy: "agent",
    creationSource: "mcp",
    parentThreadId: caller.threadId,
    projectId: parent.projectId,
    title,
    modelSelection: model.selection,
    runtimeMode: parent.runtimeMode,
    interactionMode: parent.interactionMode,
    branch: parent.branch,
    worktreePath: parent.worktreePath,
    role: source === undefined ? trimmed(input.role)! : source.role,
    purpose,
    goalId: parentRow?.goalId ?? null,
    anchorTaskId:
      input.anchorTaskId === undefined
        ? (source?.anchorTaskId ?? null)
        : GoalTaskId.make(input.anchorTaskId),
    kickoffBriefPath,
    blockedBy: edges.blockedBy,
    ...(gateRework === undefined ? {} : { routes: gateRoutes(gateRework, input.gate?.maxRounds) }),
    // Siblings spawned in one parent turn share a generation (the join barrier key).
    spawnGeneration: parent.activeRunId ?? threadId,
    ...(forkFrom === undefined ? {} : { forkFromThreadId: forkFrom }),
  });
  return appendWarnings(`Spawned Workstream sub-thread ${threadId}: ${title}`, [
    ...edges.warnings,
    ...model.warnings,
  ]);
});
