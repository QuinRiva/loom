/**
 * `workstream_set_outcome`: the plan outcome of the caller or a direct child
 * through `thread.outcome.set` (`none` reopens). A thread may not complete
 * ITSELF around a review gate — a pending rework round or membership of an
 * unresolved gate must finish through `workstream_submit`, whose outcome routes
 * the gate; a parent's `done` on such a child is allowed and the arm's warning
 * is echoed. `cancelled` cascades through the arm's re-drive.
 *
 * @module mcp/toolkits/workstream/handlers/outcome
 */
import { type LoomGateWarningKind, ThreadId } from "@t3tools/contracts";
import { isMemberOfUnresolvedGate } from "@t3tools/shared/workstreamGraph";
import * as Effect from "effect/Effect";

import * as LoomStore from "../../../../loom/projection/LoomStore.ts";
import { authoriseTarget, type WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { agentToolName as t } from "../families.ts";
import { requestKey, stableCommandId } from "../idempotency.ts";
import { appendWarnings } from "../render.ts";
import { asToolError, committed, dispatch, fail, nowIso } from "./shared.ts";

const WARNING_ADVICE: Record<LoomGateWarningKind, string> = {
  "target-done-mid-round": ` Its next ${t("workstream_submit")} still routes to its reviewer for re-verification; to dissolve the gate, set the reviewer done or cancelled instead.`,
  "reopened-with-started-dependents":
    " They keep running; stop or re-plan them if they built on the reopened work.",
};

export const workstreamSetOutcome = Effect.fn("LoomToolkit.workstreamSetOutcome")(function* (
  input: LoomToolInput<"workstream_set_outcome">,
  caller: WorkstreamCaller,
) {
  const row = yield* authoriseTarget(
    caller,
    input.threadId === undefined ? undefined : ThreadId.make(input.threadId.trim()),
  );
  const threadId = row?.threadId ?? caller.threadId;
  if (input.outcome === "done" && threadId === caller.threadId && row !== null) {
    const tree = yield* asToolError(
      (yield* LoomStore.LoomStoreV2).listWorkstreamTree(row.rootThreadId, {
        includeArchived: true,
      }),
    );
    const nodes = tree.map((node) => ({ ...node, id: node.threadId }));
    if (
      row.outcome === null &&
      (row.pendingRework || isMemberOfUnresolvedGate({ ...row, id: threadId }, nodes))
    )
      return yield* fail(
        `This thread is part of an active review gate; finish with ${t("workstream_submit")} (your outcome routes the gate) instead of setting your own outcome to done.`,
      );
  }
  const result = yield* dispatch({
    type: "thread.outcome.set",
    commandId: stableCommandId(caller, yield* requestKey(undefined), "workstream-set-outcome"),
    threadId,
    createdAt: yield* nowIso,
    outcome: input.outcome === "none" ? null : input.outcome,
  });
  const warnings = committed(result, "thread.gate-warning").map(
    ({ payload }) => `${payload.detail}${WARNING_ADVICE[payload.kind]}`,
  );
  return appendWarnings(
    input.outcome === "none"
      ? `Reopened Workstream thread ${threadId}: its outcome is cleared.`
      : `Set Workstream thread ${threadId} outcome to ${input.outcome}.`,
    warnings,
  );
});
