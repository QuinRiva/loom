/**
 * t-lock (plan §7) and the pure planner's episode rules (§4, DL-199, DL-213).
 * The real orchestrator, sink, SQL projection and receipts; upstream's keyed
 * lock is wrapped by a recorder (below) that logs any lock taken while the same
 * fiber already holds another key of the same lock.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  IsoDateTime,
  type LoomThreadWorkstream,
  MessageId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { vi } from "vite-plus/test";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { emptyWorkstream, LoomStoreV2 } from "../projection/LoomStore.ts";
import {
  dispatch,
  LoomOrchestratorTestLayer,
  seededRunIds,
  seedRunningRun,
  seedThread,
  spawnChild,
} from "../testkit/loomOrchestratorLayer.ts";
import { makeGateLegComposer } from "./dispatcher/gateLegs.ts";
import { dispatchServerCommand, planReDrive, runReDrivePass } from "./redrive.ts";

// The recording wrapper around upstream's KeyedLock (ThreadCommandExecutor's
// implementation): a fiber-local list of held (lock, key) pairs.
const lockLog = vi.hoisted(() => ({
  taken: 0,
  nested: [] as Array<{ readonly held: ReadonlyArray<unknown>; readonly key: unknown }>,
}));
vi.mock("@t3tools/shared/KeyedLock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/shared/KeyedLock")>();
  const Context = await import("effect/Context");
  const Eff = await import("effect/Effect");
  type Held = ReadonlyArray<{ readonly lock: number; readonly key: unknown }>;
  const HeldLocks = Context.Reference<Held>("test/loom/HeldLocks", { defaultValue: () => [] });
  let locks = 0;
  return {
    ...actual,
    make: <Key>() =>
      Eff.map(actual.make<Key>(), (inner): KeyedLock.KeyedLock<Key> => {
        const lock = ++locks;
        return {
          ...inner,
          withLock: (key, effect) =>
            Eff.gen(function* () {
              const held = yield* HeldLocks;
              const same = held.filter((entry) => entry.lock === lock);
              if (same.length > 0) lockLog.nested.push({ held: same.map((h) => h.key), key });
              lockLog.taken += 1;
              return yield* inner.withLock(
                key,
                Eff.provideService(effect, HeldLocks, [...held, { lock, key }]),
              );
            }),
        };
      }),
  };
});

const createdAt = "2026-01-01T00:00:00.000Z";
const A = ThreadId.make("lock-a");
const B = ThreadId.make("lock-b");
const C = ThreadId.make("lock-c");

const rejectedReceipts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly commandId: string; readonly error: string | null }>`
    SELECT command_id AS "commandId", error FROM orchestration_command_receipts
    WHERE status = 'rejected'`;
});
const interruptEffectThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly threadId: string }>`
    SELECT thread_id AS "threadId" FROM orchestration_v2_effect_outbox
    WHERE effect_type = 'provider-turn.interrupt' ORDER BY thread_id`;
  return rows.map((row) => row.threadId);
});

describe("the lock recorder", () => {
  it.effect("records a lock taken while the same lock holds another key", () =>
    Effect.gen(function* () {
      const lock = yield* KeyedLock.make<string>();
      yield* lock.withLock("x", lock.withLock("y", Effect.void));
      assert.deepEqual(lockLog.nested, [{ held: ["x"], key: "y" }]);
      lockLog.nested.length = 0;
    }),
  );
});

it.layer(LoomOrchestratorTestLayer)("Loom re-drive", (it) => {
  it.effect(
    "t-lock: a cancel cascade and a delete cascade under concurrency, one lock at a time",
    () =>
      Effect.gen(function* () {
        const store = yield* LoomStoreV2;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const pass = runReDrivePass(makeGateLegComposer(new Map()), dispatchServerCommand);
        yield* seedThread({ threadId: A });
        yield* spawnChild({ parentThreadId: A, threadId: B });
        yield* spawnChild({ parentThreadId: B, threadId: C });
        yield* seedRunningRun({ threadId: B, live: true });
        yield* seedRunningRun({ threadId: C, live: true });
        yield* dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("lock-c-queued"),
          threadId: C,
          messageId: MessageId.make("message:lock-c-queued"),
          text: "Queued behind C's turn",
          attachments: [],
          createdBy: "agent",
          creationSource: "server",
          dispatchMode: { type: "queue_after_active" },
        });
        lockLog.taken = 0;

        yield* Effect.all(
          [
            dispatch({
              type: "thread.outcome.set",
              commandId: CommandId.make("lock-cancel-a"),
              threadId: A,
              createdAt,
              outcome: "cancelled",
            }),
            dispatch({
              type: "thread.attention.raise",
              commandId: CommandId.make("lock-raise-c"),
              threadId: C,
              createdAt,
              reason: "needs_guidance",
            }),
            dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("lock-human-b"),
              threadId: B,
              messageId: MessageId.make("message:lock-human-b"),
              text: "A human follow-up",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              dispatchMode: { type: "queue_after_active" },
            }),
          ],
          { concurrency: "unbounded" },
        );

        const first = yield* pass;
        assert.lengthOf(first.accepted, 2);
        const second = yield* pass;
        assert.deepEqual(second, { accepted: [], deferred: [], dead: [] });

        for (const threadId of [B, C]) {
          const row = (yield* store.getWorkstream(threadId))!;
          assert.equal(row.outcome, "cancelled");
          assert.deepEqual(row.attention, []);
          const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
          // The live turn is being interrupted; every queued run (B's human message, C's wake) is cancelled.
          assert.equal(
            runs.find((run) => run.id === seededRunIds(threadId).runId)?.status,
            "running",
          );
          assert.deepEqual(
            runs.filter((run) => run.id !== seededRunIds(threadId).runId).map((run) => run.status),
            ["cancelled"],
          );
        }
        assert.deepEqual(yield* interruptEffectThreads, [B, C]);
        assert.deepEqual(yield* rejectedReceipts, []);

        yield* dispatch({
          type: "thread.delete",
          commandId: CommandId.make("lock-delete-a"),
          threadId: A,
        });
        const third = yield* pass;
        assert.lengthOf(third.accepted, 2);
        assert.isNotNull((yield* store.getWorkstream(B))?.deletedAt);
        assert.isNotNull((yield* store.getWorkstream(C))?.deletedAt);
        assert.deepEqual(yield* pass, { accepted: [], deferred: [], dead: [] });
        assert.deepEqual(yield* rejectedReceipts, []);

        assert.isAbove(lockLog.taken, 0);
        assert.deepEqual(lockLog.nested, []);
      }),
  );
});

describe("planReDrive episode rules", () => {
  const at = (minute: number) =>
    IsoDateTime.make(`2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`);
  const row = (
    id: string,
    parent: string | null,
    patch: Partial<LoomThreadWorkstream> = {},
  ): LoomThreadWorkstream => ({
    ...emptyWorkstream({
      threadId: ThreadId.make(id),
      projectId: ProjectId.make("project:plan"),
      parentThreadId: parent === null ? null : ThreadId.make(parent),
      rootThreadId: ThreadId.make("root"),
      at: at(0),
    }),
    ...patch,
  });
  const ids = (rows: ReadonlyArray<LoomThreadWorkstream>) =>
    planReDrive({ rows, now: at(59), gateLeg: makeGateLegComposer(new Map()) }).map(
      (command) => command.commandId,
    );

  it("an episode without a stamp (an imported row) re-drives nothing", () => {
    assert.deepEqual(
      ids([
        row("root", null, { outcome: "cancelled", outcomeAt: at(5), outcomeEventId: null }),
        row("child", "root"),
      ]),
      [],
    );
  });

  it("a cancel reaches only descendants that existed at the episode", () => {
    assert.deepEqual(
      ids([
        row("root", null, {
          outcome: "cancelled",
          outcomeAt: at(5),
          outcomeEventId: EventId.make("event:cancel"),
        }),
        row("old", "root", { createdAt: at(1) }),
        row("new", "root", { createdAt: at(6) }),
      ]),
      [CommandId.make("server:loom:cascade-cancel:event:cancel:old")],
    );
  });

  it("DL-199: an unarchive re-opens only children archived at or before it", () => {
    assert.deepEqual(
      ids([
        row("root", null, {
          unarchivedAt: at(10),
          unarchivedEventId: EventId.make("event:unarchive"),
        }),
        row("cascaded", "root", { archivedAt: at(5) }),
        row("rearchived", "root", { archivedAt: at(20) }),
      ]),
      [CommandId.make("server:loom:cascade-unarchive:event:unarchive:cascaded")],
    );
  });
});
