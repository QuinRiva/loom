/**
 * Dev fixture seeder — populates a scratch `T3CODE_HOME` with a realistic
 * workstream so agents (and humans) can verify UI states that are otherwise
 * unreachable against an empty database.
 *
 * It dispatches real orchestration commands through the OrchestrationEngine
 * offline (no running server) — exactly like `cli/project.ts` — so the fixture
 * stays immune to schema/projection drift, and captures real git checkpoint
 * refs in a tiny scratch repo so per-turn diff drill-down produces actual
 * patches.
 *
 * Run: `T3CODE_HOME=<scratch> node apps/server/src/dev/seedWorkstream.ts`
 *
 * @module dev/seedWorkstream
 */
// Dev-only fixture tooling (not shipped): the heavyweight Effect diagnostics
// (tagged errors, DateTime, Schema-over-JSON) are disproportionate here — plain
// Error/Date/JSON keep the seeder legible, matching `scripts/*.ts`.
// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off globalDateInEffect:off globalDate:off preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  GoalId,
  MessageId,
  type OrchestrationCheckpointFile,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as References from "effect/References";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import { checkpointRefForThreadTurn } from "../checkpointing/Utils.ts";
import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { buildSeedConfig } from "./seedConfig.ts";

// Stable ids so re-running against a fresh home reproduces the same fixture and
// a partially-seeded home is detected by the project-create invariant.
const PROJECT_ID = ProjectId.make("seed-project-0000");
const GOAL_ID = GoalId.make("seed-goal-0000");
const ORCHESTRATOR_ID = ThreadId.make("seed-thread-orchestrator");
const CODER_ALPHA_ID = ThreadId.make("seed-thread-coder-alpha");
const CODER_BETA_ID = ThreadId.make("seed-thread-coder-beta");
const CODER_REWORK_ID = ThreadId.make("seed-thread-coder-rework");
const CODER_SHARED_ID = ThreadId.make("seed-thread-coder-shared");
const CODER_CANCELLED_ID = ThreadId.make("seed-thread-coder-cancelled");

const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("pi"),
  model: "claude-opus-4-8",
} as const;

const BASE_TIME = "2026-01-01T09:00:00.000Z";

let commandCounter = 0;
const nextCommandId = (label: string): CommandId =>
  CommandId.make(`seed:${label}:${(commandCounter++).toString().padStart(4, "0")}`);

function runGit(cwd: string, args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

const seedProgram = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;

  // The seeded project's workspace lives under the durable state dir so it
  // survives alongside the sqlite the dev server reads.
  const workspaceRoot = path.join(config.stateDir, "seed-workspace");

  // Idempotence: a fully-seeded home already has this project. Re-running must
  // not corrupt state, so refuse with a clear message and let the caller wipe.
  const preSnapshot = yield* (yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery).getSnapshot();
  if (preSnapshot.projects.some((project) => project.id === PROJECT_ID)) {
    return yield* Effect.fail(
      new Error(
        `Seed project '${PROJECT_ID}' already exists in ${config.dbPath}. ` +
          `The seed is already applied; delete '${config.stateDir}' (or use a fresh T3CODE_HOME) to reseed.`,
      ),
    );
  }

  // Fresh scratch workspace repos.
  if (yield* fs.exists(workspaceRoot)) {
    yield* fs.remove(workspaceRoot, { recursive: true });
  }
  yield* fs.makeDirectory(workspaceRoot, { recursive: true });

  // The orchestrator's own worktree must be a git repo: the DiffPanel gates the
  // entire Diff surface on the active thread's worktree being a repo
  // (`gitStatusQuery.isRepo`), and the "By coder" scope only renders when the
  // orchestrator is the active thread. Without this the dropdown is unreachable
  // in the UI even though the read model is fully populated. The per-coder
  // subrepos below nest inside as untracked dirs, which is harmless.
  runGit(workspaceRoot, ["init", "--initial-branch=main"]);
  runGit(workspaceRoot, ["config", "user.email", "seed@example.com"]);
  runGit(workspaceRoot, ["config", "user.name", "Seed"]);
  NodeFS.writeFileSync(
    NodePath.join(workspaceRoot, "README.md"),
    "# Seed Fixture Project\n",
    "utf8",
  );
  runGit(workspaceRoot, ["add", "README.md"]);
  runGit(workspaceRoot, ["commit", "-m", "Initial"]);

  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const dispatch = (command: Parameters<typeof engine.dispatch>[0]) =>
    engine
      .dispatch(command)
      .pipe(
        Effect.mapError((cause) => new Error(`dispatch ${command.type} failed: ${String(cause)}`)),
      );

  const baseMs = new Date(BASE_TIME).getTime();
  const iso = (offsetMinutes: number): string =>
    new Date(baseMs + offsetMinutes * 60_000).toISOString();

  // ---- project + goal + orchestrator ------------------------------------
  yield* dispatch({
    type: "project.create",
    commandId: nextCommandId("project"),
    projectId: PROJECT_ID,
    title: "Seed Fixture Project",
    workspaceRoot,
    defaultModelSelection: MODEL_SELECTION,
    createdAt: iso(0),
  });

  yield* dispatch({
    type: "goal.create",
    commandId: nextCommandId("goal"),
    goalId: GOAL_ID,
    projectId: PROJECT_ID,
    slug: "diff-panel-fixture",
    title: "Render the By-coder diff scope",
    description:
      "A realistic workstream: an orchestrator with coder descendants carrying turn checkpoints.",
    createdAt: iso(0),
  });

  yield* dispatch({
    type: "thread.create",
    commandId: nextCommandId("orchestrator"),
    threadId: ORCHESTRATOR_ID,
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    parentThreadId: null,
    role: "orchestrator",
    purpose: "Coordinate the coders delivering the diff-panel fixture.",
    title: "Deliver diff-panel fixture",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    planLane: "in_progress",
    branch: null,
    worktreePath: workspaceRoot,
    createdAt: iso(0),
  });

  // A user message on the orchestrator so it reads as a genuinely started root.
  yield* dispatch({
    type: "thread.turn.start",
    commandId: nextCommandId("orchestrator-turn"),
    threadId: ORCHESTRATOR_ID,
    message: {
      messageId: MessageId.make("seed-msg-orchestrator-user"),
      role: "user",
      text: "Seed the diff-panel fixture workstream.",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: iso(0),
  });

  // ---- coder definitions -------------------------------------------------
  const coderSpecs = [
    {
      id: CODER_ALPHA_ID,
      name: "coder-alpha",
      title: "Add config loader",
      purpose: "Implement the configuration loader module.",
      role: "coder",
      isolation: "isolated" as const,
      planLane: "done" as const,
      turns: [
        {
          file: "config.ts",
          contents: [
            "export const load = () => ({});\n",
            "export const load = () => ({ ready: true });\n",
          ],
        },
      ],
    },
    {
      id: CODER_BETA_ID,
      name: "coder-beta",
      title: "Wire HTTP routes",
      purpose: "Add the HTTP routing surface.",
      role: "coder",
      isolation: "isolated" as const,
      planLane: "done" as const,
      turns: [
        {
          file: "routes.ts",
          contents: ["export const routes = [];\n", 'export const routes = ["/health"];\n'],
        },
      ],
    },
    {
      id: CODER_REWORK_ID,
      name: "coder-rework",
      title: "Parser with rework",
      purpose: "Implement the parser; expect a review rework loop.",
      role: "coder",
      isolation: "isolated" as const,
      planLane: "in_progress" as const,
      turns: [
        {
          file: "parser.ts",
          contents: [
            "export const parse = (s: string) => s;\n",
            "export const parse = (s: string) => s.trim();\n",
            "export const parse = (s: string) => s.trim().toLowerCase();\n",
          ],
        },
      ],
    },
    {
      id: CODER_SHARED_ID,
      name: "coder-shared",
      title: "Tweak shared worktree",
      purpose: "A shared-isolation child editing the parent worktree.",
      role: "coder",
      isolation: "shared" as const,
      planLane: "done" as const,
      turns: [{ file: "shared-notes.md", contents: ["notes\n", "notes\nmore notes\n"] }],
    },
    {
      id: CODER_CANCELLED_ID,
      name: "coder-cancelled",
      title: "Abandoned experiment",
      purpose: "A cancelled child whose work was not merged.",
      role: "coder",
      isolation: "isolated" as const,
      planLane: "cancelled" as const,
      turns: [
        { file: "experiment.ts", contents: ["export const x = 1;\n", "export const x = 2;\n"] },
      ],
    },
  ];

  let coderIndex = 0;

  for (const spec of coderSpecs) {
    coderIndex += 1;
    const worktreePath = NodePath.join(workspaceRoot, spec.name);
    NodeFS.mkdirSync(worktreePath, { recursive: true });
    runGit(worktreePath, ["init", "--initial-branch=main"]);
    runGit(worktreePath, ["config", "user.email", "seed@example.com"]);
    runGit(worktreePath, ["config", "user.name", "Seed"]);
    NodeFS.writeFileSync(NodePath.join(worktreePath, "README.md"), `# ${spec.name}\n`, "utf8");
    runGit(worktreePath, ["add", "."]);
    runGit(worktreePath, ["commit", "-m", "Initial"]);

    // shared-isolation child shares the orchestrator worktree conceptually, but
    // still needs a repo with its own checkpoint refs for diffs to resolve.
    yield* dispatch({
      type: "thread.create",
      commandId: nextCommandId(`create-${spec.name}`),
      threadId: spec.id,
      projectId: PROJECT_ID,
      goalId: GOAL_ID,
      parentThreadId: ORCHESTRATOR_ID,
      role: spec.role,
      purpose: spec.purpose,
      title: spec.title,
      modelSelection: MODEL_SELECTION,
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      isolation: spec.isolation,
      planLane: "ready",
      // Deliberately null: a non-null branch marks the child as a provisioned
      // worktree, which the live WorkstreamFanInReactor would then try to git
      // merge/remove at runtime — mutating or destroying the seeded checkpoints.
      // `isolation` alone carries what the DiffPanel scope needs; the branch is
      // irrelevant to `collectCoderDescendants`.
      branch: null,
      worktreePath,
      createdAt: iso(coderIndex),
    });

    const turnSpec = spec.turns[0]!;
    const contents = turnSpec.contents;
    const filePath = NodePath.join(worktreePath, turnSpec.file);

    // Capture the pre-work baseline as turn/0 (the diff `from` anchor).
    yield* checkpointStore.captureCheckpoint({
      cwd: worktreePath,
      checkpointRef: checkpointRefForThreadTurn(spec.id, 0),
    });

    for (let t = 0; t < contents.length; t += 1) {
      const turnCount = t + 1;
      NodeFS.writeFileSync(filePath, contents[t]!, "utf8");
      yield* checkpointStore.captureCheckpoint({
        cwd: worktreePath,
        checkpointRef: checkpointRefForThreadTurn(spec.id, turnCount),
      });

      const additions = contents[t]!.split("\n").length;
      const files: ReadonlyArray<OrchestrationCheckpointFile> = [
        { path: turnSpec.file, kind: "modified", additions, deletions: t === 0 ? 0 : 1 },
      ];
      const turnId = TurnId.make(`${spec.id}-turn-${turnCount}`);
      const messageId = MessageId.make(`${spec.id}-assistant-${turnCount}`);

      // A user + assistant message per turn so the thread reads like real work.
      yield* dispatch({
        type: "thread.turn.start",
        commandId: nextCommandId(`${spec.name}-user-${turnCount}`),
        threadId: spec.id,
        message: {
          messageId: MessageId.make(`${spec.id}-user-${turnCount}`),
          role: "user",
          text: turnCount === 1 ? spec.purpose : `Rework round ${turnCount - 1}.`,
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        createdAt: iso(coderIndex * 10 + turnCount),
      });
      yield* dispatch({
        type: "thread.message.assistant.complete",
        commandId: nextCommandId(`${spec.name}-assistant-${turnCount}`),
        threadId: spec.id,
        messageId,
        turnId,
        createdAt: iso(coderIndex * 10 + turnCount),
      });
      yield* dispatch({
        type: "thread.turn.diff.complete",
        commandId: nextCommandId(`${spec.name}-diff-${turnCount}`),
        threadId: spec.id,
        turnId,
        completedAt: iso(coderIndex * 10 + turnCount),
        checkpointRef: checkpointRefForThreadTurn(spec.id, turnCount),
        status: "ready",
        files,
        assistantMessageId: messageId,
        checkpointTurnCount: turnCount,
        createdAt: iso(coderIndex * 10 + turnCount),
      });
    }

    // Terminal lane / attention shaping.
    if (spec.planLane === "done") {
      yield* dispatch({
        type: "thread.plan-lane.set",
        commandId: nextCommandId(`${spec.name}-done`),
        threadId: spec.id,
        planLane: "done",
        createdAt: iso(coderIndex * 10 + 9),
      });
    } else if (spec.planLane === "cancelled") {
      yield* dispatch({
        type: "thread.plan-lane.set",
        commandId: nextCommandId(`${spec.name}-cancel`),
        threadId: spec.id,
        planLane: "cancelled",
        createdAt: iso(coderIndex * 10 + 9),
      });
    } else if (spec.id === CODER_REWORK_ID) {
      // Mid-rework: leave in progress and flag it needs guidance so the
      // attention surface has something to render.
      yield* dispatch({
        type: "thread.attention.raise",
        commandId: nextCommandId(`${spec.name}-attn`),
        threadId: spec.id,
        reason: "needs_guidance",
        createdAt: iso(coderIndex * 10 + 9),
      });
    }
  }

  yield* Console.log(
    JSON.stringify(
      {
        ok: true,
        dbPath: config.dbPath,
        workspaceRoot,
        projectId: PROJECT_ID,
        goalId: GOAL_ID,
        orchestratorThreadId: ORCHESTRATOR_ID,
        coders: coderSpecs.map((spec) => ({
          threadId: spec.id,
          title: spec.title,
          isolation: spec.isolation,
          planLane: spec.planLane,
          turnCount: spec.turns[0]!.contents.length,
          worktreePath: NodePath.join(workspaceRoot, spec.name),
        })),
      },
      null,
      2,
    ),
  );
});

const main = Effect.gen(function* () {
  const config = yield* buildSeedConfig;
  const seedRuntimeLayer = Layer.mergeAll(
    OrchestrationLayerLive.pipe(
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      Layer.provideMerge(SqlitePersistenceLayerLive),
    ),
    CheckpointStore.layer.pipe(
      Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
    ),
  ).pipe(
    Layer.provideMerge(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
  );

  yield* seedProgram.pipe(Effect.provide(seedRuntimeLayer));
}).pipe(Effect.provide(NodeServices.layer));

if (import.meta.main) {
  NodeRuntime.runMain(main);
}
