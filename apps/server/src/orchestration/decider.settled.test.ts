import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const SETTLED_AT = "2025-12-30T00:00:00.000Z";
const SETTLE_BLOCKED_MESSAGE =
  "This thread still needs attention. Resolve or interrupt it first, then try again.";

function makeReadModel(
  settledOverride: OrchestrationThread["settledOverride"],
  archivedAt: string | null = null,
  session: OrchestrationSession | null = null,
  activities: OrchestrationThread["activities"] = [],
  messages: OrchestrationThread["messages"] = [],
  lifecycle: {
    readonly pinnedAt?: string | null;
    readonly snoozedUntil?: string | null;
    readonly snoozedAt?: string | null;
  } = {},
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    goals: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
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
        continuesThreadId: null,
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
        handoffDestinations: [],
        notifySendLog: [],
        title: "Thread",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt,
        settledOverride,
        settledAt: settledOverride === "settled" ? SETTLED_AT : null,
        snoozedUntil: lifecycle.snoozedUntil ?? null,
        snoozedAt: lifecycle.snoozedAt ?? (lifecycle.snoozedUntil != null ? SETTLED_AT : null),
        pinnedAt: lifecycle.pinnedAt ?? null,
        deletedAt: null,
        messages,
        proposedPlans: [],
        activities,
        checkpoints: [],
        session,
      },
    ],
    updatedAt: NOW,
  };
}

function makeSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: ThreadId.make("thread-1"),
    status,
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    queuedMessages: { steering: [], followUp: [] },
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("settled thread decider", (it) => {
  it.effect("preserves the activity stamp when automatically settling", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.auto-settle",
          commandId: CommandId.make("cmd-auto-settle-inactive"),
          threadId: ThreadId.make("thread-1"),
          snapshotSequence: 0,
          settledAt: SETTLED_AT,
        },
        readModel: makeReadModel(null),
      });
      const events = Array.isArray(result) ? result : [result];
      const settled = events.find((event) => event.type === "thread.settled");
      expect(settled?.payload.settledAt).toBe(SETTLED_AT);
      // updatedAt stays the command time so the row still moves on settle.
      expect(settled?.payload.updatedAt).toBe(settled?.occurredAt);
      expect(settled?.payload.updatedAt).not.toBe(SETTLED_AT);
    }),
  );

  it.effect("rejects an automatic settle when the thread is pinned active", () =>
    Effect.gen(function* () {
      const command = {
        type: "thread.auto-settle" as const,
        commandId: CommandId.make("cmd-auto-settle"),
        threadId: ThreadId.make("thread-1"),
        snapshotSequence: 0,
        settledAt: SETTLED_AT,
      };
      const pinnedActive = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel("active"),
      }).pipe(Effect.flip);
      expect(pinnedActive._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("settles awake threads without a redundant wake and re-emits idempotently", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.settled");
      if (events[0]?.type === "thread.settled") {
        expect(events[0].payload.settledAt).toBe(events[0].payload.updatedAt);
      }

      // Already settled: the engine rejects zero-event commands, so idempotency
      // is by re-emission — preserving the original settledAt.
      const reEmit = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-again"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel("settled"),
      });
      const reEmitEvents = Array.isArray(reEmit) ? reEmit : [reEmit];
      expect(reEmitEvents).toHaveLength(1);
      expect(reEmitEvents[0]?.type).toBe("thread.settled");
      if (reEmitEvents[0]?.type === "thread.settled") {
        expect(reEmitEvents[0].payload.settledAt).toBe(SETTLED_AT);
        // updatedAt must NOT rewind to the historical settledAt: sorting and
        // relative-time labels key on it.
        expect(reEmitEvents[0].payload.updatedAt).not.toBe(SETTLED_AT);
      }
    }),
  );

  // loom: the sweep is the single owner of auto-settle, so the plan-state
  // blockers live here. They suppress `thread.auto-settle` ONLY — an explicit
  // settle stays legal, or an abandoned graph could never be cleared by hand.
  it.effect("blocks the sweep on plan state, never an explicit settle", () =>
    Effect.gen(function* () {
      const base = makeReadModel(null);
      const root = base.threads[0]!;
      const graph = (
        lane: OrchestrationThread["planLane"],
        descendantLane: OrchestrationThread["planLane"] | null,
      ): OrchestrationReadModel => ({
        ...base,
        threads: [
          { ...root, planLane: lane },
          ...(descendantLane === null
            ? []
            : [
                {
                  ...root,
                  id: ThreadId.make("thread-2"),
                  parentThreadId: ThreadId.make("thread-1"),
                  planLane: descendantLane,
                },
              ]),
        ],
      });
      const autoSettle = (label: string, readModel: OrchestrationReadModel) =>
        decideOrchestrationCommand({
          command: {
            type: "thread.auto-settle" as const,
            commandId: CommandId.make(`cmd-auto-settle-${label}`),
            threadId: ThreadId.make("thread-1"),
            snapshotSequence: 0,
            settledAt: SETTLED_AT,
          },
          readModel,
        });

      for (const [label, readModel] of [
        // Parked awaiting a decision: quiescent by every runtime signal, owed.
        ["yielded", graph("yielded", null)],
        // The idle orchestrator whose subtree is still burning tokens.
        ["live-descendant", graph("in_progress", "in_progress")],
        // Same blocker under the finished-work trigger: a root that reported
        // done waits for its subtree before it leaves the inbox.
        ["done-root-live-descendant", graph("done", "in_progress")],
      ] as const) {
        expect(yield* autoSettle(label, readModel).pipe(Effect.flip)).toMatchObject({
          _tag: "OrchestrationThreadSettleBlockedError",
          threadId: ThreadId.make("thread-1"),
          message: SETTLE_BLOCKED_MESSAGE,
        });
      }

      // A stored attention flag is deliberately NOT a blocker: it ages out with
      // inactivity, and the settled row still carries the flag.
      const flagged = yield* autoSettle("attention", {
        ...base,
        threads: [{ ...root, attention: ["needs_guidance" as const] }],
      });
      expect((Array.isArray(flagged) ? flagged : [flagged])[0]?.type).toBe("thread.settled");

      // Terminal descendants are not live work, so the root sweeps normally.
      const doneSubtree = yield* autoSettle("done-descendant", graph("in_progress", "done"));
      expect((Array.isArray(doneSubtree) ? doneSubtree : [doneSubtree])[0]?.type).toBe(
        "thread.settled",
      );

      // The user can always settle by hand, whatever the plan says.
      const explicit = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-yielded"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: graph("yielded", "in_progress"),
      });
      expect((Array.isArray(explicit) ? explicit : [explicit])[0]?.type).toBe("thread.settled");
    }),
  );

  it.effect("settling a snoozed thread also wakes it", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-snoozed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [], [], {
          snoozedUntil: "1970-01-02T09:00:00.000Z",
        }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((entry) => entry.type)).toEqual(["thread.settled", "thread.unsnoozed"]);
      const settled = events.find((entry) => entry.type === "thread.settled");
      const unsnoozed = events.find((entry) => entry.type === "thread.unsnoozed");
      if (settled?.type === "thread.settled" && unsnoozed?.type === "thread.unsnoozed") {
        expect(unsnoozed.payload.reason).toBe("user");
        expect(unsnoozed.payload.updatedAt).toBe(settled.payload.updatedAt);
      }
    }),
  );

  it.effect("repeated settle repairs legacy settled and snoozed state", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-snoozed-again"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel("settled", null, null, [], [], {
          snoozedUntil: "1970-01-02T09:00:00.000Z",
        }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((entry) => entry.type)).toEqual(["thread.settled", "thread.unsnoozed"]);
      const settled = events.find((entry) => entry.type === "thread.settled");
      const unsnoozed = events.find((entry) => entry.type === "thread.unsnoozed");
      if (settled?.type === "thread.settled" && unsnoozed?.type === "thread.unsnoozed") {
        expect(settled.payload.settledAt).toBe(SETTLED_AT);
        expect(settled.payload.updatedAt).toBe(NOW);
        expect(unsnoozed.payload.updatedAt).not.toBe(NOW);
      }
    }),
  );

  it.effect("settling a pinned and snoozed thread clears the pin and snooze", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-pinned-snoozed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [], [], {
          pinnedAt: SETTLED_AT,
          snoozedUntil: "1970-01-02T09:00:00.000Z",
        }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((entry) => entry.type)).toEqual([
        "thread.settled",
        "thread.unpinned",
        "thread.unsnoozed",
      ]);
    }),
  );

  it.effect("rejects settling a thread with a live session", () =>
    Effect.gen(function* () {
      for (const status of ["starting", "running"] as const) {
        const error = yield* decideOrchestrationCommand({
          command: {
            type: "thread.settle",
            commandId: CommandId.make(`cmd-settle-live-${status}`),
            threadId: ThreadId.make("thread-1"),
          },
          readModel: makeReadModel(null, null, makeSession(status)),
        }).pipe(Effect.flip);
        expect(error).toMatchObject({
          _tag: "OrchestrationThreadSettleBlockedError",
          threadId: ThreadId.make("thread-1"),
          message: SETTLE_BLOCKED_MESSAGE,
        });
      }
      // Stopped/error sessions are settleable — only live work is protected.
      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-stopped"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, makeSession("stopped")),
      });
      const settledEvents = Array.isArray(settled) ? settled : [settled];
      expect(settledEvents[0]?.type).toBe("thread.settled");
    }),
  );

  it.effect("rejects settling a thread with an open approval or user-input request", () =>
    Effect.gen(function* () {
      const requestActivity = (kind: string, requestId: string, at: string) =>
        ({
          id: EventId.make(`activity-${requestId}-${kind}`),
          tone: "approval" as const,
          kind,
          summary: kind,
          payload: { requestId },
          turnId: null,
          createdAt: at,
        }) as OrchestrationThread["activities"][number];

      // Open approval request: settle rejected.
      const openError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-pending"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          requestActivity("approval.requested", "req-1", NOW),
        ]),
      }).pipe(Effect.flip);
      expect(openError).toMatchObject({
        _tag: "OrchestrationThreadSettleBlockedError",
        threadId: ThreadId.make("thread-1"),
        message: SETTLE_BLOCKED_MESSAGE,
      });

      // Same request later resolved: settleable again.
      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-resolved"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          requestActivity("approval.requested", "req-1", NOW),
          requestActivity("approval.resolved", "req-1", NOW),
        ]),
      });
      const settledEvents = Array.isArray(settled) ? settled : [settled];
      expect(settledEvents[0]?.type).toBe("thread.settled");

      // Open user-input request: also rejected.
      const inputError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-pending-input"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          requestActivity("user-input.requested", "req-2", NOW),
        ]),
      }).pipe(Effect.flip);
      expect(inputError).toMatchObject({
        _tag: "OrchestrationThreadSettleBlockedError",
        threadId: ThreadId.make("thread-1"),
        message: SETTLE_BLOCKED_MESSAGE,
      });
    }),
  );

  it.effect("manual settlement dismisses async questions without starting a turn", () =>
    Effect.gen(function* () {
      const question = (requestId: string): OrchestrationThread["activities"][number] => ({
        id: EventId.make(requestId),
        kind: "user-input.requested",
        summary: "Question",
        tone: "approval",
        turnId: null,
        createdAt: "1969-12-31T00:00:00.000Z",
        payload: { requestId, responseMode: "message" },
      });
      const readModel = makeReadModel(null, null, makeSession("ready"), [
        question("first"),
        question("second"),
        question("answered"),
        {
          ...question("answered"),
          id: EventId.make("answer"),
          createdAt: "1969-12-31T01:00:00.000Z",
          kind: "user-input.resolved",
        },
      ]);
      const command = {
        type: "thread.settle" as const,
        commandId: CommandId.make("settle-async"),
        threadId: ThreadId.make("thread-1"),
      };
      const result = yield* decideOrchestrationCommand({ command, readModel });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.settled",
        "thread.activity-appended",
        "thread.activity-appended",
      ]);
      expect(events.slice(1).map((event) => event.payload)).toEqual(
        ["first", "second"].map((requestId) => ({
          threadId: command.threadId,
          activity: expect.objectContaining({
            kind: "user-input.resolved",
            summary: "User input dismissed",
            payload: { requestId, responseMode: "message" },
          }),
        })),
      );
      let projected = readModel;
      for (const [index, event] of events.entries()) {
        projected = yield* projectEvent(projected, { ...event, sequence: index + 1 });
      }
      expect(projected.threads[0]?.settledOverride).toBe("settled");
      expect(projected.threads[0]?.messages).toEqual([]);
      const repeated = yield* decideOrchestrationCommand({ command, readModel: projected });
      expect(repeated).toMatchObject({ type: "thread.settled" });
    }),
  );

  // loom: a pi question carries `dismissible: true` and no `responseMode`, and
  // the panel offers Dismiss for it — so Settle must not error where Dismiss
  // works. A request the client cannot dismiss still blocks.
  it.effect("an explicit settle dismisses a question marked dismissible", () =>
    Effect.gen(function* () {
      const question = (
        requestId: string,
        payload: Record<string, unknown>,
      ): OrchestrationThread["activities"][number] => ({
        id: EventId.make(requestId),
        kind: "user-input.requested",
        summary: "Question",
        tone: "approval",
        turnId: null,
        createdAt: NOW,
        payload: { requestId, ...payload },
      });
      const command = {
        type: "thread.settle" as const,
        commandId: CommandId.make("settle-dismissible"),
        threadId: ThreadId.make("thread-1"),
      };
      const result = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(null, null, makeSession("ready"), [
          question("pi-question", { questions: [], dismissible: true }),
        ]),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.settled",
        "thread.activity-appended",
      ]);

      const blocked = yield* decideOrchestrationCommand({
        command,
        readModel: makeReadModel(null, null, makeSession("ready"), [
          question("native-callback", { dismissible: false }),
        ]),
      }).pipe(Effect.flip);
      expect(blocked).toMatchObject({ _tag: "OrchestrationThreadSettleBlockedError" });
    }),
  );

  it.effect("async questions do not bypass automatic settlement or other blockers", () =>
    Effect.gen(function* () {
      const question: OrchestrationThread["activities"][number] = {
        id: EventId.make("async-question"),
        kind: "user-input.requested",
        summary: "Question",
        tone: "approval",
        turnId: null,
        createdAt: NOW,
        payload: { requestId: "async-question", responseMode: "message" },
      };
      for (const blocker of ["auto", "running", "starting", "approval", "native"] as const) {
        const error = yield* decideOrchestrationCommand({
          command:
            blocker === "auto"
              ? {
                  type: "thread.auto-settle",
                  commandId: CommandId.make(`settle-${blocker}`),
                  threadId: ThreadId.make("thread-1"),
                  snapshotSequence: 0,
                  settledAt: NOW,
                }
              : {
                  type: "thread.settle",
                  commandId: CommandId.make(`settle-${blocker}`),
                  threadId: ThreadId.make("thread-1"),
                },
          readModel: makeReadModel(
            null,
            null,
            makeSession(blocker === "running" || blocker === "starting" ? blocker : "ready"),
            [
              question,
              ...(blocker === "approval" || blocker === "native"
                ? [
                    {
                      ...question,
                      id: EventId.make("blocking-request"),
                      kind: blocker === "approval" ? "approval.requested" : "user-input.requested",
                      payload: { requestId: "blocking-request" },
                    },
                  ]
                : []),
            ],
          ),
        }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "OrchestrationThreadSettleBlockedError" });
      }
    }),
  );

  it.effect("clears an open request when its respond failure marks it stale", () =>
    Effect.gen(function* () {
      const activity = (
        kind: string,
        requestId: string,
        payload: Record<string, unknown>,
      ): OrchestrationThread["activities"][number] =>
        ({
          id: EventId.make(`activity-${requestId}-${kind}`),
          tone: "approval" as const,
          kind,
          summary: kind,
          payload: { requestId, ...payload },
          turnId: null,
          createdAt: NOW,
        }) as OrchestrationThread["activities"][number];

      // Stale-failure detail clears an APPROVAL — mirrors the projection's pending
      // accounting, which is what the client's canSettle sees.
      // Stale-failure details clear the request, matching the projection flags.
      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-stale-failed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          activity("approval.requested", "req-1", {}),
          activity("provider.approval.respond.failed", "req-1", {
            detail: "Unknown pending approval request req-1",
          }),
        ]),
      });
      const settledEvents = Array.isArray(settled) ? settled : [settled];
      expect(settledEvents[0]?.type).toBe("thread.settled");

      // A QUESTION is NOT cleared by any failure detail: settlement is guaranteed
      // to arrive as a resolution, so a delivery diagnostic leaves it open (and
      // the thread unsettleable) rather than the client guessing from prose.
      const questionStillOpen = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-question-failed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          activity("user-input.requested", "req-2", {}),
          activity("provider.user-input.respond.failed", "req-2", {
            detail: "stale pending user-input request req-2",
          }),
        ]),
      }).pipe(Effect.flip);
      // loom: upstream's settle path raises its own typed blocker rather than the
      // generic invariant error; the guarantee (the settle is refused) is the same.
      expect(questionStillOpen._tag).toBe("OrchestrationThreadSettleBlockedError");

      // …and terminal-wins: a resolution clears it permanently, even when a
      // duplicate `requested` row for the same id follows it.
      const questionSettled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-question-resolved"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          activity("user-input.resolved", "req-4", { outcome: "dismissed" }),
          activity("user-input.requested", "req-4", {}),
        ]),
      });
      const questionSettledEvents = Array.isArray(questionSettled)
        ? questionSettled
        : [questionSettled];
      expect(questionSettledEvents[0]?.type).toBe("thread.settled");

      // A non-stale respond failure (transient provider error) keeps the
      // request open: the user can retry, so it is still blocked-on-you.
      const stillOpen = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-transient-failed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          activity("approval.requested", "req-3", {}),
          activity("provider.approval.respond.failed", "req-3", {
            detail: "provider connection reset",
          }),
        ]),
      }).pipe(Effect.flip);
      expect(stillOpen).toMatchObject({
        _tag: "OrchestrationThreadSettleBlockedError",
        threadId: ThreadId.make("thread-1"),
        message: SETTLE_BLOCKED_MESSAGE,
      });
    }),
  );

  it.effect("bounds the queued-turn grace window against client clock skew", () =>
    Effect.gen(function* () {
      const userMessage = (createdAt: string): OrchestrationThread["messages"][number] => ({
        id: MessageId.make("message-queued"),
        role: "user",
        text: "Continue",
        turnId: null,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      });

      // The decider's clock is the Effect test clock, pinned to the epoch:
      // timestamps here are relative to 1970-01-01T00:00:00.000Z.

      // Within the grace window: genuinely queued, settle rejected.
      const queuedError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-queued"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [], [userMessage("1969-12-31T23:59:30.000Z")]),
      }).pipe(Effect.flip);
      expect(queuedError).toMatchObject({
        _tag: "OrchestrationThreadSettleBlockedError",
        threadId: ThreadId.make("thread-1"),
        message: SETTLE_BLOCKED_MESSAGE,
      });

      // Message timestamp far in the FUTURE (client clock ahead of server):
      // a negative age must not read as queued forever — past the grace
      // bound in either direction the thread is settleable.
      const skewed = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-skewed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [], [userMessage("1970-01-01T01:00:00.000Z")]),
      });
      const skewedEvents = Array.isArray(skewed) ? skewed : [skewed];
      expect(skewedEvents[0]?.type).toBe("thread.settled");
    }),
  );

  it.effect("rejects settling and unsettling archived threads", () =>
    Effect.gen(function* () {
      const settleError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-archived"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, NOW),
      }).pipe(Effect.flip);
      expect(settleError._tag).toBe("OrchestrationCommandInvariantError");

      const unsettleError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId: CommandId.make("cmd-unsettle-archived"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel("settled", NOW),
      }).pipe(Effect.flip);
      expect(unsettleError._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("maps unsettle reasons to overrides and re-emits idempotently", () =>
    Effect.gen(function* () {
      const userEvent = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId: CommandId.make("cmd-unsettle-user"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel("settled"),
      });
      const userEvents = Array.isArray(userEvent) ? userEvent : [userEvent];
      expect(userEvents).toHaveLength(1);
      expect(userEvents[0]?.type).toBe("thread.unsettled");
      if (userEvents[0]?.type === "thread.unsettled") {
        expect(userEvents[0].payload.reason).toBe("user");
      }

      // Re-dispatching against the already-reached state re-emits rather than
      // producing zero events (the engine rejects empty commands).
      const userAgain = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId: CommandId.make("cmd-unsettle-user-again"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel("active"),
      });
      const userAgainEvents = Array.isArray(userAgain) ? userAgain : [userAgain];
      expect(userAgainEvents).toHaveLength(1);
      expect(userAgainEvents[0]?.type).toBe("thread.unsettled");
    }),
  );

  // Command-to-projection: an accepted un-settle must land as the re-entry
  // stamp clients sort by (max of createdAt and unsettledAt, see
  // activeThreadAnchorTimestampMs in client-runtime), so the thread surfaces
  // above threads created after it. The projector tests feed events directly;
  // this one proves the decider actually emits what they consume.
  it.effect("an accepted un-settle re-anchors the thread for the active list", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel("settled");
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId: CommandId.make("cmd-unsettle-anchor"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];
      const unsettled = events[0]!;
      expect(unsettled.type).toBe("thread.unsettled");

      const projected = yield* projectEvent(readModel, {
        ...unsettled,
        sequence: readModel.snapshotSequence + 1,
      } as OrchestrationEvent);
      const thread = projected.threads[0]!;
      expect(thread.settledOverride).toBe("active");
      // The stamp is the decider's accept time: every thread created before
      // the un-settle anchors below it.
      expect(thread.unsettledAt).toBe(unsettled.occurredAt);
      if (unsettled.type === "thread.unsettled") {
        expect(thread.unsettledAt).toBe(unsettled.payload.updatedAt);
      }
    }),
  );

  // loom: a human re-engaging a settled finished root makes the manual
  // Un-settle choice durably; automated notices never make that choice for them.
  it.effect(
    "pins a human-messaged settled root active, but leaves control-plane turns settled",
    () =>
      Effect.gen(function* () {
        const settled = makeReadModel("settled");
        const settledDone: OrchestrationReadModel = {
          ...settled,
          threads: [{ ...settled.threads[0]!, planLane: "done" }],
        };
        const startTurn = (
          commandId: string,
          messageId: string,
          readModel: OrchestrationReadModel,
          origin?: "control_notice" | "notify",
        ) =>
          decideOrchestrationCommand({
            command: {
              type: "thread.turn.start",
              commandId: CommandId.make(commandId),
              threadId: ThreadId.make("thread-1"),
              message: {
                messageId: MessageId.make(messageId),
                role: "user",
                text: "Continue",
                attachments: [],
                ...(origin !== undefined ? { origin } : {}),
              },
              runtimeMode: "full-access",
              interactionMode: "default",
              createdAt: NOW,
            },
            readModel,
          });
        const projectAll = Effect.fn("projectSettlementEvents")(function* (
          readModel: OrchestrationReadModel,
          events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
        ) {
          let projected = readModel;
          for (const event of events) {
            projected = yield* projectEvent(projected, {
              ...event,
              sequence: projected.snapshotSequence + 1,
            } as OrchestrationEvent);
          }
          return projected;
        });
        const setSession = (
          commandId: string,
          status: OrchestrationSession["status"],
          readModel: OrchestrationReadModel,
        ) =>
          decideOrchestrationCommand({
            command: {
              type: "thread.session.set",
              commandId: CommandId.make(commandId),
              threadId: ThreadId.make("thread-1"),
              session: makeSession(status),
              createdAt: NOW,
            },
            readModel,
          });

        const humanResult = yield* startTurn("cmd-human-turn", "message-human", settledDone);
        const humanEvents = Array.isArray(humanResult) ? humanResult : [humanResult];
        expect(humanEvents.map((event) => event.type)).toEqual([
          "thread.unsettled",
          "thread.message-sent",
          "thread.turn-start-requested",
        ]);
        const humanUnsettled = humanEvents[0];
        expect(humanUnsettled?.type).toBe("thread.unsettled");
        if (humanUnsettled?.type === "thread.unsettled") {
          expect(humanUnsettled.payload.reason).toBe("user");
        }

        let humanModel = yield* projectAll(settledDone, humanEvents);
        expect(humanModel.threads[0]?.settledOverride).toBe("active");
        for (const status of ["running", "idle"] as const) {
          const result = yield* setSession(`cmd-human-${status}`, status, humanModel);
          const events = Array.isArray(result) ? result : [result];
          expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
          humanModel = yield* projectAll(humanModel, events);
        }
        expect(humanModel.threads[0]?.settledOverride).toBe("active");

        const autoSettle = yield* decideOrchestrationCommand({
          command: {
            type: "thread.auto-settle",
            commandId: CommandId.make("cmd-finished-root-auto-settle"),
            threadId: ThreadId.make("thread-1"),
            snapshotSequence: humanModel.snapshotSequence,
            settledAt: NOW,
          },
          readModel: humanModel,
        }).pipe(Effect.flip);
        expect(autoSettle._tag).toBe("OrchestrationCommandInvariantError");

        const manualSettle = yield* decideOrchestrationCommand({
          command: {
            type: "thread.settle",
            commandId: CommandId.make("cmd-human-manual-settle"),
            threadId: ThreadId.make("thread-1"),
          },
          readModel: humanModel,
        });
        const manuallySettled = yield* projectAll(
          humanModel,
          Array.isArray(manualSettle) ? manualSettle : [manualSettle],
        );
        expect(manuallySettled.threads[0]?.settledOverride).toBe("settled");

        const activityResult = yield* decideOrchestrationCommand({
          command: {
            type: "thread.activity.append",
            commandId: CommandId.make("cmd-active-approval"),
            threadId: ThreadId.make("thread-1"),
            activity: {
              id: EventId.make("activity-active"),
              tone: "approval",
              kind: "approval.requested",
              summary: "Command approval requested",
              payload: null,
              turnId: null,
              createdAt: NOW,
            },
            createdAt: NOW,
          },
          readModel: humanModel,
        });
        expect(
          (Array.isArray(activityResult) ? activityResult : [activityResult]).map(
            (event) => event.type,
          ),
        ).toEqual(["thread.activity-appended"]);

        for (const origin of ["control_notice", "notify"] as const) {
          const controlResult = yield* startTurn(
            `cmd-${origin}-turn`,
            `message-${origin}`,
            settledDone,
            origin,
          );
          const controlEvents = Array.isArray(controlResult) ? controlResult : [controlResult];
          expect(controlEvents.map((event) => event.type)).toEqual([
            "thread.message-sent",
            "thread.turn-start-requested",
          ]);
          let controlModel = yield* projectAll(settledDone, controlEvents);
          for (const status of ["running", "idle"] as const) {
            const result = yield* setSession(`cmd-${origin}-${status}`, status, controlModel);
            const events = Array.isArray(result) ? result : [result];
            expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
            controlModel = yield* projectAll(controlModel, events);
          }
          expect(controlModel.threads[0]?.settledOverride).toBe("settled");
        }
      }),
  );

  it.effect("does not unsettle for session stop/error status writes", () =>
    Effect.gen(function* () {
      for (const status of ["stopped", "error", "ready", "idle"] as const) {
        const result = yield* decideOrchestrationCommand({
          command: {
            type: "thread.session.set",
            commandId: CommandId.make(`cmd-session-${status}`),
            threadId: ThreadId.make("thread-1"),
            session: makeSession(status),
            createdAt: NOW,
          },
          readModel: makeReadModel("settled"),
        });
        const events = Array.isArray(result) ? result : [result];
        expect(events.map((event) => event.type)).toEqual(["thread.session-set"]);
      }
    }),
  );

  it.effect("unsettles for approval and user-input activities but not others", () =>
    Effect.gen(function* () {
      const approvalResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-activity-approval"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-1"),
            tone: "approval",
            kind: "approval.requested",
            summary: "Command approval requested",
            payload: null,
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
        readModel: makeReadModel("settled"),
      });
      const approvalEvents = Array.isArray(approvalResult) ? approvalResult : [approvalResult];
      expect(approvalEvents.map((event) => event.type)).toEqual([
        "thread.unsettled",
        "thread.activity-appended",
      ]);

      const routineResult = yield* decideOrchestrationCommand({
        command: {
          type: "thread.activity.append",
          commandId: CommandId.make("cmd-activity-routine"),
          threadId: ThreadId.make("thread-1"),
          activity: {
            id: EventId.make("activity-2"),
            tone: "info",
            kind: "tool.completed",
            summary: "Tool completed",
            payload: null,
            turnId: null,
            createdAt: NOW,
          },
          createdAt: NOW,
        },
        readModel: makeReadModel("settled"),
      });
      const routineEvents = Array.isArray(routineResult) ? routineResult : [routineResult];
      expect(routineEvents.map((event) => event.type)).toEqual(["thread.activity-appended"]);
    }),
  );

  it.effect("drops an onlyIfSettled session stop when the thread was re-engaged", () =>
    Effect.gen(function* () {
      const stopCommand = (commandId: string) =>
        ({
          type: "thread.session.stop",
          commandId: CommandId.make(commandId),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
          onlyIfSettled: true,
        }) as const;

      // Still settled with an idle session: the cleanup stop goes through.
      const stopped = yield* decideOrchestrationCommand({
        command: stopCommand("cmd-stop-settled-idle"),
        readModel: makeReadModel("settled", null, makeSession("ready")),
      });
      const stoppedEvents = Array.isArray(stopped) ? stopped : [stopped];
      expect(stoppedEvents.map((event) => event.type)).toEqual(["thread.session-stop-requested"]);

      // Re-engaged before the stop was decided (a turn start unsettles the
      // thread): the stale cleanup stop must not kill the new session.
      const unsettledError = yield* decideOrchestrationCommand({
        command: stopCommand("cmd-stop-unsettled"),
        readModel: makeReadModel(null, null, makeSession("starting")),
      }).pipe(Effect.flip);
      expect(unsettledError._tag).toBe("OrchestrationCommandInvariantError");

      // Still settled but the session is already coming alive: same drop.
      const aliveError = yield* decideOrchestrationCommand({
        command: stopCommand("cmd-stop-session-alive"),
        readModel: makeReadModel("settled", null, makeSession("starting")),
      }).pipe(Effect.flip);
      expect(aliveError._tag).toBe("OrchestrationCommandInvariantError");

      // Without the flag the stop stays unconditional (archive, stop button).
      const unconditional = yield* decideOrchestrationCommand({
        command: {
          type: "thread.session.stop",
          commandId: CommandId.make("cmd-stop-unconditional"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
        },
        readModel: makeReadModel(null, null, makeSession("starting")),
      });
      const unconditionalEvents = Array.isArray(unconditional) ? unconditional : [unconditional];
      expect(unconditionalEvents.map((event) => event.type)).toEqual([
        "thread.session-stop-requested",
      ]);
    }),
  );
});
