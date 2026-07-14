// Scaffold-first graph authoring (workstream-scaffold plan §0/§1a): the
// `thread.scaffold` engine command creates a whole child graph atomically, and
// `thread.kickoff-brief.set` attaches the on-disk brief pointer. These tests
// exercise the decider's transactional batch validation + emission.
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const PROJECT = ProjectId.make("project-scaffold");
const PARENT = ThreadId.make("parent-1");
const MODEL: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
};

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
      modelSelection: MODEL,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      ...extra,
    },
  });

const apply = (readModel: OrchestrationReadModel, events: ReadonlyArray<OrchestrationEvent>) =>
  Effect.gen(function* () {
    let model = readModel;
    for (const event of events) model = yield* projectEvent(model, event);
    return model;
  });

/** Project + parent (with an inheritable worktree) every fixture builds on. */
const base = Effect.gen(function* () {
  seq = 0;
  return yield* apply(createEmptyReadModel(now), [
    seedEvent({
      aggregateKind: "project",
      aggregateId: PROJECT,
      type: "project.created",
      payload: {
        projectId: PROJECT,
        title: "Scaffold",
        workspaceRoot: "/tmp/scaffold",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
    threadCreated(PARENT, {
      runtimeMode: "auto-accept-edits",
      branch: "main",
      worktreePath: "/tmp/scaffold/parent",
    }),
  ]);
});

type ScaffoldNode = {
  threadId: ThreadId;
  graphKey: string;
  role?: string | null;
  title?: string;
  purpose?: string | null;
  blockedBy?: ReadonlyArray<ThreadId>;
  planLane?: "ready" | "planned";
};

const scaffold = (
  nodes: ReadonlyArray<ScaffoldNode>,
  extra: { staged?: boolean } = {},
): OrchestrationCommand =>
  ({
    type: "thread.scaffold",
    commandId: CommandId.make(`server:scaffold-${nodes.map((n) => n.graphKey).join(",")}`),
    parentThreadId: PARENT,
    ...(extra.staged !== undefined ? { staged: extra.staged } : {}),
    nodes: nodes.map((n) => ({
      threadId: n.threadId,
      graphKey: n.graphKey,
      role: n.role ?? "coder",
      title: n.title ?? `Node ${n.graphKey}`,
      purpose: n.purpose ?? null,
      ...(n.blockedBy !== undefined ? { blockedBy: n.blockedBy } : {}),
      ...(n.planLane !== undefined ? { planLane: n.planLane } : {}),
      modelSelection: MODEL,
    })),
    createdAt: now,
  }) as OrchestrationCommand;

const briefSet = (threadId: ThreadId, kickoffBriefPath: string): OrchestrationCommand => ({
  type: "thread.kickoff-brief.set",
  commandId: CommandId.make(`server:brief-${threadId}`),
  threadId,
  kickoffBriefPath,
  createdAt: now,
});

const decide = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

const rejectionDetail = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.flip,
    Effect.map((error) =>
      error._tag === "OrchestrationCommandInvariantError" ? error.detail : `unexpected: ${error}`,
    ),
  );

const A = ThreadId.make("11111111-1111-4111-8111-111111111111");
const B = ThreadId.make("22222222-2222-4222-8222-222222222222");
const C = ThreadId.make("33333333-3333-4333-8333-333333333333");

it.layer(NodeServices.layer)("thread.scaffold decider", (it) => {
  it.effect("creates every node atomically, inheriting parent shared fields", () =>
    Effect.gen(function* () {
      const model = yield* base;
      const events = yield* decide(
        scaffold([
          { threadId: A, graphKey: "api" },
          { threadId: B, graphKey: "web", blockedBy: [A] },
        ]),
        model,
      );
      expect(events.map((e) => e.type)).toEqual(["thread.created", "thread.created"]);
      const [a, b] = events;
      expect((a.payload as Record<string, unknown>).graphKey).toBe("api");
      expect((a.payload as Record<string, unknown>).planLane).toBe("ready");
      // Shared per-parent fields are inherited from the parent thread.
      expect((a.payload as Record<string, unknown>).runtimeMode).toBe("auto-accept-edits");
      expect((a.payload as Record<string, unknown>).branch).toBe("main");
      expect((a.payload as Record<string, unknown>).worktreePath).toBe("/tmp/scaffold/parent");
      expect((a.payload as Record<string, unknown>).parentThreadId).toBe(PARENT);
      expect((b.payload as Record<string, unknown>).blockedBy).toEqual([A]);
    }),
  );

  it.effect("staged scaffold creates every node planned", () =>
    Effect.gen(function* () {
      const model = yield* base;
      const events = yield* decide(
        scaffold([{ threadId: A, graphKey: "api" }], { staged: true }),
        model,
      );
      expect((events[0].payload as Record<string, unknown>).planLane).toBe("planned");
    }),
  );

  it.effect("rejects a duplicate key within the batch", () =>
    Effect.gen(function* () {
      const model = yield* base;
      const detail = yield* rejectionDetail(
        scaffold([
          { threadId: A, graphKey: "dup" },
          { threadId: B, graphKey: "dup" },
        ]),
        model,
      );
      expect(detail).toContain("duplicated");
    }),
  );

  it.effect("rejects a key already used by an existing child (unique-forever)", () =>
    Effect.gen(function* () {
      const model = yield* Effect.flatMap(base, (m) =>
        apply(m, [threadCreated(C, { parentThreadId: PARENT, graphKey: "api" })]),
      );
      const detail = yield* rejectionDetail(scaffold([{ threadId: A, graphKey: "api" }]), model);
      expect(detail).toContain("unique-forever");
    }),
  );

  it.effect("rejects a UUID-shaped key", () =>
    Effect.gen(function* () {
      const model = yield* base;
      const detail = yield* rejectionDetail(
        scaffold([{ threadId: A, graphKey: "44444444-4444-4444-8444-444444444444" }]),
        model,
      );
      expect(detail).toContain("UUID-shaped");
    }),
  );

  it.effect("rejects a dangling reference, naming the node", () =>
    Effect.gen(function* () {
      const model = yield* base;
      const detail = yield* rejectionDetail(
        scaffold([{ threadId: A, graphKey: "web", blockedBy: [B] }]),
        model,
      );
      expect(detail).toContain("web");
      expect(detail).toContain(B);
    }),
  );

  it.effect("rejects a cycle across the batch", () =>
    Effect.gen(function* () {
      const model = yield* base;
      const detail = yield* rejectionDetail(
        scaffold([
          { threadId: A, graphKey: "api", blockedBy: [B] },
          { threadId: B, graphKey: "web", blockedBy: [A] },
        ]),
        model,
      );
      expect(detail).toContain("cycle");
    }),
  );

  it.effect("rejects a preallocated id that already exists", () =>
    Effect.gen(function* () {
      const model = yield* Effect.flatMap(base, (m) =>
        apply(m, [threadCreated(A, { parentThreadId: PARENT, graphKey: "existing" })]),
      );
      const detail = yield* rejectionDetail(scaffold([{ threadId: A, graphKey: "api" }]), model);
      expect(detail).toContain(A);
    }),
  );

  it.effect("allows a batch node to depend on an existing active sibling", () =>
    Effect.gen(function* () {
      const model = yield* Effect.flatMap(base, (m) =>
        apply(m, [threadCreated(C, { parentThreadId: PARENT, graphKey: "seed" })]),
      );
      const events = yield* decide(
        scaffold([{ threadId: A, graphKey: "api", blockedBy: [C] }]),
        model,
      );
      expect((events[0].payload as Record<string, unknown>).blockedBy).toEqual([C]);
    }),
  );
});

it.layer(NodeServices.layer)("thread.kickoff-brief.set decider", (it) => {
  it.effect("emits thread.kickoff-brief-set on a scaffolded child", () =>
    Effect.gen(function* () {
      const model = yield* Effect.flatMap(base, (m) =>
        apply(m, [threadCreated(A, { parentThreadId: PARENT, graphKey: "api" })]),
      );
      const events = yield* decide(briefSet(A, "/tmp/briefs/api.md"), model);
      expect(events.map((e) => e.type)).toEqual(["thread.kickoff-brief-set"]);
      expect((events[0].payload as Record<string, unknown>).kickoffBriefPath).toBe(
        "/tmp/briefs/api.md",
      );
    }),
  );

  it.effect("rejects a kickoff brief on a root thread", () =>
    Effect.gen(function* () {
      const model = yield* base;
      const detail = yield* rejectionDetail(briefSet(PARENT, "/tmp/briefs/root.md"), model);
      expect(detail).toContain("root");
    }),
  );
});
