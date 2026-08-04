// @effect-diagnostics nodeBuiltinImport:off
import {
  CheckpointRef,
  EventId,
  GoalId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { TestClock } from "effect/testing";

import { ServerConfig, layerTest as serverConfigLayerTest } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ORCHESTRATION_PROJECTOR_NAMES } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import {
  applyBriefNeededParentAttention,
  makeBriefNeededOutwardAttention,
} from "../briefNeededOutwardAttention.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asCheckpointRef = (value: string): CheckpointRef => CheckpointRef.make(value);
const asGoalId = (value: string): GoalId => GoalId.make(value);

/**
 * Two projects (one deleted), four goals (active / archived / deleted / other
 * project) and a nested task tree with one deleted task — the shapes the goal
 * MCP endpoints must resolve correctly.
 */
const seedGoalFixture = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql`DELETE FROM projection_goal_tasks`;
    yield* sql`DELETE FROM projection_goals`;
    yield* sql`DELETE FROM projection_projects`;
    yield* sql`DELETE FROM projection_threads`;

    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, default_model_selection_json, scripts_json,
        created_at, updated_at, deleted_at
      ) VALUES
        ('project-1', 'Project 1', '/tmp/project-1', NULL, '[]',
         '2026-04-06T00:00:00.000Z', '2026-04-06T00:00:01.000Z', NULL),
        ('project-2', 'Project 2', '/tmp/project-2', NULL, '[]',
         '2026-04-06T00:00:02.000Z', '2026-04-06T00:00:03.000Z', NULL),
        ('project-3', 'Project 3 (deleted)', '/tmp/project-3', NULL, '[]',
         '2026-04-06T00:00:04.000Z', '2026-04-06T00:00:05.000Z', '2026-04-06T00:00:06.000Z')
    `;

    yield* sql`
      INSERT INTO projection_goals (
        goal_id, project_id, slug, title, title_provenance, description,
        created_at, updated_at, archived_at, deleted_at
      ) VALUES
        ('goal-1', 'project-1', 'goal-one', 'Goal One', 'curated', 'Objective one.',
         '2026-04-06T00:00:07.000Z', '2026-04-06T00:00:08.000Z', NULL, NULL),
        ('goal-archived', 'project-1', 'archived-goal', 'Archived Goal', 'curated', '',
         '2026-04-06T00:00:07.000Z', '2026-04-06T00:00:08.000Z', '2026-04-06T00:00:09.000Z', NULL),
        ('goal-deleted', 'project-1', 'deleted-goal', 'Deleted Goal', 'curated', '',
         '2026-04-06T00:00:07.000Z', '2026-04-06T00:00:08.000Z', NULL, '2026-04-06T00:00:10.000Z'),
        ('goal-other', 'project-2', 'other-project-goal', 'Other Project Goal', 'curated', '',
         '2026-04-06T00:00:07.000Z', '2026-04-06T00:00:08.000Z', NULL, NULL)
    `;

    yield* sql`
      INSERT INTO projection_goal_tasks (
        task_id, goal_id, parent_task_id, position, text, done,
        created_at, updated_at, deleted_at
      ) VALUES
        ('task-1', 'goal-1', NULL, 0, 'Parent task', 0,
         '2026-04-06T00:00:11.000Z', '2026-04-06T00:00:11.000Z', NULL),
        ('task-1a', 'goal-1', 'task-1', 0, 'Child task', 1,
         '2026-04-06T00:00:12.000Z', '2026-04-06T00:00:12.000Z', NULL),
        ('task-gone', 'goal-1', NULL, 1, 'Deleted task', 0,
         '2026-04-06T00:00:13.000Z', '2026-04-06T00:00:13.000Z', '2026-04-06T00:00:14.000Z'),
        ('task-other', 'goal-other', NULL, 0, 'Other goal task', 0,
         '2026-04-06T00:00:15.000Z', '2026-04-06T00:00:15.000Z', NULL)
    `;
  });

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(
      serverConfigLayerTest(process.cwd(), { prefix: "psq-test" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

projectionSnapshotLayer("ProjectionSnapshotQuery", (it) => {
  it.effect("hydrates read model from projection tables and computes snapshot sequence", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`DELETE FROM projection_thread_proposed_plans`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[{"id":"script-1","name":"Build","command":"bun run build","icon":"build","runOnWorktreeCreate":false}]',
          '2026-02-24T00:00:00.000Z',
          '2026-02-24T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-1',
          '2026-02-24T00:00:04.000Z',
          1,
          0,
          0,
          '2026-02-24T00:00:02.000Z',
          '2026-02-24T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id,
          thread_id,
          turn_id,
          role,
          text,
          is_streaming,
          created_at,
          updated_at
        )
        VALUES (
          'message-1',
          'thread-1',
          'turn-1',
          'assistant',
          'hello from projection',
          0,
          '2026-02-24T00:00:04.000Z',
          '2026-02-24T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_proposed_plans (
          plan_id,
          thread_id,
          turn_id,
          plan_markdown,
          implemented_at,
          implementation_thread_id,
          created_at,
          updated_at
        )
        VALUES (
          'plan-1',
          'thread-1',
          'turn-1',
          '# Ship it',
          '2026-02-24T00:00:05.500Z',
          'thread-2',
          '2026-02-24T00:00:05.000Z',
          '2026-02-24T00:00:05.500Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          created_at
        )
        VALUES (
          'activity-1',
          'thread-1',
          'turn-1',
          'info',
          'runtime.note',
          'provider started',
          '{"stage":"start"}',
          '2026-02-24T00:00:06.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id,
          status,
          provider_name,
          provider_session_id,
          provider_thread_id,
          runtime_mode,
          active_turn_id,
          last_error,
          updated_at
        )
        VALUES (
          'thread-1',
          'running',
          'codex',
          'provider-session-1',
          'provider-thread-1',
          'approval-required',
          'turn-1',
          NULL,
          '2026-02-24T00:00:07.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-1',
          'turn-1',
          NULL,
          'thread-1',
          'plan-1',
          'message-1',
          'completed',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          '2026-02-24T00:00:08.000Z',
          1,
          'checkpoint-1',
          'ready',
          '[{"path":"README.md","kind":"modified","additions":2,"deletions":1}]'
        )
      `;

      let sequence = 5;
      for (const projector of Object.values(ORCHESTRATION_PROJECTOR_NAMES)) {
        yield* sql`
          INSERT INTO projection_state (
            projector,
            last_applied_sequence,
            updated_at
          )
          VALUES (
            ${projector},
            ${sequence},
            '2026-02-24T00:00:09.000Z'
          )
        `;
        sequence += 1;
      }

      const snapshot = yield* snapshotQuery.getSnapshot();

      assert.equal(snapshot.snapshotSequence, 5);
      assert.equal(snapshot.updatedAt, "2026-02-24T00:00:09.000Z");
      assert.deepEqual(snapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          defaultStartFromOrigin: null,
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
          deletedAt: null,
        },
      ]);
      assert.deepEqual(snapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          goalId: null,
          parentThreadId: null,
          role: null,
          purpose: null,
          brief: null,
          planLane: "planned" as const,
          attention: [],
          cumulativeCostUsd: 0,
          blockedBy: [],
          spawnGeneration: null,
          forkFromThreadId: null,
          finalCommitSha: null,
          reportPath: null,
          graphKey: null,
          kickoffBriefPath: null,
          routes: [],
          gateRounds: 0,
          pendingRework: false,
          lastOutcome: null,
          isolation: "shared" as const,
          fanInState: "none" as const,
          title: "Thread 1",
          titleProvenance: "curated" as const,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          toolUses: null,
          usedTokens: null,
          maxTokens: null,
          diffAdditions: null,
          diffDeletions: null,
          handoffCount: 0,
          notifySendLog: [],
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          deletedAt: null,
          messages: [
            {
              id: asMessageId("message-1"),
              role: "assistant",
              text: "hello from projection",
              turnId: asTurnId("turn-1"),
              streaming: false,
              createdAt: "2026-02-24T00:00:04.000Z",
              updatedAt: "2026-02-24T00:00:05.000Z",
            },
          ],
          proposedPlans: [
            {
              id: "plan-1",
              turnId: asTurnId("turn-1"),
              planMarkdown: "# Ship it",
              implementedAt: "2026-02-24T00:00:05.500Z",
              implementationThreadId: ThreadId.make("thread-2"),
              createdAt: "2026-02-24T00:00:05.000Z",
              updatedAt: "2026-02-24T00:00:05.500Z",
            },
          ],
          activities: [
            {
              id: asEventId("activity-1"),
              tone: "info",
              kind: "runtime.note",
              summary: "provider started",
              payload: { stage: "start" },
              turnId: asTurnId("turn-1"),
              createdAt: "2026-02-24T00:00:06.000Z",
            },
          ],
          hasMoreActivities: false,
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-1"),
              status: "ready",
              files: [{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }],
              assistantMessageId: asMessageId("message-1"),
              completedAt: "2026-02-24T00:00:08.000Z",
            },
          ],
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            queuedMessages: { steering: [], followUp: [] },
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
        },
      ]);

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.snapshotSequence, 5);
      assert.deepEqual(shellSnapshot.projects, [
        {
          id: asProjectId("project-1"),
          title: "Project 1",
          workspaceRoot: "/tmp/project-1",
          repositoryIdentity: null,
          defaultModelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          defaultStartFromOrigin: null,
          scripts: [
            {
              id: "script-1",
              name: "Build",
              command: "bun run build",
              icon: "build",
              runOnWorktreeCreate: false,
            },
          ],
          createdAt: "2026-02-24T00:00:00.000Z",
          updatedAt: "2026-02-24T00:00:01.000Z",
        },
      ]);
      assert.deepEqual(shellSnapshot.threads, [
        {
          id: ThreadId.make("thread-1"),
          projectId: asProjectId("project-1"),
          goalId: null,
          parentThreadId: null,
          role: null,
          purpose: null,
          brief: null,
          planLane: "planned" as const,
          attention: [],
          cumulativeCostUsd: 0,
          blockedBy: [],
          spawnGeneration: null,
          forkFromThreadId: null,
          finalCommitSha: null,
          reportPath: null,
          graphKey: null,
          kickoffBriefPath: null,
          planLaneSince: null,
          dependenciesSince: null,
          faninSince: null,
          routes: [],
          gateRounds: 0,
          pendingRework: false,
          lastOutcome: null,
          isolation: "shared" as const,
          fanInState: "none" as const,
          title: "Thread 1",
          titleProvenance: "curated" as const,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          interactionMode: "default",
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          latestTurn: {
            turnId: asTurnId("turn-1"),
            state: "completed",
            requestedAt: "2026-02-24T00:00:08.000Z",
            startedAt: "2026-02-24T00:00:08.000Z",
            completedAt: "2026-02-24T00:00:08.000Z",
            assistantMessageId: asMessageId("message-1"),
            sourceProposedPlan: {
              threadId: ThreadId.make("thread-1"),
              planId: "plan-1",
            },
          },
          createdAt: "2026-02-24T00:00:02.000Z",
          updatedAt: "2026-02-24T00:00:03.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          snoozedUntil: null,
          snoozedAt: null,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "approval-required",
            activeTurnId: asTurnId("turn-1"),
            lastError: null,
            queuedMessages: { steering: [], followUp: [] },
            updatedAt: "2026-02-24T00:00:07.000Z",
          },
          latestUserMessageAt: "2026-02-24T00:00:04.000Z",
          hasPendingApprovals: true,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          lastActivityPreview: "hello from projection",
          consults: [],
          peerMessages: [],
          notifySendLog: [],
          toolUses: null,
          usedTokens: null,
          maxTokens: null,
          diffAdditions: null,
          diffDeletions: null,
          handoffCount: 0,
        },
      ]);

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value, snapshot.threads[0]);
      }
    }),
  );

  // `/handoff` fork-drafter (finding 3): a non-zero handoff_count must round-trip
  // through BOTH the shell snapshot and the thread-detail assembler (the detail
  // path previously omitted the field, silently reporting 0 via decode-default).
  it.effect("round-trips a non-zero handoffCount through shell and thread detail", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-1', 'Project 1', '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:01.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, role, title, model_selection_json, runtime_mode,
          interaction_mode, handoff_count, created_at, updated_at, deleted_at
        ) VALUES (
          'drafter-1', 'project-1', 'handoff-drafter', 'Handoff: fix retry',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          2, '2026-02-24T00:00:02.000Z', '2026-02-24T00:00:03.000Z', NULL
        )
      `;

      const detail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("drafter-1"));
      assert.equal(detail._tag, "Some");
      if (detail._tag === "Some") {
        assert.equal(detail.value.handoffCount, 2);
      }

      const shell = yield* snapshotQuery.getShellSnapshot();
      const drafterShell = shell.threads.find((thread) => thread.id === "drafter-1");
      assert.equal(drafterShell?.handoffCount, 2);
    }),
  );

  it.effect(
    "aggregates peer-message edges (count/pendingCount/preview), rebuilds the windowed notifySendLog, and orders pending FIFO with a seq tiebreak",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_thread_peer_messages`;
        yield* sql`DELETE FROM projection_state`;

        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, created_at, updated_at, deleted_at
          ) VALUES (
            'project-1', 'Project 1', '/tmp/project-1',
            '{"provider":"codex","model":"gpt-5-codex"}', '[]',
            '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:01.000Z', NULL
          )
        `;
        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, role, title, model_selection_json, runtime_mode,
            interaction_mode, created_at, updated_at, deleted_at
          ) VALUES (
            'sender-1', 'project-1', 'coder', 'Sender',
            '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
            '2026-02-24T00:00:02.000Z', '2026-02-24T00:00:03.000Z', NULL
          )
        `;

        // Window-relative timestamps: recent rows are inside the 1h cap window,
        // the stale row is outside it (so it counts toward the edge aggregate but
        // NOT the reconstructed notifySendLog).
        const nowDt = yield* DateTime.now;
        const recent = DateTime.formatIso(DateTime.subtractDuration(nowDt, Duration.minutes(1)));
        const recentOlder = DateTime.formatIso(
          DateTime.subtractDuration(nowDt, Duration.minutes(2)),
        );
        const stale = DateTime.formatIso(DateTime.subtractDuration(nowDt, Duration.hours(2)));

        const insertRow = (row: {
          recordId: string;
          target: string;
          preview: string;
          status: string;
          seq: number;
          createdAt: string;
        }) =>
          sql`
            INSERT INTO projection_thread_peer_messages (
              record_id, sender_thread_id, target_thread_id, target_title,
              message, framed_message, message_preview, status, seq, created_at, delivered_at
            ) VALUES (
              ${row.recordId}, 'sender-1', ${row.target}, 'Target',
              'body', 'framed body', ${row.preview}, ${row.status}, ${row.seq}, ${row.createdAt}, NULL
            )
          `;

        // target-a: pa1 + pa2 pending at the SAME timestamp (seq tiebreak
        // decides FIFO), plus a stale delivered row.
        yield* insertRow({
          recordId: "pa1",
          target: "target-a",
          preview: "first-a",
          status: "pending",
          seq: 101,
          createdAt: recent,
        });
        yield* insertRow({
          recordId: "pa2",
          target: "target-a",
          preview: "latest-a",
          status: "pending",
          seq: 102,
          createdAt: recent,
        });
        yield* insertRow({
          recordId: "stale-a",
          target: "target-a",
          preview: "stale-a",
          status: "delivered",
          seq: 50,
          createdAt: stale,
        });
        // target-b: one delivered row.
        yield* insertRow({
          recordId: "db1",
          target: "target-b",
          preview: "only-b",
          status: "delivered",
          seq: 100,
          createdAt: recentOlder,
        });

        // Edge aggregation on the sender shell.
        const shell = yield* snapshotQuery.getShellSnapshot();
        const sender = shell.threads.find((thread) => thread.id === "sender-1");
        assert.isDefined(sender);
        const edges = new Map(sender!.peerMessages.map((edge) => [edge.targetThreadId, edge]));
        assert.equal(edges.get("target-a" as never)?.count, 3);
        assert.equal(edges.get("target-a" as never)?.pendingCount, 2);
        // Latest by created_at DESC, seq DESC → pa2 (same ts as pa1, higher seq).
        assert.equal(edges.get("target-a" as never)?.lastMessagePreview, "latest-a");
        assert.equal(edges.get("target-b" as never)?.count, 1);
        assert.equal(edges.get("target-b" as never)?.pendingCount, 0);

        // notifySendLog is rebuilt from the in-window rows only (stale excluded):
        // pa1, pa2, db1 = 3.
        const readModel = yield* snapshotQuery.getCommandReadModel();
        const senderThread = readModel.threads.find((thread) => thread.id === "sender-1");
        assert.isDefined(senderThread);
        assert.equal(senderThread!.notifySendLog.length, 3);

        // Pending scan is FIFO: same-timestamp pa1/pa2 order by their seq tiebreak.
        const pending = yield* snapshotQuery.listPendingPeerMessages();
        assert.deepEqual(
          pending.map((row) => row.recordId),
          ["pa1", "pa2"],
        );
      }),
  );

  it.effect("reads one thread's ordered lifecycle events, scoped and filtered", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM orchestration_events`;

      // stream A: three lifecycle events plus one non-lifecycle event
      // (dependencies-set) that must be filtered out; stream B proves scoping.
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, command_id, causation_event_id, correlation_id,
          actor_kind, payload_json, metadata_json
        )
        VALUES
          ('evt-a1', 'thread', 'thread-A', 0, 'thread.plan-lane-set',
            '2026-07-13T00:00:01.000Z', NULL, NULL, NULL, 'server',
            '{"threadId":"thread-A","planLane":"in_progress","updatedAt":"2026-07-13T00:00:01.000Z"}', '{}'),
          ('evt-a2', 'thread', 'thread-A', 1, 'thread.dependencies-set',
            '2026-07-13T00:00:02.000Z', NULL, NULL, NULL, 'server',
            '{"threadId":"thread-A","blockedBy":[],"updatedAt":"2026-07-13T00:00:02.000Z"}', '{}'),
          ('evt-a3', 'thread', 'thread-A', 2, 'thread.outcome-recorded',
            '2026-07-13T00:00:03.000Z', NULL, NULL, NULL, 'server',
            '{"threadId":"thread-A","outcome":"needs_rework","decision":"loop","round":1,"updatedAt":"2026-07-13T00:00:03.000Z"}', '{}'),
          ('evt-a4', 'thread', 'thread-A', 3, 'thread.fanin-set',
            '2026-07-13T00:00:04.000Z', NULL, NULL, NULL, 'server',
            '{"threadId":"thread-A","fanInState":"completed","updatedAt":"2026-07-13T00:00:04.000Z"}', '{}'),
          ('evt-b1', 'thread', 'thread-B', 0, 'thread.plan-lane-set',
            '2026-07-13T00:00:05.000Z', NULL, NULL, NULL, 'server',
            '{"threadId":"thread-B","planLane":"done","updatedAt":"2026-07-13T00:00:05.000Z"}', '{}')
      `;

      const events = yield* snapshotQuery.getThreadLifecycle({
        threadId: ThreadId.make("thread-A"),
      });
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["thread.plan-lane-set", "thread.outcome-recorded", "thread.fanin-set"],
      );
      assert.equal(events[0]?.eventId, "evt-a1");
      // Decoded payload survives the round-trip through OrchestrationEvent.
      const outcome = events[1];
      assert.equal(outcome?.type, "thread.outcome-recorded");
      if (outcome?.type === "thread.outcome-recorded") {
        assert.equal(outcome.payload.outcome, "needs_rework");
        assert.equal(outcome.payload.round, 1);
      }
    }),
  );

  it.effect("keeps archived threads out of the main shell snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-archive-test',
          'Archive Test',
          '/tmp/archive-test',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-active',
            'project-archive-test',
            'Active Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:02.000Z',
            '2026-04-06T00:00:03.000Z',
            NULL,
            NULL
          ),
          (
            'thread-archived',
            'project-archive-test',
            'Archived Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            NULL,
            0,
            0,
            0,
            '2026-04-06T00:00:04.000Z',
            '2026-04-06T00:00:05.000Z',
            '2026-04-06T00:00:06.000Z',
            NULL
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:07.000Z')
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-active")],
      );

      const archivedShellSnapshot = yield* snapshotQuery.getArchivedShellSnapshot();
      assert.deepEqual(
        archivedShellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-archived")],
      );
      assert.equal(archivedShellSnapshot.threads[0]?.archivedAt, "2026-04-06T00:00:06.000Z");
    }),
  );

  it.effect("reads a thread's live subtree with per-member session liveness", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-subtree', 'Subtree', '/tmp/subtree',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-04-06T00:00:00.000Z', '2026-04-06T00:00:01.000Z', NULL
        )
      `;

      // root → child → grandchild, plus a deleted child (excluded) and an
      // unrelated thread (never reachable through the lineage edge).
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, parent_thread_id, title, model_selection_json,
          runtime_mode, interaction_mode, latest_user_message_at,
          pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, created_at, updated_at, archived_at, deleted_at
        ) VALUES
          ('subtree-root', 'project-subtree', NULL, 'Root',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:02.000Z', '2026-04-06T00:00:02.000Z', NULL, NULL),
          ('subtree-child', 'project-subtree', 'subtree-root', 'Child',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:03.000Z', '2026-04-06T00:00:03.000Z', NULL, NULL),
          ('subtree-grandchild', 'project-subtree', 'subtree-child', 'Grandchild',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:04.000Z', '2026-04-06T00:00:04.000Z', NULL, NULL),
          ('subtree-deleted', 'project-subtree', 'subtree-root', 'Deleted',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:05.000Z', '2026-04-06T00:00:05.000Z', NULL,
           '2026-04-06T00:00:06.000Z'),
          ('subtree-unrelated', 'project-subtree', NULL, 'Unrelated',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:07.000Z', '2026-04-06T00:00:07.000Z', NULL, NULL)
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id,
          provider_thread_id, runtime_mode, active_turn_id, last_error, updated_at
        ) VALUES
          ('subtree-child', 'running', 'codex', NULL, NULL, 'full-access', NULL, NULL,
           '2026-04-06T00:00:08.000Z'),
          ('subtree-grandchild', 'stopped', 'codex', NULL, NULL, 'full-access', NULL, NULL,
           '2026-04-06T00:00:08.000Z')
      `;

      const sweep = yield* snapshotQuery.getLiveSubtreeSessionLiveness(
        ThreadId.make("subtree-root"),
      );
      assert.deepEqual(sweep, [
        { threadId: ThreadId.make("subtree-child"), hasLiveSession: true },
        { threadId: ThreadId.make("subtree-grandchild"), hasLiveSession: false },
        { threadId: ThreadId.make("subtree-root"), hasLiveSession: false },
      ]);

      // An unknown root still yields itself, so the archive sweep never skips
      // the thread the command actually named.
      const unknownSweep = yield* snapshotQuery.getLiveSubtreeSessionLiveness(
        ThreadId.make("subtree-missing"),
      );
      assert.deepEqual(unknownSweep, [
        { threadId: ThreadId.make("subtree-missing"), hasLiveSession: false },
      ]);
    }),
  );

  it.effect("reads a thread's outstanding obligations for the session reaper", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-obligations', 'Obligations', '/tmp/obligations',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-04-06T00:00:00.000Z', '2026-04-06T00:00:01.000Z', NULL
        )
      `;

      // `waiting` is a fanned-out orchestrator: one live child, one done child,
      // one cancelled child, one deleted child. Only the live one is an
      // obligation. `finished` has only terminal children. `gated` is blocked on
      // a not-done sibling AND on a done sibling AND on a dangling id (which
      // must not gate). `questioned` is parked on an open question.
      //
      // The fan-in shapes matter most: `ob-idle-isolated` is an ordinary
      // in-flight isolated coder (fanInState 'none') and `ob-conflicted` has a
      // settled-but-conflicted fan-in. Neither owes the PROVIDER anything —
      // fan-in is pure git work in WorkstreamFanInReactor — so both must stay
      // reapable, or every isolated coder's process leaks forever.
      // `ob-fanin-dep`/`ob-fanin-blocked` and `ob-reviewer`/`ob-two-hop` cover
      // the two gates a lane-only proxy would miss: a DONE isolated dependency
      // whose merge has not landed, and a DONE attached reviewer whose gated
      // coder has not fanned in.
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, parent_thread_id, blocked_by, plan_lane,
          pending_rework, isolation, fan_in_state, title, model_selection_json,
          runtime_mode, interaction_mode, latest_user_message_at,
          pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, created_at, updated_at, archived_at, deleted_at
        ) VALUES
          ('ob-waiting', 'project-obligations', NULL, '[]', 'in_progress',
           0, 'shared', 'none', 'Waiting orchestrator',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:02.000Z', '2026-04-06T00:00:02.000Z', NULL, NULL),
          ('ob-live-child', 'project-obligations', 'ob-waiting', '[]', 'in_progress',
           0, 'shared', 'none', 'Live child',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:03.000Z', '2026-04-06T00:00:03.000Z', NULL, NULL),
          ('ob-done-child', 'project-obligations', 'ob-waiting', '[]', 'done',
           0, 'shared', 'none', 'Done child',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:04.000Z', '2026-04-06T00:00:04.000Z', NULL, NULL),
          ('ob-cancelled-child', 'project-obligations', 'ob-waiting', '[]', 'cancelled',
           0, 'shared', 'none', 'Cancelled child',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:05.000Z', '2026-04-06T00:00:05.000Z', NULL, NULL),
          ('ob-deleted-child', 'project-obligations', 'ob-waiting', '[]', 'in_progress',
           0, 'shared', 'none', 'Deleted child',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:06.000Z', '2026-04-06T00:00:06.000Z', NULL,
           '2026-04-06T00:00:07.000Z'),
          ('ob-finished', 'project-obligations', NULL, '[]', 'in_progress',
           0, 'shared', 'none', 'Finished orchestrator',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:08.000Z', '2026-04-06T00:00:08.000Z', NULL, NULL),
          ('ob-finished-child', 'project-obligations', 'ob-finished', '[]', 'done',
           0, 'shared', 'none', 'Finished child',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:09.000Z', '2026-04-06T00:00:09.000Z', NULL, NULL),
          ('ob-gated', 'project-obligations', 'ob-finished',
           '["ob-finished-child","ob-open-dep","ob-dangling"]', 'ready',
           0, 'isolated', 'none', 'Gated sibling',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:10.000Z', '2026-04-06T00:00:10.000Z', NULL, NULL),
          ('ob-open-dep', 'project-obligations', 'ob-finished', '[]', 'in_progress',
           0, 'shared', 'none', 'Open dependency',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:11.000Z', '2026-04-06T00:00:11.000Z', NULL, NULL),
          ('ob-questioned', 'project-obligations', NULL, '[]', 'in_progress',
           1, 'isolated', 'completed', 'Questioned thread',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 2, 0, '2026-04-06T00:00:12.000Z', '2026-04-06T00:00:12.000Z', NULL, NULL),
          ('ob-idle-isolated', 'project-obligations', NULL, '[]', 'in_progress',
           0, 'isolated', 'none', 'Ordinary idle isolated coder',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:13.000Z', '2026-04-06T00:00:13.000Z', NULL, NULL),
          ('ob-conflicted', 'project-obligations', NULL, '[]', 'done',
           0, 'isolated', 'conflicted', 'Settled conflicted fan-in',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:14.000Z', '2026-04-06T00:00:14.000Z', NULL, NULL),
          ('ob-fanin-parent', 'project-obligations', NULL, '[]', 'in_progress',
           0, 'shared', 'none', 'Fan-in gate parent',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:15.000Z', '2026-04-06T00:00:15.000Z', NULL, NULL),
          ('ob-fanin-dep', 'project-obligations', 'ob-fanin-parent', '[]', 'done',
           0, 'isolated', 'none', 'Done isolated dep, fan-in not landed',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:16.000Z', '2026-04-06T00:00:16.000Z', NULL, NULL),
          ('ob-fanin-blocked', 'project-obligations', 'ob-fanin-parent', '["ob-fanin-dep"]',
           'ready', 0, 'shared', 'none', 'Blocked behind unlanded fan-in',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:17.000Z', '2026-04-06T00:00:17.000Z', NULL, NULL),
          ('ob-coder', 'project-obligations', 'ob-fanin-parent', '[]', 'done',
           0, 'isolated', 'none', 'Gated coder, fan-in not landed',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:18.000Z', '2026-04-06T00:00:18.000Z', NULL, NULL),
          ('ob-reviewer', 'project-obligations', 'ob-fanin-parent', '["ob-coder"]', 'done',
           0, 'attached', 'none', 'Done attached reviewer',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:19.000Z', '2026-04-06T00:00:19.000Z', NULL, NULL),
          ('ob-two-hop', 'project-obligations', 'ob-fanin-parent', '["ob-reviewer"]', 'ready',
           0, 'shared', 'none', 'Blocked two hops behind fan-in',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           NULL, 0, 0, 0, '2026-04-06T00:00:20.000Z', '2026-04-06T00:00:20.000Z', NULL, NULL)
      `;

      yield* sql`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, provider_session_id,
          provider_thread_id, runtime_mode, active_turn_id, last_error, updated_at
        ) VALUES
          ('ob-waiting', 'running', 'codex', NULL, NULL, 'full-access', 'turn-ob-waiting', NULL,
           '2026-04-06T00:00:21.000Z')
      `;

      const NONE = {
        activeTurnId: null,
        liveChildCount: 0,
        hasUnmetDependencies: false,
        openUserInputCount: 0,
        pendingRework: false,
      };

      // A waiting orchestrator: exactly the one non-terminal, non-deleted child.
      // Its active turn rides along on the same read (no second query).
      assert.deepEqual(yield* snapshotQuery.getThreadObligations(ThreadId.make("ob-waiting")), {
        ...NONE,
        activeTurnId: TurnId.make("turn-ob-waiting"),
        liveChildCount: 1,
      });

      // `ob-gated`: only the not-done sibling gates; the done one and the
      // dangling id do not.
      assert.deepEqual(yield* snapshotQuery.getThreadObligations(ThreadId.make("ob-gated")), {
        ...NONE,
        hasUnmetDependencies: true,
      });

      // Open questions and an open rework round are obligations.
      assert.deepEqual(yield* snapshotQuery.getThreadObligations(ThreadId.make("ob-questioned")), {
        ...NONE,
        openUserInputCount: 2,
        pendingRework: true,
      });

      // Regression — the leak this must never reintroduce: an ordinary in-flight
      // isolated coder (fanInState 'none') owes nothing, and neither does one
      // whose fan-in settled as `conflicted`. A thread's own fan-in is not a
      // provider obligation, so both stay reapable.
      assert.deepEqual(
        yield* snapshotQuery.getThreadObligations(ThreadId.make("ob-idle-isolated")),
        NONE,
      );
      assert.deepEqual(
        yield* snapshotQuery.getThreadObligations(ThreadId.make("ob-conflicted")),
        NONE,
      );

      // The two gates a lane-only proxy misses. Both dependencies are `done`, so
      // only the shared predicate's fan-in refinement keeps these blocked.
      assert.deepEqual(
        yield* snapshotQuery.getThreadObligations(ThreadId.make("ob-fanin-blocked")),
        { ...NONE, hasUnmetDependencies: true },
      );
      assert.deepEqual(yield* snapshotQuery.getThreadObligations(ThreadId.make("ob-two-hop")), {
        ...NONE,
        hasUnmetDependencies: true,
      });

      // An orchestrator whose children are all terminal owes nothing — still
      // reapable. (`ob-gated`/`ob-open-dep` are its children, both non-terminal,
      // so assert on the leaf instead.)
      assert.deepEqual(
        yield* snapshotQuery.getThreadObligations(ThreadId.make("ob-finished-child")),
        NONE,
      );

      // An unknown / deleted thread owes nothing, so a stale binding stays
      // reapable rather than becoming immortal.
      assert.deepEqual(
        yield* snapshotQuery.getThreadObligations(ThreadId.make("ob-missing")),
        NONE,
      );
    }),
  );

  it.effect("keeps settled threads in the shell snapshot with non-null settlement fields", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-settled-test',
          'Settled Test',
          '/tmp/settled-test',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-06T00:00:00.000Z',
          '2026-04-06T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          settled_override,
          settled_at,
          deleted_at
        )
        VALUES (
          'thread-settled',
          'project-settled-test',
          'Settled Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-06T00:00:02.000Z',
          '2026-04-06T00:00:05.000Z',
          NULL,
          'settled',
          '2026-04-06T00:00:04.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 4, '2026-04-06T00:00:07.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 4, '2026-04-06T00:00:07.000Z')
      `;

      // Settled ≠ archived: the thread must appear in the LIVE shell
      // snapshot, carrying its settlement fields through the row aliases.
      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepEqual(
        shellSnapshot.threads.map((thread) => thread.id),
        [ThreadId.make("thread-settled")],
      );
      assert.equal(shellSnapshot.threads[0]?.settledOverride, "settled");
      assert.equal(shellSnapshot.threads[0]?.settledAt, "2026-04-06T00:00:04.000Z");

      // And the full command read model carries them too.
      const readModel = yield* snapshotQuery.getCommandReadModel();
      const thread = readModel.threads.find(
        (candidate) => candidate.id === ThreadId.make("thread-settled"),
      );
      assert.equal(thread?.settledOverride, "settled");
      assert.equal(thread?.settledAt, "2026-04-06T00:00:04.000Z");
    }),
  );

  it.effect(
    "reads targeted project, thread, and count queries without hydrating the full snapshot",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_turns`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-active',
            'Active Project',
            '/tmp/workspace',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-03-01T00:00:00.000Z',
            '2026-03-01T00:00:01.000Z',
            NULL
          ),
          (
            'project-deleted',
            'Deleted Project',
            '/tmp/deleted',
            NULL,
            '[]',
            '2026-03-01T00:00:02.000Z',
            '2026-03-01T00:00:03.000Z',
            '2026-03-01T00:00:04.000Z'
          )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES
          (
            'thread-first',
            'project-active',
            'First Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:05.000Z',
            '2026-03-01T00:00:06.000Z',
            NULL,
            NULL
          ),
          (
            'thread-second',
            'project-active',
            'Second Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:07.000Z',
            '2026-03-01T00:00:08.000Z',
            NULL,
            NULL
          ),
          (
            'thread-deleted',
            'project-active',
            'Deleted Thread',
            '{"provider":"codex","model":"gpt-5-codex"}',
            'full-access',
            'default',
            NULL,
            NULL,
            NULL,
            '2026-03-01T00:00:09.000Z',
            '2026-03-01T00:00:10.000Z',
            NULL,
            '2026-03-01T00:00:11.000Z'
          )
      `;

        const counts = yield* snapshotQuery.getCounts();
        assert.deepEqual(counts, {
          projectCount: 2,
          threadCount: 3,
        });

        const project = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/workspace");
        assert.equal(project._tag, "Some");
        if (project._tag === "Some") {
          assert.equal(project.value.id, asProjectId("project-active"));
        }

        const missingProject = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/missing");
        assert.equal(missingProject._tag, "None");

        const firstThreadId = yield* snapshotQuery.getFirstActiveThreadIdByProjectId(
          asProjectId("project-active"),
        );
        assert.equal(firstThreadId._tag, "Some");
        if (firstThreadId._tag === "Some") {
          assert.equal(firstThreadId.value, ThreadId.make("thread-first"));
        }
      }),
  );

  it.effect("reads single-thread checkpoint context without hydrating unrelated threads", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-context',
          'Context Project',
          '/tmp/context-workspace',
          NULL,
          '[]',
          '2026-03-02T00:00:00.000Z',
          '2026-03-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-context',
          'project-context',
          'Context Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          'feature/perf',
          '/tmp/context-worktree',
          NULL,
          '2026-03-02T00:00:02.000Z',
          '2026-03-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-context',
            'turn-1',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            '2026-03-02T00:00:04.000Z',
            1,
            'checkpoint-a',
            'ready',
            '[]'
          ),
          (
            'thread-context',
            'turn-2',
            NULL,
            NULL,
            NULL,
            NULL,
            'completed',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            '2026-03-02T00:00:05.000Z',
            2,
            'checkpoint-b',
            'ready',
            '[]'
          )
      `;

      const context = yield* snapshotQuery.getThreadCheckpointContext(
        ThreadId.make("thread-context"),
      );
      assert.equal(context._tag, "Some");
      if (context._tag === "Some") {
        assert.deepEqual(context.value, {
          threadId: ThreadId.make("thread-context"),
          projectId: asProjectId("project-context"),
          workspaceRoot: "/tmp/context-workspace",
          worktreePath: "/tmp/context-worktree",
          checkpoints: [
            {
              turnId: asTurnId("turn-1"),
              checkpointTurnCount: 1,
              checkpointRef: asCheckpointRef("checkpoint-a"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:04.000Z",
            },
            {
              turnId: asTurnId("turn-2"),
              checkpointTurnCount: 2,
              checkpointRef: asCheckpointRef("checkpoint-b"),
              status: "ready",
              files: [],
              assistantMessageId: null,
              completedAt: "2026-03-02T00:00:05.000Z",
            },
          ],
        });
      }
    }),
  );

  it.effect("keeps thread detail activity ordering consistent with shell snapshot ordering", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-01T00:00:00.000Z',
          '2026-04-01T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          NULL,
          NULL,
          0,
          0,
          0,
          '2026-04-01T00:00:02.000Z',
          '2026-04-01T00:00:03.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id,
          thread_id,
          turn_id,
          tone,
          kind,
          summary,
          payload_json,
          sequence,
          created_at
        )
        VALUES
          (
            'activity-unsequenced',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'unsequenced first',
            '{"source":"unsequenced"}',
            NULL,
            '2026-04-01T00:00:06.000Z'
          ),
          (
            'activity-sequence-2',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence two',
            '{"source":"sequence-2"}',
            2,
            '2026-04-01T00:00:04.000Z'
          ),
          (
            'activity-sequence-1',
            'thread-1',
            NULL,
            'info',
            'runtime.note',
            'sequence one',
            '{"source":"sequence-1"}',
            1,
            '2026-04-01T00:00:05.000Z'
          )
      `;

      const snapshot = yield* snapshotQuery.getSnapshot();
      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));

      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.deepEqual(threadDetail.value.activities, snapshot.threads[0]?.activities ?? []);
      }

      assert.deepEqual(snapshot.threads[0]?.activities ?? [], [
        {
          id: asEventId("activity-unsequenced"),
          tone: "info",
          kind: "runtime.note",
          summary: "unsequenced first",
          payload: { source: "unsequenced" },
          turnId: null,
          createdAt: "2026-04-01T00:00:06.000Z",
        },
        {
          id: asEventId("activity-sequence-1"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence one",
          payload: { source: "sequence-1" },
          turnId: null,
          sequence: 1,
          createdAt: "2026-04-01T00:00:05.000Z",
        },
        {
          id: asEventId("activity-sequence-2"),
          tone: "info",
          kind: "runtime.note",
          summary: "sequence two",
          payload: { source: "sequence-2" },
          turnId: null,
          sequence: 2,
          createdAt: "2026-04-01T00:00:04.000Z",
        },
      ]);
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for targeted thread latest turn queries", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-02T00:00:00.000Z',
          '2026-04-02T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-02T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-02T00:00:02.000Z',
          '2026-04-02T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-02T00:00:05.000Z',
            '2026-04-02T00:00:06.000Z',
            '2026-04-02T00:00:20.000Z',
            5,
            'checkpoint-5',
            'ready',
            '[]'
          ),
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-02T00:00:30.000Z',
            '2026-04-02T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      const threadShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-1"));
      assert.equal(threadShell._tag, "Some");
      if (threadShell._tag === "Some") {
        assert.equal(threadShell.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadShell.value.latestTurn?.state, "running");
        assert.equal(threadShell.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }

      const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(threadDetail._tag, "Some");
      if (threadDetail._tag === "Some") {
        assert.equal(threadDetail.value.latestTurn?.turnId, asTurnId("turn-running"));
        assert.equal(threadDetail.value.latestTurn?.state, "running");
        assert.equal(threadDetail.value.latestTurn?.startedAt, "2026-04-02T00:00:30.000Z");
      }
    }),
  );

  it.effect("uses projection_threads.latest_turn_id for bulk command and shell snapshots", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-1',
          'Project 1',
          '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-03T00:00:00.000Z',
          '2026-04-03T00:00:01.000Z',
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-1',
          'project-1',
          'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-running',
          '2026-04-03T00:00:04.000Z',
          0,
          0,
          0,
          '2026-04-03T00:00:02.000Z',
          '2026-04-03T00:00:03.000Z',
          NULL,
          NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES
          (
            'thread-1',
            'turn-running',
            'message-user-2',
            NULL,
            NULL,
            NULL,
            'running',
            '2026-04-03T00:00:30.000Z',
            '2026-04-03T00:00:30.000Z',
            NULL,
            NULL,
            NULL,
            NULL,
            '[]'
          ),
          (
            'thread-1',
            'turn-completed',
            'message-user-1',
            NULL,
            NULL,
            'message-assistant-1',
            'completed',
            '2026-04-03T00:00:05.000Z',
            '2026-04-03T00:00:06.000Z',
            '2026-04-03T00:00:20.000Z',
            NULL,
            NULL,
            NULL,
            '[]'
          )
      `;

      yield* sql`
        INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
        VALUES
          (${ORCHESTRATION_PROJECTOR_NAMES.projects}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threads}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadMessages}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadProposedPlans}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadActivities}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.threadSessions}, 3, '2026-04-03T00:00:40.000Z'),
          (${ORCHESTRATION_PROJECTOR_NAMES.checkpoints}, 3, '2026-04-03T00:00:40.000Z')
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "running");

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(shellSnapshot.threads[0]?.latestTurn?.state, "running");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-running"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "running");
    }),
  );

  it.effect("keeps deleted project and thread tombstones in the command read model", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-deleted',
          'Deleted Project',
          '/tmp/deleted-project',
          '{"provider":"codex","model":"gpt-5-codex"}',
          '[]',
          '2026-04-05T00:00:00.000Z',
          '2026-04-05T00:00:01.000Z',
          '2026-04-05T00:00:02.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          latest_user_message_at,
          pending_approval_count,
          pending_user_input_count,
          has_actionable_proposed_plan,
          created_at,
          updated_at,
          archived_at,
          deleted_at
        )
        VALUES (
          'thread-deleted',
          'project-deleted',
          'Deleted Thread',
          '{"provider":"codex","model":"gpt-5-codex"}',
          'full-access',
          'default',
          NULL,
          NULL,
          'turn-deleted',
          NULL,
          0,
          0,
          0,
          '2026-04-05T00:00:03.000Z',
          '2026-04-05T00:00:04.000Z',
          NULL,
          '2026-04-05T00:00:05.000Z'
        )
      `;

      yield* sql`
        INSERT INTO projection_turns (
          thread_id,
          turn_id,
          pending_message_id,
          source_proposed_plan_thread_id,
          source_proposed_plan_id,
          assistant_message_id,
          state,
          requested_at,
          started_at,
          completed_at,
          checkpoint_turn_count,
          checkpoint_ref,
          checkpoint_status,
          checkpoint_files_json
        )
        VALUES (
          'thread-deleted',
          'turn-deleted',
          'message-deleted-user',
          NULL,
          NULL,
          'message-deleted-assistant',
          'completed',
          '2026-04-05T00:00:04.100Z',
          '2026-04-05T00:00:04.200Z',
          '2026-04-05T00:00:04.300Z',
          NULL,
          NULL,
          NULL,
          '[]'
        )
      `;

      const commandReadModel = yield* snapshotQuery.getCommandReadModel();
      assert.equal(commandReadModel.projects[0]?.id, asProjectId("project-deleted"));
      assert.equal(commandReadModel.projects[0]?.deletedAt, "2026-04-05T00:00:02.000Z");
      assert.equal(commandReadModel.threads[0]?.id, ThreadId.make("thread-deleted"));
      assert.equal(commandReadModel.threads[0]?.deletedAt, "2026-04-05T00:00:05.000Z");
      assert.equal(commandReadModel.threads[0]?.latestTurn?.turnId, asTurnId("turn-deleted"));
      assert.equal(commandReadModel.threads[0]?.latestTurn?.state, "completed");

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(fullSnapshot.threads[0]?.id, ThreadId.make("thread-deleted"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.turnId, asTurnId("turn-deleted"));
      assert.equal(fullSnapshot.threads[0]?.latestTurn?.state, "completed");

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.equal(shellSnapshot.projects.length, 0);
      assert.equal(shellSnapshot.threads.length, 0);
    }),
  );

  it.effect(
    "windows thread-detail activities to the most recent 500 and pages older on demand",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`DELETE FROM projection_state`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        )
        VALUES (
          'project-1', 'Project 1', '/tmp/project-1',
          '{"provider":"codex","model":"gpt-5-codex"}', '[]',
          '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:01.000Z', NULL
        )
      `;

        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id,
          latest_user_message_at, pending_approval_count, pending_user_input_count,
          has_actionable_proposed_plan, created_at, updated_at, archived_at, deleted_at
        )
        VALUES (
          'thread-1', 'project-1', 'Thread 1',
          '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
          NULL, NULL, NULL, NULL, 0, 0, 0,
          '2026-04-01T00:00:02.000Z', '2026-04-01T00:00:03.000Z', NULL, NULL
        )
      `;

        // 600 activities (sequence 1..600); the detail load must return only the
        // most recent 500 (sequence 101..600), re-sorted ascending for display.
        const total = 600;
        yield* Effect.forEach(
          Array.from({ length: total }, (_unused, index) => index + 1),
          (seq) =>
            sql`
            INSERT INTO projection_thread_activities (
              activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
              sequence, created_at
            )
            VALUES (
              ${`activity-${String(seq).padStart(4, "0")}`}, 'thread-1', NULL,
              'info', 'runtime.note', ${`act-${seq}`}, '{}', ${seq},
              '2026-04-01T00:01:00.000Z'
            )
          `,
          { discard: true },
        );

        const threadDetail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
        assert.equal(threadDetail._tag, "Some");
        if (threadDetail._tag === "Some") {
          const activities = threadDetail.value.activities;
          assert.equal(activities.length, 500);
          assert.equal(activities[0]?.summary, "act-101");
          assert.equal(activities[0]?.sequence, 101);
          assert.equal(activities.at(-1)?.summary, "act-600");
          // 600 > window, so the client is told older history can be lazy-loaded.
          assert.equal(threadDetail.value.hasMoreActivities, true);
        }

        // Lazy-load the page immediately older than the windowed view (cursor =
        // oldest loaded sequence, 101): sequences 1..100, ascending, no more left.
        const olderPage = yield* snapshotQuery.getThreadActivitiesPage({
          threadId: ThreadId.make("thread-1"),
          beforeSequence: 101,
          limit: 500,
        });
        assert.equal(olderPage.activities.length, 100);
        assert.equal(olderPage.activities[0]?.summary, "act-1");
        assert.equal(olderPage.activities.at(-1)?.summary, "act-100");
        assert.equal(olderPage.hasMore, false);

        // A bounded page returns the newest `limit` of the older set and reports
        // that more remain (sequences 401..600, with 1..400 still older).
        const boundedPage = yield* snapshotQuery.getThreadActivitiesPage({
          threadId: ThreadId.make("thread-1"),
          beforeSequence: 601,
          limit: 200,
        });
        assert.equal(boundedPage.activities.length, 200);
        assert.equal(boundedPage.activities[0]?.summary, "act-401");
        assert.equal(boundedPage.activities.at(-1)?.summary, "act-600");
        assert.equal(boundedPage.hasMore, true);

        yield* sql`DELETE FROM projection_thread_activities`;

        // Legacy rows may not have a sequence. They are still windowed in the
        // detail load and must remain pageable by the deterministic created/id
        // ordering used by the snapshot query.
        yield* Effect.forEach(
          Array.from({ length: total }, (_unused, index) => index + 1),
          (seq) =>
            sql`
            INSERT INTO projection_thread_activities (
              activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
              sequence, created_at
            )
            VALUES (
              ${`unsequenced-${String(seq).padStart(4, "0")}`}, 'thread-1', NULL,
              'info', 'runtime.note', ${`legacy-act-${seq}`}, '{}', NULL,
              '2026-04-01T00:01:00.000Z'
            )
          `,
          { discard: true },
        );

        const legacyThreadDetail = yield* snapshotQuery.getThreadDetailById(
          ThreadId.make("thread-1"),
        );
        assert.equal(legacyThreadDetail._tag, "Some");
        if (legacyThreadDetail._tag === "Some") {
          const activities = legacyThreadDetail.value.activities;
          assert.equal(activities.length, 500);
          assert.equal(activities[0]?.summary, "legacy-act-101");
          assert.equal(activities[0]?.sequence, undefined);
          assert.equal(activities.at(-1)?.summary, "legacy-act-600");

          const legacyOlderPage = yield* snapshotQuery.getThreadActivitiesPage({
            threadId: ThreadId.make("thread-1"),
            beforeCreatedAt: activities[0]?.createdAt ?? "2026-04-01T00:01:00.000Z",
            beforeActivityId: activities[0]?.id ?? asEventId("unsequenced-0101"),
            limit: 500,
          });
          assert.equal(legacyOlderPage.activities.length, 100);
          assert.equal(legacyOlderPage.activities[0]?.summary, "legacy-act-1");
          assert.equal(legacyOlderPage.activities.at(-1)?.summary, "legacy-act-100");
          assert.equal(legacyOlderPage.hasMore, false);
        }

        const legacyBoundedPage = yield* snapshotQuery.getThreadActivitiesPage({
          threadId: ThreadId.make("thread-1"),
          beforeCreatedAt: "2026-04-01T00:01:00.000Z",
          beforeActivityId: asEventId("unsequenced-0601"),
          limit: 200,
        });
        assert.equal(legacyBoundedPage.activities.length, 200);
        assert.equal(legacyBoundedPage.activities[0]?.summary, "legacy-act-401");
        assert.equal(legacyBoundedPage.activities.at(-1)?.summary, "legacy-act-600");
        assert.equal(legacyBoundedPage.hasMore, true);
      }),
  );

  it.effect("unsequenced cursor reaches all older rows without stranding sequenced ones", () =>
    // Regression for the "unsequenced cursor hides sequenced history" concern:
    // sequenced rows always sort newer than NULL-sequence (legacy) rows, so when
    // the oldest loaded row is unsequenced every sequenced row is already in the
    // window — the `sequence IS NULL` cursor can't strand sequenced rows.
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_activities`;
      yield* sql`DELETE FROM projection_state`;
      yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, created_at, updated_at, deleted_at
          ) VALUES (
            'project-1', 'Project 1', '/tmp/project-1',
            '{"provider":"codex","model":"gpt-5-codex"}', '[]',
            '2026-04-01T00:00:00.000Z', '2026-04-01T00:00:01.000Z', NULL
          )
        `;
      yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, branch, worktree_path, latest_turn_id,
            latest_user_message_at, pending_approval_count, pending_user_input_count,
            has_actionable_proposed_plan, created_at, updated_at, archived_at, deleted_at
          ) VALUES (
            'thread-1', 'project-1', 'Thread 1',
            '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
            NULL, NULL, NULL, NULL, 0, 0, 0,
            '2026-04-01T00:00:02.000Z', '2026-04-01T00:00:03.000Z', NULL, NULL
          )
        `;
      // 600 legacy unsequenced rows (older) + 3 sequenced rows (newer). The
      // window keeps the 3 sequenced + the most-recent 497 unsequenced, so the
      // oldest loaded row is unsequenced and 103 older unsequenced remain.
      yield* Effect.forEach(
        Array.from({ length: 600 }, (_u, index) => index + 1),
        (n) =>
          sql`
              INSERT INTO projection_thread_activities (
                activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
                sequence, created_at
              ) VALUES (
                ${`unseq-${String(n).padStart(4, "0")}`}, 'thread-1', NULL,
                'info', 'runtime.note', ${`unseq-${n}`}, '{}', NULL,
                ${`2026-04-01T00:00:01.${String(n).padStart(3, "0")}Z`}
              )
            `,
        { discard: true },
      );
      yield* Effect.forEach(
        [1, 2, 3],
        (seq) =>
          sql`
              INSERT INTO projection_thread_activities (
                activity_id, thread_id, turn_id, tone, kind, summary, payload_json,
                sequence, created_at
              ) VALUES (
                ${`seq-${seq}`}, 'thread-1', NULL, 'info', 'runtime.note',
                ${`seq-${seq}`}, '{}', ${seq}, ${`2026-04-01T09:00:0${seq}.000Z`}
              )
            `,
        { discard: true },
      );

      const detail = yield* snapshotQuery.getThreadDetailById(ThreadId.make("thread-1"));
      assert.equal(detail._tag, "Some");
      if (detail._tag !== "Some") return;
      const windowed = detail.value.activities;
      assert.equal(windowed.length, 500);
      // Sequenced rows are the newest (end of the ascending window); the oldest
      // loaded row is unsequenced — exactly the case the concern is about.
      assert.equal(windowed.at(-1)?.summary, "seq-3");
      assert.equal(windowed[0]?.sequence, undefined);

      // The client pages with the unsequenced cursor of the oldest loaded row.
      const oldest = windowed[0];
      assert.ok(oldest);
      const olderPage = yield* snapshotQuery.getThreadActivitiesPage({
        threadId: ThreadId.make("thread-1"),
        beforeCreatedAt: oldest.createdAt,
        beforeActivityId: oldest.id,
        limit: 500,
      });
      // The 103 older unsequenced rows come back, none are sequenced, and no
      // sequenced row was stranded (all 3 are already in the window).
      assert.equal(olderPage.activities.length, 103);
      assert.equal(olderPage.hasMore, false);
      assert.ok(olderPage.activities.every((a) => a.sequence === undefined));
    }),
  );

  it.effect(
    "activity freshness ignores control-plane workstream rows (liveness clock cannot self-reset)",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          )
          VALUES
            ('act-tool', 'thread-fresh', 'turn-1', 'tool', 'tool.started', 'bash started', '{}', 1, '2026-05-01T00:00:00.000Z'),
            ('act-nudge', 'thread-fresh', NULL, 'error', 'workstream.liveness.stalled', 'Recovery nudge sent', '{}', 2, '2026-05-01T00:20:00.000Z')
        `;

        // The newest row is the control-plane nudge marker — it must NOT count
        // as child activity, or every nudge would erase the stall episode.
        const freshness = yield* snapshotQuery.getActivityFreshnessByThreadId(
          ThreadId.make("thread-fresh"),
        );
        assert.equal(freshness.maxCreatedAt, "2026-05-01T00:00:00.000Z");
      }),
  );

  it.effect(
    "in-flight tool detection treats an updated lifecycle row as running until completed",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_thread_activities`;
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          )
          VALUES
            ('act-read', 'thread-t', 'turn-1', 'tool', 'tool.completed', 'read', '{}', 2, '2026-05-01T00:00:01.000Z'),
            ('act-bash', 'thread-t', 'turn-1', 'tool', 'tool.updated', 'bash', '{}', 3, '2026-05-01T00:00:12.000Z'),
            ('act-old', 'thread-t', 'turn-0', 'tool', 'tool.started', 'stale started', '{}', 0, '2026-04-30T00:00:00.000Z')
        `;

        const inFlight = yield* snapshotQuery.getInFlightToolByThreadId(
          ThreadId.make("thread-t"),
          asTurnId("turn-1"),
        );
        assert.deepStrictEqual(inFlight, {
          toolName: "bash",
          startedAt: "2026-05-01T00:00:12.000Z",
          activityId: "act-bash",
          itemType: null,
          commandText: null,
          timeoutSeconds: null,
        });

        yield* sql`
          UPDATE projection_thread_activities
          SET kind = 'tool.completed', summary = 'bash', sequence = 4, created_at = '2026-05-01T00:00:13.000Z'
          WHERE activity_id = 'act-bash'
        `;
        assert.equal(
          yield* snapshotQuery.getInFlightToolByThreadId(
            ThreadId.make("thread-t"),
            asTurnId("turn-1"),
          ),
          null,
        );

        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          )
          VALUES
            ('old-started', 'thread-old', 'turn-1', 'tool', 'tool.started', 'grep started', '{}', 1, '2026-05-01T00:00:00.000Z'),
            ('old-updated', 'thread-old', 'turn-1', 'tool', 'tool.updated', 'grep', '{}', 2, '2026-05-01T00:00:10.000Z'),
            ('old-completed', 'thread-old', 'turn-1', 'tool', 'tool.completed', 'grep', '{}', 3, '2026-05-01T00:00:11.000Z')
        `;
        assert.equal(
          yield* snapshotQuery.getInFlightToolByThreadId(
            ThreadId.make("thread-old"),
            asTurnId("turn-1"),
          ),
          null,
        );
      }),
  );

  it.effect(
    "surfaces the started row's itemType, detail (command, with any eta marker), and the extracted numeric timeout",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_thread_activities`;
        // A command_execution started row whose payload carries the `# eta:`
        // command detail and the ingestion-extracted numeric `timeoutSeconds`.
        yield* sql`
          INSERT INTO projection_thread_activities (
            activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
          )
          VALUES
            (
              'act-eta', 'thread-eta', 'turn-1', 'tool', 'tool.started', 'bash started',
              '{"itemType":"command_execution","detail":"# eta: 25m\n python run.py","timeoutSeconds":1800}',
              1, '2026-05-01T00:00:00.000Z'
            )
        `;
        assert.deepStrictEqual(
          yield* snapshotQuery.getInFlightToolByThreadId(
            ThreadId.make("thread-eta"),
            asTurnId("turn-1"),
          ),
          {
            toolName: "bash",
            startedAt: "2026-05-01T00:00:00.000Z",
            activityId: "act-eta",
            itemType: "command_execution",
            commandText: "# eta: 25m\n python run.py",
            timeoutSeconds: 1800,
          },
        );

        // A non-numeric timeoutSeconds must degrade to null rather than break the
        // decode; a non-command tool surfaces its itemType so the rail can gate.
        yield* sql`
          UPDATE projection_thread_activities
          SET payload_json = '{"itemType":"dynamic_tool_call","detail":"grep foo","timeoutSeconds":"nope"}'
          WHERE activity_id = 'act-eta'
        `;
        assert.deepStrictEqual(
          yield* snapshotQuery.getInFlightToolByThreadId(
            ThreadId.make("thread-eta"),
            asTurnId("turn-1"),
          ),
          {
            toolName: "bash",
            startedAt: "2026-05-01T00:00:00.000Z",
            activityId: "act-eta",
            itemType: "dynamic_tool_call",
            commandText: "grep foo",
            timeoutSeconds: null,
          },
        );
      }),
  );

  // Derived attention at the shell boundary (redesign commitment 2). The
  // invariant under test is two-sided: `awaiting_input ∈ shell.attention ⇺
  // pendingUserInputCount > 0` on EVERY shell surface, AND
  // `awaiting_input ∉ getCommandReadModel().attention` always — because the engine
  // hydrates the decider's in-memory model from that query, where every attention
  // member is event-owned.
  it.effect(
    "unions a derived awaiting_input into shell attention, never into the command read model",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;

        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-1', 'Project 1', '/tmp/project-1',
          '{"provider":"pi","model":"claude-opus-4-8"}', '[]',
          '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:01.000Z', NULL
        )
      `;

        // Four rows spanning the whole invariant surface: count 0 with no stored
        // reasons; count 1 with none (the pure-derived case); count 1 alongside a
        // stored reason (the union must ADD, not replace); and an archived row with
        // an open question (the archived board reads the same union).
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, branch, worktree_path, latest_turn_id,
          latest_user_message_at, attention, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan,
          created_at, updated_at, archived_at, deleted_at
        ) VALUES
          ('thread-quiet', 'project-1', 'Quiet', '{"provider":"pi","model":"claude-opus-4-8"}',
           'full-access', 'default', NULL, NULL, NULL, NULL, '[]', 0, 0, 0,
           '2026-06-01T00:00:02.000Z', '2026-06-01T00:00:03.000Z', NULL, NULL),
          ('thread-asking', 'project-1', 'Asking', '{"provider":"pi","model":"claude-opus-4-8"}',
           'full-access', 'default', NULL, NULL, NULL, NULL, '[]', 0, 1, 0,
           '2026-06-01T00:00:02.000Z', '2026-06-01T00:00:03.000Z', NULL, NULL),
          ('thread-asking-flagged', 'project-1', 'Asking + flagged', '{"provider":"pi","model":"claude-opus-4-8"}',
           'full-access', 'default', NULL, NULL, NULL, NULL, '["needs_guidance"]', 0, 2, 0,
           '2026-06-01T00:00:02.000Z', '2026-06-01T00:00:03.000Z', NULL, NULL),
          ('thread-archived-asking', 'project-1', 'Archived asking', '{"provider":"pi","model":"claude-opus-4-8"}',
           'full-access', 'default', NULL, NULL, NULL, NULL, '[]', 0, 1, 0,
           '2026-06-01T00:00:02.000Z', '2026-06-01T00:00:03.000Z', '2026-06-01T00:00:04.000Z', NULL)
      `;

        const attentionOf = (
          threads: ReadonlyArray<{
            readonly id: ThreadId;
            readonly attention: ReadonlyArray<string>;
          }>,
          id: string,
        ) => threads.find((t) => t.id === ThreadId.make(id))?.attention;

        const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
        assert.deepStrictEqual(attentionOf(shellSnapshot.threads, "thread-quiet"), []);
        assert.deepStrictEqual(attentionOf(shellSnapshot.threads, "thread-asking"), [
          "awaiting_input",
        ]);
        // The union ADDS to the stored set rather than replacing it.
        assert.deepStrictEqual(attentionOf(shellSnapshot.threads, "thread-asking-flagged"), [
          "needs_guidance",
          "awaiting_input",
        ]);

        // Per-thread shell lookup (the WS thread-upserted subscription view) reads
        // the same union — this is the surface the bridge and the dispatcher see.
        const threadShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-asking"));
        assert.deepStrictEqual(Option.getOrUndefined(threadShell)?.attention, ["awaiting_input"]);
        const quietShell = yield* snapshotQuery.getThreadShellById(ThreadId.make("thread-quiet"));
        assert.deepStrictEqual(Option.getOrUndefined(quietShell)?.attention, []);

        const archivedSnapshot = yield* snapshotQuery.getArchivedShellSnapshot();
        assert.deepStrictEqual(attentionOf(archivedSnapshot.threads, "thread-archived-asking"), [
          "awaiting_input",
        ]);

        // The decider's hydration source carries STORED reasons only, on every row.
        const readModel = yield* snapshotQuery.getCommandReadModel();
        for (const thread of readModel.threads) {
          assert.ok(
            !thread.attention.includes("awaiting_input"),
            `command read model leaked a derived awaiting_input on ${thread.id}`,
          );
        }
        assert.deepStrictEqual(attentionOf(readModel.threads, "thread-asking"), []);
        assert.deepStrictEqual(attentionOf(readModel.threads, "thread-asking-flagged"), [
          "needs_guidance",
        ]);

        // Resolving every open request clears the flag with the count, in one step:
        // the two are one value, so there is no second write that could go missing.
        yield* sql`
        UPDATE projection_threads SET pending_user_input_count = 0
        WHERE thread_id IN ('thread-asking', 'thread-asking-flagged')
      `;
        const afterResolve = yield* snapshotQuery.getShellSnapshot();
        assert.deepStrictEqual(attentionOf(afterResolve.threads, "thread-asking"), []);
        assert.deepStrictEqual(attentionOf(afterResolve.threads, "thread-asking-flagged"), [
          "needs_guidance",
        ]);
      }),
  );

  // The `awaiting-input` parent wake keys its episode on the open requestId set,
  // so the fold must be exposed by identity and not merely by count — terminal-wins
  // and order-independent, matching the shell's count exactly.
  it.effect("reads the OPEN user-input requestIds terminal-wins, regardless of row order", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_thread_activities`;

      // `req-b` is resolved by a row that lands BEFORE its request (replay /
      // out-of-order ingestion); `req-c` gets a duplicate request row with a
      // distinct activity id AFTER its resolution. Neither may reopen.
      yield* sql`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, sequence, created_at
        ) VALUES
          ('a1', 'thread-open', NULL, 'info', 'user-input.requested', 'q', '{"requestId":"req-a"}', 1, '2026-06-02T00:00:01.000Z'),
          ('a2', 'thread-open', NULL, 'info', 'user-input.resolved', 'r', '{"requestId":"req-b"}', 2, '2026-06-02T00:00:02.000Z'),
          ('a3', 'thread-open', NULL, 'info', 'user-input.requested', 'q', '{"requestId":"req-b"}', 3, '2026-06-02T00:00:03.000Z'),
          ('a4', 'thread-open', NULL, 'info', 'user-input.requested', 'q', '{"requestId":"req-c"}', 4, '2026-06-02T00:00:04.000Z'),
          ('a5', 'thread-open', NULL, 'info', 'user-input.resolved', 'r', '{"requestId":"req-c"}', 5, '2026-06-02T00:00:05.000Z'),
          ('a6', 'thread-open', NULL, 'info', 'user-input.requested', 'q', '{"requestId":"req-c"}', 6, '2026-06-02T00:00:06.000Z'),
          ('a7', 'thread-open', NULL, 'info', 'user-input.requested', 'q', '{"requestId":"req-d"}', 7, '2026-06-02T00:00:07.000Z')
      `;

      const open = yield* snapshotQuery.getOpenUserInputRequestIdsByThreadId(
        ThreadId.make("thread-open"),
      );
      assert.deepStrictEqual([...open].toSorted(), ["req-a", "req-d"]);

      const none = yield* snapshotQuery.getOpenUserInputRequestIdsByThreadId(
        ThreadId.make("thread-without-activities"),
      );
      assert.equal(none.size, 0);
    }),
  );

  it.effect(
    "exposes a promptDebugPath for pi-session threads and omits it for other providers",
    () =>
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;
        const sql = yield* SqlClient.SqlClient;

        yield* sql`DELETE FROM projection_projects`;
        yield* sql`DELETE FROM projection_threads`;
        yield* sql`DELETE FROM projection_thread_sessions`;

        yield* sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, created_at, updated_at, deleted_at
          ) VALUES (
            'project-1', 'Project 1', '/tmp/project-1',
            '{"provider":"pi","model":"claude-opus-4-8"}', '[]',
            '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:01.000Z', NULL
          )
        `;

        yield* sql`
          INSERT INTO projection_threads (
            thread_id, project_id, title, model_selection_json, runtime_mode,
            interaction_mode, branch, worktree_path, latest_turn_id,
            latest_user_message_at, pending_approval_count, pending_user_input_count,
            has_actionable_proposed_plan, created_at, updated_at, deleted_at
          ) VALUES
            ('thread-pi', 'project-1', 'Pi Thread', '{"provider":"pi","model":"claude-opus-4-8"}',
             'full-access', 'default', NULL, NULL, NULL, NULL, 0, 0, 0,
             '2026-02-24T00:00:02.000Z', '2026-02-24T00:00:03.000Z', NULL),
            ('thread-pi-nofile', 'project-1', 'Pi Thread No File', '{"provider":"pi","model":"claude-opus-4-8"}',
             'full-access', 'default', NULL, NULL, NULL, NULL, 0, 0, 0,
             '2026-02-24T00:00:02.000Z', '2026-02-24T00:00:03.000Z', NULL),
            ('thread-codex', 'project-1', 'Codex Thread', '{"provider":"codex","model":"gpt-5-codex"}',
             'full-access', 'default', NULL, NULL, NULL, NULL, 0, 0, 0,
             '2026-02-24T00:00:02.000Z', '2026-02-24T00:00:03.000Z', NULL)
        `;

        yield* sql`
          INSERT INTO projection_thread_sessions (
            thread_id, status, provider_name, provider_session_id,
            provider_thread_id, runtime_mode, active_turn_id, last_error, updated_at
          ) VALUES
            ('thread-pi', 'running', 'pi', NULL, NULL, 'full-access', NULL, NULL,
             '2026-02-24T00:00:07.000Z'),
            ('thread-pi-nofile', 'running', 'pi', NULL, NULL, 'full-access', NULL, NULL,
             '2026-02-24T00:00:07.000Z'),
            ('thread-codex', 'running', 'codex', NULL, NULL, 'full-access', NULL, NULL,
             '2026-02-24T00:00:07.000Z')
        `;

        // Only thread-pi has a sidecar on disk; thread-pi-nofile is a pi thread
        // that has not produced a capture yet. The path must surface ONLY when
        // the file exists, so a not-yet-launched / failed-capture thread never
        // renders a dead UI link.
        const promptDebugDir = (yield* ServerConfig).workstreamPromptDebugDir;
        NodeFS.mkdirSync(promptDebugDir, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(promptDebugDir, "thread-pi.md"), "# capture", "utf8");
        // A stale sidecar for the non-pi thread, so the provider gate is proven
        // on its own rather than passing because the file is simply absent.
        NodeFS.writeFileSync(NodePath.join(promptDebugDir, "thread-codex.md"), "# stale", "utf8");

        const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
        const byId = (id: string) => shellSnapshot.threads.find((t) => t.id === ThreadId.make(id));
        const piThread = byId("thread-pi");
        assert.ok(
          piThread?.promptDebugPath,
          "pi thread with a sidecar should expose promptDebugPath",
        );
        assert.ok(
          piThread!.promptDebugPath!.endsWith("prompt-debug/thread-pi.md"),
          `unexpected promptDebugPath: ${piThread!.promptDebugPath}`,
        );
        // pi thread WITHOUT a sidecar file: no path (would be a dead link).
        assert.equal(byId("thread-pi-nofile")?.promptDebugPath, undefined);
        // Non-pi thread: no path regardless of any file.
        assert.equal(byId("thread-codex")?.promptDebugPath, undefined);

        // The single-thread lookup backs every `thread-upserted` shell-stream
        // event, so it must agree with the full snapshot exactly. When it did
        // not, the UI's Prompt button appeared on a fresh snapshot and vanished
        // on the thread's very next event.
        const shellById = (id: string) =>
          snapshotQuery.getThreadShellById(ThreadId.make(id)).pipe(Effect.map(Option.getOrNull));
        assert.equal(
          (yield* shellById("thread-pi"))?.promptDebugPath,
          piThread!.promptDebugPath,
          "getThreadShellById must surface the same promptDebugPath as getShellSnapshot",
        );
        assert.equal((yield* shellById("thread-pi-nofile"))?.promptDebugPath, undefined);
        assert.equal((yield* shellById("thread-codex"))?.promptDebugPath, undefined);
      }),
  );

  // The agent-facing goal endpoints (goal_task_*, goal_update, goal_handoff,
  // goal_continue) resolve one goal / one project list per call. They used to
  // do it by scanning a full `getSnapshot()`; these narrow queries must return
  // exactly what that scan did.
  it.effect("getGoalById returns the goal with its task tree, matching the full snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* seedGoalFixture(sql);

      const goal = yield* snapshotQuery.getGoalById(asGoalId("goal-1"));
      assert.ok(Option.isSome(goal));

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      const fromSnapshot = fullSnapshot.goals.find(
        (candidate) => candidate.id === asGoalId("goal-1") && candidate.deletedAt === null,
      );
      assert.deepStrictEqual(goal.value, fromSnapshot);

      // Task tree shape: deleted tasks excluded, children nested under parents.
      assert.deepStrictEqual(
        goal.value.tasks.map((task) => task.id),
        ["task-1"],
      );
      assert.deepStrictEqual(
        goal.value.tasks[0]?.children.map((task) => task.id),
        ["task-1a"],
      );
    }),
  );

  it.effect("getGoalById returns an archived goal but never a deleted or missing one", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* seedGoalFixture(sql);

      // Archived is still resolvable: an archived goal's task tree stays usable.
      const archived = yield* snapshotQuery.getGoalById(asGoalId("goal-archived"));
      assert.ok(Option.isSome(archived));
      assert.equal(archived.value.archivedAt, "2026-04-06T00:00:09.000Z");

      // Deleted and unknown goals are both absent, as the old snapshot
      // `find(g => g.id === goalId && g.deletedAt === null)` was.
      assert.ok(Option.isNone(yield* snapshotQuery.getGoalById(asGoalId("goal-deleted"))));
      assert.ok(Option.isNone(yield* snapshotQuery.getGoalById(asGoalId("goal-missing"))));
    }),
  );

  it.effect("listGoalSlugsByProjectId scopes to the project and includes deleted goals", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* seedGoalFixture(sql);

      const slugs = yield* snapshotQuery.listGoalSlugsByProjectId(asProjectId("project-1"));
      // `goal-deleted` is in project-1 and its slug is still taken.
      assert.deepStrictEqual(slugs.toSorted(), ["archived-goal", "deleted-goal", "goal-one"]);

      assert.deepStrictEqual(
        yield* snapshotQuery.listGoalSlugsByProjectId(asProjectId("project-2")),
        ["other-project-goal"],
      );
      assert.deepStrictEqual(
        yield* snapshotQuery.listGoalSlugsByProjectId(asProjectId("project-missing")),
        [],
      );
    }),
  );

  it.effect("listActiveProjectRefs matches the full snapshot's active projects, in order", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* seedGoalFixture(sql);

      const refs = yield* snapshotQuery.listActiveProjectRefs();
      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      assert.deepStrictEqual(
        refs,
        fullSnapshot.projects
          .filter((project) => project.deletedAt === null)
          .map((project) => ({ id: project.id, title: project.title })),
      );
      assert.deepStrictEqual(
        refs.map((project) => project.id),
        [asProjectId("project-1"), asProjectId("project-2")],
      );
    }),
  );
});

const NOW_MS = Date.parse("2026-06-24T00:00:00.000Z");

projectionSnapshotLayer("derived brief-needed parent attention (liveness plan §3.3)", (it) => {
  // A node that is released, unblocked, and unbriefed cannot run and cannot help
  // itself. Past 24h its parent carries `needs_guidance` for a human — DERIVED at
  // the outward read boundary, because every turn-start clears stored attention
  // (which is exactly how the old backstop's flag was erased minutes after it was
  // raised).
  //
  // The answer is a SEPARATE read, never a decoration on the shell queries: the
  // dispatcher and liveness sweep consume those same queries and judge
  // `attention.length` as stored control-plane state. Both facts are pinned
  // below against real SQL.
  const seed = (
    sql: SqlClient.SqlClient,
    childCreatedAt: string,
    kickoffBriefPath: string | null,
  ) =>
    Effect.gen(function* () {
      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_thread_sessions`;
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model_selection_json,
          scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          'project-1', 'Project 1', '/tmp/project-1', NULL, '[]',
          '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:01.000Z', NULL
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, parent_thread_id, role, purpose, plan_lane,
          kickoff_brief_path, title, model_selection_json, runtime_mode,
          interaction_mode, created_at, updated_at, deleted_at
        ) VALUES
          ('parent-1', 'project-1', NULL, NULL, NULL, 'in_progress', NULL,
           'Orchestrator', '{"provider":"codex","model":"gpt-5-codex"}',
           'full-access', 'default',
           '2026-02-24T00:00:02.000Z', '2026-02-24T00:00:03.000Z', NULL),
          ('child-1', 'project-1', 'parent-1', 'coder', 'do the thing', 'ready',
           ${kickoffBriefPath}, 'Unbriefed node',
           '{"provider":"codex","model":"gpt-5-codex"}', 'full-access', 'default',
           ${childCreatedAt}, ${childCreatedAt}, NULL)
      `;
    });

  const parentAttention = Effect.fn("parentAttention")(function* (
    childCreatedAt: string,
    kickoffBriefPath: string | null,
  ) {
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    // The 24h predicate is wall-clock arithmetic, so the fixture clock must agree
    // with the fixture timestamps (the suite defaults to epoch 0).
    yield* TestClock.setTime(NOW_MS);
    yield* seed(yield* SqlClient.SqlClient, childCreatedAt, kickoffBriefPath);
    const parents = yield* snapshotQuery.getBriefNeededAttentionParentIds();
    const snapshot = yield* snapshotQuery.getShellSnapshot();
    const byId = yield* snapshotQuery.getThreadShellById(ThreadId.make("parent-1"));
    const outward = applyBriefNeededParentAttention(snapshot, parents);
    return {
      derivedParents: [...parents],
      // What an outward reader (UI shell stream / shell HTTP route) sees.
      outward: outward.threads.find((thread) => thread.id === "parent-1")?.attention ?? [],
      // What the dispatcher and liveness sweep see — these MUST stay stored-only.
      controlPlaneSnapshot:
        snapshot.threads.find((thread) => thread.id === "parent-1")?.attention ?? [],
      controlPlaneLookup: byId._tag === "Some" ? byId.value.attention : [],
    };
  });

  const aged = () => DateTime.formatIso(DateTime.makeUnsafe(NOW_MS - 25 * 3_600_000));
  const fresh = () => DateTime.formatIso(DateTime.makeUnsafe(NOW_MS - 60_000));

  it.effect("flags the parent OUTWARD once a child sits 24h unbriefed", () =>
    Effect.gen(function* () {
      const attention = yield* parentAttention(aged(), null);
      assert.deepStrictEqual(attention.derivedParents, ["parent-1"]);
      assert.deepStrictEqual(attention.outward, ["needs_guidance"]);
    }),
  );

  it.effect("leaves the CONTROL-PLANE reads stored-only while the outward flag is set", () =>
    Effect.gen(function* () {
      // The dispatcher classifies a child with any attention as paused and wakes
      // ITS parent; the sweep stops nudging a flagged thread's stalls. Neither
      // may see a flag that only means "a grandchild is unbriefed", or an
      // overdue node fabricates an internal pause on a healthy orchestrator.
      const attention = yield* parentAttention(aged(), null);
      assert.deepStrictEqual(attention.outward, ["needs_guidance"]);
      assert.deepStrictEqual(attention.controlPlaneSnapshot, []);
      assert.deepStrictEqual(attention.controlPlaneLookup, []);
    }),
  );

  it.effect("does not flag inside the window", () =>
    Effect.gen(function* () {
      const attention = yield* parentAttention(fresh(), null);
      assert.deepStrictEqual(attention.derivedParents, []);
      assert.deepStrictEqual(attention.outward, []);
    }),
  );

  it.effect("adds no noise to a parent that ALREADY carries a stored needs_guidance", () =>
    Effect.gen(function* () {
      // The superseded a81963cfa needed an explicit `parentFlagged` guard for
      // this ("if a human already has a reason to look, adding another is
      // noise"). A derived union needs none: union with a stored flag is the
      // identity, so the property holds by construction.
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(NOW_MS);
      yield* seed(sql, aged(), null);
      yield* sql`UPDATE projection_threads SET attention = '["needs_guidance"]' WHERE thread_id = 'parent-1'`;

      const parents = yield* snapshotQuery.getBriefNeededAttentionParentIds();
      const outward = applyBriefNeededParentAttention(
        yield* snapshotQuery.getShellSnapshot(),
        parents,
      );
      assert.deepStrictEqual(
        outward.threads.find((thread) => thread.id === "parent-1")?.attention,
        ["needs_guidance"],
      );
    }),
  );

  it.effect("self-clears the moment the brief lands", () =>
    Effect.gen(function* () {
      const attention = yield* parentAttention(aged(), "/briefs/child-1.md");
      assert.deepStrictEqual(attention.derivedParents, []);
      assert.deepStrictEqual(attention.outward, []);
    }),
  );

  // The flag is derived, so NOTHING publishes a change event when the predicate
  // flips — and the three sanctioned exits (brief / hold / cancel) all emit a
  // CHILD event. Without republishing the parent alongside it, the client keeps
  // a stale alarm on exactly the thread the operator just fixed, until an
  // unrelated parent event or a reload. These drive the real transitions through
  // the outward tracker against real SQL.
  const trackerAfterTransition = Effect.fn("trackerAfterTransition")(function* (
    transition: string,
  ) {
    const snapshotQuery = yield* ProjectionSnapshotQuery;
    const sql = yield* SqlClient.SqlClient;
    yield* TestClock.setTime(NOW_MS);
    yield* seed(sql, aged(), null);

    const tracker = yield* makeBriefNeededOutwardAttention(snapshotQuery);
    // The client's initial state: parent flagged.
    const initial = yield* tracker.decorateSnapshot(yield* snapshotQuery.getShellSnapshot());
    const before = initial.threads.find((thread) => thread.id === "parent-1")?.attention ?? [];

    // The operator (or the parent agent) takes a sanctioned exit on the CHILD.
    yield* sql.unsafe(transition);
    const child = yield* snapshotQuery.getThreadShellById(ThreadId.make("child-1"));
    if (child._tag !== "Some") throw new Error("expected the child shell");
    const published = yield* tracker.decorateUpsert(child.value);
    return {
      before,
      publishedIds: published.map((thread) => thread.id),
      parentAfter: published.find((thread) => thread.id === "parent-1")?.attention,
    };
  });

  it.effect("republishes the parent when the child is HELD (`set_lane planned`)", () =>
    Effect.gen(function* () {
      const result = yield* trackerAfterTransition(
        "UPDATE projection_threads SET plan_lane = 'planned' WHERE thread_id = 'child-1'",
      );
      assert.deepStrictEqual(result.before, ["needs_guidance"]);
      // One event carries BOTH shells — the client's reducer drops a second event
      // sharing the same domain sequence.
      assert.deepStrictEqual(result.publishedIds.toSorted(), ["child-1", "parent-1"]);
      assert.deepStrictEqual(result.parentAfter, []);
    }),
  );

  it.effect("republishes the parent when the brief is attached", () =>
    Effect.gen(function* () {
      const result = yield* trackerAfterTransition(
        "UPDATE projection_threads SET kickoff_brief_path = '/briefs/c.md' WHERE thread_id = 'child-1'",
      );
      assert.deepStrictEqual(result.before, ["needs_guidance"]);
      assert.deepStrictEqual(result.publishedIds.toSorted(), ["child-1", "parent-1"]);
      assert.deepStrictEqual(result.parentAfter, []);
    }),
  );

  it.effect("publishes only the child when nothing about the parent's answer changed", () =>
    Effect.gen(function* () {
      // An unrelated child event must not drag a redundant parent shell along.
      const result = yield* trackerAfterTransition(
        "UPDATE projection_threads SET title = 'Renamed' WHERE thread_id = 'child-1'",
      );
      assert.deepStrictEqual(result.before, ["needs_guidance"]);
      assert.deepStrictEqual(result.publishedIds, ["child-1"]);
    }),
  );
});

it.effect(
  "ProjectionSnapshotQuery dedupes repository identity resolution by workspace root and skips deleted projects for shell snapshots",
  () => {
    const resolveCalls: string[] = [];
    const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provideMerge(
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
          resolve: (cwd: string) =>
            Effect.sync(() => {
              resolveCalls.push(cwd);
              return {
                canonicalKey: `github.com/acme${cwd}`,
                locator: {
                  source: "git-remote" as const,
                  remoteName: "origin",
                  remoteUrl: `https://github.com/acme${cwd}.git`,
                },
                rootPath: cwd,
              };
            }),
        }),
      ),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(
        serverConfigLayerTest(process.cwd(), { prefix: "psq-test" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    );

    return Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;
      yield* sql`DELETE FROM projection_threads`;
      yield* sql`DELETE FROM projection_turns`;
      yield* sql`DELETE FROM projection_state`;

      // Only one ACTIVE project may exist per workspace_root (migration 050's
      // partial unique index), so the shared root is exercised via an active
      // project plus a soft-deleted one — the legitimate way two projects can
      // still share a root.
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_model_selection_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-1',
            'Shared Project 1',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:00.000Z',
            '2026-04-04T00:00:01.000Z',
            NULL
          ),
          (
            'project-2',
            'Shared Project 2 (deleted)',
            '/tmp/shared-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:02.000Z',
            '2026-04-04T00:00:03.000Z',
            '2026-04-04T00:00:06.000Z'
          ),
          (
            'project-3',
            'Deleted Project',
            '/tmp/deleted-root',
            '{"provider":"codex","model":"gpt-5-codex"}',
            '[]',
            '2026-04-04T00:00:04.000Z',
            '2026-04-04T00:00:05.000Z',
            '2026-04-04T00:00:06.000Z'
          )
      `;

      const shellSnapshot = yield* snapshotQuery.getShellSnapshot();
      assert.deepStrictEqual(resolveCalls.toSorted(), ["/tmp/shared-root"]);
      assert.equal(shellSnapshot.projects.length, 1);
      assert.equal(shellSnapshot.projects[0]?.repositoryIdentity?.rootPath, "/tmp/shared-root");

      resolveCalls.length = 0;

      const fullSnapshot = yield* snapshotQuery.getSnapshot();
      // Two projects share /tmp/shared-root but the resolver runs once per
      // unique workspace root.
      assert.deepStrictEqual(resolveCalls.toSorted(), ["/tmp/deleted-root", "/tmp/shared-root"]);
      assert.equal(fullSnapshot.projects.length, 3);
      assert.equal(fullSnapshot.projects[1]?.repositoryIdentity?.rootPath, "/tmp/shared-root");
      assert.equal(fullSnapshot.projects[2]?.repositoryIdentity?.rootPath, "/tmp/deleted-root");
    }).pipe(Effect.provide(layer));
  },
);
