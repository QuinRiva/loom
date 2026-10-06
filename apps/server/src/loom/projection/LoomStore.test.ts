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

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as LoomStore from "./LoomStore.ts";

const TestLayer = LoomStore.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));
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
});
