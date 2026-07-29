/**
 * Incident 2's forensic regression: a plain message sent while a question is open.
 *
 * Thread `13653de6` had a question open and its turn blocked inside the tool
 * call. The human replied twice on Slack; both replies were queued as steering
 * against a turn that would never resume, then wiped at the next restart. The
 * fix is supersede: the FIRST plain message resolves the question `superseded`
 * and is delivered AS the tool result, bypassing the steer queue entirely; the
 * second is an ordinary turn-start, because there is no longer a question to
 * settle.
 */
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-07-28T02:30:31.889Z";
const THREAD = ThreadId.make("thread-supersede");
const REQUEST_ID = "req-supersede-1";

const questionActivity = (
  kind: "user-input.requested" | "user-input.resolved",
  payload: Record<string, unknown>,
): OrchestrationThread["activities"][number] =>
  ({
    id: EventId.make(`activity-${kind}-${REQUEST_ID}`),
    tone: "info" as const,
    kind,
    summary: kind,
    payload: { requestId: REQUEST_ID, ...payload },
    turnId: null,
    createdAt: NOW,
  }) as OrchestrationThread["activities"][number];

const makeReadModel = (
  activities: OrchestrationThread["activities"] = [],
): OrchestrationReadModel => ({
  snapshotSequence: 0,
  projects: [],
  goals: [],
  threads: [
    {
      id: THREAD,
      projectId: ProjectId.make("project-1"),
      goalId: null,
      parentThreadId: null,
      role: null,
      purpose: null,
      brief: null,
      kickoffBriefPath: null,
      graphKey: null,
      planLane: "in_progress" as const,
      attention: [],
      blockedBy: [],
      spawnGeneration: null,
      forkFromThreadId: null,
      reportPath: null,
      routes: [],
      gateRounds: 0,
      pendingRework: false,
      lastOutcome: null,
      isolation: "shared" as const,
      fanInState: "none" as const,
      cumulativeCostUsd: 0,
      toolUses: null,
      usedTokens: null,
      maxTokens: null,
      diffAdditions: null,
      diffDeletions: null,
      handoffCount: 0,
      notifySendLog: [],
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "pi" },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities,
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: NOW,
});

const sendPlainMessage = (input: {
  readonly commandId: string;
  readonly text: string;
  readonly readModel: OrchestrationReadModel;
  readonly origin?: "control_notice";
}) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.turn.start",
      commandId: CommandId.make(input.commandId),
      threadId: THREAD,
      message: {
        messageId: MessageId.make(`msg-${input.commandId}`),
        role: "user",
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
        text: input.text,
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: NOW,
    },
    readModel: input.readModel,
  }).pipe(Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])));

const resolutionOf = (events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>) =>
  events.find(
    (event) =>
      event.type === "thread.activity-appended" &&
      (event.payload as { activity: { kind: string } }).activity.kind === "user-input.resolved",
  );

const deliveryOf = (events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>) =>
  events.find((event) => event.type === "thread.user-input-response-requested");

it.layer(NodeServices.layer)("plain message while a question is open", (it) => {
  it.effect("supersedes the question and delivers the text as the tool result", () =>
    Effect.gen(function* () {
      const openQuestion = makeReadModel([
        questionActivity("user-input.requested", { questions: [] }),
      ]);

      const first = yield* sendPlainMessage({
        commandId: "cmd-supersede-1",
        text: "Can you populate it, I'd like to see the building on the platform",
        readModel: openQuestion,
      });

      // The message still lands as a message (the human said it, so it belongs in
      // the transcript)…
      expect(first.map((event) => event.type)).toContain("thread.message-sent");

      // …but NO turn-start is emitted. Delivery is exclusive: the blocked tool
      // call returns the text and the EXISTING turn resumes with it. Emitting a
      // turn-start too would send the same instruction twice — once as the tool
      // result, once as a steer folded into that very same live turn — and an
      // action-bearing message would be executed twice.
      expect(first.map((event) => event.type)).not.toContain("thread.turn-start-requested");

      // …and the question is settled `superseded` in the SAME transaction.
      const resolution = resolutionOf(first);
      expect(resolution).toBeDefined();
      expect(
        (resolution?.payload as { activity: { payload: Record<string, unknown> } }).activity
          .payload,
      ).toMatchObject({
        requestId: REQUEST_ID,
        outcome: "superseded",
        message: "Can you populate it, I'd like to see the building on the platform",
      });

      // The text is routed to the BROKER as the tool result, not to the steer
      // queue: a steer against a turn blocked inside the tool call is never
      // consumed, which is exactly how two Slack replies were lost.
      const delivery = deliveryOf(first);
      expect(delivery?.payload).toMatchObject({
        requestId: REQUEST_ID,
        outcome: "superseded",
        message: "Can you populate it, I'd like to see the building on the platform",
      });

      // The SECOND message has no question left to settle: an ordinary turn-start.
      const alreadyResolved = makeReadModel([
        questionActivity("user-input.requested", { questions: [] }),
        questionActivity("user-input.resolved", { answers: {}, outcome: "superseded" }),
      ]);
      const second = yield* sendPlainMessage({
        commandId: "cmd-supersede-2",
        text: "I'm not seeing anything populated in the stackplan",
        readModel: alreadyResolved,
      });
      expect(resolutionOf(second)).toBeUndefined();
      expect(deliveryOf(second)).toBeUndefined();
      expect(second.map((event) => event.type)).toContain("thread.turn-start-requested");
    }),
  );

  it.effect("does not supersede when there is no open question", () =>
    Effect.gen(function* () {
      const events = yield* sendPlainMessage({
        commandId: "cmd-no-question",
        text: "just a message",
        readModel: makeReadModel(),
      });
      expect(resolutionOf(events)).toBeUndefined();
      expect(deliveryOf(events)).toBeUndefined();
    }),
  );

  // A control-plane notice is not a human answering. Settling a question with an
  // automated restart-recovery notice would put words in the user's mouth.
  it.effect("never supersedes from a control-plane notice", () =>
    Effect.gen(function* () {
      const events = yield* sendPlainMessage({
        commandId: "cmd-control-notice",
        text: "[T3 Workstream control plane] resume from where you left off",
        origin: "control_notice",
        readModel: makeReadModel([questionActivity("user-input.requested", { questions: [] })]),
      });
      expect(resolutionOf(events)).toBeUndefined();
      expect(deliveryOf(events)).toBeUndefined();
    }),
  );
});
