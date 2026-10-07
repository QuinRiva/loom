// @effect-diagnostics nodeBuiltinImport:off - fixture role files on disk.
/**
 * The real composer over the real orchestrator and Loom store: byte-stable
 * output, the write-once launch identity, `forkFrom` replay and the drafter
 * exceptions to it, the child
 * readership clause, cache retention, the extension path and the relocation
 * clause.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { CheckpointId, CommandId, EventId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ServerConfig from "../../config.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import {
  LOOM_EXTENSION_FILENAME,
  LoomExtensionPathLive,
} from "../../provider/Drivers/Pi/loomExtension.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { HANDOFF_DRAFTER_ROLE } from "../handoff/handoffDraft.ts";
import { RETRO_REVIEWER_OVERLAY_PROMPT, RETRO_REVIEWER_ROLE } from "../handoff/retroDraft.ts";
import { loomPaths } from "../loomPaths.ts";
import {
  completeSeededRun,
  dispatch,
  LoomOrchestratorTestLayer,
  seededRunIds,
  seedRunningRun,
  spawnChild,
  testModelSelection,
  writeEvents,
} from "../testkit/loomOrchestratorLayer.ts";
import { CHILD_READERSHIP_CLAUSE, WORK_MODEL_ADDENDUM, threadIdentityClause } from "./prose.ts";
import type { LoomSessionComposerShape } from "./sessionComposer.ts";
import { makeLoomSessionComposer } from "./sessionComposerLive.ts";

/** Where the stub adapter's sessions run (the testkit's inert provider session). */
const STUB_SESSION_CWD = "/workspace/loom-test";

const composerDeps = (rootCacheRetention: "ab" | "long" | "short") =>
  Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer, LoomExtensionPathLive).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-composer-" })),
    Layer.provideMerge(ServerSettings.layerTest({ rootCacheRetention })),
    Layer.provideMerge(NodeServices.layer),
  );

/** A fresh composer with its own state dir; `body` gets the launch-identity dir too. */
const withComposer = <A, E, R>(
  rootCacheRetention: "ab" | "long" | "short",
  body: (composer: LoomSessionComposerShape, identityDir: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const composer = yield* makeLoomSessionComposer;
    const config = yield* ServerConfig.ServerConfig;
    return yield* body(composer, loomPaths(config).workstreamLaunchIdentityDir);
  }).pipe(Effect.provide(composerDeps(rootCacheRetention)));

/** A root on a real checkout (so `.t3code/roles/` can be written under it). */
const seedRoot = (name: string, worktreePath: string) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make(`project:composer-${name}`);
    const threadId = ThreadId.make(`thread:composer-${name}`);
    yield* (yield* ProjectService.ProjectService).create({
      commandId: CommandId.make(`command:seed-project:${projectId}`),
      projectId,
      title: "Composer project",
      workspaceRoot: worktreePath,
    });
    yield* dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:seed-thread:${threadId}`),
      threadId,
      projectId,
      title: `Root ${name}`,
      modelSelection: testModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath,
    });
    return { projectId, threadId };
  });

const identityFile = (dir: string, threadId: ThreadId) =>
  NodePath.join(dir, `${threadId.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

const tempCheckout = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "loom-composer-checkout-"));
  NodeFS.writeFileSync(NodePath.join(dir, ".git"), "");
  return dir;
};

const writeProjectRole = (checkout: string, role: string, body: string) => {
  NodeFS.mkdirSync(NodePath.join(checkout, ".t3code", "roles"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(checkout, ".t3code", "roles", `${role}.md`), body);
};

it.layer(LoomOrchestratorTestLayer)("LoomSessionComposer", (it) => {
  it.effect(
    "is byte-stable, and the identity is written once (a role edit does not reach a relaunch)",
    () =>
      withComposer("long", (composer, identityDir) =>
        Effect.gen(function* () {
          const checkout = tempCheckout();
          writeProjectRole(checkout, "orchestrator", "- PROJECT RULE ONE");
          const { threadId } = yield* seedRoot("stable", checkout);

          const first = yield* composer.compose(threadId);
          writeProjectRole(checkout, "orchestrator", "- PROJECT RULE TWO");
          const second = yield* composer.compose(threadId);

          assert.deepEqual(second, first);
          assert.include(first.appendSystemPrompt, "PROJECT RULE ONE");
          assert.notInclude(second.appendSystemPrompt, "PROJECT RULE TWO");
          const sidecar = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
          )(
            yield* (yield* FileSystem.FileSystem).readFileString(
              identityFile(identityDir, threadId),
            ),
          );
          assert.deepEqual(Object.keys(sidecar).sort(), [
            "appendSystemPrompt",
            "env",
            "extensions",
            "modelSelection",
            "skills",
            "tools",
          ]);
          assert.equal(sidecar.appendSystemPrompt, first.appendSystemPrompt);
          assert.deepEqual(sidecar.modelSelection, testModelSelection);
          // The orchestrator's resident families are the launched profile.
          assert.include(sidecar.tools as Array<string>, "mcp__t3-code__workstream_spawn");
          assert.include(sidecar.tools as Array<string>, "mcp__t3-code__enable_toolset");
        }),
      ),
  );

  it.effect("composes addendum → identity → overlay for a root, with no child clause", () =>
    withComposer("long", (composer) =>
      Effect.gen(function* () {
        const { threadId } = yield* seedRoot("order", tempCheckout());
        const { appendSystemPrompt, env, extensions } = yield* composer.compose(threadId);
        assert.isTrue(
          appendSystemPrompt.startsWith(
            `${WORK_MODEL_ADDENDUM}\n\n${threadIdentityClause(threadId)}\n\nYou orchestrate`,
          ),
        );
        assert.notInclude(appendSystemPrompt, CHILD_READERSHIP_CLAUSE);
        assert.include(appendSystemPrompt, "SHIPPING POLICY");
        assert.include(appendSystemPrompt, "Available roles for spawning children");
        assert.deepEqual(env, { PI_CACHE_RETENTION: "long" });
        assert.lengthOf(extensions, 1);
        assert.equal(NodePath.basename(extensions[0]!), LOOM_EXTENSION_FILENAME);
        assert.isTrue(NodeFS.existsSync(extensions[0]!));
      }),
    ),
  );

  it.effect("gives a child the readership clause, its role, short retention and no catalogue", () =>
    withComposer("long", (composer) =>
      Effect.gen(function* () {
        const { threadId: root, projectId } = yield* seedRoot("parent", tempCheckout());
        const child = ThreadId.make("thread:composer-child");
        yield* spawnChild({ parentThreadId: root, threadId: child, projectId, role: "coder" });
        const { appendSystemPrompt, env } = yield* composer.compose(child);
        assert.isTrue(
          appendSystemPrompt.startsWith(
            `${WORK_MODEL_ADDENDUM}\n\n${CHILD_READERSHIP_CLAUSE}\n\n${threadIdentityClause(child)}\n\nYou are a coder sub-thread.`,
          ),
        );
        assert.notInclude(appendSystemPrompt, "Available roles for spawning children");
        assert.deepEqual(env, { PI_CACHE_RETENTION: "short" });
      }),
    ),
  );

  it.effect(
    "replays a forkFrom child from its source's record verbatim, leaving the source's untouched",
    () =>
      withComposer("short", (composer, identityDir) =>
        Effect.gen(function* () {
          const { threadId: root, projectId } = yield* seedRoot("fork", tempCheckout());
          const source = ThreadId.make("thread:composer-fork-source");
          const fork = ThreadId.make("thread:composer-fork-child");
          yield* spawnChild({
            parentThreadId: root,
            threadId: source,
            projectId,
            role: "researcher",
          });
          yield* dispatch({
            type: "thread.spawn",
            commandId: CommandId.make(`server:test-spawn:${fork}`),
            threadId: fork,
            createdAt: DateTime.formatIso(yield* DateTime.now),
            createdBy: "agent",
            creationSource: "mcp",
            parentThreadId: root,
            projectId,
            title: "Fork child",
            modelSelection: testModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            role: "researcher",
            purpose: "fork of the source",
            goalId: null,
            blockedBy: [source],
            forkFromThreadId: source,
          });

          // No source record yet: the fork refuses loudly.
          const refused = yield* Effect.exit(composer.compose(fork));
          assert.isTrue(Exit.isFailure(refused));
          assert.include(
            String(Exit.isFailure(refused) ? refused.cause : ""),
            "LoomForkSourceIdentityMissing",
          );

          const fs = yield* FileSystem.FileSystem;
          const sourceFile = identityFile(identityDir, source);
          const sourceFields = yield* composer.compose(source);
          const sourceBytes = yield* fs.readFileString(sourceFile);

          assert.deepEqual(yield* composer.compose(fork), sourceFields);
          assert.equal(yield* fs.readFileString(sourceFile), sourceBytes);
          // The fork keeps its own copy, so a fork of the fork replays the same bytes.
          assert.equal(yield* fs.readFileString(identityFile(identityDir, fork)), sourceBytes);
        }),
      ),
  );

  it.effect("replays a V2 fork (thread_fork) from its source as a root, not as its child", () =>
    withComposer("long", (composer) =>
      Effect.gen(function* () {
        const { threadId: source } = yield* seedRoot("v2-fork", tempCheckout());
        const sourceFields = yield* composer.compose(source);
        yield* seedRunningRun({ threadId: source });
        yield* completeSeededRun({ threadId: source });
        // `latest_stable` forks the last completed run with a checkpoint.
        const run = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(source))
          .runs[0]!;
        yield* writeEvents([
          {
            id: EventId.make("event:composer-v2-fork:checkpoint"),
            type: "run.updated",
            threadId: source,
            runId: seededRunIds(source).runId,
            occurredAt: yield* DateTime.now,
            payload: { ...run, checkpointId: CheckpointId.make("checkpoint:composer-v2-fork") },
          },
        ]);
        const fork = ThreadId.make("thread:composer-v2-fork-target");
        yield* dispatch({
          type: "thread.fork",
          commandId: CommandId.make(`server:test-fork:${fork}`),
          createdBy: "agent",
          creationSource: "mcp",
          sourceThreadId: source,
          targetThreadId: fork,
          sourcePoint: { type: "latest_stable" },
        });

        const forked = yield* composer.compose(fork);
        assert.deepEqual(forked, sourceFields);
        assert.notInclude(forked.appendSystemPrompt, CHILD_READERSHIP_CLAUSE);
        assert.deepEqual(forked.env, { PI_CACHE_RETENTION: "long" });
      }),
    ),
  );

  it.effect(
    "a retro reviewer composes its own identity with its overlay; a handoff drafter replays its source, or composes fresh when the source never launched",
    () =>
      withComposer("short", (composer) =>
        Effect.gen(function* () {
          const { threadId: source, projectId } = yield* seedRoot("drafted", tempCheckout());
          const { threadId: unlaunched } = yield* seedRoot("upstream-only", tempCheckout());
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const drafter = (id: string, role: string, from: ThreadId) =>
            Effect.as(
              dispatch({
                type: "thread.spawn",
                commandId: CommandId.make(`server:test-spawn:${id}`),
                threadId: ThreadId.make(id),
                createdAt,
                createdBy: "user",
                creationSource: "server",
                parentThreadId: null,
                projectId,
                title: id,
                modelSelection: testModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                role,
                purpose: null,
                goalId: null,
                forkFromThreadId: from,
              }),
              ThreadId.make(id),
            );
          const sourceFields = yield* composer.compose(source);

          const reviewer = yield* drafter("thread:composer-retro", RETRO_REVIEWER_ROLE, source);
          const reviewed = (yield* composer.compose(reviewer)).appendSystemPrompt;
          assert.isTrue(
            reviewed.startsWith(
              `${WORK_MODEL_ADDENDUM}\n\n${threadIdentityClause(reviewer)}\n\n${RETRO_REVIEWER_OVERLAY_PROMPT}`,
            ),
          );
          assert.notInclude(reviewed, "Available roles for spawning children");

          const replaying = yield* drafter("thread:composer-drafter", HANDOFF_DRAFTER_ROLE, source);
          assert.deepEqual(yield* composer.compose(replaying), sourceFields);

          const fresh = yield* drafter(
            "thread:composer-drafter-fresh",
            HANDOFF_DRAFTER_ROLE,
            unlaunched,
          );
          assert.isTrue(
            (yield* composer.compose(fresh)).appendSystemPrompt.startsWith(
              `${WORK_MODEL_ADDENDUM}\n\n${threadIdentityClause(fresh)}`,
            ),
          );
        }),
      ),
  );

  it.effect("appends the relocation clause only when a recorded session ran elsewhere", () =>
    withComposer("short", (composer) =>
      Effect.gen(function* () {
        const elsewhere = tempCheckout();
        const { threadId: moved } = yield* seedRoot("moved", elsewhere);
        const { threadId: stayed } = yield* seedRoot("stayed", STUB_SESSION_CWD);

        const before = yield* composer.compose(moved);
        assert.notInclude(
          before.appendSystemPrompt,
          "previously happened in a different working directory",
        );

        // The stub adapter's session records STUB_SESSION_CWD as its cwd.
        yield* seedRunningRun({ threadId: moved, live: true });
        yield* seedRunningRun({ threadId: stayed, live: true });

        const after = yield* composer.compose(moved);
        assert.equal(
          after.appendSystemPrompt,
          `${before.appendSystemPrompt}\n\nYour work here previously happened in a different working directory; you are now in \`${elsewhere}\`. The files you see are this tree's CURRENT state, which may have moved on since you last ran, and any absolute paths you remember are historical — re-verify before reading or editing.`,
        );
        assert.notInclude(
          (yield* composer.compose(stayed)).appendSystemPrompt,
          "previously happened in a different working directory",
        );
      }),
    ),
  );
});
