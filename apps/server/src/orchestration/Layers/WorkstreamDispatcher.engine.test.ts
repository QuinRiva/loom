import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { WorkstreamDispatcherLive, wakeCommandId } from "./WorkstreamDispatcher.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { WorkstreamDispatcher } from "../Services/WorkstreamDispatcher.ts";

const now = "2026-06-24T00:00:00.000Z";
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

// Full engine round-trip harness for the dispatcher: a real OrchestrationEngine
// (in-memory sqlite, real projector + projection pipeline + receipt store) with
// the live WorkstreamDispatcher reactor wired on top. Lets us prove the
// deferred-until-idle wake path end-to-end (join → idle-gate → deterministic
// idempotent delivery) rather than only the pure decision seams.
//
// Layers are memoized by reference within a single build, so the receipt repo
// and snapshot query the engine writes through are the SAME instances the
// dispatcher and the test assertions read — one sqlite store throughout.
const base = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
  OrchestrationCommandReceiptRepositoryLive,
).pipe(
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(RepositoryIdentityResolverLive),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-dispatcher-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const testLayer = WorkstreamDispatcherLive.pipe(Layer.provideMerge(base));

const idleSession = (parentId: ThreadId) => ({
  threadId: parentId,
  status: "ready" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: now,
});

it.live(
  "WorkstreamDispatcher defers a wake at a busy parent, then delivers exactly one once idle and never duplicates",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-1");
      const parentId = ThreadId.make("parent-1");
      const childId = ThreadId.make("child-1");
      const generation = "gen-1";
      const wakeId = CommandId.make(wakeCommandId(parentId, generation));

      const engine = yield* OrchestrationEngineService;
      const receipts = yield* OrchestrationCommandReceiptRepository;
      const dispatcher = yield* WorkstreamDispatcher;

      const wakeDelivered = receipts
        .getByCommandId({ commandId: wakeId })
        .pipe(Effect.map(Option.isSome));
      const parentTurnStartCount = engine.readEvents(0).pipe(
        Stream.runCollect,
        Effect.map(
          (chunk) =>
            Array.from(chunk).filter(
              (event) =>
                event.type === "thread.turn-start-requested" && event.payload.threadId === parentId,
            ).length,
        ),
      );

      // --- Durable setup (dispatcher not yet started) -----------------------
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId,
        title: "Project",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: modelSelection,
        createdAt: now,
      });
      // Parent is a root thread; the join only ever scopes its children.
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-parent-create"),
        threadId: parentId,
        projectId,
        title: "Parent",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-child-create"),
        threadId: childId,
        projectId,
        parentThreadId: parentId,
        role: "researcher",
        purpose: "do the thing",
        spawnGeneration: generation,
        title: "Child",
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: now,
      });
      // Give the child a started turn so it reads as "started" (a real done
      // child has run); this keeps the promote-ready pass from re-injecting.
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make("cmd-child-turn-start"),
        threadId: childId,
        message: {
          messageId: MessageId.make("msg-child-1"),
          role: "user",
          text: "go",
          attachments: [],
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        createdAt: now,
      });
      // Child reaches a terminal status → the generation is joined.
      yield* engine.dispatch({
        type: "thread.status.set",
        commandId: CommandId.make("cmd-child-done"),
        threadId: childId,
        status: "done",
        createdAt: now,
      });
      // Parent is BUSY (session running) → not idle.
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-parent-busy"),
        threadId: parentId,
        session: {
          ...idleSession(parentId),
          status: "running",
          activeTurnId: TurnId.make("turn-parent-1"),
        },
        createdAt: now,
      });

      // --- Start the dispatcher: its startup reconciliation pass runs now ----
      yield* dispatcher.start();
      yield* dispatcher.drain;

      // (1) Busy parent: the joined generation is recognised but the wake is
      //     deferred — no receipt is written, so the generation is NOT handled.
      expect(yield* wakeDelivered).toBe(false);
      expect(yield* parentTurnStartCount).toBe(0);

      // Let the live event subscription settle before driving the idle drain.
      yield* Effect.sleep(Duration.millis(50));

      // --- Parent goes idle → the session-set drains the deferred wake -------
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-parent-idle"),
        threadId: parentId,
        session: idleSession(parentId),
        createdAt: now,
      });

      // (2) Exactly one deterministic wake receipt + exactly one injected turn.
      yield* wakeDelivered.pipe(
        Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail("pending" as const))),
        Effect.retry(Schedule.spaced(Duration.millis(10))),
        Effect.timeout(Duration.seconds(2)),
      );
      yield* dispatcher.drain;
      expect(yield* wakeDelivered).toBe(true);
      expect(yield* parentTurnStartCount).toBe(1);

      // (3) Repeated drains / re-evaluations produce no duplicate wake. Re-emit
      //     an idle session-set to force more passes; the deterministic id +
      //     handled marker keep delivery at exactly once.
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make("cmd-parent-idle-again"),
        threadId: parentId,
        session: idleSession(parentId),
        createdAt: now,
      });
      yield* Effect.sleep(Duration.millis(50));
      yield* dispatcher.drain;
      expect(yield* parentTurnStartCount).toBe(1);
    }).pipe(Effect.provide(testLayer)),
);
