/**
 * Dev fixture verifier — proves the seeded workstream reads back as the web
 * shell serves it: every seeded thread's `workstream` on the joined shell with
 * the column and attention the seed meant, the goal and its tree, the control
 * cards on the root, a real checkpoint ref per started thread, and nothing a
 * booting server would act on (an empty effect outbox, every re-drive episode
 * already receipted). Read-only: the effect worker does not run.
 *
 * Run: `T3CODE_HOME=<scratch> node apps/server/src/dev/verifySeed.ts`
 *
 * @module dev/verifySeed
 */
// Dev-only fixture tooling (not shipped); see seedWorkstream.ts.
// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { LoomThreadShellFields, ThreadId } from "@t3tools/contracts";
import { isEligibleToStart, type StartNode } from "@t3tools/shared/workstreamStart.loom";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as SqlClient from "effect/sql/SqlClient";

import { makeGateLegComposer } from "../loom/orchestration/dispatcher/gateLegs.ts";
import { planReDrive } from "../loom/orchestration/redrive.ts";
import * as LoomStore from "../loom/projection/LoomStore.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { buildSeedConfig } from "./seedConfig.ts";
import { SEED, seedDatabaseLayer, seedRuntimeLayer } from "./seedWorkstream.ts";

/** What each seeded thread must read as: board column and stored attention. */
const EXPECTED: Record<string, { readonly column: string; readonly attention?: string }> = {
  [SEED.root]: { column: "in_progress" },
  [SEED.coderDone]: { column: "done" },
  [SEED.gateCoder]: { column: "in_progress" },
  [SEED.gateReviewer]: { column: "in_progress" },
  [SEED.quiescent]: { column: "in_progress", attention: "awaiting_orchestrator" },
  [SEED.blocked]: { column: "blocked" },
  [SEED.unbriefed]: { column: "blocked" },
  [SEED.cancelledLead]: { column: "cancelled" },
  [SEED.cancelledGrandchild]: { column: "cancelled" },
  [SEED.needsGuidanceRoot]: { column: "in_progress", attention: "needs_guidance" },
  [SEED.stagedRoot]: { column: "held" },
};

const startNode = (ws: LoomThreadShellFields): StartNode => ({ ...ws, id: ws.threadId });
// The web's deriveBoardColumn (client-runtime state/loom/workstream.ts), on the same predicate.
const columnOf = (ws: LoomThreadShellFields, byId: ReadonlyMap<ThreadId, StartNode>) =>
  ws.outcome ??
  (ws.held
    ? "held"
    : ws.kickoffAt !== null
      ? "in_progress"
      : isEligibleToStart(startNode(ws), byId)
        ? "ready"
        : "blocked");

const verifyProgram = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const loomStore = yield* LoomStore.LoomStoreV2;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const failures: string[] = [];
  const check = (ok: boolean, detail: string) => {
    if (!ok) failures.push(detail);
  };

  const shell = yield* orchestrator.getShellSnapshot({ location: "active" });
  const threads = shell.threads.filter((thread) => thread.projectId === SEED.projectId);
  const byId = new Map(
    threads.flatMap((thread) =>
      thread.workstream === undefined ? [] : [[thread.id, startNode(thread.workstream)] as const],
    ),
  );
  const rows = threads.map((thread) => {
    const ws = thread.workstream;
    const expected = EXPECTED[thread.id];
    const column = ws === undefined ? "(no workstream)" : columnOf(ws, byId);
    check(expected !== undefined, `unexpected thread ${thread.id}`);
    check(
      column === expected?.column,
      `${thread.id}: column ${column}, expected ${expected?.column}`,
    );
    check(
      (ws?.attention ?? []).join(",") === (expected?.attention ?? ""),
      `${thread.id}: attention [${ws?.attention.join(",")}], expected [${expected?.attention ?? ""}]`,
    );
    check(
      thread.lineage.parentThreadId === (ws?.parentThreadId ?? null),
      `${thread.id}: lineage parent differs from the sidecar's`,
    );
    return {
      threadId: thread.id,
      column,
      attention: ws?.attention ?? [],
      parent: thread.lineage.parentThreadId,
      goalId: ws?.goalId ?? null,
      pendingRework: ws?.pendingRework ?? false,
      gateRounds: ws?.gateRounds ?? 0,
      lastOutcome: ws?.lastOutcome === null || ws === undefined ? null : ws.lastOutcome.outcome,
      synthesised: ws?.lastOutcome?.synthesised === true,
      reportPath: ws?.reportPath ?? null,
    };
  });
  check(rows.length === Object.keys(EXPECTED).length, `found ${rows.length} seeded threads`);
  const ws = (id: ThreadId) => threads.find((thread) => thread.id === id)?.workstream;
  check(ws(SEED.gateCoder)?.pendingRework === true, "gate coder holds no rework round");
  check(ws(SEED.gateReviewer)?.lastOutcome?.decision === "loop", "reviewer did not loop");
  check(ws(SEED.quiescent)?.lastOutcome?.synthesised === true, "quiescent outcome not synthesised");
  check(ws(SEED.coderDone)?.reportPath != null, "done coder has no report");
  check(ws(SEED.stagedRoot)?.kickoffBriefPath != null, "staged root has no brief");

  const goal = yield* loomStore.goals.get(SEED.goalId);
  check(goal !== null && goal.tasks.length > 0, "goal or its task tree is missing");

  // Control cards on the root.
  const root = yield* orchestrator.getThreadProjection(SEED.root);
  const payloads = root.messages.flatMap((message) => message.loom?.controlPayload ?? []);
  const cards: ReadonlyArray<string> = payloads.map((payload) => payload.notice ?? payload.kind);
  check(
    payloads.filter((payload) => payload.kind === "digest").length === 1,
    "expected one digest",
  );
  check(
    payloads.some((payload) => payload.kind === "yield" && payload.synthesised === true),
    "expected a synthesised yield",
  );
  for (const notice of [
    "gate-rework",
    "gate-reverify",
    "brief-needed",
    "deadlock",
    "stall-nudge",
    "attention",
    "notify",
  ]) {
    check(cards.includes(notice), `missing ${notice} notice card`);
  }

  // A real checkpoint ref per started thread (the Diff surface).
  const checkpoints: Record<string, number> = {};
  for (const row of rows.filter((entry) => entry.column !== "held" && entry.column !== "blocked")) {
    const projection = yield* orchestrator.getThreadProjection(row.threadId);
    const ready = projection.checkpoints.filter((checkpoint) => checkpoint.status === "ready");
    checkpoints[row.threadId] = ready.length;
    const cwd = projection.thread.worktreePath;
    const ref = ready.at(-1)?.ref;
    check(
      cwd !== null &&
        ref !== undefined &&
        NodeChildProcess.spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], { cwd })
          .status === 0,
      `${row.threadId}: no resolvable checkpoint ref`,
    );
  }

  // Inert on boot: no outbox work, and every re-drive episode already receipted.
  const [outbox] = yield* sql<{ open: number }>`
    SELECT count(*) AS open FROM orchestration_v2_effect_outbox WHERE status IN ('pending', 'running')
  `;
  check(outbox?.open === 0, `${outbox?.open} effects pending in the outbox`);
  const owed = [];
  for (const command of planReDrive({
    rows: yield* loomStore.listReDriveInput(),
    now: DateTime.formatIso(yield* DateTime.now),
    gateLeg: makeGateLegComposer(new Map()),
  })) {
    if (Option.isNone(yield* receipts.getByCommandId(command.commandId)))
      owed.push(command.commandId);
  }
  check(owed.length === 0, `re-drive would send on boot: ${owed.join(", ")}`);

  yield* Console.log(
    JSON.stringify(
      { ok: failures.length === 0, failures, goal: goal?.title, threads: rows, cards, checkpoints },
      null,
      2,
    ),
  );
  if (failures.length > 0) return yield* Effect.fail(new Error(failures.join("\n")));
});

const main = Effect.gen(function* () {
  const config = yield* buildSeedConfig;
  yield* verifyProgram.pipe(
    Effect.provide(seedRuntimeLayer(config, seedDatabaseLayer(config), { runEffectWorker: false })),
  );
}).pipe(
  Effect.provide(NodeServices.layer),
  Effect.provideService(References.MinimumLogLevel, "Error"),
);

if (import.meta.main) {
  NodeRuntime.runMain(main);
}
