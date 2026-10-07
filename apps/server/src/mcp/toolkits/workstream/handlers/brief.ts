/**
 * `mcp__t3-code__workstream_brief`: writes an unstarted direct child's kickoff brief to disk
 * and records its path with `thread.kickoff-brief.set`. Delivering the kickoff
 * is the control plane's (the child starts once briefed and unblocked).
 *
 * @module mcp/toolkits/workstream/handlers/brief
 */
import * as Effect from "effect/Effect";

import { writeWorkstreamBrief } from "../../../../loom/workstream/brief.ts";
import type { WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { agentToolName as t } from "../families.ts";
import { requestKey, stableCommandId } from "../idempotency.ts";
import { asToolError, childrenOf, dispatch, fail, nowIso, threadRefIds } from "./shared.ts";

export const workstreamBrief = Effect.fn("LoomToolkit.workstreamBrief")(function* (
  input: LoomToolInput<"workstream_brief">,
  caller: WorkstreamCaller,
) {
  if (input.markdown.trim().length === 0) return yield* fail("markdown is required.");
  const ids = threadRefIds(input.node);
  const target = (yield* childrenOf(caller.threadId)).find(
    (child) =>
      child.archivedAt === null &&
      (ids.includes(child.threadId) || child.graphKey === input.node.trim()),
  );
  if (target === undefined)
    return yield* fail(
      `No direct child matches "${input.node}". A brief may only be attached to a thread you directly parent (by key or thread id).`,
    );
  if (target.kickoffAt !== null)
    return yield* fail(
      `Child ${target.threadId} has already started — its kickoff is fixed. Use ${t("workstream_prompt")} to steer it.`,
    );
  const briefPath = yield* asToolError(writeWorkstreamBrief(target.threadId, input.markdown));
  yield* dispatch({
    type: "thread.kickoff-brief.set",
    commandId: stableCommandId(caller, yield* requestKey(undefined), "workstream-brief"),
    threadId: target.threadId,
    createdAt: yield* nowIso,
    kickoffBriefPath: briefPath,
  });
  return `Attached kickoff brief to Workstream child ${target.threadId}${
    target.graphKey === null ? "" : ` (${target.graphKey})`
  } at ${briefPath}. It launches once its dependencies are done.`;
});
