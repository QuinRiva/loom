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
  EventId,
  GoalId,
  GoalTaskId,
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
// Goal-panel fixture: three extra ROOT threads on the same goal. The chain
// (predecessor -> successor via continuesThreadId) plus a parallel root created
// BETWEEN them is what makes the Threads section's handoff order distinguishable
// from plain createdAt order.
const GOAL_PREDECESSOR_ID = ThreadId.make("seed-thread-goal-predecessor");
const GOAL_PARALLEL_ID = ThreadId.make("seed-thread-goal-parallel");
const GOAL_SUCCESSOR_ID = ThreadId.make("seed-thread-goal-successor");
const CODER_ALPHA_ID = ThreadId.make("seed-thread-coder-alpha");
const CODER_BETA_ID = ThreadId.make("seed-thread-coder-beta");
const CODER_REWORK_ID = ThreadId.make("seed-thread-coder-rework");
const CODER_SHARED_ID = ThreadId.make("seed-thread-coder-shared");
const CODER_CANCELLED_ID = ThreadId.make("seed-thread-coder-cancelled");
// A ready dependency + a dependent gated on it: the dependent resolves to the
// `blocked` column (steel, v2 palette) with a steel within-wave waits-on edge.
const CODER_DEP_ID = ThreadId.make("seed-thread-coder-dep");
const CODER_BLOCKED_ID = ThreadId.make("seed-thread-coder-blocked");

const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("pi"),
  model: "claude-opus-4-8",
} as const;

const BASE_TIME = "2026-01-01T09:00:00.000Z";

let commandCounter = 0;
const nextCommandId = (label: string): CommandId =>
  CommandId.make(`seed:${label}:${(commandCounter++).toString().padStart(4, "0")}`);

let eventCounter = 0;
const nextEventId = (label: string): EventId =>
  EventId.make(`seed-evt:${label}:${(eventCounter++).toString().padStart(4, "0")}`);

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

  // Goal tasks: the panel's task tree needs a live fixture, and the progress
  // pill is meaningless without a mix of done/outstanding.
  for (const [index, task] of [
    { text: "Seed a realistic workstream fixture", done: true },
    { text: "Capture real turn checkpoints for the diff scope", done: true },
    { text: "Verify the goal panel's handoff ordering", done: false },
  ].entries()) {
    const taskId = GoalTaskId.make(`seed-goal-task-${index}`);
    yield* dispatch({
      type: "goal.task.create",
      commandId: nextCommandId(`goal-task-${index}`),
      goalId: GOAL_ID,
      taskId,
      parentTaskId: null,
      text: task.text,
      position: index,
      createdAt: iso(0),
    });
    if (task.done) {
      yield* dispatch({
        type: "goal.task.update",
        commandId: nextCommandId(`goal-task-done-${index}`),
        goalId: GOAL_ID,
        taskId,
        done: true,
      });
    }
  }

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

  // A control-plane FYI digest on the orchestrator so the collapsed digest card
  // (structured `controlPayload` + "show raw payload" toggle) has a live fixture
  // for the dev-verify recipe. The `text` is the exact flattened bytes the model
  // would receive; the payload is the structured source-of-truth rendered.
  yield* dispatch({
    type: "thread.turn.start",
    commandId: nextCommandId("orchestrator-digest"),
    threadId: ORCHESTRATOR_ID,
    message: {
      messageId: MessageId.make("seed-msg-orchestrator-digest"),
      role: "user",
      origin: "control_notice",
      controlPayload: {
        kind: "digest",
        heading:
          "FYI digest — the following items completed and were fully routed since you last heard.",
        items: [
          {
            threadId: CODER_ALPHA_ID,
            role: "coder",
            title: "Completed",
            status: "done",
            icon: "☑️",
            reportPath: "seed-thread-coder-alpha.md",
            excerpt: "# Config loader\nImplemented the loader module and wired it into startup.",
            timestamp: "2026-07-13 02:15Z",
          },
          {
            threadId: CODER_REWORK_ID,
            role: "reviewer",
            title: "Gate resolved (clean)",
            status: "clean",
            icon: "✅",
            reportPath: "seed-thread-coder-rework.md",
            excerpt: "Verified the rework: findings addressed, no new issues.",
            timestamp: "2026-07-13 02:16Z",
          },
          {
            threadId: CODER_CANCELLED_ID,
            role: "coder",
            title: "Cancelled",
            status: "cancelled",
            icon: "🚫",
            timestamp: "2026-07-13 02:17Z",
          },
        ],
      },
      text: [
        "[T3 Workstream control plane — automated notice, not from the user]",
        "",
        "FYI digest — the following items completed and were fully routed since you last heard. Nothing below is blocked on you.",
        "",
        "### ☑️ coder `seed-thread-coder-alpha` — done",
        "Report reference: `seed-thread-coder-alpha.md` (read the full report on demand).",
        "",
        "# Config loader",
        "Implemented the loader module and wired it into startup.",
        "",
        "### ✅ Gate resolved `clean` — reviewer `seed-thread-coder-rework`",
        "Verdict report: `seed-thread-coder-rework.md` — excerpt:",
        "",
        "Verified the rework: findings addressed, no new issues.",
        "",
        "### coder `seed-thread-coder-cancelled` — cancelled",
      ].join("\n"),
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: iso(1),
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
    {
      id: CODER_DEP_ID,
      name: "coder-dep",
      title: "Schema migration",
      purpose: "The upstream migration the reviewer waits on.",
      role: "coder",
      isolation: "isolated" as const,
      // Left "ready" (not done) so its dependent stays blocked — exercises the
      // steel `blocked` node + steel waits-on edge in the v2 palette. No turns
      // (never started), so it reads awaiting_brief — still "not done".
      planLane: "ready" as const,
      turns: [] as { file: string; contents: string[] }[],
    },
    {
      id: CODER_BLOCKED_ID,
      name: "coder-blocked",
      title: "Migration review",
      purpose: "A reviewer gated on the schema migration — blocked on upstream.",
      role: "reviewer",
      isolation: "isolated" as const,
      planLane: "ready" as const,
      blockedBy: [CODER_DEP_ID],
      turns: [] as { file: string; contents: string[] }[],
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
      ...((spec as { blockedBy?: ReadonlyArray<ThreadId> }).blockedBy
        ? { blockedBy: (spec as { blockedBy?: ReadonlyArray<ThreadId> }).blockedBy }
        : {}),
      // Deliberately null: a non-null branch marks the child as a provisioned
      // worktree, which the live WorkstreamFanInReactor would then try to git
      // merge/remove at runtime — mutating or destroying the seeded checkpoints.
      // `isolation` alone carries what the DiffPanel scope needs; the branch is
      // irrelevant to `collectCoderDescendants`.
      branch: null,
      worktreePath,
      createdAt: iso(coderIndex),
    });

    // A never-started spec (empty turns) stays a clean pre-run node — skip the
    // checkpoint baseline + turn dispatch (a blocked thread may not start a turn).
    if (spec.turns.length > 0) {
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
            // Sub-thread turns are control-plane-injected: turn 1 is the kickoff
            // brief, later turns are gate rework legs.
            origin: turnCount === 1 ? "kickoff" : "control_notice",
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

  // Enrich the in-progress rework coder so the graph's running-node footer, the
  // hover card (⚒ tools · pill · cost · turn line), and the active strip meta row
  // all have real data — and leave a genuinely in-flight turn so the live pulse
  // dot renders. toolUses/cost derive from durable activities; the assistant
  // delta (no matching complete) is the latest-narration preview + running turn.
  for (let t = 0; t < 12; t += 1) {
    yield* dispatch({
      type: "thread.activity.append",
      commandId: nextCommandId(`rework-tool-${t}`),
      threadId: CODER_REWORK_ID,
      activity: {
        id: nextEventId(`rework-tool-${t}`),
        tone: "tool",
        kind: "tool.completed",
        summary: `Edited parser.ts (${t + 1})`,
        payload: { tool: "edit" },
        turnId: null,
        createdAt: iso(200 + t),
      },
      createdAt: iso(200 + t),
    });
  }
  yield* dispatch({
    type: "thread.activity.append",
    commandId: nextCommandId("rework-ctx"),
    threadId: CODER_REWORK_ID,
    activity: {
      id: nextEventId("rework-ctx"),
      tone: "info",
      kind: "context-window.updated",
      summary: "Context window updated",
      payload: { usedTokens: 82_000, maxTokens: 200_000, costUsd: 1.43 },
      turnId: null,
      createdAt: iso(213),
    },
    createdAt: iso(213),
  });
  // A fresh user turn with no completion → latestTurn.state "running"
  // (hasRunningSignal), and an assistant delta → the lastActivityPreview line.
  yield* dispatch({
    type: "thread.turn.start",
    commandId: nextCommandId("rework-live-user"),
    threadId: CODER_REWORK_ID,
    message: {
      messageId: MessageId.make("seed-msg-rework-live-user"),
      role: "user",
      origin: "control_notice",
      text: "Rework round 3.",
      attachments: [],
    },
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: iso(214),
  });
  yield* dispatch({
    type: "thread.message.assistant.delta",
    commandId: nextCommandId("rework-live-delta"),
    threadId: CODER_REWORK_ID,
    messageId: MessageId.make("seed-msg-rework-live-assistant"),
    delta: "Normalising the parser input — lower-casing then trimming before the tokenizer pass",
    createdAt: iso(215),
  });

  // ---- goal-panel roots: a handoff chain plus a parallel root -------------
  // Creation order is predecessor(261) -> parallel(262) -> successor(263), so a
  // createdAt-only list would read [predecessor, parallel, successor]. The
  // handoff walk must instead read [predecessor, successor, parallel]: the
  // successor follows the thread it continues, and the unchained root sorts by
  // creation among the chain HEADS.
  yield* dispatch({
    type: "thread.create",
    commandId: nextCommandId("goal-predecessor"),
    threadId: GOAL_PREDECESSOR_ID,
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    parentThreadId: null,
    role: "orchestrator",
    purpose: "Scope the diff-panel fixture before implementation.",
    title: "Scope the diff-panel fixture",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    planLane: "done",
    branch: null,
    worktreePath: workspaceRoot,
    createdAt: iso(261),
  });
  yield* dispatch({
    type: "thread.create",
    commandId: nextCommandId("goal-parallel"),
    threadId: GOAL_PARALLEL_ID,
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    parentThreadId: null,
    role: "researcher",
    purpose: "Independent investigation on the same goal \u2014 not on the chain.",
    title: "Checkpoint-ref survey (parallel root)",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    planLane: "done",
    branch: null,
    worktreePath: workspaceRoot,
    createdAt: iso(262),
  });
  yield* dispatch({
    type: "thread.create",
    commandId: nextCommandId("goal-successor"),
    threadId: GOAL_SUCCESSOR_ID,
    projectId: PROJECT_ID,
    goalId: GOAL_ID,
    parentThreadId: null,
    role: "orchestrator",
    purpose: "Continue the scoping work with a fresh context window.",
    title: "Fixture follow-through (continuation)",
    brief: "Continue from the scoping thread; the checkpoint refs are captured.",
    modelSelection: MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    planLane: "planned",
    continuesThreadId: GOAL_PREDECESSOR_ID,
    branch: null,
    worktreePath: workspaceRoot,
    createdAt: iso(263),
  });

  yield* Console.log(
    JSON.stringify(
      {
        ok: true,
        dbPath: config.dbPath,
        workspaceRoot,
        projectId: PROJECT_ID,
        goalId: GOAL_ID,
        orchestratorThreadId: ORCHESTRATOR_ID,
        goalChain: [GOAL_PREDECESSOR_ID, GOAL_SUCCESSOR_ID, GOAL_PARALLEL_ID],
        coders: coderSpecs.map((spec) => ({
          threadId: spec.id,
          title: spec.title,
          isolation: spec.isolation,
          planLane: spec.planLane,
          turnCount: spec.turns[0]?.contents.length ?? 0,
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
