/**
 * `workstream_submit`: writes the caller's report and dispatches
 * `thread.work.submit`; the arm routes the outcome and the echo reports what
 * it decided (from the `thread.outcome-recorded` / `thread.route-taken` events
 * it committed), so "yielded" and a rework route read as NOT done. A
 * completing submit is refused while a hold stands (D19) before any report is
 * written; inside a gate loop each round keeps its own report file.
 *
 * @module mcp/toolkits/workstream/handlers/submit
 */
import { holdErasedByCompletion, routeWorkSubmit } from "@t3tools/shared/workstreamGraph";
import * as Effect from "effect/Effect";

import * as LoomStore from "../../../../loom/projection/LoomStore.ts";
import { SUBMIT_REFUSED_WHILE_RAISED } from "../../../../loom/prompt/prose.ts";
import { writeWorkstreamReport } from "../../../../loom/workstream/report.ts";
import type { WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { requestKey, stableCommandId } from "../idempotency.ts";
import { renderSubmitOutcome } from "../render.ts";
import { asToolError, committed, dispatch, fail, nowIso } from "./shared.ts";

export const workstreamSubmit = Effect.fn("LoomToolkit.workstreamSubmit")(function* (
  input: LoomToolInput<"workstream_submit">,
  caller: WorkstreamCaller,
) {
  if (input.markdown.trim().length === 0) return yield* fail("markdown is required.");
  const outcome = input.outcome?.trim();
  if (outcome === "") return yield* fail("outcome must be a non-empty string when present.");
  const contested = input.contested?.map((entry) => entry.trim());
  if (contested?.some((entry) => entry.length === 0))
    return yield* fail("contested must be an array of non-empty strings.");
  if (input.counts !== undefined && (input.counts.mustFix < 0 || input.counts.niceToHave < 0))
    return yield* fail("counts must be { mustFix, niceToHave } with non-negative integers.");

  const store = yield* LoomStore.LoomStoreV2;
  const row = yield* asToolError(store.getWorkstream(caller.threadId));
  if (row === null)
    return yield* fail(
      `Thread ${caller.threadId} is not a workstream thread; there is nothing to submit to.`,
    );
  // The arm's own routing, mirrored to refuse before a report is written and to name a round's file.
  const tree = yield* asToolError(store.listWorkstreamTree(row.rootThreadId));
  const asNode = (node: typeof row) => ({ ...node, id: node.threadId });
  const routing = routeWorkSubmit(asNode(row), tree.map(asNode), outcome ?? "done");
  if (holdErasedByCompletion({ attention: row.attention, decision: routing.decision }) !== null)
    return yield* fail(SUBMIT_REFUSED_WHILE_RAISED);

  const reportPath = yield* asToolError(
    writeWorkstreamReport(
      caller.threadId,
      input.markdown,
      routing.decision === "loop" ? routing.round : undefined,
    ),
  );
  const result = yield* dispatch({
    type: "thread.work.submit",
    commandId: stableCommandId(caller, yield* requestKey(undefined), "workstream-submit"),
    threadId: caller.threadId,
    createdAt: yield* nowIso,
    reportPath,
    ...(outcome === undefined ? {} : { outcome }),
    ...(contested === undefined ? {} : { contested }),
    ...(input.counts === undefined ? {} : { counts: input.counts }),
  });
  const recorded = committed(result, "thread.outcome-recorded")[0];
  const route = committed(result, "thread.route-taken")[0];
  const echo = renderSubmitOutcome({
    decision: recorded?.payload.decision ?? routing.decision,
    outcome: outcome ?? "done",
    round: recorded?.payload.round ?? routing.round,
    ...(route?.payload.kind === "loop"
      ? { leg: "rework" as const }
      : route?.payload.kind === "loop-back"
        ? { leg: "reverify" as const }
        : {}),
  });
  return `${echo}\nReport: ${reportPath}`;
});
