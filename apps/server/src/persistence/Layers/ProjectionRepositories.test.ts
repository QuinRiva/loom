import { ProjectId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionProjectRepositoryLive } from "./ProjectionProjects.ts";
import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { ProjectionProjectRepository } from "../Services/ProjectionProjects.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";

const projectionRepositoriesLayer = it.layer(
  Layer.mergeAll(
    ProjectionProjectRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

projectionRepositoriesLayer("Projection repositories", (it) => {
  it.effect("stores SQL NULL for missing project model options", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectionProjectRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* projects.upsert({
        projectId: ProjectId.make("project-null-options"),
        title: "Null options project",
        workspaceRoot: "/tmp/project-null-options",
        defaultModelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        defaultStartFromOrigin: null,
        defaultThreadEnvMode: null,
        scripts: [],
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly defaultModelSelection: string | null;
      }>`
        SELECT default_model_selection_json AS "defaultModelSelection"
        FROM projection_projects
        WHERE project_id = 'project-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_projects row to exist.");
      }

      assert.strictEqual(
        row.defaultModelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        }),
      );

      const persisted = yield* projects.getById({
        projectId: ProjectId.make("project-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.defaultModelSelection, {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      });
    }),
  );

  it.effect("stores JSON for thread model options", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-null-options"),
        projectId: ProjectId.make("project-null-options"),
        goalId: null,
        parentThreadId: null,
        role: null,
        purpose: null,
        brief: null,
        planLane: "planned" as const,
        attention: [],
        blockedBy: [],
        spawnGeneration: null,
        forkFromThreadId: null,
        continuesThreadId: null,
        reportPath: null,
        graphKey: null,
        kickoffBriefPath: null,
        planLaneSince: null,
        dependenciesSince: null,
        faninSince: null,
        routes: [],
        gateRounds: 0,
        pendingRework: 0,
        lastOutcome: null,
        isolation: "shared" as const,
        fanInState: "none" as const,
        title: "Null options thread",
        titleProvenance: "curated" as const,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        cumulativeCostUsd: 0,
        toolUses: null,
        usedTokens: null,
        maxTokens: null,
        diffAdditions: null,
        diffDeletions: null,
        handoffDestinations: [],
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly modelSelection: string | null;
      }>`
        SELECT model_selection_json AS "modelSelection"
        FROM projection_threads
        WHERE thread_id = 'thread-null-options'
      `;
      const row = rows[0];
      if (!row) {
        return yield* Effect.die("Expected projection_threads row to exist.");
      }

      assert.strictEqual(
        row.modelSelection,
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        }),
      );

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-null-options"),
      });
      assert.deepStrictEqual(Option.getOrNull(persisted)?.modelSelection, {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      });
    }),
  );

  // Scaffold-first graph authoring: graphKey (unique-forever) must round-trip
  // through SQL so the decider's uniqueness check survives a restart (the
  // command read model is hydrated from these columns), and kickoffBriefPath
  // must round-trip so the dispatcher's brief gate reads a durable pointer.
  it.effect("round-trips graphKey and kickoffBriefPath columns", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-scaffold-fields");

      yield* threads.upsert({
        threadId: ThreadId.make("thread-scaffold-fields"),
        projectId: ProjectId.make("project-1"),
        goalId: null,
        parentThreadId: ThreadId.make("parent-scaffold"),
        role: "coder",
        purpose: null,
        brief: null,
        planLane: "ready" as const,
        attention: [],
        blockedBy: [],
        spawnGeneration: null,
        forkFromThreadId: null,
        continuesThreadId: null,
        reportPath: null,
        graphKey: "api",
        kickoffBriefPath: "/tmp/briefs/api.md",
        planLaneSince: null,
        dependenciesSince: null,
        faninSince: null,
        routes: [],
        gateRounds: 0,
        pendingRework: 0,
        lastOutcome: null,
        isolation: "shared" as const,
        fanInState: "none" as const,
        title: "Scaffolded node",
        titleProvenance: "curated" as const,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-4-6",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-24T00:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        cumulativeCostUsd: 0,
        toolUses: null,
        usedTokens: null,
        maxTokens: null,
        diffAdditions: null,
        diffDeletions: null,
        handoffDestinations: [],
        deletedAt: null,
      });

      const rows = yield* sql<{
        readonly graphKey: string | null;
        readonly kickoffBriefPath: string | null;
      }>`
        SELECT graph_key AS "graphKey", kickoff_brief_path AS "kickoffBriefPath"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `;
      assert.strictEqual(rows[0]?.graphKey, "api");
      assert.strictEqual(rows[0]?.kickoffBriefPath, "/tmp/briefs/api.md");

      const persisted = yield* threads.getById({ threadId });
      assert.strictEqual(Option.getOrNull(persisted)?.graphKey, "api");
      assert.strictEqual(Option.getOrNull(persisted)?.kickoffBriefPath, "/tmp/briefs/api.md");
    }),
  );

  it.effect("round-trips non-null settlement values through the thread row", () =>
    Effect.gen(function* () {
      const threads = yield* ProjectionThreadRepository;

      yield* threads.upsert({
        threadId: ThreadId.make("thread-settled"),
        projectId: ProjectId.make("project-1"),
        goalId: null,
        parentThreadId: null,
        role: "coder",
        purpose: null,
        brief: null,
        planLane: "ready" as const,
        attention: [],
        blockedBy: [],
        spawnGeneration: null,
        forkFromThreadId: null,
        continuesThreadId: null,
        reportPath: null,
        graphKey: null,
        kickoffBriefPath: null,
        planLaneSince: null,
        dependenciesSince: null,
        faninSince: null,
        routes: [],
        gateRounds: 0,
        pendingRework: 0,
        lastOutcome: null,
        isolation: "shared" as const,
        fanInState: "none" as const,
        title: "Settled thread",
        titleProvenance: "curated" as const,
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurnId: null,
        createdAt: "2026-03-24T00:00:00.000Z",
        updatedAt: "2026-03-25T00:00:00.000Z",
        archivedAt: null,
        settledOverride: "settled",
        settledAt: "2026-03-25T00:00:00.000Z",
        snoozedUntil: "2026-03-26T09:00:00.000Z",
        snoozedAt: "2026-03-25T00:00:00.000Z",
        pinnedAt: "2026-03-25T00:00:00.000Z",
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        cumulativeCostUsd: 0,
        toolUses: null,
        usedTokens: null,
        maxTokens: null,
        diffAdditions: null,
        diffDeletions: null,
        handoffDestinations: [],
        deletedAt: null,
      });

      const persisted = yield* threads.getById({
        threadId: ThreadId.make("thread-settled"),
      });
      const row = Option.getOrNull(persisted);
      if (!row) {
        return yield* Effect.die("Expected settled projection_threads row to exist.");
      }
      assert.strictEqual(row.settledOverride, "settled");
      assert.strictEqual(row.settledAt, "2026-03-25T00:00:00.000Z");
      assert.strictEqual(row.snoozedUntil, "2026-03-26T09:00:00.000Z");
      assert.strictEqual(row.snoozedAt, "2026-03-25T00:00:00.000Z");
      assert.strictEqual(row.pinnedAt, "2026-03-25T00:00:00.000Z");

      // Un-settle to the keep-active pin and wake the snooze; confirm the
      // flips persist.
      yield* threads.upsert({
        ...row,
        settledOverride: "active",
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
      });
      const repersisted = yield* threads.getById({
        threadId: ThreadId.make("thread-settled"),
      });
      const updated = Option.getOrNull(repersisted);
      assert.strictEqual(updated?.settledOverride, "active");
      assert.strictEqual(updated?.settledAt, null);
      assert.strictEqual(updated?.snoozedUntil, null);
      assert.strictEqual(updated?.snoozedAt, null);
      assert.strictEqual(updated?.pinnedAt, null);
    }),
  );
});
