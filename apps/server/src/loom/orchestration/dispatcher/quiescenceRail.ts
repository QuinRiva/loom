/**
 * The quiescence rail (Phase 3 plan "The quiescence rail"): a started Loom
 * child that ended its turn without `mcp__t3-code__workstream_submit` and has
 * stayed idle past its grace gets a synthesised report from its last assistant
 * message and a `quiescent` submit under `server:loom:quiescent:<threadId>:<runId>`.
 * The arm routes it to `yield` (before any rework interception, so a quiet gate
 * coder is parked, never looped to its reviewer), raises `awaiting_orchestrator`
 * and records `lastOutcome.synthesised`; the yield rail wakes the parent on the
 * next pass. `quiescenceCandidate` (Phase 2) decides; this step only feeds it.
 *
 * @module loom/orchestration/dispatcher/quiescenceRail
 */
import { CommandId } from "@t3tools/contracts";
import { isWaitingInGate } from "@t3tools/shared/workstreamGraph";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { LoomStoreV2 } from "../../projection/LoomStore.ts";
import { writeSynthesisedReport } from "../../workstream/report.ts";
import { latestUnheldRun, quiescenceCandidate, turnStartedByHuman } from "../quiescence.ts";
import { quiescentSubmitCommandId } from "./controlMessage.ts";
import type { PassContext, PassStep } from "./WorkstreamDispatcher.ts";

/** A grace in the report header's words: "10 minutes", "1 minute", "45 seconds". */
export const formatGrace = (ms: number): string => {
  const [n, unit] = ms % 60_000 === 0 ? [ms / 60_000, "minute"] : [Math.round(ms / 1000), "second"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
};

export const quiescenceRail: PassStep = {
  name: "quiescence",
  run: Effect.fn("loom.dispatcher.quiescence")(function* (ctx: PassContext) {
    const orchestrator = yield* OrchestratorV2;
    const loomStore = yield* LoomStoreV2;
    for (const row of ctx.rows) {
      const shell = ctx.shells.get(row.threadId);
      // The cheap shell pre-filter; `quiescenceCandidate` re-checks all of it.
      if (
        shell === undefined ||
        row.parentThreadId === null ||
        row.kickoffAt === null ||
        row.outcome !== null ||
        row.attention.length > 0 ||
        shell.activityRunStatus != null ||
        shell.pendingRuntimeRequest !== null
      )
        continue;
      const records = yield* orchestrator.getThreadRecords(row.threadId, ["runs", "messages"], {
        messageRoles: ["user"],
      });
      if (
        !quiescenceCandidate({
          shell,
          runs: records.runs,
          userMessages: records.messages,
          children: yield* loomStore.listChildren(row.threadId, { includeArchived: true }),
          now: ctx.now,
          grace: ctx.grace,
        })
      )
        continue;
      // A party waiting for its gate counterpart is parked, not quiet (plan: "`isWaitingInGate`
      // still exempts…"). Read the siblings fresh: this pass's re-drive may just have
      // opened the counterpart's round, which the pass-start snapshot cannot show.
      const siblings = new Map(
        (yield* loomStore.listChildren(row.parentThreadId, { includeArchived: true })).map(
          (sibling) => [sibling.threadId, { ...sibling, id: sibling.threadId }],
        ),
      );
      const fresh = siblings.get(row.threadId)!;
      if (fresh.outcome !== null || fresh.attention.length > 0 || isWaitingInGate(fresh, siblings))
        continue;
      const run = latestUnheldRun(records.runs)!;
      const commandId = quiescentSubmitCommandId(row.threadId, run.id);
      if (yield* ctx.sent(commandId)) continue;
      const { turnItems } = yield* orchestrator.getThreadRecords(row.threadId, ["turnItems"], {
        turnItemRunIds: [run.id],
        turnItemTypes: ["assistant_message"],
      });
      const lastAssistant = turnItems
        .flatMap((item) => (item.type === "assistant_message" ? [item] : []))
        .toSorted((a, b) => a.ordinal - b.ordinal)
        .at(-1);
      const humanStarted = turnStartedByHuman(records.runs, records.messages);
      const reportPath = yield* writeSynthesisedReport(
        row.threadId,
        run.id,
        lastAssistant?.text ?? "_The last run produced no assistant message._",
        formatGrace(humanStarted ? ctx.grace.humanStartedMs! : ctx.grace.controlStartedMs),
      ).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("loom.dispatcher.quiescent-report-failed", {
            threadId: row.threadId,
            error,
          }),
        ),
        Effect.option,
      );
      if (Option.isNone(reportPath)) continue;
      yield* ctx.dispatch("quiescence", {
        type: "thread.work.submit",
        commandId: CommandId.make(commandId),
        threadId: row.threadId,
        createdAt: DateTime.formatIso(ctx.now),
        reportPath: reportPath.value,
        outcome: "quiescent",
      });
    }
  }),
};
