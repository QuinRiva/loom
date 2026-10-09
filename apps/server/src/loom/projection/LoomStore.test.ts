import { assert, it } from "@effect/vitest";
import {
  EventId,
  GoalId,
  GoalTaskId,
  type LoomThreadWorkstream,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as LoomStore from "./LoomStore.ts";

const TestLayer = LoomStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const projectId = ProjectId.make("project:store");
const T = (minute: number) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;

/** Writes a sidecar row through the store's codec; `parent` also sets the root. */
const row = (
  id: string,
  patch: Partial<LoomThreadWorkstream> & { readonly parent?: string; readonly root?: string } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const { parent, root, ...rest } = patch;
    yield* LoomStore.writeWorkstream(sql, {
      ...LoomStore.emptyWorkstream({
        threadId: ThreadId.make(id),
        projectId,
        parentThreadId: parent === undefined ? null : ThreadId.make(parent),
        rootThreadId: ThreadId.make(root ?? parent ?? id),
        at: T(0),
      }),
      ...rest,
    });
  });

it.layer(TestLayer)("LoomStoreV2", (it) => {
  it.effect("round-trips the record through the codec and filters the tree reads", () =>
    Effect.gen(function* () {
      const store = yield* LoomStore.LoomStoreV2;
      yield* row("tree-root", {
        attention: ["needs_guidance"],
        attentionEpisodes: { needs_guidance: EventId.make("event:raise") },
        held: true,
        routes: [{ on: ["needs_rework"], kind: "loop", to: ThreadId.make("tree-a") }],
        lastRoute: {
          to: ThreadId.make("tree-a"),
          round: 1,
          kind: "loop",
          eventId: EventId.make("e"),
        },
      });
      yield* row("tree-a", { parent: "tree-root" });
      yield* row("tree-b", { parent: "tree-root", archivedAt: T(1) });
      yield* row("tree-c", { parent: "tree-root", deletedAt: T(1) });

      const root = yield* store.getWorkstream(ThreadId.make("tree-root"));
      assert.deepEqual(root?.attention, ["needs_guidance"]);
      assert.equal(root?.attentionEpisodes.needs_guidance, "event:raise");
      assert.isTrue(root?.held);
      assert.equal(root?.lastRoute?.round, 1);
      assert.isNull(yield* store.getWorkstream(ThreadId.make("tree-missing")));

      const ids = (rows: ReadonlyArray<LoomThreadWorkstream>) =>
        rows.map((entry) => entry.threadId);
      assert.deepEqual(ids(yield* store.listWorkstreamTree(ThreadId.make("tree-root"))), [
        "tree-a",
        "tree-root",
      ]);
      assert.deepEqual(
        ids(yield* store.listChildren(ThreadId.make("tree-root"), { includeArchived: true })),
        ["tree-a", "tree-b"],
      );
      assert.deepEqual(
        ids(
          yield* store.listWorkstreamTree(ThreadId.make("tree-root"), {
            includeArchived: true,
            includeDeleted: true,
          }),
        ).length,
        4,
      );
    }),
  );

  it.effect(
    "listReDriveInput: live rows plus only the episodes their subtree has not followed",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStore.LoomStoreV2;
        const cancelled = {
          outcome: "cancelled" as const,
          outcomeAt: T(10),
          outcomeEventId: EventId.make("e:c"),
        };
        // Cancelled + archived root, unstarted archived child still open → both listed.
        yield* row("rd-a", { ...cancelled, archivedAt: T(11) });
        yield* row("rd-a1", { parent: "rd-a", archivedAt: T(11) });
        // The same, but the child followed (cancelled + archived) → neither listed.
        yield* row("rd-c", { ...cancelled, archivedAt: T(11) });
        yield* row("rd-c1", { parent: "rd-c", ...cancelled, archivedAt: T(11) });
        // Deleted root over an archived, undeleted child → both listed.
        yield* row("rd-g", { archivedAt: T(5), deletedAt: T(12) });
        yield* row("rd-g1", { parent: "rd-g", archivedAt: T(5) });
        // Unarchived root: a child archived before the unarchive keeps the episode open;
        // one a human re-archived after it does not (it is listed only because an open
        // episode lists its whole subtree — the planner's episode-keyed id skips it).
        yield* row("rd-i", { unarchivedAt: T(20), unarchivedEventId: EventId.make("e:u") });
        yield* row("rd-i1", { parent: "rd-i", archivedAt: T(15) });
        yield* row("rd-i2", { parent: "rd-i", archivedAt: T(25) });
        yield* row("rd-j", { unarchivedAt: T(20), unarchivedEventId: EventId.make("e:u2") });
        yield* row("rd-j1", { parent: "rd-j", archivedAt: T(25) });
        // An imported cancel (no episode stamp) is history, not news.
        yield* row("rd-l", { outcome: "cancelled", outcomeAt: T(10), archivedAt: T(11) });
        yield* row("rd-l1", { parent: "rd-l", archivedAt: T(11) });
        // Archived root whose child a human unarchived afterwards: the child is live, the
        // root is not an open episode.
        yield* row("rd-n", { archivedAt: T(30) });
        yield* row("rd-n1", { parent: "rd-n", unarchivedAt: T(31) });
        // A child created after the archive is out of the episode's scope.
        yield* row("rd-p", { archivedAt: T(30) });
        yield* row("rd-p1", { parent: "rd-p", createdAt: T(40) });

        const listed = new Set(
          (yield* store.listReDriveInput())
            .map((entry) => entry.threadId)
            .filter((id) => id.startsWith("rd-")),
        );
        assert.deepEqual([...listed].toSorted(), [
          "rd-a",
          "rd-a1",
          "rd-g",
          "rd-g1",
          "rd-i",
          "rd-i1",
          "rd-i2",
          "rd-j",
          "rd-n1",
          "rd-p1",
        ]);
      }),
  );

  it.effect("lists Loom threads with a held queued run", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* LoomStore.LoomStoreV2;
      yield* row("held-a");
      const run = (runId: string, threadId: string, ordinal: number, payloadJson: string) =>
        sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${runId}, ${threadId}, ${ordinal}, 'codex', 'queued', ${T(0)}, ${payloadJson})`;
      yield* run("run-held", "held-a", 1, '{"queueHeld":true}');
      yield* run("run-free", "held-a", 2, "{}");
      yield* run("run-other", "held-not-loom", 1, '{"queueHeld":true}');
      assert.deepEqual(yield* store.listThreadsWithHeldQueue(), [ThreadId.make("held-a")]);
    }),
  );

  it.effect("shell stats add V1's imported tool count to V2's and fall back to V1's context", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* LoomStore.LoomStoreV2;
      const thread = (id: string, activeProviderThreadId: string | null) =>
        Effect.andThen(
          row(id),
          sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title,
              default_provider, runtime_mode, interaction_mode, active_provider_thread_id,
              created_at, updated_at, payload_json)
            VALUES (${id}, ${projectId}, ${id}, 'pi', 'full-access', 'default',
              ${activeProviderThreadId}, ${T(0)}, ${T(0)}, '{}')`,
        );
      const item = (id: string, threadId: string, type: string) =>
        sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, ordinal,
            type, status, updated_at, payload_json)
          VALUES (${id}, ${threadId}, 1, ${type}, 'completed', ${T(0)}, '{}')`;
      // Imported and still running under V2: both counts, V2's context wins.
      yield* thread("stats-spans", "pt-spans");
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads (provider_thread_id,
          thread_id, provider, status, updated_at, payload_json)
        VALUES ('pt-spans', 'stats-spans', 'pi', 'idle', ${T(0)},
          '{"contextUsage":{"usedTokens":500,"maxTokens":1000}}')`;
      yield* item("i-1", "stats-spans", "command_execution");
      yield* item("i-2", "stats-spans", "assistant_message");
      // Imported, never run under V2: V1's figures alone.
      yield* thread("stats-v1", null);
      yield* sql`INSERT INTO loom_thread_imported_metrics (thread_id, tool_calls, used_tokens, max_tokens)
        VALUES ('stats-spans', 40, 9000, 1000000), ('stats-v1', 7, 250000, 1000000)`;
      // New under V2, nothing reported yet.
      yield* thread("stats-new", null);

      const fields = yield* store.shellFields(
        ["stats-spans", "stats-v1", "stats-new"].map((id) => ThreadId.make(id)),
      );
      const stats = (id: string) => {
        const entry = fields.get(ThreadId.make(id));
        return [entry?.toolCalls, entry?.contextUsage];
      };
      assert.deepEqual(stats("stats-spans"), [41, { usedTokens: 500, maxTokens: 1000 }]);
      assert.deepEqual(stats("stats-v1"), [7, { usedTokens: 250000, maxTokens: 1000000 }]);
      assert.deepEqual(stats("stats-new"), [0, null]);
    }),
  );

  it.effect(
    "active step: the oldest in-flight tool, else the model since the last tool ended",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* LoomStore.LoomStoreV2;
        const run = (runId: string, threadId: string, status: string) =>
          Effect.all([
            row(threadId),
            sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title,
              default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
            VALUES (${threadId}, ${projectId}, ${threadId}, 'pi', 'full-access', 'default',
              ${T(0)}, ${T(0)}, '{}')`,
            sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider,
              status, requested_at, payload_json)
            VALUES (${runId}, ${threadId}, 1, 'pi', ${status}, ${T(0)},
              ${JSON.stringify({ workStartedAt: T(1) })})`,
          ]);
        const item = (
          id: string,
          threadId: string,
          runId: string,
          ordinal: number,
          type: string,
          status: string,
          payload: Record<string, unknown>,
        ) =>
          sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id,
            ordinal, type, status, updated_at, payload_json)
          VALUES (${id}, ${threadId}, ${runId}, ${ordinal}, ${type}, ${status}, ${T(ordinal)},
            ${JSON.stringify(payload)})`;
        // Two tools in flight: the older one is the step; its command's first line is the detail.
        yield* run("run-tool", "step-tool", "running");
        yield* item("st-1", "step-tool", "run-tool", 2, "command_execution", "completed", {
          completedAt: T(3),
        });
        yield* item("st-2", "step-tool", "run-tool", 4, "command_execution", "running", {
          title: "bash",
          startedAt: T(4),
          input: "sleep 1200\necho done",
        });
        yield* item("st-3", "step-tool", "run-tool", 5, "dynamic_tool", "running", {
          title: "read",
          startedAt: T(5),
          input: { path: "a.ts" },
        });
        // Between tools: since the last tool ended, however much text streamed after it.
        yield* run("run-model", "step-model", "running");
        yield* item("sm-1", "step-model", "run-model", 2, "dynamic_tool", "completed", {
          completedAt: T(6),
        });
        yield* item("sm-2", "step-model", "run-model", 3, "assistant_message", "running", {});
        // No tool yet: since the run's work start. Settled run: no step at all.
        yield* run("run-fresh", "step-fresh", "running");
        yield* run("run-idle", "step-idle", "completed");
        yield* item("si-1", "step-idle", "run-idle", 2, "command_execution", "running", {
          startedAt: T(2),
        });

        const fields = yield* store.shellFields(
          ["step-tool", "step-model", "step-fresh", "step-idle"].map((id) => ThreadId.make(id)),
        );
        const step = (id: string) => fields.get(ThreadId.make(id))?.activeStep;
        assert.deepEqual(step("step-tool"), {
          kind: "tool",
          since: T(4),
          title: "bash",
          detail: "sleep 1200",
        });
        assert.deepEqual(step("step-model"), {
          kind: "model",
          since: T(6),
          title: null,
          detail: null,
        });
        assert.deepEqual(step("step-fresh"), {
          kind: "model",
          since: T(1),
          title: null,
          detail: null,
        });
        assert.isNull(step("step-idle"));
      }),
  );

  it.effect("goal and task CRUD assembles the live tree and soft-deletes by project", () =>
    Effect.gen(function* () {
      const store = yield* LoomStore.LoomStoreV2;
      const goalId = GoalId.make("goal:crud");
      const task = (id: string, parent: string | null, position: number) => ({
        id: GoalTaskId.make(id),
        parentTaskId: parent === null ? null : GoalTaskId.make(parent),
        text: `Task ${id}`,
        done: false,
        position,
      });
      const goal = yield* store.goals.upsert({
        id: goalId,
        projectId,
        slug: "crud",
        title: "Crud",
        description: "",
      });
      assert.deepEqual(goal.tasks, []);
      yield* store.tasks.replaceTree(goalId, [
        task("t1", null, 1),
        task("t0", null, 0),
        task("t1a", "t1", 0),
        task("t1a-x", "t1a", 0),
      ]);
      const tree = yield* store.tasks.replaceTree(goalId, [
        task("t1", null, 1),
        task("t0", null, 0),
        task("t1a", "t1", 0),
        task("t1a-x", "t1a", 0),
        task("t2", null, 2),
      ]);
      assert.deepEqual(
        tree.map((node) => node.id),
        ["t0", "t1", "t2"],
      );
      assert.equal(tree[1]?.children[0]?.children[0]?.id, "t1a-x");

      const afterDelete = yield* store.tasks.markDeleted(goalId, GoalTaskId.make("t1"));
      assert.deepEqual(
        afterDelete.map((node) => node.id),
        ["t0", "t2"],
      );
      const rewritten = yield* store.tasks.replaceTree(goalId, [task("t2", null, 0)]);
      assert.deepEqual(
        rewritten.map((node) => node.id),
        ["t2"],
      );
      yield* store.tasks.upsert({ ...task("t2", null, 0), goalId, done: true });
      assert.isTrue((yield* store.tasks.listByGoal(goalId))[0]?.done);

      assert.isNotNull((yield* store.goals.archive(goalId))?.archivedAt);
      assert.isNull((yield* store.goals.unarchive(goalId))?.archivedAt);
      const deleted = yield* store.goals.softDeleteByProject(projectId);
      assert.deepEqual(
        deleted.map((entry) => entry.id),
        [goalId],
      );
      assert.deepEqual(yield* store.goals.listByProject(projectId), []);
      assert.isNotNull((yield* store.goals.get(goalId))?.deletedAt);
    }),
  );

  it.effect("folds the thread's history across V1 and V2 events", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* LoomStore.LoomStoreV2;
      const threadId = "history-thread";
      const event = (version: number, n: number, type: string, payload: object) =>
        sql`INSERT INTO orchestration_events ${sql.insert({
          event_id: `event:${n}`,
          aggregate_kind: "thread",
          stream_id: threadId,
          stream_version: n,
          event_type: type,
          occurred_at: T(n),
          actor_kind: "server",
          payload_json: JSON.stringify(payload),
          metadata_json: "{}",
          application_event_version: version,
        })}`;
      // V1 payloads carry `threadId` / `updatedAt` besides the V2 fields; V1's
      // route-taken has no kind and its yield is a lane.
      const v1 = { threadId, updatedAt: T(1) };
      yield* event(1, 1, "thread.report-set", { ...v1, reportPath: "/r/t.round-1.md" });
      yield* event(1, 2, "thread.outcome-recorded", {
        ...v1,
        outcome: "needs_rework",
        decision: "loop",
        round: 1,
        counts: { mustFix: 1, niceToHave: 0 },
      });
      yield* event(1, 3, "thread.route-taken", { ...v1, to: "coder", round: 1 });
      yield* event(1, 4, "thread.plan-lane-set", { ...v1, planLane: "yielded" });
      yield* event(1, 5, "thread.plan-lane-set", { ...v1, planLane: "in_progress" });
      yield* event(2, 6, "thread.title-set", { title: "noise" });
      yield* event(2, 7, "thread.attention-raised", { reason: "needs_guidance" });
      yield* event(2, 8, "thread.attention-cleared", {});
      yield* event(2, 9, "thread.report-set", { reportPath: "/r/t.md" });
      yield* event(2, 10, "thread.outcome-recorded", {
        outcome: "clean",
        decision: "resolve",
        round: 1,
      });
      yield* event(2, 11, "thread.outcome-set", { outcome: "done", cause: "submit" });

      const history = yield* store.history(ThreadId.make(threadId));
      assert.deepEqual(
        history.map((entry) => [entry.type, entry.at]),
        [
          ["outcome", T(2)],
          ["route-taken", T(3)],
          ["attention-raised", T(4)],
          ["attention-cleared", T(5)],
          ["attention-raised", T(7)],
          ["attention-cleared", T(8)],
          ["outcome", T(10)],
          ["outcome-set", T(11)],
        ],
      );
      const [rework, route, yielded, resumed, , clearedAll, clean] = history;
      assert.deepInclude(rework, {
        reportPath: "/r/t.round-1.md",
        eventId: EventId.make("event:2"),
        counts: { mustFix: 1, niceToHave: 0 },
      });
      assert.deepInclude(route, { kind: "loop", round: 1 });
      assert.deepInclude(yielded, { reason: "awaiting_orchestrator" });
      assert.deepInclude(resumed, { reason: "awaiting_orchestrator" });
      assert.deepInclude(clearedAll, { reason: null });
      assert.deepInclude(clean, { outcome: "clean", reportPath: "/r/t.md" });
      assert.deepEqual(yield* store.history(ThreadId.make("no-events")), []);
    }),
  );
});
