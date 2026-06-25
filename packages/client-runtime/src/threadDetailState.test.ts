import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  EventId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadStreamItem,
} from "@t3tools/contracts";

import { createThreadDetailManager, type ThreadDetailClient } from "./threadDetailState.ts";

let atomRegistry = AtomRegistry.make();

function resetAtomRegistry() {
  atomRegistry.dispose();
  atomRegistry = AtomRegistry.make();
}

function registerListener<T>(listeners: Set<(event: T) => void>, listener: (event: T) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const baseEventFields = {
  eventId: EventId.make("event-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

const BASE_THREAD: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  goalId: null,
  parentThreadId: null,
  role: null,
  purpose: null,
  status: "planned" as const,
  blockedBy: [],
  spawnGeneration: null,
  reportPath: null,
  title: "Test Thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

const TARGET = {
  environmentId: EnvironmentId.make("env-local"),
  threadId: ThreadId.make("thread-1"),
} as const;

function createMockClient(): {
  client: ThreadDetailClient;
  listeners: Set<(event: OrchestrationThreadStreamItem) => void>;
  emit: (event: OrchestrationThreadStreamItem) => void;
} {
  const listeners = new Set<(event: OrchestrationThreadStreamItem) => void>();
  const client: ThreadDetailClient = {
    subscribeThread: vi.fn((_input, listener: (event: OrchestrationThreadStreamItem) => void) =>
      registerListener(listeners, listener),
    ),
  };

  return {
    client,
    listeners,
    emit: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

describe("createThreadDetailManager", () => {
  afterEach(() => {
    vi.useRealTimers();
    resetAtomRegistry();
  });

  it("starts in a pending state when watching", () => {
    const { client } = createMockClient();
    const manager = createThreadDetailManager({
      getRegistry: () => atomRegistry,
      getClient: () => null,
    });

    manager.watch(TARGET, client);

    expect(manager.getSnapshot(TARGET)).toEqual({
      data: null,
      error: null,
      isPending: true,
      isDeleted: false,
    });
  });

  it("applies snapshots and incremental events", () => {
    const { client, emit } = createMockClient();
    const manager = createThreadDetailManager({
      getRegistry: () => atomRegistry,
      getClient: () => null,
    });

    const release = manager.watch(TARGET, client);

    emit({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        thread: BASE_THREAD,
      },
    });

    emit({
      kind: "event",
      event: {
        ...baseEventFields,
        sequence: 2,
        occurredAt: "2026-04-01T01:00:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-sent",
        payload: {
          threadId: ThreadId.make("thread-1"),
          turnId: TurnId.make("turn-1"),
          messageId: MessageId.make("message-1"),
          role: "assistant",
          text: "hello",
          streaming: false,
          createdAt: "2026-04-01T01:00:00.000Z",
          updatedAt: "2026-04-01T01:00:00.000Z",
        },
      } as any,
    });

    expect(manager.getSnapshot(TARGET)).toEqual({
      data: {
        ...BASE_THREAD,
        updatedAt: "2026-04-01T01:00:00.000Z",
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "completed",
          requestedAt: "2026-04-01T01:00:00.000Z",
          startedAt: "2026-04-01T01:00:00.000Z",
          completedAt: "2026-04-01T01:00:00.000Z",
          assistantMessageId: MessageId.make("message-1"),
        },
        messages: [
          {
            id: MessageId.make("message-1"),
            role: "assistant",
            text: "hello",
            turnId: TurnId.make("turn-1"),
            streaming: false,
            createdAt: "2026-04-01T01:00:00.000Z",
            updatedAt: "2026-04-01T01:00:00.000Z",
          },
        ],
      },
      error: null,
      isPending: false,
      isDeleted: false,
    });

    release();
  });

  it("routes transient reasoning-delta items and drops them once durably finalized", () => {
    const { client, emit } = createMockClient();
    const manager = createThreadDetailManager({
      getRegistry: () => atomRegistry,
      getClient: () => null,
    });
    const release = manager.watch(TARGET, client);
    const messageId = MessageId.make("assistant:item-r");

    emit({ kind: "snapshot", snapshot: { snapshotSequence: 1, thread: BASE_THREAD } });
    emit({
      kind: "reasoning-delta",
      payload: {
        kind: "delta",
        threadId: ThreadId.make("thread-1"),
        messageId,
        turnId: TurnId.make("turn-r"),
        text: "Think",
      },
    });

    const afterDelta = manager.getSnapshot(TARGET).data?.messages.find((m) => m.id === messageId);
    expect(afterDelta?.reasoningText).toBe("Think");
    expect(afterDelta?.reasoningStreaming).toBe(true);

    // Durable REPLACE event marks the message finalized.
    emit({
      kind: "event",
      event: {
        ...baseEventFields,
        sequence: 4,
        occurredAt: "2026-04-01T01:20:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-reasoning",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId,
          turnId: TurnId.make("turn-r"),
          reasoningText: "Thinking done",
          reasoningStreaming: false,
          createdAt: "2026-04-01T01:20:00.000Z",
          updatedAt: "2026-04-01T01:20:00.000Z",
        },
      } as any,
    });

    // A late, out-of-order transient delta must be dropped (no duplication).
    emit({
      kind: "reasoning-delta",
      payload: {
        kind: "delta",
        threadId: ThreadId.make("thread-1"),
        messageId,
        turnId: TurnId.make("turn-r"),
        text: "-stale",
      },
    });

    const finalized = manager.getSnapshot(TARGET).data?.messages.find((m) => m.id === messageId);
    expect(finalized?.reasoningText).toBe("Thinking done");
    expect(finalized?.reasoningStreaming).toBe(false);

    release();
  });

  it("scopes reasoning finalization per thread so one thread cannot drop another's live reasoning", () => {
    // Message ids are not globally unique across threads. A manager-wide
    // finalized set would let thread-1's durable REPLACE drop thread-2's live
    // reasoning that happens to share the same message id. This guards that.
    const clientA = createMockClient();
    const clientB = createMockClient();
    const manager = createThreadDetailManager({
      getRegistry: () => atomRegistry,
      getClient: () => null,
    });
    const targetB = {
      environmentId: EnvironmentId.make("env-local"),
      threadId: ThreadId.make("thread-2"),
    } as const;
    const releaseA = manager.watch(TARGET, clientA.client);
    const releaseB = manager.watch(targetB, clientB.client);
    const sharedMessageId = MessageId.make("assistant:item-shared");

    clientA.emit({ kind: "snapshot", snapshot: { snapshotSequence: 1, thread: BASE_THREAD } });
    clientB.emit({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        thread: { ...BASE_THREAD, id: ThreadId.make("thread-2") },
      },
    });

    // Thread-1 durably finalizes the shared message id.
    clientA.emit({
      kind: "event",
      event: {
        ...baseEventFields,
        sequence: 3,
        occurredAt: "2026-04-01T01:20:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.message-reasoning",
        payload: {
          threadId: ThreadId.make("thread-1"),
          messageId: sharedMessageId,
          turnId: TurnId.make("turn-a"),
          reasoningText: "A done",
          reasoningStreaming: false,
          createdAt: "2026-04-01T01:20:00.000Z",
          updatedAt: "2026-04-01T01:20:00.000Z",
        },
      } as any,
    });

    // Thread-2's live delta for the same message id must NOT be dropped.
    clientB.emit({
      kind: "reasoning-delta",
      payload: {
        kind: "delta",
        threadId: ThreadId.make("thread-2"),
        messageId: sharedMessageId,
        turnId: TurnId.make("turn-b"),
        text: "B think",
      },
    });

    const bMessage = manager
      .getSnapshot(targetB)
      .data?.messages.find((m) => m.id === sharedMessageId);
    expect(bMessage?.reasoningText).toBe("B think");
    expect(bMessage?.reasoningStreaming).toBe(true);

    const aMessage = manager
      .getSnapshot(TARGET)
      .data?.messages.find((m) => m.id === sharedMessageId);
    expect(aMessage?.reasoningText).toBe("A done");
    expect(aMessage?.reasoningStreaming).toBe(false);

    releaseA();
    releaseB();
  });

  it("marks threads as deleted when the stream deletes them", () => {
    const { client, emit } = createMockClient();
    const manager = createThreadDetailManager({
      getRegistry: () => atomRegistry,
      getClient: () => null,
    });

    const release = manager.watch(TARGET, client);

    emit({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        thread: BASE_THREAD,
      },
    });
    emit({
      kind: "event",
      event: {
        ...baseEventFields,
        sequence: 3,
        occurredAt: "2026-04-01T01:10:00.000Z",
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.deleted",
        payload: {
          threadId: ThreadId.make("thread-1"),
          deletedAt: "2026-04-01T01:10:00.000Z",
        },
      } as any,
    });

    expect(manager.getSnapshot(TARGET)).toEqual({
      data: null,
      error: null,
      isPending: false,
      isDeleted: true,
    });

    release();
  });

  it("waits for delayed client registration when subscribeClientChanges is configured", () => {
    const connectionListeners = new Set<() => void>();
    const clients = new Map<string, ReturnType<typeof createMockClient>>();
    const manager = createThreadDetailManager({
      getRegistry: () => atomRegistry,
      getClient: (environmentId) => clients.get(environmentId)?.client ?? null,
      getClientIdentity: (environmentId) => (clients.has(environmentId) ? environmentId : null),
      subscribeClientChanges: (listener) => {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      },
    });

    const release = manager.watch(TARGET);
    expect(manager.getSnapshot(TARGET).isPending).toBe(true);

    const mock = createMockClient();
    clients.set("env-local", mock);
    for (const listener of connectionListeners) {
      listener();
    }

    mock.emit({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        thread: BASE_THREAD,
      },
    });

    expect(manager.getSnapshot(TARGET).data?.id).toBe(ThreadId.make("thread-1"));

    release();
  });

  it("evicts idle subscriptions after the configured ttl", () => {
    vi.useFakeTimers();
    const mock = createMockClient();
    const manager = createThreadDetailManager({
      getRegistry: () => atomRegistry,
      getClient: () => mock.client,
      retention: {
        idleTtlMs: 60_000,
        maxRetainedEntries: 10,
      },
    });

    const release = manager.watch(TARGET);
    expect(mock.listeners.size).toBe(1);

    release();
    expect(mock.listeners.size).toBe(1);

    vi.advanceTimersByTime(60_000);
    expect(mock.listeners.size).toBe(0);
  });

  it("keeps non-idle threads warm when the retention policy says to", () => {
    vi.useFakeTimers();
    const mock = createMockClient();
    const manager = createThreadDetailManager({
      getRegistry: () => atomRegistry,
      getClient: () => mock.client,
      retention: {
        idleTtlMs: 60_000,
        maxRetainedEntries: 10,
        shouldKeepWarm: (_target, state) => state.data?.session?.status === "running",
      },
    });

    const release = manager.watch(TARGET);
    mock.emit({
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        thread: {
          ...BASE_THREAD,
          session: {
            threadId: ThreadId.make("thread-1"),
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: TurnId.make("turn-1"),
            lastError: null,
            queuedMessages: { steering: [], followUp: [] },
            updatedAt: "2026-04-01T00:10:00.000Z",
          },
        },
      },
    });

    release();
    vi.advanceTimersByTime(60_000);

    expect(mock.listeners.size).toBe(1);
    manager.reset();
    expect(mock.listeners.size).toBe(0);
  });
});
