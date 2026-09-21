import {
  ApprovalRequestId,
  EventId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { loomThreadFixtureDefaults } from "./deciderTestThread.ts";

const UPDATED_AT = "2026-01-01T00:00:00.000Z";
const requestId = ApprovalRequestId.make("multi-question");

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  goals: [],
  projects: [],
  threads: [
    {
      ...loomThreadFixtureDefaults,
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Manual title",
      modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "claude-fable-5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      pullRequests: [],
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: UPDATED_AT,
      updatedAt: UPDATED_AT,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
  updatedAt: UPDATED_AT,
};

const request = {
  id: EventId.make("question"),
  kind: "user-input.requested",
  summary: "Question",
  tone: "info" as const,
  turnId: null,
  createdAt: UPDATED_AT,
  payload: {
    requestId,
    questions: [
      {
        id: "0",
        header: "Package manager",
        question: "Which package manager?",
        options: [{ label: "pnpm", description: "" }],
      },
      {
        id: "1",
        header: "Name",
        question: "What should it be named?",
        options: [],
        allowCustomAnswer: true,
      },
    ],
  },
};

const attachment = {
  type: "file" as const,
  id: "thread-1-00000000-0000-4000-8000-0000000000aa-txt",
  name: "spec.txt",
  mimeType: "text/plain",
  sizeBytes: 4,
};

const respond = (answers: ProviderUserInputAnswers, attached = false) => ({
  type: "thread.user-input.respond" as const,
  commandId: CommandId.make("answer"),
  threadId: ThreadId.make("thread-1"),
  requestId,
  answers,
  createdAt: UPDATED_AT,
  ...(attached ? { attachmentsByQuestionId: { "1": [attachment] } } : {}),
});

it.layer(NodeServices.layer)("multi-question answers", (it) => {
  it.effect("refuses to settle a form that is missing an answer", () =>
    Effect.gen(function* () {
      // The last pair carries a file on the unanswered question: as upstream, an
      // attachment stands in for a blank answer but not for a missing one.
      for (const [answers, attached] of [
        [{ "0": "pnpm" }, false],
        [{ "0": "pnpm", "1": "   " }, false],
        [{ "0": [], "1": "Example" }, false],
        [{ "0": "pnpm" }, true],
      ] satisfies ReadonlyArray<readonly [ProviderUserInputAnswers, boolean]>) {
        const result = yield* decideOrchestrationCommand({
          readModel,
          command: respond(answers, attached),
          userInputActivity: request,
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        // Nothing settled: the resolution and the delivery intent are one
        // transaction, so a rejected command leaves the question open.
        expect(String(result._tag === "Failure" ? result.failure : "")).toContain(
          "Answer each question before sending.",
        );
      }
    }),
  );
  it.effect("accepts a blank answer the user attached a file to", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: respond({ "0": "pnpm", "1": "" }, true),
        userInputActivity: request,
      });
      expect((Array.isArray(result) ? result : [result]).map((event) => event.type)).toEqual([
        "thread.activity-appended",
        "thread.user-input-response-requested",
      ]);
    }),
  );
  it.effect("settles once every question is answered", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        readModel,
        command: respond({ "0": ["pnpm"], "1": "Example" }),
        userInputActivity: request,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.activity-appended",
        "thread.user-input-response-requested",
      ]);
      expect(events[0]?.payload).toMatchObject({
        activity: {
          kind: "user-input.resolved",
          payload: { requestId, outcome: "answered", answers: { "0": ["pnpm"], "1": "Example" } },
        },
      });
    }),
  );
});
