import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ThreadId,
  TurnId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderValidationError } from "../Errors.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderSessionReaperLive } from "./ProviderSessionReaper.ts";

const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = (await Effect.runPromise(Clock.currentTimeMillis)) + timeoutMs;
  const poll = async (): Promise<void> => {
    if (await predicate()) {
      return;
    }
    if ((await Effect.runPromise(Clock.currentTimeMillis)) >= deadline) {
      throw new Error("Timed out waiting for expectation.");
    }
    await Effect.runPromise(Effect.yieldNow);
    return poll();
  };

  return poll();
}

const drainFibers = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
});

const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

/**
 * Outstanding obligations per thread, as the sweep's narrow
 * `getThreadObligations` query would report them. Absent ids owe nothing.
 */
type Obligations = {
  readonly activeTurnId?: TurnId | null;
  readonly liveChildCount?: number;
  readonly hasUnmetDependencies?: boolean;
  readonly openUserInputCount?: number;
  readonly pendingRework?: boolean;
};

const NO_OBLIGATIONS = {
  activeTurnId: null,
  liveChildCount: 0,
  hasUnmetDependencies: false,
  openUserInputCount: 0,
  pendingRework: false,
} as const;

function makeReadModel(
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly session: {
      readonly threadId: ThreadId;
      readonly status: "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
      readonly providerName: "codex" | "claudeAgent";
      readonly runtimeMode: "approval-required" | "full-access" | "auto-accept-edits";
      readonly activeTurnId: TurnId | null;
      readonly lastError: string | null;
      readonly updatedAt: string;
    } | null;
  }>,
) {
  const now = "2026-01-01T00:00:00.000Z";
  const projectId = ProjectId.make("project-provider-session-reaper");

  return {
    snapshotSequence: 0,
    updatedAt: now,
    goals: [],
    projects: [
      {
        id: projectId,
        title: "Provider Reaper Project",
        workspaceRoot: "/tmp/provider-reaper-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: threads.map((thread) => ({
      id: thread.id,
      projectId,
      goalId: null,
      parentThreadId: null,
      role: null,
      purpose: null,
      brief: null,
      planLane: "planned" as const,
      attention: [],
      blockedBy: [],
      spawnGeneration: null,
      forkFromThreadId: null,
      reportPath: null,
      graphKey: null,
      kickoffBriefPath: null,
      planLaneSince: null,
      dependenciesSince: null,
      faninSince: null,
      routes: [],
      gateRounds: 0,
      pendingRework: false,
      lastOutcome: null,
      isolation: "shared" as const,
      fanInState: "none" as const,
      title: `Thread ${thread.id}`,
      modelSelection: defaultModelSelection,
      interactionMode: "default" as const,
      runtimeMode: "full-access" as const,
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      toolUses: null,
      usedTokens: null,
      maxTokens: null,
      diffAdditions: null,
      diffDeletions: null,
      handoffCount: 0,
      notifySendLog: [],
      latestTurn: null,
      messages: [],
      session: thread.session
        ? { ...thread.session, queuedMessages: { steering: [], followUp: [] } }
        : null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    })),
  };
}

describe("ProviderSessionReaper", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | ProviderSessionReaper
    | ProviderSessionDirectory
    | ProviderSessionRuntime.ProviderSessionRuntimeRepository,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  async function createHarness(input: {
    readonly readModel: ReturnType<typeof makeReadModel>;
    readonly obligationsByThreadId?: ReadonlyMap<ThreadId, Obligations>;
    readonly failThreadLivenessRead?: boolean;
    /** Threads whose `deleted_at` is set (irreversible). */
    readonly deletedThreadIds?: ReadonlySet<ThreadId>;
    readonly stopSessionImplementation?: (input: {
      readonly threadId: ThreadId;
    }) => ReturnType<ProviderServiceShape["stopSession"]>;
  }) {
    const stoppedThreadIds = new Set<ThreadId>();
    // Retention must classify every binding without a per-binding projection
    // read: `getThreadShellById` costs six SQL statements each, so per-row use
    // would be a periodic global stall on the single serial connection.
    let threadShellReads = 0;
    let deletedThreadIdsReads = 0;
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(
      (request) =>
        (input.stopSessionImplementation
          ? input.stopSessionImplementation(request)
          : Effect.sync(() => {
              stoppedThreadIds.add(request.threadId);
            })) as ReturnType<ProviderServiceShape["stopSession"]>,
    );

    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession,
      listSessions: () => Effect.succeed([]),
      getSession: () => Effect.succeed(undefined),
      getCapabilities: () =>
        Effect.succeed({ sessionModelSwitch: "in-session", emitsExitOnStop: true }),
      getInstanceInfo: (instanceId) => {
        const driverKind = ProviderDriverKind.make(String(instanceId));
        return Effect.succeed({
          instanceId,
          driverKind,
          displayName: undefined,
          enabled: true,
          continuationIdentity: {
            driverKind,
            continuationKey: `${driverKind}:instance:${instanceId}`,
          },
        });
      },
      rollbackConversation: () => unsupported(),
      streamEvents: Stream.empty,
    };

    const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
      Layer.provide(SqlitePersistenceMemory),
    );
    const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
      Layer.provide(runtimeRepositoryLayer),
    );
    const layer = makeProviderSessionReaperLive({
      inactivityThresholdMs: 1_000,
      sweepIntervalMs: 60_000,
    }).pipe(
      Layer.provideMerge(providerSessionDirectoryLayer),
      Layer.provideMerge(runtimeRepositoryLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provideMerge(
        Layer.succeed(ProjectionSnapshotQuery, {
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () =>
            Effect.succeed({ snapshotSequence: input.readModel.snapshotSequence }),
          getCounts: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
          getProjectShellById: () => Effect.die("unused"),
          getGoalShellById: () => Effect.die("unused"),
          getGoalById: () => Effect.die("unused"),
          listGoalSlugsByProjectId: () => Effect.die("unused"),
          listActiveProjectRefs: () => Effect.die("unused"),
          getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.die("unused"),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: (threadId) => {
            threadShellReads += 1;
            if (input.failThreadLivenessRead) {
              return Effect.fail(
                new PersistenceSqlError({
                  operation: "ProjectionSnapshotQuery.getThreadShellById:query",
                  cause: new Error("simulated projection read failure"),
                }),
              );
            }
            const found = input.readModel.threads.find((thread) => thread.id === threadId);
            return Effect.succeed(
              found
                ? Option.some({
                    ...found,
                    lastActivityPreview: null,
                    consults: [],
                    peerMessages: [],
                    notifySendLog: [],
                  })
                : Option.none(),
            );
          },
          getThreadDetailById: () => Effect.die("unused"),
          getThreadDetailSnapshotById: () => Effect.die("unused"),
          getThreadActivitiesPage: () => Effect.die("unused"),
          getThreadLifecycle: () => Effect.die("unused"),
          getLiveSubtreeSessionLiveness: () => Effect.succeed([]),
          getThreadObligations: (threadId) =>
            Effect.succeed({
              ...NO_OBLIGATIONS,
              ...input.obligationsByThreadId?.get(threadId),
            }),
          getPendingTurnStartThreadIds: () => Effect.succeed(new Set()),
          getDeletedThreadIds: () => {
            deletedThreadIdsReads += 1;
            if (input.failThreadLivenessRead) {
              return Effect.fail(
                new PersistenceSqlError({
                  operation: "ProjectionSnapshotQuery.getDeletedThreadIds:query",
                  cause: new Error("simulated projection read failure"),
                }),
              );
            }
            return Effect.succeed(input.deletedThreadIds ?? new Set<ThreadId>());
          },
          listPendingPeerMessages: () => Effect.succeed([]),
          getActivityFreshnessByThreadId: () =>
            Effect.succeed({ maxCreatedAt: null, heartbeatAt: null }),
          getOpenUserInputRequestIdsByThreadId: () => Effect.die("unused in this test"),
          getRecentToolActivityByThreadId: () => Effect.succeed([]),
          getThreadProgressSignal: () =>
            Effect.succeed({ recentInputsSource: null, checkpointSource: null }),
          getInFlightToolByThreadId: () => Effect.succeed(null),
          getThreadDetailSnapshot: () => Effect.die("unused"),
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    return {
      stopSession,
      stoppedThreadIds,
      threadShellReads: () => threadShellReads,
      deletedThreadIdsReads: () => deletedThreadIdsReads,
    };
  }

  /** Persist a stale (past the harness's 1s threshold) running binding. */
  async function persistStaleBinding(input: {
    readonly threadId: ThreadId;
    readonly providerName: "codex" | "claudeAgent";
    readonly resumeOpaque: string;
    readonly lastSeenAt?: string;
  }) {
    await runtime!.runPromise(
      Effect.flatMap(
        Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
        (repository) =>
          repository.upsert({
            threadId: input.threadId,
            providerName: input.providerName,
            providerInstanceId: null,
            adapterKey: input.providerName,
            runtimeMode: "full-access",
            status: "running",
            lastSeenAt: input.lastSeenAt ?? "2026-04-14T00:00:00.000Z",
            resumeCursor: { opaque: input.resumeOpaque },
            runtimePayload: null,
          }),
      ),
    );
  }

  /** Start the reaper's sweep fiber in a fresh scope the afterEach closes. */
  async function startReaper() {
    scope = await Effect.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(
      Effect.flatMap(Effect.service(ProviderSessionReaper), (reaper) =>
        reaper.start().pipe(Scope.provide(scope!)),
      ),
    );
  }

  /** Whether the binding survived the sweep (i.e. the session was not reaped). */
  async function bindingStillPersisted(threadId: ThreadId) {
    return runtime!.runPromise(
      Effect.flatMap(
        Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
        (repository) =>
          Effect.map(repository.getByThreadId({ threadId }), (row) => Option.isSome(row)),
      ),
    );
  }

  /** A ready session with no active turn of its own — the idle-orchestrator shape. */
  const idleSessionFor = (threadId: ThreadId) =>
    ({
      threadId,
      status: "ready",
      providerName: "claudeAgent",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }) as const;

  it("reaps stale persisted sessions without active turns", async () => {
    const threadId = ThreadId.make("thread-reaper-stale");
    const harness = await createHarness({
      readModel: makeReadModel([{ id: threadId, session: idleSessionFor(threadId) }]),
    });
    await persistStaleBinding({
      threadId,
      providerName: "claudeAgent",
      resumeOpaque: "resume-stale",
    });

    await startReaper();

    await waitFor(() => harness.stopSession.mock.calls.length === 1);

    expect(harness.stopSession.mock.calls[0]?.[0]).toEqual({ threadId });
    expect(harness.stoppedThreadIds.has(threadId)).toBe(true);
  });

  it("skips stale sessions when the thread still has an active turn", async () => {
    const threadId = ThreadId.make("thread-reaper-active-turn");
    const activeTurnId = TurnId.make("turn-reaper-active");
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: { ...idleSessionFor(threadId), status: "running", activeTurnId },
        },
      ]),
      obligationsByThreadId: new Map([[threadId, { activeTurnId }]]),
    });
    await persistStaleBinding({
      threadId,
      providerName: "claudeAgent",
      resumeOpaque: "resume-active-turn",
    });

    await startReaper();
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(await bindingStillPersisted(threadId)).toBe(true);
  });

  // The shape the reaper used to kill on every sweep: a fanned-out orchestrator
  // has no active turn of its own (its turn ended when it finished spawning) and
  // its binding's `lastSeenAt` is bumped only by its OWN activity, so a child
  // running for hours leaves the parent looking abandoned.
  it.each<readonly [string, Obligations]>([
    ["a live child", { liveChildCount: 1 }],
    ["an unmet dependency", { hasUnmetDependencies: true }],
    ["an open user-input request", { openUserInputCount: 1 }],
    ["an open rework round", { pendingRework: true }],
  ])("skips a stale session whose thread still has %s", async (_label, obligations) => {
    const threadId = ThreadId.make("thread-reaper-waiting");
    const harness = await createHarness({
      // No active turn: the orchestrator's own turn ended at spawn time.
      readModel: makeReadModel([{ id: threadId, session: idleSessionFor(threadId) }]),
      obligationsByThreadId: new Map([[threadId, obligations]]),
    });
    await persistStaleBinding({
      threadId,
      providerName: "claudeAgent",
      resumeOpaque: "resume-waiting",
    });

    await startReaper();
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(await bindingStillPersisted(threadId)).toBe(true);
  });

  // The other half of the contract: obligations must not become "never reap".
  it("still reaps a stale orchestrator once every child is terminal", async () => {
    const threadId = ThreadId.make("thread-reaper-finished-orchestrator");
    const harness = await createHarness({
      readModel: makeReadModel([{ id: threadId, session: idleSessionFor(threadId) }]),
      obligationsByThreadId: new Map([[threadId, NO_OBLIGATIONS]]),
    });
    await persistStaleBinding({
      threadId,
      providerName: "claudeAgent",
      resumeOpaque: "resume-finished-orchestrator",
    });

    await startReaper();

    await waitFor(() => harness.stopSession.mock.calls.length === 1);

    expect(harness.stoppedThreadIds.has(threadId)).toBe(true);
  });

  it("does not reap sessions that are still within the inactivity threshold", async () => {
    const threadId = ThreadId.make("thread-reaper-fresh");
    const now = DateTime.formatIso(await Effect.runPromise(DateTime.now));
    const harness = await createHarness({
      readModel: makeReadModel([
        { id: threadId, session: { ...idleSessionFor(threadId), updatedAt: now } },
      ]),
    });
    await persistStaleBinding({
      threadId,
      providerName: "claudeAgent",
      resumeOpaque: "resume-fresh",
      lastSeenAt: now,
    });

    await startReaper();
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(await bindingStillPersisted(threadId)).toBe(true);
  });

  it("keeps a stopped binding whose thread is still live so it stays resumable", async () => {
    const threadId = ThreadId.make("thread-reaper-stopped");
    const harness = await createHarness({
      readModel: makeReadModel([
        { id: threadId, session: { ...idleSessionFor(threadId), status: "stopped" } },
      ]),
    });
    await runtime!.runPromise(
      Effect.flatMap(
        Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
        (repository) =>
          repository.upsert({
            threadId,
            providerName: "claudeAgent",
            providerInstanceId: null,
            adapterKey: "claudeAgent",
            runtimeMode: "full-access",
            status: "stopped",
            lastSeenAt: "2026-04-14T00:00:00.000Z",
            resumeCursor: { opaque: "resume-stopped" },
            runtimePayload: null,
          }),
      ),
    );

    await startReaper();
    await Effect.runPromise(drainFibers);

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(await bindingStillPersisted(threadId)).toBe(true);
  });

  // One binding's stop failing (or defecting) must not abandon the rest of the
  // sweep, so both faults are exercised over the same two-binding fixture.
  it.each([
    [
      "fails",
      ThreadId.make("thread-reaper-stop-failure"),
      ThreadId.make("thread-reaper-stop-success"),
      () =>
        Effect.fail(
          new ProviderValidationError({
            operation: "ProviderSessionReaper.test",
            issue: "simulated stop failure",
          }),
        ),
    ],
    [
      "defects",
      ThreadId.make("thread-reaper-stop-defect"),
      ThreadId.make("thread-reaper-stop-after-defect"),
      () => Effect.die(new Error("simulated stop defect")),
    ],
  ] as ReadonlyArray<
    readonly [string, ThreadId, ThreadId, () => ReturnType<ProviderServiceShape["stopSession"]>]
  >)(
    "continues reaping other sessions when one stop attempt %s",
    async (label, faultingThreadId, reapedThreadId, fault) => {
      const harness = await createHarness({
        readModel: makeReadModel([
          { id: faultingThreadId, session: idleSessionFor(faultingThreadId) },
          {
            id: reapedThreadId,
            session: { ...idleSessionFor(reapedThreadId), providerName: "codex" },
          },
        ]),
        stopSessionImplementation: (request) =>
          request.threadId === faultingThreadId ? fault() : Effect.void,
      });

      await persistStaleBinding({
        threadId: faultingThreadId,
        providerName: "claudeAgent",
        resumeOpaque: `resume-${label}`,
      });
      await persistStaleBinding({
        threadId: reapedThreadId,
        providerName: "codex",
        resumeOpaque: `resume-after-${label}`,
        lastSeenAt: "2026-04-14T00:01:00.000Z",
      });

      await startReaper();

      await waitFor(() => harness.stopSession.mock.calls.length === 2);

      expect(harness.stopSession.mock.calls.map(([request]) => request.threadId)).toEqual([
        faultingThreadId,
        reapedThreadId,
      ]);
    },
  );

  it("prunes a deleted thread's stopped binding but keeps an archived one", async () => {
    const deletedThreadId = ThreadId.make("thread-reaper-prune-deleted");
    const archivedThreadId = ThreadId.make("thread-reaper-prune-archived");
    const liveThreadId = ThreadId.make("thread-reaper-prune-live");
    const now = "2026-01-01T00:00:00.000Z";
    // Archived AND deleted threads are both absent from the shell read model
    // (its query filters both), so absence cannot distinguish them. Only the
    // deleted set may be pruned: `thread.archive` has a matching
    // `thread.unarchive` command, so an archived thread can be restored and
    // still needs its provider pointer. Deletion has no undo.
    const harness = await createHarness({
      readModel: makeReadModel([
        {
          id: liveThreadId,
          session: {
            threadId: liveThreadId,
            status: "stopped",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: now,
          },
        },
      ]),
      deletedThreadIds: new Set([deletedThreadId]),
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    for (const [threadId, providerName] of [
      [deletedThreadId, "claudeAgent"],
      [archivedThreadId, "claudeAgent"],
      [liveThreadId, "codex"],
    ] as const) {
      await runtime!.runPromise(
        repository.upsert({
          threadId,
          providerName,
          providerInstanceId: null,
          adapterKey: providerName,
          runtimeMode: "full-access",
          status: "stopped",
          // Identical lastSeenAt across all three: retention must not be judged
          // from age. `runStopAll` rewrites every binding at shutdown, so all
          // stopped rows share one fresh timestamp in production.
          lastSeenAt: "2026-04-14T00:00:00.000Z",
          resumeCursor: null,
          runtimePayload: null,
        }),
      );
    }

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));

    await waitFor(async () =>
      Option.isNone(
        await runtime!.runPromise(repository.getByThreadId({ threadId: deletedThreadId })),
      ),
    );

    // Archived: restorable, so its resume pointer must survive.
    const archived = await runtime!.runPromise(
      repository.getByThreadId({ threadId: archivedThreadId }),
    );
    expect(Option.isSome(archived)).toBe(true);
    const live = await runtime!.runPromise(repository.getByThreadId({ threadId: liveThreadId }));
    expect(Option.isSome(live)).toBe(true);
    expect(harness.stopSession).not.toHaveBeenCalled();

    // Query budget: one bulk lifecycle read for the whole sweep, and NOT one
    // six-statement shell lookup per stopped binding.
    expect(harness.deletedThreadIdsReads()).toBe(1);
    expect(harness.threadShellReads()).toBe(0);
  });

  it("does not prune a binding that a concurrent start promoted back to running", async () => {
    // The sweep decides from a listBindings snapshot, so a start/recovery can
    // re-upsert the row to `running` before the delete lands. The delete is
    // conditional on the row still being `stopped`, so the live session's
    // routing binding must survive.
    const threadId = ThreadId.make("thread-reaper-prune-race");
    const harness = await createHarness({ readModel: makeReadModel([]) });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: null,
        runtimePayload: null,
      }),
    );

    // Simulate the interleaving: the row is promoted to `running` after the
    // snapshot the sweep would have read, but before the sweep's delete.
    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "running",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: null,
        runtimePayload: null,
      }),
    );

    const directory = await runtime!.runPromise(Effect.service(ProviderSessionDirectory));
    const removed = await runtime!.runPromise(directory.removeIfStopped(threadId));

    expect(removed).toBe(false);
    const surviving = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(surviving)).toBe(true);
    expect(harness.stopSession).not.toHaveBeenCalled();
  });
  it("keeps a stopped binding when the deleted-thread read fails", async () => {
    // A failed lifecycle read must never be mistaken for "thread deleted":
    // deleting on a transient projection error would destroy a live thread's
    // routing binding, which is unrecoverable, whereas keeping the row costs
    // nothing but one more sweep.
    const threadId = ThreadId.make("thread-reaper-liveness-unknown");
    const harness = await createHarness({
      readModel: makeReadModel([]),
      failThreadLivenessRead: true,
    });
    const repository = await runtime!.runPromise(
      Effect.service(ProviderSessionRuntime.ProviderSessionRuntimeRepository),
    );

    await runtime!.runPromise(
      repository.upsert({
        threadId,
        providerName: "claudeAgent",
        providerInstanceId: null,
        adapterKey: "claudeAgent",
        runtimeMode: "full-access",
        status: "stopped",
        lastSeenAt: "2026-04-14T00:00:00.000Z",
        resumeCursor: null,
        runtimePayload: null,
      }),
    );

    const reaper = await runtime!.runPromise(Effect.service(ProviderSessionReaper));
    scope = await runtime!.runPromise(Scope.make("sequential"));
    await runtime!.runPromise(reaper.start().pipe(Scope.provide(scope)));
    await runtime!.runPromise(drainFibers);

    const surviving = await runtime!.runPromise(repository.getByThreadId({ threadId }));
    expect(Option.isSome(surviving)).toBe(true);
    expect(harness.stopSession).not.toHaveBeenCalled();
  });
});
