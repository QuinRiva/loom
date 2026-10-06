/**
 * Dev fixture seeder — populates a scratch `T3CODE_HOME` with a realistic Loom
 * workstream so agents (and humans) can verify UI states that are otherwise
 * unreachable against an empty database.
 *
 * Everything is written through the real V2 orchestrator offline (no running
 * server): upstream commands for the project's threads and messages, Loom
 * commands for the sidecar graph (spawn, submit, outcome, attention), the
 * re-drive planner for the gate leg and the cancel cascade, and `LoomStoreV2`
 * for the goal and its task tree (goals are plain tables). Never direct SQL,
 * so the fixture exercises the Loom arm and stays immune to projection drift.
 *
 * Turns run against an in-process stub adapter that answers every turn at once
 * and edits one file in the shared checkout, so runs complete with real
 * checkpoint refs (the Diff surface) and nothing is left for a provider: the
 * seed exits only once the effect outbox is drained and a final re-drive pass
 * has nothing left to send, so a dev server booted on this home starts no pi.
 *
 * Run: `T3CODE_HOME=<scratch> node apps/server/src/dev/seedWorkstream.ts`
 *
 * @module dev/seedWorkstream
 */
// Dev-only fixture tooling (not shipped): plain Error/Date/JSON and node:fs keep
// the seeder legible, matching `scripts/*.ts`.
// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off globalDateInEffect:off globalDate:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  GoalTaskId,
  type LoomMessageFields,
  MessageId,
  PI_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type ThreadId,
  TurnItemId,
  type WorkstreamRoute,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import {
  dispatchServerCommand,
  runReDrivePass,
  type GateLegComposer,
} from "../loom/orchestration/redrive.ts";
import { makeGateLegComposer } from "../loom/orchestration/dispatcher/gateLegs.ts";
import * as LoomStore from "../loom/projection/LoomStore.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import type {
  ProviderAdapterV2Event,
  ProviderAdapterV2Shape,
} from "../orchestration-v2/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { buildSeedConfig } from "./seedConfig.ts";
import { LOOM_SEED, loomSeedControlMessages } from "@t3tools/shared/loomSeedFixture.loom";

// Stable ids (shared with the web preview fixtures): a re-run against a fresh
// home reproduces the fixture, and a seeded home is refused.
export const SEED = {
  ...LOOM_SEED.threads,
  projectId: LOOM_SEED.projectId,
  goalId: LOOM_SEED.goalId,
};

const driver = ProviderDriverKind.make("pi");
const instanceId = ProviderInstanceId.make("pi");
const MODEL_SELECTION = { instanceId, model: PI_DEFAULT_MODEL };
const taskId = (n: number) => GoalTaskId.make(`00000000-0000-4000-8000-00000000000${n}`);

const runGit = (cwd: string, args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });

/**
 * An in-process pi stand-in: every turn appends a line to `seed-notes/<thread>.md`
 * in the run's checkout (so its checkpoint has a real diff), then completes
 * with one assistant message. No provider process exists.
 */
const seedAdapter: ProviderAdapterV2Shape = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (sessionInput) =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderAdapterV2Event>();
      const now = yield* DateTime.now;
      const unused = () => Effect.die("unused by the dev seed");
      return {
        instanceId,
        driver,
        providerSessionId: sessionInput.providerSessionId,
        providerSession: {
          id: sessionInput.providerSessionId,
          driver,
          providerInstanceId: instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: MODEL_SELECTION.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.fromPubSub(events),
        ensureThread: (threadInput) =>
          Effect.map(DateTime.now, (createdAt) => ({
            id: ProviderThreadId.make(`provider-thread:seed:${threadInput.threadId}`),
            driver,
            providerInstanceId: instanceId,
            providerSessionId: sessionInput.providerSessionId,
            appThreadId: threadInput.threadId,
            ownerNodeId: null,
            // No native session exists: a real pi turn later starts a fresh one.
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle" as const,
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt,
            updatedAt: createdAt,
          })),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        startTurn: (turn) =>
          Effect.gen(function* () {
            const cwd = turn.runtimePolicy.cwd ?? turn.appThread.worktreePath;
            if (cwd !== null) {
              const notes = NodePath.join(cwd, "seed-notes", `${turn.threadId}.md`);
              NodeFS.mkdirSync(NodePath.dirname(notes), { recursive: true });
              NodeFS.appendFileSync(
                notes,
                `- run ${turn.runOrdinal}: ${turn.message.text.split("\n")[0]}\n`,
              );
            }
            const at = yield* DateTime.now;
            const providerTurnId = ProviderTurnId.make(
              `provider-turn:seed:${turn.threadId}:${turn.runOrdinal}`,
            );
            yield* PubSub.publishAll(events, [
              // A context-window reading, so the web's context chip has a value (3d-4).
              {
                type: "provider_thread.updated",
                driver,
                providerThread: {
                  ...turn.providerThread,
                  contextUsage: {
                    usedTokens: 18_000 + (turn.runOrdinal % 4) * 41_000,
                    maxTokens: 200_000,
                  },
                  updatedAt: at,
                },
              },
              {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: null,
                  ordinal: turn.providerTurnOrdinal,
                  status: "completed",
                  startedAt: at,
                  completedAt: at,
                },
              },
              {
                type: "turn_item.updated",
                driver,
                turnItem: {
                  id: TurnItemId.make(`turn-item:seed:${turn.threadId}:${turn.runOrdinal}`),
                  threadId: turn.threadId,
                  runId: turn.runId,
                  nodeId: turn.rootNodeId,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: turn.runOrdinal * 100 + 1,
                  status: "completed",
                  title: null,
                  startedAt: at,
                  completedAt: at,
                  updatedAt: at,
                  type: "assistant_message",
                  messageId: MessageId.make(`message:seed:${turn.threadId}:${turn.runOrdinal}`),
                  text: `Seed turn ${turn.runOrdinal}: noted in \`seed-notes/${turn.threadId}.md\`.`,
                  streaming: false,
                },
              },
              {
                type: "turn.terminal",
                driver,
                providerThreadId: turn.providerThread.id,
                providerTurnId,
                runOrdinal: turn.runOrdinal,
                status: "completed",
                failure: null,
                threadDisposition: "reusable",
              },
            ]);
          }),
        steerTurn: unused,
        interruptTurn: () => Effect.void,
        respondToRuntimeRequest: unused,
        readThreadSnapshot: unused,
        rollbackThread: unused,
        forkThread: unused,
      };
    }),
};

/** 3b's gate-leg composer (seam 6 notice kinds); the seed reads no reports, so no excerpt. */
const seedGateLeg = makeGateLegComposer(new Map());

const BLOCKING_RUN_STATUSES = new Set(["queued", "preparing", "starting", "running", "waiting"]);

const seedProgram = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const loomStore = yield* LoomStore.LoomStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const workspaceRoot = NodePath.join(config.worktreesDir, "seed-workspace");
  const reportsDir = NodePath.join(config.stateDir, "workstream-reports");
  const briefsDir = NodePath.join(config.stateDir, "workstream-briefs");
  for (const dir of [reportsDir, briefsDir]) NodeFS.mkdirSync(dir, { recursive: true });
  const iso = () => new Date().toISOString();

  const dispatch = (command: Parameters<typeof orchestrator.dispatch>[0]) =>
    orchestrator
      .dispatch(command)
      .pipe(
        Effect.mapError(
          (cause) => new Error(`${command.type} (${command.commandId}) failed: ${cause.message}`),
        ),
      );

  /** Waits until the thread's runs (and the effects they enqueue) have finished. */
  const settle = (threadId: ThreadId) =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 2_000; attempt += 1) {
        const { runs } = yield* orchestrator.getThreadProjection(threadId);
        const [outbox] = yield* sql<{ open: number }>`
          SELECT count(*) AS open FROM orchestration_v2_effect_outbox
          WHERE status IN ('pending', 'running')
        `;
        if (outbox?.open === 0 && runs.every((run) => !BLOCKING_RUN_STATUSES.has(run.status)))
          return runs;
        yield* Effect.sleep("10 millis");
      }
      return yield* Effect.fail(new Error(`Thread ${threadId} did not settle.`));
    });

  const writeFile = (dir: string, name: string, body: string) => {
    const file = NodePath.join(dir, name);
    NodeFS.writeFileSync(file, body, "utf8");
    return file;
  };

  const message = (
    threadId: ThreadId,
    id: string,
    text: string,
    loom?: LoomMessageFields,
    human = false,
  ) =>
    dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      threadId,
      messageId: MessageId.make(`message:${id}`),
      text,
      attachments: [],
      createdBy: human ? "user" : "agent",
      creationSource: human ? "web" : "server",
      dispatchMode: { type: human ? "start_immediately" : "queue_after_active" },
      ...(loom === undefined ? {} : { loom }),
    }).pipe(Effect.andThen(settle(threadId)));

  const createRoot = (threadId: ThreadId, title: string, anchorTaskId?: GoalTaskId) =>
    Effect.gen(function* () {
      yield* dispatch({
        type: "thread.create",
        commandId: CommandId.make(`seed:create:${threadId}`),
        threadId,
        projectId: SEED.projectId,
        title,
        modelSelection: MODEL_SELECTION,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: workspaceRoot,
        createdBy: "user",
        creationSource: "web",
      });
      // A root's first goal-set creates its sidecar row.
      yield* dispatch({
        type: "thread.goal.set",
        commandId: CommandId.make(`seed:goal:${threadId}`),
        threadId,
        createdAt: iso(),
        goalId: SEED.goalId,
        ...(anchorTaskId === undefined ? {} : { anchorTaskId }),
      });
    });

  const spawn = (input: {
    readonly threadId: ThreadId;
    readonly parent: ThreadId;
    readonly title: string;
    readonly role: string;
    readonly purpose: string;
    readonly brief?: boolean;
    readonly blockedBy?: ReadonlyArray<ThreadId>;
    readonly routes?: ReadonlyArray<WorkstreamRoute>;
    readonly anchorTaskId?: GoalTaskId;
    /** The parent turn that spawned it; siblings sharing one form a wave on the graph. */
    readonly spawnGeneration?: string;
  }) =>
    dispatch({
      type: "thread.spawn",
      commandId: CommandId.make(`seed:spawn:${input.threadId}`),
      threadId: input.threadId,
      createdAt: iso(),
      createdBy: "agent",
      creationSource: "mcp",
      parentThreadId: input.parent,
      projectId: SEED.projectId,
      title: input.title,
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: workspaceRoot,
      role: input.role,
      purpose: input.purpose,
      goalId: SEED.goalId,
      ...(input.brief === false
        ? {}
        : {
            kickoffBriefPath: writeFile(
              briefsDir,
              `${input.threadId}.md`,
              `# ${input.title}\n\n${input.purpose}\n\nSubmit with mcp__t3-code__workstream_submit when done.\n`,
            ),
          }),
      ...(input.blockedBy === undefined ? {} : { blockedBy: input.blockedBy }),
      ...(input.routes === undefined ? {} : { routes: input.routes }),
      ...(input.anchorTaskId === undefined ? {} : { anchorTaskId: input.anchorTaskId }),
      ...(input.spawnGeneration === undefined ? {} : { spawnGeneration: input.spawnGeneration }),
    });

  /** 3b's kickoff: the brief as the first message, origin kickoff, under 3b's command id. */
  const kickoff = (threadId: ThreadId) =>
    message(
      threadId,
      `server:workstream-kickoff:${threadId}`,
      `[T3 Workstream kickoff — your brief, written by your parent agent]\n\n${NodeFS.readFileSync(
        NodePath.join(briefsDir, `${threadId}.md`),
        "utf8",
      )}`,
      { origin: "kickoff" },
    );

  const submit = (
    threadId: ThreadId,
    outcome: string,
    report: string,
    extra: { readonly counts?: { mustFix: number; niceToHave: number } } = {},
  ) =>
    dispatch({
      type: "thread.work.submit",
      commandId: CommandId.make(`seed:submit:${threadId}:${outcome}`),
      threadId,
      createdAt: iso(),
      reportPath: writeFile(reportsDir, `${threadId}.md`, report),
      outcome,
      ...extra,
    });

  const reDrive = runReDrivePass(seedGateLeg, dispatchServerCommand).pipe(
    Effect.mapError((cause) => new Error(`re-drive pass failed: ${String(cause)}`)),
  );

  // ---- refuse a seeded home; lay out the shared checkout --------------------
  if ((yield* loomStore.goals.get(SEED.goalId)) !== null) {
    return yield* Effect.fail(
      new Error(
        `The seed is already applied to ${config.dbPath}; delete '${config.stateDir}' (or use a fresh T3CODE_HOME) to reseed.`,
      ),
    );
  }

  // ---- goal + task tree (plain tables, LoomStoreV2) ----------------------------
  yield* loomStore.goals.upsert({
    id: SEED.goalId,
    projectId: SEED.projectId,
    slug: "workstream-fixture",
    title: "Render the workstream fixture",
    description:
      "A realistic Loom workstream: an orchestrator, a gated pair mid-round, a quiescent child, a blocked dependent and a cancelled subtree.",
  });
  yield* loomStore.tasks.replaceTree(
    SEED.goalId,
    [
      { id: 0, parent: null, text: "Seed a realistic workstream fixture", done: true },
      { id: 1, parent: 0, text: "Write the threads through real commands", done: true },
      { id: 2, parent: null, text: "Verify the seeded surfaces", done: false },
      { id: 3, parent: 2, text: "Render every board column", done: false },
      { id: 4, parent: 3, text: "Confirm the task-to-thread chip on anchored rows", done: false },
      { id: 5, parent: 2, text: "Render every control card", done: false },
    ].map((task, position) => ({
      id: taskId(task.id),
      parentTaskId: task.parent === null ? null : taskId(task.parent),
      text: task.text,
      done: task.done,
      position,
    })),
  );

  // ---- the orchestrator root ---------------------------------------------------
  yield* createRoot(SEED.root, "Deliver the workstream fixture", taskId(2));
  yield* message(
    SEED.root,
    "seed:root:human",
    "Seed the workstream fixture: a done coder, a gated pair, a quiet researcher with a dependent, and a cancelled subtree.",
    undefined,
    true,
  );

  // ---- done coder (anchored to a task, with a report) ---------------------------
  yield* spawn({
    threadId: SEED.coderDone,
    parent: SEED.root,
    title: "Add config loader",
    role: "coder",
    purpose: "Implement the configuration loader module.",
    anchorTaskId: taskId(4),
  });
  yield* kickoff(SEED.coderDone);
  yield* submit(
    SEED.coderDone,
    "done",
    "# Config loader\n\nImplemented the loader module and wired it into startup.\n",
  );

  // ---- gated pair, mid-round: reviewer looped findings, coder holds rework round 1 ----
  yield* spawn({
    threadId: SEED.gateCoder,
    parent: SEED.root,
    title: "Parser with review gate",
    role: "coder",
    purpose: "Implement the parser; a reviewer gates it.",
    spawnGeneration: "seed-wave-gate",
  });
  yield* spawn({
    threadId: SEED.gateReviewer,
    parent: SEED.root,
    title: "Review the parser",
    role: "reviewer",
    purpose: "Review the parser; loop findings back until clean.",
    blockedBy: [SEED.gateCoder],
    spawnGeneration: "seed-wave-gate",
    routes: [
      { on: ["needs_rework"], kind: "loop", to: SEED.gateCoder, maxRounds: 2 },
      { on: ["clean"], kind: "resolve" },
    ],
  });
  yield* kickoff(SEED.gateCoder);
  yield* submit(SEED.gateCoder, "done", "# Parser\n\nFirst cut: trims input.\n");
  yield* kickoff(SEED.gateReviewer);
  yield* submit(
    SEED.gateReviewer,
    "needs_rework",
    "# Parser review — round 1\n\n- must fix: lower-case before tokenising\n- must fix: reject empty input\n- nice: name the regex\n",
    { counts: { mustFix: 2, niceToHave: 1 } },
  );
  // The re-drive planner sends the rework leg under its own id, exactly as the server would.
  yield* reDrive;
  yield* settle(SEED.gateCoder);
  // The human cut in on the rework: a human-started last turn is never synthesised quiescent
  // (null human grace), so the dispatcher never yields this mid-round coder on boot.
  yield* message(
    SEED.gateCoder,
    "seed:gate-coder:human",
    "Before the rework lands: keep the tokeniser's public signature unchanged.",
    undefined,
    true,
  );

  // ---- quiescent child (synthesised report, awaiting_orchestrator) and its blocked dependent ----
  yield* spawn({
    threadId: SEED.quiescent,
    parent: SEED.root,
    title: "Survey checkpoint refs",
    role: "researcher",
    purpose: "Survey how checkpoint refs are named across providers.",
    spawnGeneration: "seed-wave-survey",
  });
  yield* kickoff(SEED.quiescent);
  const quietRun = (yield* settle(SEED.quiescent)).at(-1)!;
  yield* dispatch({
    type: "thread.work.submit",
    commandId: CommandId.make(`server:loom:quiescent:${SEED.quiescent}:${quietRun.id}`),
    threadId: SEED.quiescent,
    createdAt: iso(),
    reportPath: writeFile(
      reportsDir,
      `${SEED.quiescent}.quiescent-${quietRun.id}.md`,
      "> **Synthesised report.** This thread ended its turn without calling `mcp__t3-code__workstream_submit`.\n> The control plane wrote this file from its last assistant message after 10m of silence\n> and yielded it to the parent. Nothing below was written as a hand-back.\n\nCheckpoint refs live under `refs/t3/checkpoints/<thread>/turn/<n>`.\n",
    ),
    outcome: "quiescent",
  });
  yield* spawn({
    threadId: SEED.blocked,
    parent: SEED.root,
    title: "Document checkpoint refs",
    role: "coder",
    purpose: "Write the checkpoint-ref doc from the survey.",
    blockedBy: [SEED.quiescent],
    spawnGeneration: "seed-wave-survey",
  });
  yield* spawn({
    threadId: SEED.unbriefed,
    parent: SEED.root,
    title: "Wire the loader into the CLI",
    role: "coder",
    purpose: "Spawned without a brief: the parent still owes one.",
    brief: false,
    // Deliberately deferred on the survey (brief-needed move 2): the web still shows it
    // brief-needed, and 3b's rail owes no notice while a dependency is open.
    blockedBy: [SEED.quiescent],
  });

  // ---- cancelled subtree: a lead with its own grandchild, cancelled by cascade ----
  yield* spawn({
    threadId: SEED.cancelledLead,
    parent: SEED.root,
    title: "Abandoned experiment",
    role: "lead",
    purpose: "Try an alternative parser and delegate the benchmark.",
  });
  yield* kickoff(SEED.cancelledLead);
  yield* spawn({
    threadId: SEED.cancelledGrandchild,
    parent: SEED.cancelledLead,
    title: "Benchmark the alternative parser",
    role: "coder",
    purpose: "Benchmark the alternative parser against the current one.",
  });
  yield* kickoff(SEED.cancelledGrandchild);
  yield* dispatch({
    type: "thread.outcome.set",
    commandId: CommandId.make(`seed:cancel:${SEED.cancelledLead}`),
    threadId: SEED.cancelledLead,
    createdAt: iso(),
    outcome: "cancelled",
  });
  yield* reDrive;

  // ---- a root owed a human decision, and a staged (held) mcp__t3-code__goal_continue root ----
  yield* createRoot(SEED.needsGuidanceRoot, "Plan the migration (needs guidance)");
  yield* message(
    SEED.needsGuidanceRoot,
    "seed:needs-guidance:human",
    "Plan the migration.",
    undefined,
    true,
  );
  yield* dispatch({
    type: "thread.attention.raise",
    commandId: CommandId.make(`seed:attention:${SEED.needsGuidanceRoot}`),
    threadId: SEED.needsGuidanceRoot,
    createdAt: iso(),
    reason: "needs_guidance",
  });
  yield* dispatch({
    type: "thread.spawn",
    commandId: CommandId.make(`seed:spawn:${SEED.stagedRoot}`),
    threadId: SEED.stagedRoot,
    createdAt: iso(),
    createdBy: "agent",
    creationSource: "mcp",
    parentThreadId: null,
    projectId: SEED.projectId,
    title: "Fixture follow-through (staged)",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: workspaceRoot,
    role: "orchestrator",
    purpose: "Continue the fixture work with a fresh context window.",
    goalId: SEED.goalId,
    held: true,
    continuesThreadId: SEED.root,
    kickoffBriefPath: writeFile(
      briefsDir,
      `${SEED.stagedRoot}.md`,
      `# Continue the workstream fixture\n\nContinue from [the orchestrator](thread://${SEED.root}); the gate is mid-round and the survey went quiet.\n`,
    ),
  });

  // ---- control cards on the root (seam 6): one digest, one synthesised yield, every notice ----
  const quiet = (yield* loomStore.getWorkstream(SEED.quiescent))!;
  const controlMessages = loomSeedControlMessages({
    quiescent: quiet.reportPath!,
    coderDone: NodePath.join(reportsDir, `${SEED.coderDone}.md`),
    gateReviewer: NodePath.join(reportsDir, `${SEED.gateReviewer}.md`),
  });
  for (const control of controlMessages) {
    const id =
      control.payload.kind === "yield"
        ? // 3b's yield id, so its rail finds this episode already delivered.
          `server:workstream-yield:${SEED.quiescent}:${quiet.lastOutcome!.eventId}`
        : `server:seed:control:${control.key}`;
    yield* message(SEED.root, id, control.text, {
      origin: control.payload.notice === "notify" ? "notify" : "control_notice",
      controlPayload: control.payload,
    });
  }

  // ---- inert on boot: nothing left for the re-drive pass, nothing in the outbox ----
  const last = yield* reDrive;
  if (last.accepted.length + last.deferred.length + last.dead.length > 0) {
    return yield* Effect.fail(
      new Error(`Final re-drive pass was not empty: ${JSON.stringify(last)}`),
    );
  }
  for (const threadId of Object.values(SEED).filter((id) => id.startsWith("seed-thread-"))) {
    yield* settle(threadId as ThreadId);
  }

  yield* Console.log(
    JSON.stringify(
      {
        ok: true,
        dbPath: config.dbPath,
        workspaceRoot,
        projectId: SEED.projectId,
        goalId: SEED.goalId,
        threads: LOOM_SEED.threads,
        controlMessageIds: controlMessages.map((control) => control.key),
      },
      null,
      2,
    ),
  );
});

/** The seed database for a seed config (migrated on open). */
export const seedDatabaseLayer = (config: ServerConfig.ServerConfig["Service"]) =>
  SqlitePersistenceLayerLive.pipe(
    Layer.provide(Layer.mergeAll(ServerConfig.layer(config), NodeServices.layer)),
    Layer.orDie,
  );

/**
 * The real V2 orchestrator (Loom arm included) over the seed database, with the
 * stub adapter; `runEffectWorker: false` is read-only (the verifier).
 */
export const seedRuntimeLayer = (
  config: ServerConfig.ServerConfig["Service"],
  database: ReturnType<typeof seedDatabaseLayer>,
  options: { readonly runEffectWorker: boolean },
) =>
  Layer.mergeAll(
    ProviderReplayHarness.layerWithRegistry(
      { name: "seed-workstream" },
      ProviderAdapterRegistry.layerSingle(seedAdapter),
      { databaseLayer: database, runEffectWorker: options.runEffectWorker },
    ),
    LoomStore.layer,
    CommandReceiptStore.layer,
  ).pipe(
    Layer.provideMerge(database),
    Layer.provideMerge(Layer.mergeAll(ServerConfig.layer(config), NodeServices.layer)),
  );

const main = Effect.gen(function* () {
  const config = yield* buildSeedConfig;
  const workspaceRoot = NodePath.join(config.worktreesDir, "seed-workspace");
  const database = seedDatabaseLayer(config);

  // 1. The project, through upstream's project service. A seeded home already has it.
  const projectLayer = RuntimeLayer.layerProjectService.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(WorkspacePaths.WorkspacePaths)({
          normalizeWorkspaceRoot: (root) => Effect.succeed(root),
        }),
        Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
          getAvailable: () =>
            Effect.succeed({
              repositoryIdentity: null,
              faviconPath: null,
              repositoryIdentityResolved: false,
            }),
          request: () => Effect.void,
          invalidate: () => Effect.void,
        }),
      ),
    ),
    Layer.provideMerge(database),
  );
  yield* Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    if ((yield* projects.getById(SEED.projectId)).pipe((found) => found._tag === "Some")) {
      return yield* Effect.fail(
        new Error(
          `Seed project '${SEED.projectId}' already exists in ${config.dbPath}; delete '${config.stateDir}' (or use a fresh T3CODE_HOME) to reseed.`,
        ),
      );
    }
    // The shared checkout lives under this home's worktreesDir: the foreign-home
    // guard reads provenance from it, and a git repo gates the Diff surface.
    NodeFS.rmSync(workspaceRoot, { recursive: true, force: true });
    NodeFS.mkdirSync(workspaceRoot, { recursive: true });
    runGit(workspaceRoot, ["init", "--initial-branch=main"]);
    runGit(workspaceRoot, ["config", "user.email", "seed@example.com"]);
    runGit(workspaceRoot, ["config", "user.name", "Seed"]);
    NodeFS.writeFileSync(NodePath.join(workspaceRoot, "README.md"), "# Seed Fixture Project\n");
    runGit(workspaceRoot, ["add", "README.md"]);
    runGit(workspaceRoot, ["commit", "-m", "Initial"]);
    yield* projects.create({
      commandId: CommandId.make("seed:project"),
      projectId: SEED.projectId,
      title: "Seed Fixture Project",
      workspaceRoot,
      defaultModelSelection: MODEL_SELECTION,
    });
  }).pipe(Effect.provide(projectLayer));

  // 2. Threads, messages and the Loom graph through the real orchestrator and its effect worker.
  yield* seedProgram.pipe(
    Effect.provide(seedRuntimeLayer(config, database, { runEffectWorker: true })),
  );
}).pipe(
  Effect.provide(NodeServices.layer),
  Effect.provideService(References.MinimumLogLevel, "Error"),
);

if (import.meta.main) {
  NodeRuntime.runMain(main);
}
