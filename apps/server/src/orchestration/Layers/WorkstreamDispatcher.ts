import {
  CommandId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  WorkstreamDispatcher,
  type WorkstreamDispatcherShape,
} from "../Services/WorkstreamDispatcher.ts";
import { workstreamChildPrompt } from "../workstreamChildPrompt.ts";

/**
 * Pure "promote ready" selection: every un-started sub-thread whose `blockedBy`
 * dependencies are all satisfied.
 *
 * - Sub-thread: has a `parentThreadId` (root threads start via the normal flow).
 * - Un-started: no provider session **and** no started turn (no user message).
 * - Deps satisfied: every known dependency is `done`. A dependency is satisfied
 *   iff the dependency thread's status is `done` (`review` does not release),
 *   mirroring the client `getEffectiveColumn` rule. Self-refs and dangling ids
 *   (unknown threads) never gate.
 *
 * Returns only threads that carry both `role` and `purpose`, which are required
 * to build the deferred kick-off prompt (spawn always sets them).
 */
export const selectThreadsToDispatch = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
): ReadonlyArray<OrchestrationThreadShell> => {
  const statusById = new Map(threads.map((thread) => [thread.id, thread.status] as const));
  return threads.filter(
    (thread) =>
      thread.parentThreadId !== null &&
      thread.role !== null &&
      thread.purpose !== null &&
      thread.session === null &&
      thread.latestUserMessageAt === null &&
      thread.blockedBy.every((depId) => {
        if (depId === thread.id) return true;
        const depStatus = statusById.get(depId);
        return depStatus === undefined || depStatus === "done";
      }),
  );
};

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:workstream-dispatcher:${tag}:${uuid}`)),
    );

  const promoteThread = Effect.fn("promoteThread")(function* (thread: OrchestrationThreadShell) {
    const { role, purpose } = thread;
    // Guaranteed non-null by selectThreadsToDispatch; this also narrows types.
    if (role === null || purpose === null) return;
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("start-turn"),
      threadId: thread.id,
      message: {
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        role: "user",
        text: workstreamChildPrompt({ role, purpose }),
        attachments: [],
      },
      titleSeed: thread.title,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: now,
    } satisfies OrchestrationCommand);

    // Land `running` in the same serialized pass so the next promote pass sees a
    // started thread and never double-starts it.
    yield* orchestrationEngine.dispatch({
      type: "thread.status.set",
      commandId: yield* serverCommandId("set-running"),
      threadId: thread.id,
      status: "running",
      createdAt: now,
    } satisfies OrchestrationCommand);
  });

  const promoteReadyThreads = Effect.fn("promoteReadyThreads")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    for (const thread of selectThreadsToDispatch(snapshot.threads)) {
      yield* promoteThread(thread);
    }
  });

  const promoteReadyThreadsSafely = promoteReadyThreads().pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logWarning("workstream dispatcher failed to promote ready threads", {
        cause: Cause.pretty(cause),
      });
    }),
  );

  const worker = yield* makeDrainableWorker(
    (_event: OrchestrationEvent) => promoteReadyThreadsSafely,
  );

  const start: WorkstreamDispatcherShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.created" ||
        event.type === "thread.status-set" ||
        event.type === "thread.dependencies-set"
          ? worker.enqueue(event)
          : Effect.void,
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies WorkstreamDispatcherShape;
});

export const WorkstreamDispatcherLive = Layer.effect(WorkstreamDispatcher, make);
