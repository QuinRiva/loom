import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ApprovalRequestId,
  type OrchestrationReadModel,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import { loomThreadFixtureDefaults } from "./deciderTestThread.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const threadId = ThreadId.make("thread-1");
const requestId = ApprovalRequestId.make("question-1");

function makeRequest(responseMode: "message" | undefined): OrchestrationThreadActivity {
  return {
    id: EventId.make(requestId),
    kind: "user-input.requested",
    summary: "Question",
    tone: "approval",
    turnId: null,
    createdAt: NOW,
    payload: {
      requestId,
      ...(responseMode === undefined ? {} : { responseMode }),
      questions: [{ id: "0", header: "Q", question: "Continue?", options: [] }],
    },
  };
}

function makeReadModel(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    goals: [],
    projects: [],
    threads: [
      {
        ...loomThreadFixtureDefaults,
        id: threadId,
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        pullRequests: [],
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [...activities],
        checkpoints: [],
        session: null,
      },
    ],
    updatedAt: NOW,
  };
}

const command = {
  type: "thread.user-input.dismiss" as const,
  commandId: CommandId.make("dismiss-1"),
  threadId,
  requestId,
  createdAt: NOW,
};

it.layer(NodeServices.layer)("user input dismiss decider", (it) => {
  // loom: upstream's unified response path sends dismissals back to every provider protocol.
  it.effect("closes an async question without sending a message or starting a turn", () =>
    Effect.gen(function* () {
      const request = makeRequest("message");
      const readModel = makeReadModel([request]);
      const result = yield* decideOrchestrationCommand({
        command,
        readModel,
        userInputActivity: request,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.activity-appended",
        "thread.user-input-response-requested",
      ]);
      expect(events[0]?.payload).toMatchObject({
        threadId,
        activity: {
          kind: "user-input.resolved",
          summary: "User input dismissed",
          // loom: the outcome, not loom's old responseMode marker, records the settlement.
          payload: { requestId, outcome: "dismissed" },
        },
      });
      const projected = yield* projectEvent(readModel, { ...events[0]!, sequence: 1 });
      expect(projected.threads[0]?.messages).toEqual([]);
      expect(projected.threads[0]?.latestTurn).toBeNull();
    }),
  );

  it.effect("dismisses a native callback question through the provider response path", () =>
    Effect.gen(function* () {
      const request = makeRequest(undefined);
      const result = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel([request]),
        userInputActivity: request,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.activity-appended",
        "thread.user-input-response-requested",
      ]);
      expect(events[1]?.payload).toMatchObject({ requestId, answers: {}, outcome: "dismissed" });
    }),
  );

  it.effect("rejects dismissing a question that was already resolved", () =>
    Effect.gen(function* () {
      const resolved: OrchestrationThreadActivity = {
        ...makeRequest("message"),
        id: EventId.make("resolved"),
        kind: "user-input.resolved",
      };
      const result = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel([makeRequest("message"), resolved]),
        userInputActivity: resolved,
      }).pipe(Effect.flip);
      expect(result).toMatchObject({
        _tag: "OrchestrationCommandInvariantError",
        detail: "User-input request 'question-1' on thread 'thread-1' is not open; it was already settled.",
      });
    }),
  );
});
