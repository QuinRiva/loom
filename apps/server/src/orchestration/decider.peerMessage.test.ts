import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { NOTIFY_PAIR_HOURLY_CAP } from "@t3tools/shared/notify";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T12:00:00.000Z";
const SENDER = ThreadId.make("sender-1");
const TARGET_A = ThreadId.make("target-a");
const TARGET_B = ThreadId.make("target-b");

let seq = 0;
const seedEvent = (
  overrides: Pick<OrchestrationEvent, "aggregateKind" | "aggregateId" | "type" | "payload">,
): OrchestrationEvent =>
  ({
    sequence: ++seq,
    eventId: EventId.make(`evt-${seq}`),
    occurredAt: now,
    commandId: CommandId.make("server:seed"),
    causationEventId: null,
    correlationId: CommandId.make("server:seed"),
    metadata: {},
    ...overrides,
  }) as OrchestrationEvent;

const seedSender = Effect.gen(function* () {
  seq = 0;
  return yield* projectEvent(
    createEmptyReadModel(now),
    seedEvent({
      aggregateKind: "thread",
      aggregateId: SENDER,
      type: "thread.created",
      payload: {
        threadId: SENDER,
        projectId: ProjectId.make("project-1"),
        title: "Sender thread",
        role: "coder",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
});

// Fold N recorded peer-messages (sender -> target, at `at`) onto the read model
// so `notifySendLog` reflects them — the exact ledger the decider counts.
const withRecorded = (
  readModel: OrchestrationReadModel,
  target: ThreadId,
  count: number,
  at: string,
) =>
  Effect.gen(function* () {
    let model = readModel;
    for (let index = 0; index < count; index += 1) {
      model = yield* projectEvent(
        model,
        seedEvent({
          aggregateKind: "thread",
          aggregateId: SENDER,
          type: "thread.peer-message-recorded",
          payload: {
            senderThreadId: SENDER,
            recordId: `rec-${target}-${at}-${index}`,
            targetThreadId: target,
            targetTitle: "Target",
            message: "hi",
            framedMessage: "framed hi",
            createdAt: at,
          },
        }),
      );
    }
    return model;
  });

const decide = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

const recordCommand = (target: ThreadId, at: string): OrchestrationCommand => ({
  type: "thread.peer-message.record",
  commandId: CommandId.make(`server:notify-record:${target}-${at}`),
  threadId: SENDER,
  recordId: `${target}-${at}`,
  targetThreadId: target,
  targetTitle: "Target",
  message: "hi there",
  framedMessage: "framed hi there",
  createdAt: at,
});

it.layer(NodeServices.layer)("decider notify_thread peer messages", (it) => {
  it.effect("derives thread.peer-message-recorded carrying raw + framed text", () =>
    Effect.gen(function* () {
      const readModel = yield* seedSender;
      const events = yield* decide(recordCommand(TARGET_A, now), readModel);
      expect(events.map((event) => event.type)).toEqual(["thread.peer-message-recorded"]);
      expect(events[0]?.payload).toMatchObject({
        senderThreadId: SENDER,
        targetThreadId: TARGET_A,
        message: "hi there",
        framedMessage: "framed hi there",
      });
    }),
  );

  it.effect(
    `admits the ${NOTIFY_PAIR_HOURLY_CAP}th send and rejects the next for the same pair`,
    () =>
      Effect.gen(function* () {
        const base = yield* seedSender;
        // Cap - 1 already recorded in-window: the next is the cap-th (admitted).
        const atCapMinusOne = yield* withRecorded(base, TARGET_A, NOTIFY_PAIR_HOURLY_CAP - 1, now);
        const admitted = yield* decide(recordCommand(TARGET_A, now), atCapMinusOne);
        expect(admitted.map((event) => event.type)).toEqual(["thread.peer-message-recorded"]);

        // Cap already reached in-window: the next is rejected.
        const atCap = yield* withRecorded(base, TARGET_A, NOTIFY_PAIR_HOURLY_CAP, now);
        const rejected = yield* decide(recordCommand(TARGET_A, now), atCap).pipe(Effect.flip);
        expect(rejected._tag).toBe("OrchestrationCommandInvariantError");
      }),
  );

  it.effect("the cap is per ordered pair: a full target A does not block target B", () =>
    Effect.gen(function* () {
      const base = yield* seedSender;
      const atCap = yield* withRecorded(base, TARGET_A, NOTIFY_PAIR_HOURLY_CAP, now);
      const events = yield* decide(recordCommand(TARGET_B, now), atCap);
      expect(events.map((event) => event.type)).toEqual(["thread.peer-message-recorded"]);
    }),
  );

  it.effect("out-of-window entries do not count toward the cap", () =>
    Effect.gen(function* () {
      const base = yield* seedSender;
      // `now` is noon; this is 2h earlier, well outside the one-hour window.
      const stale = "2026-01-01T10:00:00.000Z";
      const withStale = yield* withRecorded(base, TARGET_A, NOTIFY_PAIR_HOURLY_CAP + 5, stale);
      const events = yield* decide(recordCommand(TARGET_A, now), withStale);
      expect(events.map((event) => event.type)).toEqual(["thread.peer-message-recorded"]);
    }),
  );

  it.effect("mark-delivered / expire are rejected on a non-server command id", () =>
    Effect.gen(function* () {
      const readModel = yield* seedSender;
      const error = yield* decide(
        {
          type: "thread.peer-message.mark-delivered",
          commandId: CommandId.make("client:notify-mark:x"),
          threadId: SENDER,
          recordId: "x",
          createdAt: now,
        },
        readModel,
      ).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("mark-delivered / expire derive their lifecycle events under a server id", () =>
    Effect.gen(function* () {
      const readModel = yield* seedSender;
      const delivered = yield* decide(
        {
          type: "thread.peer-message.mark-delivered",
          commandId: CommandId.make("server:notify-mark:x"),
          threadId: SENDER,
          recordId: "x",
          createdAt: now,
        },
        readModel,
      );
      expect(delivered.map((event) => event.type)).toEqual(["thread.peer-message-delivered"]);

      const expired = yield* decide(
        {
          type: "thread.peer-message.expire",
          commandId: CommandId.make("server:notify-expire:x"),
          threadId: SENDER,
          recordId: "x",
          createdAt: now,
        },
        readModel,
      );
      expect(expired.map((event) => event.type)).toEqual(["thread.peer-message-expired"]);
    }),
  );
});
