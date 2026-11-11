/**
 * `workstream_submit`: writes the report, dispatches `thread.work.submit` and echoes the route the arm
 * committed, so "yielded" and rework read as NOT done. Every refusal the arm would make (terminal
 * thread, reserved outcome, a completion erasing a hold) and a missing response block are refused
 * before writing, so a refused submit never replaces the record; each gate round has its own file.
 */
import {
  gateLoopTargetsOf,
  holdErasedByCompletion,
  routeWorkSubmit,
  workSubmitRefusal,
} from "@t3tools/shared/workstreamGraph";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { renderOpenBranch } from "../../../../loom/goals/goalTaskRender.ts";
import { resolveThreadAnchor } from "../../../../loom/goals/goalTaskTree.ts";
import * as LoomStore from "../../../../loom/projection/LoomStore.ts";
import { humanSpokeInTurn } from "../../../../loom/orchestration/turns.ts";
import {
  NO_RESPONSE_BLOCK,
  SUBMIT_REFUSED_WHILE_HELD,
  SUBMIT_REFUSED_WHILE_RAISED,
} from "../../../../loom/prompt/prose.ts";
import { formatWakeTimestamp } from "../../../../loom/orchestration/dispatcher/wakes.ts";
import {
  appendWorkstreamReport,
  REPORT_ADDITION_HEADING,
  repeatsReport,
  reportResponse,
  writeWorkstreamReport,
} from "../../../../loom/workstream/report.ts";
import { resolveThreadRef } from "../../../../loom/workstream/threadResolve.ts";
import * as Orchestrator from "../../../../orchestration-v2/Orchestrator.ts";
import type { WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { requestKey, stableCommandId } from "../idempotency.ts";
import {
  HELD_AGAIN_ECHO,
  renderSubmitOutcome,
  REPORT_ADDITION_ECHO,
  REPORT_REPEAT_REFUSAL,
} from "../render.ts";
import { asToolError, committed, dispatch, fail, nowIso } from "./shared.ts";

export const workstreamSubmit = Effect.fn("LoomToolkit.workstreamSubmit")(function* (
  input: LoomToolInput<"workstream_submit">,
  caller: WorkstreamCaller,
) {
  if (input.markdown.trim().length === 0) return yield* fail("markdown is required.");
  if (reportResponse(input.markdown).source !== "block") return yield* fail(NO_RESPONSE_BLOCK);
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
  const siblings = gateLoopTargetsOf(row);
  const rework = input.rework?.map((ref) => resolveThreadRef(ref, new Set(siblings)));
  const routing = routeWorkSubmit(asNode(row), tree.map(asNode), outcome ?? "done", rework);
  // A finished thread a human has written to since it finished adds to its report: no event, so
  // nothing behind it moves and its parent is not told (a gate rework round still routes).
  if (
    row.outcome === "done" &&
    row.reportPath !== null &&
    row.outcomeAt !== null &&
    !(row.pendingRework && routing.decision === "loop")
  ) {
    const finishedAt = Date.parse(row.outcomeAt);
    const { messages } = yield* asToolError(
      Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
        orchestrator.getThreadRecords(caller.threadId, ["messages"], { messageRoles: ["user"] }),
      ),
    );
    if (
      messages.some(
        (message) =>
          message.loom?.humanAuthored === true &&
          DateTime.toEpochMillis(message.createdAt) > finishedAt,
      )
    ) {
      const fs = yield* FileSystem.FileSystem;
      const report = yield* asToolError(fs.readFileString(row.reportPath));
      if (repeatsReport(report, input.markdown)) return yield* fail(REPORT_REPEAT_REFUSAL);
      const section = `\n\n${REPORT_ADDITION_HEADING}${formatWakeTimestamp(yield* nowIso)}\n\n${input.markdown}`;
      yield* asToolError(appendWorkstreamReport(caller.threadId, row.reportPath, section));
      return `${REPORT_ADDITION_ECHO}\nReport: ${row.reportPath}`;
    }
  }
  const refusal = workSubmitRefusal(
    asNode(row),
    outcome ?? "done",
    routing.decision,
    false,
    rework,
  );
  if (refusal !== null) return yield* fail(refusal);
  const held = row.attention.includes("awaiting_acceptance");
  const completes = routing.decision === "terminal" || routing.decision === "resolve";
  const humanInTurn =
    held && (completes || outcome === "awaiting_acceptance")
      ? yield* Orchestrator.OrchestratorV2.pipe(
          Effect.flatMap((orchestrator) =>
            orchestrator.getThreadRecords(caller.threadId, ["runs", "messages"], {
              messageRoles: ["user"],
            }),
          ),
          Effect.map(({ runs, messages }) => humanSpokeInTurn(runs, messages)),
          asToolError,
        )
      : false;
  const erased = holdErasedByCompletion({
    attention: row.attention,
    decision: routing.decision,
    humanInTurn,
  });
  if (erased !== null)
    return yield* fail(
      erased === "awaiting_acceptance" ? SUBMIT_REFUSED_WHILE_HELD : SUBMIT_REFUSED_WHILE_RAISED,
    );
  // A held hand-back repeated in a round the human is correcting: the record is refreshed, and the
  // parent, already pointed at this thread, is told nothing.
  if (held && outcome === "awaiting_acceptance" && humanInTurn) {
    yield* asToolError(writeWorkstreamReport(caller.threadId, input.markdown));
    return HELD_AGAIN_ECHO;
  }

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
    ...(rework === undefined ? {} : { rework }),
    ...(contested === undefined ? {} : { contested }),
    ...(input.counts === undefined ? {} : { counts: input.counts }),
  });
  const recorded = committed(result, "thread.outcome-recorded")[0];
  const routes = committed(result, "thread.route-taken");
  const decision = recorded?.payload.decision ?? routing.decision;
  const echo = renderSubmitOutcome({
    decision,
    outcome: outcome ?? "done",
    round: recorded?.payload.round ?? routing.round,
    siblings,
    reopened: routes.flatMap((route) => (route.payload.kind === "loop" ? [route.payload.to] : [])),
    ...(routes[0]?.payload.kind === "loop"
      ? { leg: "rework" as const }
      : routes[0]?.payload.kind === "loop-back"
        ? { leg: "reverify" as const }
        : {}),
  });
  const goal =
    row.goalId === null || row.anchorTaskId === null || !COMPLETING.has(decision)
      ? null
      : yield* asToolError(store.goals.get(row.goalId));
  const anchor = goal === null ? null : resolveThreadAnchor(goal.tasks, row.anchorTaskId);
  const open = anchor === null ? "" : renderOpenBranch(anchor);
  return `${echo}\nReport: ${reportPath}${
    open === ""
      ? ""
      : `\n\nStill open in your branch; your parent's notice of your completion lists these lines:\n${open}`
  }`;
});

/** Decisions whose route ends in the parent's child-done notice (a gate loop resolves later). */
const COMPLETING = new Set<string>(["terminal", "resolve", "loop"]);
