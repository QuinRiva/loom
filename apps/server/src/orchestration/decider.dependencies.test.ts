// WP2 — decider coherence backstop for the direct-WS paths (web board /
// client-runtime dispatch `thread.create` and `thread.dependencies.set`
// straight past the MCP handlers). Covers R1 cycle rejection, R2 non-sibling /
// dangling / archived rejection, and R3 attention on an edge wired onto an
// already-cancelled dependency. See docs/plans/workstream-spawn-hardening.md.
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type WorkstreamRoute,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const PROJECT = ProjectId.make("project-deps");
const PARENT = ThreadId.make("parent-1");
const OTHER_PARENT = ThreadId.make("parent-2");

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

const threadCreated = (threadId: ThreadId, extra: Record<string, unknown> = {}) =>
  seedEvent({
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    payload: {
      threadId,
      projectId: PROJECT,
      title: `Thread ${threadId}`,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      ...extra,
    },
  });

const userMessage = (threadId: ThreadId) =>
  seedEvent({
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId: MessageId.make(`msg-${threadId}-${seq}`),
      role: "user",
      text: "kickoff",
      attachments: [],
      turnId: null,
      streaming: false,
      createdAt: now,
      updatedAt: now,
    },
  });

const threadArchived = (threadId: ThreadId) =>
  seedEvent({
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.archived",
    payload: { threadId, archivedAt: now, updatedAt: now },
  });

const apply = (readModel: OrchestrationReadModel, events: ReadonlyArray<OrchestrationEvent>) =>
  Effect.gen(function* () {
    let model = readModel;
    for (const event of events) model = yield* projectEvent(model, event);
    return model;
  });

/** Project + parent scaffold every fixture builds on. */
const base = Effect.gen(function* () {
  seq = 0;
  return yield* apply(createEmptyReadModel(now), [
    seedEvent({
      aggregateKind: "project",
      aggregateId: PROJECT,
      type: "project.created",
      payload: {
        projectId: PROJECT,
        title: "Deps",
        workspaceRoot: "/tmp/deps",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
    threadCreated(PARENT),
  ]);
});

const setDeps = (threadId: ThreadId, blockedBy: ReadonlyArray<ThreadId>): OrchestrationCommand => ({
  type: "thread.dependencies.set",
  commandId: CommandId.make(`cmd-setdeps-${threadId}-${blockedBy.join(",")}`),
  threadId,
  blockedBy,
  createdAt: now,
});

const createThread = (
  threadId: ThreadId,
  extra: Partial<Extract<OrchestrationCommand, { type: "thread.create" }>> = {},
): OrchestrationCommand => ({
  type: "thread.create",
  commandId: CommandId.make(`cmd-create-${threadId}`),
  threadId,
  projectId: PROJECT,
  title: `Thread ${threadId}`,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "full-access",
  branch: null,
  worktreePath: null,
  createdAt: now,
  ...extra,
});

const decide = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

/** Run a command expecting rejection; return the invariant-error detail. */
const rejectionDetail = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.flip,
    Effect.map((error) =>
      error._tag === "OrchestrationCommandInvariantError" ? error.detail : `unexpected: ${error}`,
    ),
  );

const A = ThreadId.make("thread-a");
const B = ThreadId.make("thread-b");
const T = ThreadId.make("thread-t");
const X = ThreadId.make("thread-x");
const Y = ThreadId.make("thread-y");

it.layer(NodeServices.layer)("decider dependency coherence backstop (WP2)", (it) => {
  // ---- Test 11: thread.dependencies.set (R1 / R2) ----
  it.effect("rejects a proposed A↔B cycle on set", () =>
    Effect.gen(function* () {
      const model = yield* Effect.flatMap(base, (m) =>
        apply(m, [
          threadCreated(A, { parentThreadId: PARENT, blockedBy: [B] }),
          threadCreated(B, { parentThreadId: PARENT }),
        ]),
      );
      const detail = yield* rejectionDetail(setDeps(B, [A]), model);
      expect(detail).toContain("cycle");
    }),
  );

  it.effect("rejects a dangling / non-sibling / archived id on set, naming it", () =>
    Effect.gen(function* () {
      const dangling = ThreadId.make("nope-1");
      const archived = ThreadId.make("thread-arch");
      const model = yield* Effect.flatMap(base, (m) =>
        apply(m, [
          threadCreated(T, { parentThreadId: PARENT }),
          threadCreated(A, { parentThreadId: PARENT }),
          threadCreated(B, { parentThreadId: OTHER_PARENT }), // cross-parent → non-sibling
          threadCreated(archived, { parentThreadId: PARENT }),
          threadArchived(archived),
        ]),
      );
      const dang = yield* rejectionDetail(setDeps(T, [dangling]), model);
      expect(dang).toContain(dangling);
      const cross = yield* rejectionDetail(setDeps(T, [B]), model);
      expect(cross).toContain(B);
      const arch = yield* rejectionDetail(setDeps(T, [archived]), model);
      expect(arch).toContain(archived);
      // A set of only active siblings is accepted.
      const ok = yield* decide(setDeps(T, [A]), model);
      expect(ok.map((event) => event.type)).toEqual(["thread.dependencies-set"]);
    }),
  );

  it.effect("rejects setting dependencies on a root thread", () =>
    Effect.gen(function* () {
      const model = yield* Effect.flatMap(base, (m) =>
        apply(m, [threadCreated(A, { parentThreadId: PARENT })]),
      );
      const detail = yield* rejectionDetail(setDeps(PARENT, [A]), model);
      expect(detail).toContain("root thread");
    }),
  );

  it.effect("rejects a self-referential set", () =>
    Effect.gen(function* () {
      const model = yield* Effect.flatMap(base, (m) =>
        apply(m, [threadCreated(T, { parentThreadId: PARENT })]),
      );
      const detail = yield* rejectionDetail(setDeps(T, [T]), model);
      expect(detail).toContain("block on itself");
    }),
  );

  it.effect("allows clearing dependencies (empty set) on any thread", () =>
    Effect.gen(function* () {
      const model = yield* Effect.flatMap(base, (m) =>
        apply(m, [
          threadCreated(A, { parentThreadId: PARENT }),
          threadCreated(T, { parentThreadId: PARENT, blockedBy: [A] }),
        ]),
      );
      // Never rejected by the coherence backstop — the empty set skips it entirely.
      const ok = yield* decide(setDeps(T, []), model);
      expect(ok.map((event) => event.type)).toEqual(["thread.dependencies-set"]);
      // On a thread that already has NO dependencies, the same clear is accepted
      // but writes nothing (W2-4 unchanged-value guard) — `dependencies-set` is a
      // dispatcher trigger, so the redundant echo is pure amplification.
      expect(yield* decide(setDeps(A, []), model)).toEqual([]);
    }),
  );

  // ---- Test 11b: thread.create (R1 / R2) ----
  it.effect("rejects create behind a pre-existing sibling cycle", () =>
    Effect.gen(function* () {
      const model = yield* Effect.flatMap(base, (m) =>
        apply(m, [
          threadCreated(A, { parentThreadId: PARENT, blockedBy: [B] }),
          threadCreated(B, { parentThreadId: PARENT, blockedBy: [A] }),
        ]),
      );
      const detail = yield* rejectionDetail(
        createThread(T, { parentThreadId: PARENT, blockedBy: [A] }),
        model,
      );
      expect(detail).toContain("cycle");
    }),
  );

  it.effect("rejects create with a dangling blockedBy id, naming it", () =>
    Effect.gen(function* () {
      const dangling = ThreadId.make("ghost-1");
      const model = yield* base;
      const detail = yield* rejectionDetail(
        createThread(T, { parentThreadId: PARENT, blockedBy: [dangling] }),
        model,
      );
      expect(detail).toContain(dangling);
    }),
  );

  it.effect("rejects create with a dangling loop-route target, naming it", () =>
    Effect.gen(function* () {
      const ghost = ThreadId.make("ghost-route");
      const routes: ReadonlyArray<WorkstreamRoute> = [
        { on: ["needs_rework"], kind: "loop", to: ghost },
      ];
      const model = yield* base;
      const detail = yield* rejectionDetail(
        createThread(T, { parentThreadId: PARENT, routes }),
        model,
      );
      expect(detail).toContain(ghost);
    }),
  );

  it.effect("leaves create with empty/absent blockedBy unaffected (sub-thread and root)", () =>
    Effect.gen(function* () {
      const model = yield* Effect.flatMap(base, (m) =>
        apply(m, [threadCreated(A, { parentThreadId: PARENT })]),
      );
      const sub = yield* decide(createThread(T, { parentThreadId: PARENT, blockedBy: [A] }), model);
      expect(sub.map((event) => event.type)).toEqual(["thread.created"]);
      const root = yield* decide(createThread(ThreadId.make("new-root")), model);
      expect(root.map((event) => event.type)).toEqual(["thread.created"]);
    }),
  );

  // ---- Test 11c: R3 — edge onto an already-cancelled dependency ----
  it.effect("raises needs_guidance wiring an un-started child onto a cancelled sibling", () =>
    Effect.gen(function* () {
      const model = yield* Effect.flatMap(base, (m) =>
        apply(m, [
          threadCreated(X, { parentThreadId: PARENT, planLane: "cancelled" }),
          threadCreated(T, { parentThreadId: PARENT, planLane: "planned" }),
        ]),
      );
      const events = yield* decide(setDeps(T, [X]), model);
      expect(events.map((event) => event.type)).toEqual([
        "thread.dependencies-set",
        "thread.attention-raised",
      ]);
      const raised = events.find((event) => event.type === "thread.attention-raised");
      expect(raised).toBeDefined();
      expect(raised?.aggregateId).toBe(T);
      expect(raised?.payload).toMatchObject({ threadId: T, reason: "needs_guidance" });
    }),
  );

  it.effect("raises nothing wiring onto a live sibling", () =>
    Effect.gen(function* () {
      const model = yield* Effect.flatMap(base, (m) =>
        apply(m, [
          threadCreated(Y, { parentThreadId: PARENT, planLane: "ready" }),
          threadCreated(T, { parentThreadId: PARENT, planLane: "planned" }),
        ]),
      );
      const events = yield* decide(setDeps(T, [Y]), model);
      expect(events.map((event) => event.type)).toEqual(["thread.dependencies-set"]);
    }),
  );

  it.effect("raises nothing when the target has already started or is terminal", () =>
    Effect.gen(function* () {
      const started = ThreadId.make("thread-started");
      const doneT = ThreadId.make("thread-done");
      const model = yield* Effect.flatMap(base, (m) =>
        apply(m, [
          threadCreated(X, { parentThreadId: PARENT, planLane: "cancelled" }),
          threadCreated(started, { parentThreadId: PARENT, planLane: "in_progress" }),
          userMessage(started),
          threadCreated(doneT, { parentThreadId: PARENT, planLane: "done" }),
        ]),
      );
      const startedEvents = yield* decide(setDeps(started, [X]), model);
      expect(startedEvents.map((event) => event.type)).toEqual(["thread.dependencies-set"]);
      const doneEvents = yield* decide(setDeps(doneT, [X]), model);
      expect(doneEvents.map((event) => event.type)).toEqual(["thread.dependencies-set"]);
    }),
  );
});
