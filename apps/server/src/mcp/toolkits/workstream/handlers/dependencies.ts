/**
 * `mcp__t3-code__workstream_set_dependencies`: replaces the `blockedBy` set of the caller or
 * a direct child through `thread.dependencies.set`, locked on the target's
 * parent (DL-202). A started thread records the edges for display only.
 *
 * @module mcp/toolkits/workstream/handlers/dependencies
 */
import * as Effect from "effect/Effect";

import { resolveThreadRef } from "../../../../loom/workstream/threadResolve.ts";
import { authoriseTarget, type WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { agentToolName as t } from "../families.ts";
import { requestKey, stableCommandId } from "../idempotency.ts";
import { appendWarnings } from "../render.ts";
import { childrenOf, dispatch, fail, nowIso } from "./shared.ts";

export const workstreamSetDependencies = Effect.fn("LoomToolkit.workstreamSetDependencies")(
  function* (input: LoomToolInput<"workstream_set_dependencies">, caller: WorkstreamCaller) {
    const row = yield* authoriseTarget(caller, input.threadId);
    if (row?.parentThreadId == null)
      return yield* fail(
        "Dependencies have no effect on a root thread — only sub-threads are dependency-gated. Nothing was changed.",
      );
    const siblingIds = new Set(
      (yield* childrenOf(row.parentThreadId)).map((sibling) => sibling.threadId),
    );
    const blockedBy = [...new Set(input.blockedBy.map((ref) => resolveThreadRef(ref, siblingIds)))];
    yield* dispatch({
      type: "thread.dependencies.set",
      commandId: stableCommandId(caller, yield* requestKey(undefined), "workstream-dependencies"),
      threadId: row.threadId,
      createdAt: yield* nowIso,
      parentThreadId: row.parentThreadId,
      blockedBy,
    });
    return appendWarnings(
      `Set Workstream thread ${row.threadId} dependencies (${blockedBy.length} waits-on).`,
      row.kickoffAt === null
        ? []
        : [
            `${row.threadId} has already started: the dependency edge was recorded for DISPLAY ONLY — a started thread is never un-run, so this will not pause or re-gate it. To pause it use ${t("workstream_stop")}; to abandon it set its outcome to cancelled with ${t("workstream_set_outcome")}; to sequence future work, set blockedBy at spawn time.`,
          ],
    );
  },
);
