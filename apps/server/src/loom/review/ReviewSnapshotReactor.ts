/**
 * A human-authored message's first `message.updated` (or its run's release, for a worktree still
 * preparing) snapshots the thread's sources; archive and delete drop them, an hourly sweep drops
 * quiet threads'. No outbox kind and messages older than {@link FRESH_WINDOW} are ignored: a late
 * capture would record agent progress as the baseline. Relayed Slack replies count as human.
 */
import type { OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ReviewSnapshotService from "./ReviewSnapshotService.ts";

const FRESH_WINDOW = Duration.seconds(10);

const isFresh = (at: DateTime.Utc) =>
  Effect.map(
    Clock.currentTimeMillis,
    (now) => now - DateTime.toEpochMillis(at) <= Duration.toMillis(FRESH_WINDOW),
  );

/** The events this reactor acts on, checked before anything is forked. */
const isReviewEvent = (event: OrchestrationV2DomainEvent) =>
  event.type === "thread.archived" ||
  event.type === "thread.deleted" ||
  (event.type === "message.updated" &&
    event.payload.role === "user" &&
    event.payload.loom?.humanAuthored === true) ||
  (event.type === "run.updated" &&
    event.payload.status === "starting" &&
    event.payload.workspacePreparation !== undefined);

/** One committed event's effect on review snapshots. */
export const reactToReviewEvent = Effect.fn("loom.review.react")(function* (
  event: OrchestrationV2DomainEvent,
) {
  if (!isReviewEvent(event)) return;
  const snapshots = yield* ReviewSnapshotService.ReviewSnapshotService;
  if (event.type === "thread.archived" || event.type === "thread.deleted")
    return yield* snapshots.deleteForThread(event.threadId);
  if (event.type === "message.updated") {
    if (!(yield* isFresh(event.payload.createdAt))) return;
    return yield* snapshots.captureForMessage({
      threadId: event.threadId,
      messageId: event.payload.id,
      messageCreatedAt: event.payload.createdAt,
    });
  }
  // A launched thread's first message waits for its workspace (a new worktree is created after
  // the message is accepted); its release, before the agent starts, is when that tree exists.
  if (event.type !== "run.updated" || !(yield* isFresh(event.occurredAt))) return;
  const { messages } = yield* (yield* Orchestrator.OrchestratorV2).getThreadRecords(
    event.threadId,
    ["messages"],
    { messageIds: [event.payload.userMessageId] },
  );
  const message = messages.find((candidate) => candidate.id === event.payload.userMessageId);
  if (message?.role !== "user" || message.loom?.humanAuthored !== true) return;
  yield* snapshots.captureForMessage({
    threadId: event.threadId,
    messageId: message.id,
    messageCreatedAt: message.createdAt,
  });
});

export const ReviewSnapshotReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const snapshots = yield* ReviewSnapshotService.ReviewSnapshotService;
    const scope = yield* Effect.scope;
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        // Forked so a capture never holds up the event stream; the service serialises per worktree.
        isReviewEvent(event)
          ? reactToReviewEvent(event).pipe(
              Effect.provideService(ReviewSnapshotService.ReviewSnapshotService, snapshots),
              Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
              Effect.catch((error) => Effect.logWarning("loom.review.react-failed", { error })),
              Effect.forkIn(scope),
              Effect.asVoid,
            )
          : Effect.void,
      ),
    );
    yield* forkParked(
      snapshots.sweepQuiet.pipe(
        Effect.catch((error) => Effect.logWarning("loom.review.sweep-failed", { error })),
        Effect.repeat(Schedule.spaced("1 hour")),
        Effect.asVoid,
      ),
    );
  }),
).pipe(Layer.provideMerge(ReviewSnapshotService.layer));
