/**
 * The reroute sweep on the real orchestrator (plan track 3c, Tests): the
 * cross-vendor reroute, the move-back, the no-reset resume, what it leaves to
 * upstream's limit recovery (disjoint by condition), and seam 13b — upstream's
 * own limit-resume on a cancelled Loom thread is an accepted no-op.
 *
 * The testkit's single provider instance (`codex`) stands in for a pi instance:
 * the fake `ProviderRegistry` reports it as driver `pi` with a two-vendor
 * catalogue, and the thread's selection carries pi slugs.
 */
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type IsoDateTime,
  type ModelSelection,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { limitRecoveryCommand } from "../../orchestration-v2/UsageLimitRecoveryWorker.ts";
import {
  ProviderHealthRegistry,
  ProviderHealthRegistryLive,
} from "../../provider/Services/ProviderHealthRegistry.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  dispatch,
  LoomOrchestratorTestLayer,
  seededRunIds,
  seedRunningRun,
  seedThread,
  spawnChild,
} from "../testkit/loomOrchestratorLayer.ts";
import { LoomPiAdapterHooks } from "../../provider/Drivers/Pi/loomAdapterHooks.loom.ts";
import { LoomProviderHealthLive } from "../serverLayers.ts";
import { runRerouteSweepPass } from "./RerouteSweep.ts";
import { insertReroute, LOOM_THREAD_REROUTE_DDL, listReroutes } from "./rerouteRecord.ts";

const INSTANCE = ProviderInstanceId.make("codex");
const INTENDED: ModelSelection = { instanceId: INSTANCE, model: "openai-codex/gpt-6.1-sol" };
const FALLBACK: ModelSelection = { instanceId: INSTANCE, model: "cliproxy/claude-opus-5-5" };

const FakePiProviders = Layer.mock(ProviderRegistry)({
  getProviders: Effect.succeed([
    {
      instanceId: INSTANCE,
      driver: "pi",
      models: [{ slug: INTENDED.model }, { slug: FALLBACK.model }],
    } as unknown as ServerProvider,
  ]),
});

const pass = runRerouteSweepPass().pipe(
  Effect.provide(
    ServerSettings.layerTest({ providerFailover: { fallbackTarget: FALLBACK.model } }),
  ),
);

/** Each case gets its own health registry; the reroute table is 3c-3's migration 1050. */
const withHealth = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    yield* (yield* SqlClient.SqlClient).unsafe(LOOM_THREAD_REROUTE_DDL);
    return yield* body;
  }).pipe(Effect.provide(ProviderHealthRegistryLive));

const inMs = (ms: number) =>
  Effect.map(DateTime.now, (now) => DateTime.formatIso(DateTime.add(now, { milliseconds: ms })));

/** Marks a model exhausted for an hour (account and scope keyed as the classifier keys them). */
const exhaust = (selection: ModelSelection) =>
  Effect.gen(function* () {
    const scoped = selection.model.startsWith("openai-codex/");
    yield* (yield* ProviderHealthRegistry).markExhausted({
      accountKey: "codex",
      modelScope: scoped ? selection.model.slice("openai-codex/".length) : selection.model,
      until: yield* inMs(3_600_000),
      source: "error",
    });
  });

/** A thread on the intended model whose only run failed on a usage limit. */
const seedLimited = Effect.fn("test.seedLimited")(function* (
  threadId: ThreadId,
  resetAt: IsoDateTime | null,
  loomParent?: ThreadId,
) {
  if (loomParent === undefined) yield* seedThread({ threadId });
  else yield* spawnChild({ parentThreadId: loomParent, threadId });
  yield* dispatch({
    type: "thread.model-selection.set",
    commandId: CommandId.make(`test:select:${threadId}`),
    threadId,
    modelSelection: INTENDED,
  });
  const ids = yield* seedRunningRun({ threadId, live: true });
  const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId);
  const run = projection.runs.find((entry) => entry.id === ids.runId)!;
  const now = yield* DateTime.now;
  yield* (yield* EventSink.EventSinkV2).write({
    events: [
      {
        id: EventId.make(`test:limit-error:${threadId}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`test:limit-error:${threadId}`),
          type: "error",
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "failed",
          title: "Usage limit reached",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          failure: {
            class: "usage_limit",
            message: "You have hit your ChatGPT usage limit.",
            code: null,
            retryable: null,
            resetAt,
          },
        },
      },
      {
        id: EventId.make(`test:limit-failed:${threadId}`),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "failed", completedAt: now },
      },
    ],
  });
  return ids;
});

const shellOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    return (yield* (yield* Orchestrator.OrchestratorV2).getThreadShell(threadId))!;
  });
/** The messages the sweep wrote (every Loom server id starts `server:loom:`). */
const sweepMessages = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projection = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId);
    return projection.messages.filter((message) => message.id.startsWith("server:loom:"));
  });

it.layer(Layer.merge(LoomOrchestratorTestLayer, FakePiProviders))("Loom reroute sweep", (it) => {
  it.effect("reroutes a limited thread onto a healthy fallback of another vendor, once", () =>
    withHealth(
      Effect.gen(function* () {
        const threadId = ThreadId.make("reroute-codex");
        yield* exhaust(INTENDED);
        const { runId } = yield* seedLimited(threadId, yield* inMs(3_600_000));
        const sessions = () =>
          Effect.gen(function* () {
            const { providerSessions } =
              yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(threadId, [
                "providerSessions",
              ]);
            return providerSessions.map((session) => session.id);
          });
        const [live] = yield* sessions();
        yield* pass;
        yield* pass;

        assert.deepEqual((yield* shellOf(threadId)).modelSelection, FALLBACK);
        // The live pi session is detached, so the resume opens a fresh process.
        const detached = yield* (yield* CommandReceiptStoreV2).getByCommandId(
          CommandId.make(`server:loom:reroute:${threadId}:${runId}:detach:${live}`),
        );
        assert.equal(Option.getOrThrow(detached).status, "accepted");
        assert.notInclude(yield* sessions(), live);

        const resumes = yield* sweepMessages(threadId);
        assert.lengthOf(resumes, 1);
        const [resume] = resumes;
        assert.equal(resume!.id, `server:loom:reroute:${threadId}:${runId}`);
        assert.equal(resume!.loom?.origin, "control_notice");
        assert.notEqual(resume!.loom?.humanAuthored, true);
        assert.equal(resume!.createdBy, "agent");
        assert.include(resume!.text, FALLBACK.model);

        const row = (yield* listReroutes).find((entry) => entry.threadId === threadId);
        assert.deepEqual(row?.intendedSelection, INTENDED);
        assert.deepEqual(row?.reroutedSelection, FALLBACK);
      }),
    ),
  );

  it.effect("moves an idle rerouted thread back once its intended account is healthy", () =>
    withHealth(
      Effect.gen(function* () {
        const threadId = ThreadId.make("reroute-back");
        yield* seedThread({ threadId });
        yield* dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`test:select:${threadId}`),
          threadId,
          modelSelection: FALLBACK,
        });
        yield* insertReroute({
          threadId,
          intendedSelection: INTENDED,
          reroutedSelection: FALLBACK,
          reroutedAt: yield* inMs(-60_000),
          windowLabel: "weekly",
          resetAt: yield* inMs(-1),
        });
        // Still out: nothing moves.
        yield* exhaust(INTENDED);
        yield* pass;
        assert.deepEqual((yield* shellOf(threadId)).modelSelection, FALLBACK);

        yield* TestClock.adjust("61 minutes");
        yield* pass;
        assert.deepEqual((yield* shellOf(threadId)).modelSelection, INTENDED);
        assert.isFalse((yield* listReroutes).some((entry) => entry.threadId === threadId));
        assert.deepEqual(yield* sweepMessages(threadId), []); // idle: nothing to resume
      }),
    ),
  );

  it.effect("leaves a thread holding awaiting_acceptance alone", () =>
    withHealth(
      Effect.gen(function* () {
        const parent = ThreadId.make("reroute-parent");
        const threadId = ThreadId.make("reroute-accept");
        yield* seedThread({ threadId: parent });
        yield* exhaust(INTENDED);
        yield* seedLimited(threadId, yield* inMs(3_600_000), parent);
        yield* dispatch({
          type: "thread.attention.raise",
          commandId: CommandId.make("test:raise-accept"),
          threadId,
          createdAt: "1970-01-01T00:00:00.000Z",
          reason: "awaiting_acceptance",
        });
        yield* pass;
        assert.deepEqual((yield* shellOf(threadId)).modelSelection, INTENDED);
        assert.deepEqual(yield* sweepMessages(threadId), []);
        assert.isFalse((yield* listReroutes).some((entry) => entry.threadId === threadId));
      }),
    ),
  );

  it.effect("leaves a thread upstream will resume to upstream, and resumes one it cannot", () =>
    withHealth(
      Effect.gen(function* () {
        // Both vendors out: no fallback.
        yield* exhaust(INTENDED);
        yield* exhaust(FALLBACK);
        const known = ThreadId.make("reroute-known-reset");
        yield* seedLimited(known, yield* inMs(3_600_000));
        const unknown = ThreadId.make("reroute-no-reset");
        const { runId } = yield* seedLimited(unknown, null);
        yield* pass;
        for (const threadId of [known, unknown]) {
          assert.deepEqual((yield* shellOf(threadId)).modelSelection, INTENDED);
          assert.deepEqual(yield* sweepMessages(threadId), []);
        }
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        // Disjoint: upstream's own predicate arms exactly the thread the sweep left alone.
        assert.equal(
          limitRecoveryCommand(yield* shellOf(known), true, nowMs)?.type,
          "thread.metadata.update",
        );
        assert.isNull(limitRecoveryCommand(yield* shellOf(unknown), true, nowMs));

        // The registry clears: Loom resumes the no-reset failure; upstream's still waits.
        yield* TestClock.adjust("61 minutes");
        yield* exhaust(FALLBACK);
        yield* pass;
        yield* pass;
        const [resume] = yield* sweepMessages(unknown);
        assert.equal(resume?.id, `server:loom:limit-resume:${unknown}:${runId}`);
        assert.equal(resume?.loom?.origin, "control_notice");
        assert.lengthOf(yield* sweepMessages(unknown), 1);
        assert.deepEqual(yield* sweepMessages(known), []);
      }),
    ),
  );

  it.effect(
    "seam 13b: upstream's limit-resume on a cancelled Loom thread is an accepted no-op",
    () =>
      withHealth(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const parent = ThreadId.make("veto-parent");
          const threadId = ThreadId.make("veto-cancelled");
          yield* seedThread({ threadId: parent });
          yield* seedLimited(threadId, yield* inMs(60_000), parent);
          const arm = limitRecoveryCommand(
            yield* shellOf(threadId),
            true,
            DateTime.toEpochMillis(yield* DateTime.now),
          );
          yield* orchestrator.dispatch(arm!);
          yield* dispatch({
            type: "thread.outcome.set",
            commandId: CommandId.make("test:cancel-veto"),
            threadId,
            createdAt: "1970-01-01T00:00:00.000Z",
            outcome: "cancelled",
          });
          yield* TestClock.adjust("2 minutes");
          const limitResume = limitRecoveryCommand(
            yield* shellOf(threadId),
            true,
            DateTime.toEpochMillis(yield* DateTime.now),
          );
          assert.equal(limitResume?.type, "message.dispatch");
          const runsBefore = (yield* orchestrator.getThreadProjection(threadId)).runs.length;
          yield* orchestrator.dispatch(limitResume!);
          const receipt = yield* (yield* CommandReceiptStoreV2).getByCommandId(
            limitResume!.commandId,
          );
          assert.equal(Option.getOrThrow(receipt).status, "accepted");
          assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, runsBefore);
          assert.equal(runsBefore, 1);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.id,
            seededRunIds(threadId).runId,
          );
        }),
      ),
  );
});

// What clause 3 waits on: the adapter's classifier marks a usage limit on the model.
it.effect("the live classifier marks a no-reset usage limit for the registry's default TTL", () =>
  Effect.gen(function* () {
    const hooks = yield* LoomPiAdapterHooks;
    const classified = yield* hooks.classifier("You have hit your usage limit.", INTENDED);
    assert.isTrue(classified.usageLimit);
    assert.isUndefined(classified.resetAt);
    const [mark] = yield* (yield* ProviderHealthRegistry).snapshot;
    assert.deepInclude(mark, { accountKey: "codex", modelScope: "gpt-6.1-sol", source: "error" });
    assert.equal(mark?.until, "1970-01-01T00:30:00.000Z");
  }).pipe(Effect.provide(LoomProviderHealthLive.pipe(Layer.provide(ServerSettings.layerTest())))),
);
