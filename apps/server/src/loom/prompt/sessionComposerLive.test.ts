// @effect-diagnostics nodeBuiltinImport:off - fixture role files on disk.
/**
 * The real composer over the real orchestrator and Loom store: byte-stable output, write-once launch
 * identity, first-launch fork replay and its drafter exceptions, the child readership clause, cache
 * retention, the extension path and the relocation clause.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EventId,
  GoalId,
  GoalTaskId,
  HANDOFF_DRAFTER_ROLE,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
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
import { RETRO_REVIEWER_OVERLAY_PROMPT, RETRO_REVIEWER_TOOLS } from "../handoff/retroDraft.ts";
import { RETRO_REVIEWER_ROLE } from "../handoff/retroRole.ts";
import { loomPaths } from "../loomPaths.ts";
import * as LoomStore from "../projection/LoomStore.ts";
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
import { CAPABILITIES, SCHEDULING } from "../../mcp/toolkits/workstream/families.ts";
import {
  CHILD_READERSHIP_CLAUSE,
  deferredCapabilitiesClause,
  WORK_MODEL_ADDENDUM,
  threadIdentityClause,
} from "./prose.ts";
import { agentGitEnv } from "../workstream/agentGitIdentity.ts";
import type { LoomOpenSessionFields } from "@t3tools/contracts";
import type { LoomSessionComposerShape } from "./sessionComposer.ts";
import { loomHiddenToolsEnv, makeLoomSessionComposer } from "./sessionComposerLive.ts";

/** A replayed record as `threadId` launches it: the identity verbatim, the git identity its own. */
const asThread = (fields: LoomOpenSessionFields, threadId: ThreadId) => ({
  ...fields,
  env: { ...fields.env, ...agentGitEnv(threadId) },
});

/** The addendum and the capability line a role with these deferred families reads after it. */
const addendumWith = (...deferred: ReadonlyArray<string>) =>
  `${WORK_MODEL_ADDENDUM}\n\n${deferredCapabilitiesClause(CAPABILITIES.filter((capability) => deferred.includes(capability.id)))}`;
const ORCHESTRATOR_HEAD = addendumWith("browser", "devices");

/** Where the stub adapter's sessions run (the testkit's inert provider session). */
const STUB_SESSION_CWD = "/workspace/loom-test";

const composerDeps = (rootCacheLongShare: number) =>
  Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer, LoomExtensionPathLive).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-composer-" })),
    Layer.provideMerge(ServerSettings.layerTest({ rootCacheLongShare })),
    Layer.provideMerge(NodeServices.layer),
  );

/** The running config's Loom directories, as the identity clause names them. */
const paths = Effect.map(ServerConfig.ServerConfig, loomPaths);

/** A fresh composer with its own state dir; `body` gets the launch-identity dir too. */
const withComposer = <A, E, R>(
  rootCacheLongShare: number,
  body: (
    composer: LoomSessionComposerShape,
    identityDir: string,
    stateDir: string,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const composer = yield* makeLoomSessionComposer;
    const config = yield* ServerConfig.ServerConfig;
    return yield* body(composer, loomPaths(config).workstreamLaunchIdentityDir, config.stateDir);
  }).pipe(Effect.provide(composerDeps(rootCacheLongShare)));

/** A 1-hour root's launch env: its identity's arm, its git identity, the hidden tools and pi's idle-warming horizon. */
const longRootEnv = (threadId: ThreadId) => ({
  PI_CACHE_RETENTION: "long",
  ...agentGitEnv(threadId),
  ...loomHiddenToolsEnv(SCHEDULING), // the orchestrator's only withheld family
  PI_CACHE_WARMING_IDLE_MAX_MS: "5400000",
});

/** A root on a real checkout (so `.t3code/roles/` can be written under it). */
const seedRoot = (name: string, worktreePath: string, role?: string) =>
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
      ...(role === undefined ? {} : { role }),
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
      withComposer(1, (composer, identityDir) =>
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
          // The arm is identity; the keep-alive horizon and idle release are per-launch policy.
          assert.deepEqual(sidecar.env, { PI_CACHE_RETENTION: "long" });
          assert.deepEqual(first.env, longRootEnv(threadId));
          assert.equal(first.idleTimeoutMs, 2 * 60 * 60_000);
          assert.deepEqual(sidecar.modelSelection, testModelSelection);
          // The orchestrator's resident families are the launched profile.
          assert.include(sidecar.tools as Array<string>, "mcp__t3-code__workstream_spawn");
        }),
      ),
  );

  it.effect("composes addendum → identity → overlay for a root, with no child clause", () =>
    withComposer(1, (composer) =>
      Effect.gen(function* () {
        const { threadId } = yield* seedRoot("order", tempCheckout());
        const { appendSystemPrompt, env, extensions } = yield* composer.compose(threadId);
        assert.isTrue(
          appendSystemPrompt.startsWith(
            `${ORCHESTRATOR_HEAD}\n\n${threadIdentityClause(threadId, null, yield* paths)}\n\nYou orchestrate`,
          ),
        );
        assert.notInclude(appendSystemPrompt, CHILD_READERSHIP_CLAUSE);
        assert.notInclude(appendSystemPrompt, "Your parent is thread");
        // Resident for the orchestrator, so the capability line does not announce it.
        assert.notInclude(appendSystemPrompt, "schedule_task");
        assert.include(appendSystemPrompt, "SHIPPING POLICY");
        assert.include(appendSystemPrompt, "Available roles for spawning children");
        assert.deepEqual(env, longRootEnv(threadId));
        assert.lengthOf(extensions, 1);
        assert.equal(NodePath.basename(extensions[0]!), LOOM_EXTENSION_FILENAME);
        assert.isTrue(NodeFS.existsSync(extensions[0]!));
      }),
    ),
  );

  it.effect(
    "composes a root created with a role under that role's project overlay and the orchestrator's tools",
    () =>
      withComposer(1, (composer) =>
        Effect.gen(function* () {
          const checkout = tempCheckout();
          writeProjectRole(checkout, "slack-inbox", "- SLACK INBOX RULE");
          const { threadId } = yield* seedRoot("inbox", checkout, "slack-inbox");
          const { appendSystemPrompt } = yield* composer.compose(threadId);
          assert.isTrue(
            appendSystemPrompt.startsWith(
              `${ORCHESTRATOR_HEAD}\n\n${threadIdentityClause(threadId, null, yield* paths)}\n\n- SLACK INBOX RULE\n\n`,
            ),
          );
          assert.notInclude(appendSystemPrompt, CHILD_READERSHIP_CLAUSE);
        }),
      ),
  );

  it.effect("gives a child the readership clause, its role, short retention and no catalogue", () =>
    withComposer(1, (composer) =>
      Effect.gen(function* () {
        const { threadId: root, projectId } = yield* seedRoot("parent", tempCheckout());
        const child = ThreadId.make("thread:composer-child");
        yield* spawnChild({ parentThreadId: root, threadId: child, projectId, role: "coder" });
        const { appendSystemPrompt, env, idleTimeoutMs } = yield* composer.compose(child);
        assert.isTrue(
          appendSystemPrompt.startsWith(
            `${addendumWith("browser", "devices", "pull-requests", "delegation", "history")}\n\n${CHILD_READERSHIP_CLAUSE}\n\n${threadIdentityClause(child, root, yield* paths)}\n\nYou are a coder sub-thread.`,
          ),
        );
        assert.include(appendSystemPrompt, `Your parent is thread \`${root}\`.`);
        assert.notInclude(appendSystemPrompt, "Available roles for spawning children");
        // Withheld from a coder (hidden, so `tool_search` cannot load it): absent, not deferred.
        assert.notInclude(appendSystemPrompt, "schedule_task");
        assert.deepEqual(env, {
          PI_CACHE_RETENTION: "short",
          ...agentGitEnv(child),
          ...loomHiddenToolsEnv([]),
        });
        assert.isUndefined(idleTimeoutMs);
      }),
    ),
  );

  it.effect(
    "names only the capabilities a role reaches by tool_search: a shipper keeps pull requests resident",
    () =>
      withComposer(1, (composer) =>
        Effect.gen(function* () {
          const { threadId: root, projectId } = yield* seedRoot("shipper-parent", tempCheckout());
          const shipper = ThreadId.make("thread:composer-shipper");
          yield* spawnChild({
            parentThreadId: root,
            threadId: shipper,
            projectId,
            role: "shipper",
          });
          const { appendSystemPrompt } = yield* composer.compose(shipper);
          assert.isTrue(
            appendSystemPrompt.startsWith(
              `${addendumWith("browser", "devices", "delegation", "history")}\n\n${CHILD_READERSHIP_CLAUSE}`,
            ),
          );
          assert.include(appendSystemPrompt, "`html_preview`");
          assert.include(appendSystemPrompt, "`thread_search`");
          assert.notInclude(appendSystemPrompt, "`watch_pull_request`");
        }),
      ),
  );

  it.effect(
    "replays a forkFrom child from its source's record on its first launch only, leaving the source's untouched",
    () =>
      withComposer(0, (composer, identityDir) =>
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

          assert.deepEqual(yield* composer.compose(fork), asThread(sourceFields, fork));
          assert.equal(yield* fs.readFileString(sourceFile), sourceBytes);

          // Its relaunch is its own child identity, written once from then on (DL-740).
          const relaunched = yield* composer.compose(fork);
          assert.isTrue(
            relaunched.appendSystemPrompt.startsWith(
              `${addendumWith("browser", "devices", "pull-requests", "delegation")}\n\n${CHILD_READERSHIP_CLAUSE}\n\n${threadIdentityClause(fork, root, yield* paths)}\n\nYou are a researcher sub-thread.`,
            ),
          );
          assert.deepEqual(yield* composer.compose(fork), relaunched);
          assert.equal(yield* fs.readFileString(sourceFile), sourceBytes);
        }),
      ),
  );

  it.effect(
    "replays a V2 fork (thread_fork) from its source as a root on its first launch only, or composes it fresh as a root when the source has no record",
    () =>
      withComposer(1, (composer) =>
        Effect.gen(function* () {
          const { threadId: source } = yield* seedRoot("v2-fork", tempCheckout());
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
          const forkOf = (id: string) =>
            Effect.as(
              dispatch({
                type: "thread.fork",
                commandId: CommandId.make(`server:test-fork:${id}`),
                createdBy: "agent",
                creationSource: "mcp",
                sourceThreadId: source,
                targetThreadId: ThreadId.make(id),
                sourcePoint: { type: "latest_stable" },
              }),
              ThreadId.make(id),
            );

          // A source that never composed under V2 (a V1 import): the fork composes fresh, as a root.
          const fresh = yield* forkOf("thread:composer-v2-fork-fresh");
          const freshFields = yield* composer.compose(fresh);
          assert.isTrue(
            freshFields.appendSystemPrompt.startsWith(
              `${ORCHESTRATOR_HEAD}\n\n${threadIdentityClause(fresh, null, yield* paths)}`,
            ),
          );
          assert.deepEqual(freshFields.env, longRootEnv(fresh));

          const sourceFields = yield* composer.compose(source);
          const target = yield* forkOf("thread:composer-v2-fork-target");
          const forked = yield* composer.compose(target);
          assert.deepEqual(forked, asThread(sourceFields, target));
          assert.notInclude(forked.appendSystemPrompt, CHILD_READERSHIP_CLAUSE);
          assert.deepEqual(forked.env, longRootEnv(target));

          // Its relaunch is its own root identity, written once from then on (DL-740).
          const relaunched = yield* composer.compose(target);
          assert.isTrue(
            relaunched.appendSystemPrompt.startsWith(
              `${ORCHESTRATOR_HEAD}\n\n${threadIdentityClause(target, null, yield* paths)}\n\nYou orchestrate`,
            ),
          );
          assert.deepEqual(yield* composer.compose(target), relaunched);
          assert.deepEqual(yield* composer.compose(source), sourceFields);
        }),
      ),
  );

  it.effect(
    "a retro reviewer (a fresh root) composes with its overlay; a handoff drafter replays its source, or composes fresh when the source never launched",
    () =>
      withComposer(0, (composer, identityDir) =>
        Effect.gen(function* () {
          const { threadId: source, projectId } = yield* seedRoot("drafted", tempCheckout());
          const { threadId: unlaunched } = yield* seedRoot("upstream-only", tempCheckout());
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const drafter = (id: string, role: string, from: ThreadId | null) =>
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
                ...(from === null ? {} : { forkFromThreadId: from }),
              }),
              ThreadId.make(id),
            );
          const sourceFields = yield* composer.compose(source);

          const reviewer = yield* drafter("thread:composer-retro", RETRO_REVIEWER_ROLE, null);
          const reviewed = (yield* composer.compose(reviewer)).appendSystemPrompt;
          // A tool profile, not pi's full tool surface.
          const reviewerIdentity = JSON.parse(
            yield* (yield* FileSystem.FileSystem).readFileString(
              identityFile(identityDir, reviewer),
            ),
          );
          assert.deepEqual(reviewerIdentity.tools, RETRO_REVIEWER_TOOLS);
          assert.isTrue(
            reviewed.startsWith(
              `${WORK_MODEL_ADDENDUM}\n\n${threadIdentityClause(reviewer, null, yield* paths)}\n\n${RETRO_REVIEWER_OVERLAY_PROMPT}`,
            ),
          );
          assert.notInclude(reviewed, "Available roles for spawning children");

          const replaying = yield* drafter("thread:composer-drafter", HANDOFF_DRAFTER_ROLE, source);
          assert.deepEqual(yield* composer.compose(replaying), asThread(sourceFields, replaying));

          const fresh = yield* drafter(
            "thread:composer-drafter-fresh",
            HANDOFF_DRAFTER_ROLE,
            unlaunched,
          );
          assert.isTrue(
            (yield* composer.compose(fresh)).appendSystemPrompt.startsWith(
              `${ORCHESTRATOR_HEAD}\n\n${threadIdentityClause(fresh, null, yield* paths)}`,
            ),
          );
        }),
      ),
  );

  it.effect("allocates roots by share, logs the share and records the arm in the cache table", () =>
    Effect.gen(function* () {
      // sha256 first bytes: share-b 125, share-e 134 (below / above 256 × 0.5).
      const { threadId: long } = yield* seedRoot("share-b", tempCheckout());
      const { threadId: short } = yield* seedRoot("share-e", tempCheckout());
      // The state dir lives as long as the composer's layer.
      const launches = yield* withComposer(0.5, (composer, _identityDir, stateDir) =>
        Effect.gen(function* () {
          const longFields = yield* composer.compose(long);
          assert.deepEqual(longFields.env, longRootEnv(long));
          assert.equal(longFields.idleTimeoutMs, 2 * 60 * 60_000);
          const shortFields = yield* composer.compose(short);
          assert.deepEqual(shortFields.env, {
            PI_CACHE_RETENTION: "short",
            ...agentGitEnv(short),
            ...loomHiddenToolsEnv(SCHEDULING),
          });
          assert.isUndefined(shortFields.idleTimeoutMs);
          return NodeFS.readFileSync(
            NodePath.join(stateDir, "cache-retention-launches.jsonl"),
            "utf8",
          )
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        }),
      );
      assert.deepEqual(
        launches.map(({ threadId, cacheRetention, longShare }) => ({
          threadId,
          cacheRetention,
          longShare,
        })),
        [
          { threadId: long, cacheRetention: "long", longShare: 0.5 },
          { threadId: short, cacheRetention: "short", longShare: 0.5 },
        ],
      );
      const store = yield* LoomStore.LoomStoreV2;
      yield* store.cache.update(long, { requestEndedAt: "2026-10-12T00:00:00.000Z" });
      const sql = yield* SqlClient.SqlClient;
      assert.deepEqual(
        yield* sql`SELECT thread_id, retention, request_ended_at FROM loom_thread_cache
            WHERE thread_id IN (${long}, ${short}) ORDER BY retention`,
        [
          { thread_id: long, retention: "long", request_ended_at: "2026-10-12T00:00:00.000Z" },
          { thread_id: short, retention: "short", request_ended_at: null },
        ],
      );
    }),
  );

  it.effect("appends the relocation clause only when a recorded session ran elsewhere", () =>
    withComposer(0, (composer) =>
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
          `${before.appendSystemPrompt}\n\nYour work here previously happened in a different working directory; you are now in \`${elsewhere}\`. The files you see are this tree's CURRENT state, which may have moved on since you last ran, and any absolute paths you remember are historical; re-verify before reading or editing.`,
        );
        assert.notInclude(
          (yield* composer.compose(stayed)).appendSystemPrompt,
          "previously happened in a different working directory",
        );
      }),
    ),
  );

  it.effect("gives a root the goal block only when its goal already has tasks", () =>
    withComposer(0, (composer) =>
      Effect.gen(function* () {
        const store = yield* LoomStore.LoomStoreV2;
        const { threadId: goalless } = yield* seedRoot("goalless", tempCheckout());
        const fresh = yield* seedRoot("fresh-goal", tempCheckout());
        const joining = yield* seedRoot("joining", tempCheckout());
        const goal = (slug: string, projectId: ProjectId) =>
          store.goals.upsert({
            id: GoalId.make(`goal:${slug}`),
            projectId,
            slug,
            title: slug,
            description: "",
          });
        const empty = yield* goal("no-tasks", fresh.projectId);
        const inProgress = yield* goal("in-progress", joining.projectId);
        yield* store.tasks.replaceTree(inProgress.id, [
          {
            id: GoalTaskId.make("task:next"),
            parentTaskId: null,
            text: "Next step",
            done: false,
            position: 0,
          },
        ]);
        const join = (threadId: ThreadId, goalId: GoalId) =>
          dispatch({
            type: "thread.goal.set",
            commandId: CommandId.make(`command:goal-set:${threadId}`),
            threadId,
            createdAt: DateTime.formatIso(DateTime.makeUnsafe(0)),
            goalId,
          });
        yield* join(fresh.threadId, empty.id);
        yield* join(joining.threadId, inProgress.id);

        assert.notInclude((yield* composer.compose(goalless)).appendSystemPrompt, "Active goal");
        assert.notInclude(
          (yield* composer.compose(fresh.threadId)).appendSystemPrompt,
          "Active goal",
        );
        const joined = (yield* composer.compose(joining.threadId)).appendSystemPrompt;
        assert.include(joined, `Active goal \`${inProgress.id}\``);
        assert.include(joined, "Next step");
      }),
    ),
  );
});
