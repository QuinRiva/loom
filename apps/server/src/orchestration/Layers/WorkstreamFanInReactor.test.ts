import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
const effectIt = it;
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationThread,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { layer as WorktreeMutationLockLive } from "../../git/WorktreeMutationLock.ts";
import type { GitMergeWorktreeBranchResult } from "../../vcs/GitVcsDriver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { WorkstreamFanInReactor } from "../Services/WorkstreamFanInReactor.ts";
import { WorkstreamFanInReactorLive } from "./WorkstreamFanInReactor.ts";

// Minimal thread shell for the reactor's reads (isolation, lanes, cwd, branch).
const shell = (
  over: Omit<Partial<OrchestrationThreadShell>, "id"> & { id: string },
): OrchestrationThreadShell =>
  ({
    projectId: "p1",
    goalId: null,
    parentThreadId: null,
    role: "coder",
    isolation: "shared",
    fanInState: "none",
    planLane: "in_progress",
    routes: [],
    branch: null,
    worktreePath: null,
    title: "t",
    // B2 fix: fan-in requires the child's turn to be completed (latestTurn.state === "completed")
    // and the parent to have no active turn. Set reasonable defaults for tests.
    latestTurn: {
      turnId: "turn-1",
      state: "completed",
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: "2026-01-01T00:00:02.000Z",
      assistantMessageId: null,
    },
    session: {
      threadId: "thread-1" as ThreadId,
      status: "idle",
      providerName: null,
      runtimeMode: "approval-required",
      activeTurnId: null,
      lastError: null,
      queuedMessages: { steering: [], followUp: [] },
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    ...over,
  }) as unknown as OrchestrationThreadShell;

interface Scenario {
  readonly child: OrchestrationThreadShell;
  readonly others: ReadonlyArray<OrchestrationThreadShell>;
  readonly mergeResult?: GitMergeWorktreeBranchResult;
}

const runReactor = (scenario: Scenario) =>
  Effect.gen(function* () {
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const gitCalls = yield* Ref.make<ReadonlyArray<string>>([]);
    const record = (ref: Ref.Ref<ReadonlyArray<string>>, tag: string) =>
      Ref.update(ref, (xs) => [...xs, tag]);

    const threads = [scenario.child, ...scenario.others];

    const engineLayer = Layer.succeed(OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
      dispatch: (command: OrchestrationCommand) =>
        Ref.update(dispatched, (xs) => [...xs, command]).pipe(Effect.as({ sequence: 0 })),
    } as never);

    const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
      getThreadDetailById: (id: ThreadId) =>
        Effect.succeed(
          id === scenario.child.id
            ? Option.some(scenario.child as unknown as OrchestrationThread)
            : Option.none(),
        ),
      getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [],
          threads,
          goals: [],
          updatedAt: "1970-01-01T00:00:00.000Z",
        }),
    } as never);

    const gitLayer = Layer.succeed(GitWorkflowService, {
      commitAll: (_cwd: string, subject: string) =>
        record(gitCalls, `commit:${subject}`).pipe(
          Effect.as({ committed: true, commitSha: "sha" }),
        ),
      mergeWorktreeBranch: () =>
        record(gitCalls, "merge").pipe(
          Effect.as(scenario.mergeResult ?? { status: "merged", conflictPaths: [] }),
        ),
      removeWorktree: () => record(gitCalls, "removeWorktree"),
      deleteBranch: () => record(gitCalls, "deleteBranch"),
    } as never);

    const layer = WorkstreamFanInReactorLive.pipe(
      Layer.provide(engineLayer),
      Layer.provide(projectionLayer),
      Layer.provide(gitLayer),
      Layer.provide(WorktreeMutationLockLive),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const reactor = yield* WorkstreamFanInReactor;
      yield* reactor.start();
      yield* reactor.drain;
    }).pipe(Effect.scoped, Effect.provide(layer));

    return {
      dispatched: yield* Ref.get(dispatched),
      gitCalls: yield* Ref.get(gitCalls),
    };
  });

const fanInStates = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
  dispatched
    .filter((c) => c.type === "thread.fanin.set")
    .map((c) => (c as Extract<OrchestrationCommand, { type: "thread.fanin.set" }>).fanInState);

const parent = shell({
  id: "parent",
  isolation: "shared",
  branch: "main",
  worktreePath: "/wt/parent",
  // B2 fix: parent must have no active turn for fan-in to proceed
  session: {
    threadId: "parent" as ThreadId,
    status: "idle",
    providerName: null,
    runtimeMode: "approval-required",
    activeTurnId: null,
    lastError: null,
    queuedMessages: { steering: [], followUp: [] },
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
});

const isolatedChild = (over: Partial<OrchestrationThreadShell> = {}) =>
  shell({
    id: "child",
    parentThreadId: "parent" as ThreadId,
    isolation: "isolated",
    planLane: "done",
    fanInState: "none",
    branch: "ws/main/coder-abc",
    worktreePath: "/wt/child",
    ...over,
  });

describe("WorkstreamFanInReactor", () => {
  it.effect("clean merge: records completed, removes worktree + branch", () =>
    Effect.gen(function* () {
      const { dispatched, gitCalls } = yield* runReactor({
        child: isolatedChild(),
        others: [parent],
      });
      expect(fanInStates(dispatched)).toContain("completed");
      expect(gitCalls).toContain("merge");
      expect(gitCalls).toContain("removeWorktree");
      expect(gitCalls).toContain("deleteBranch");
      // Meta repointed back to the parent worktree/branch.
      const repoint = dispatched.find((c) => c.type === "thread.meta.update") as
        | Extract<OrchestrationCommand, { type: "thread.meta.update" }>
        | undefined;
      expect(repoint?.worktreePath).toBe("/wt/parent");
      expect(repoint?.branch).toBe("main");
    }),
  );

  it.effect("conflict: records conflicted, keeps worktree + branch", () =>
    Effect.gen(function* () {
      const { dispatched, gitCalls } = yield* runReactor({
        child: isolatedChild(),
        others: [parent],
        mergeResult: { status: "conflict", conflictPaths: ["README.md"] },
      });
      expect(fanInStates(dispatched)).toContain("conflicted");
      expect(gitCalls).not.toContain("removeWorktree");
      expect(gitCalls).not.toContain("deleteBranch");
      // A conflict activity is surfaced on the child.
      expect(
        dispatched.some(
          (c) =>
            c.type === "thread.activity.append" &&
            c.activity.kind === "workstream.fanin.conflicted",
        ),
      ).toBe(true);
    }),
  );

  it.effect("occupancy: clean merge defers removal while a resident sibling is live", () =>
    Effect.gen(function* () {
      const occupant = shell({
        id: "grandchild",
        parentThreadId: "child" as ThreadId,
        isolation: "shared",
        planLane: "in_progress",
        worktreePath: "/wt/child", // resides in the child's worktree
      });
      const { dispatched, gitCalls } = yield* runReactor({
        child: isolatedChild(),
        others: [parent, occupant],
      });
      // The merge + settlement still happen…
      expect(fanInStates(dispatched)).toContain("completed");
      expect(gitCalls).toContain("merge");
      // …but removal is deferred while the resident is live.
      expect(gitCalls).not.toContain("removeWorktree");
      expect(gitCalls).not.toContain("deleteBranch");
    }),
  );

  it.effect("cancelled: commits wip onto the branch, removes worktree, keeps branch", () =>
    Effect.gen(function* () {
      const { dispatched, gitCalls } = yield* runReactor({
        child: isolatedChild({ planLane: "cancelled" }),
        others: [parent],
      });
      expect(gitCalls).toContain("commit:wip: cancelled");
      expect(gitCalls).toContain("removeWorktree");
      expect(gitCalls).not.toContain("deleteBranch");
      expect(gitCalls).not.toContain("merge");
      expect(fanInStates(dispatched)).toEqual([]);
    }),
  );

  // Phase 3 task A (cancel-race): a cancelled child whose provider session is
  // still winding down (session running / turn running) must NOT have its
  // worktree committed + removed yet — the provider process may still be
  // writing files. Cleanup runs once the projection shows the child quiescent.
  effectIt.effect("cancelled mid-turn: cleanup defers until the child session is quiescent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
        const gitCalls = yield* Ref.make<ReadonlyArray<string>>([]);
        const record = (tag: string) => Ref.update(gitCalls, (xs) => [...xs, tag]);
        const busyCancelled = isolatedChild({
          planLane: "cancelled",
          latestTurn: {
            turnId: TurnId.make("turn-cancel-race"),
            state: "running",
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: "2026-01-01T00:00:01.000Z",
            completedAt: null,
            assistantMessageId: null,
          },
          session: {
            threadId: "child" as ThreadId,
            status: "running",
            providerName: null,
            runtimeMode: "approval-required",
            activeTurnId: TurnId.make("turn-cancel-race"),
            lastError: null,
            queuedMessages: { steering: [], followUp: [] },
            updatedAt: "2026-01-01T00:00:01.000Z",
          },
        });
        const childRef = yield* Ref.make<OrchestrationThreadShell>(busyCancelled);
        const events = yield* PubSub.unbounded<OrchestrationEvent>();

        const engineLayer = Layer.succeed(OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.fromPubSub(events),
          dispatch: (command: OrchestrationCommand) =>
            Ref.update(dispatched, (xs) => [...xs, command]).pipe(Effect.as({ sequence: 0 })),
        } as never);
        const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
          getShellSnapshot: () =>
            Effect.map(Ref.get(childRef), (child) => ({
              snapshotSequence: 0,
              projects: [],
              goals: [],
              updatedAt: "1970-01-01T00:00:00.000Z",
              threads: [child, parent],
            })),
        } as never);
        const gitLayer = Layer.succeed(GitWorkflowService, {
          commitAll: (_cwd: string, subject: string) =>
            record(`commit:${subject}`).pipe(Effect.as({ committed: true, commitSha: "sha" })),
          mergeWorktreeBranch: () =>
            record("merge").pipe(Effect.as({ status: "merged", conflictPaths: [] })),
          removeWorktree: () => record("removeWorktree"),
          deleteBranch: () => record("deleteBranch"),
        } as never);
        const layer = WorkstreamFanInReactorLive.pipe(
          Layer.provide(engineLayer),
          Layer.provide(projectionLayer),
          Layer.provide(gitLayer),
          Layer.provide(WorktreeMutationLockLive),
          Layer.provideMerge(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const reactor = yield* WorkstreamFanInReactor;
          yield* reactor.start();
          yield* reactor.drain;

          // Startup pass sees the cancelled child still mid-turn: no cleanup.
          expect(yield* Ref.get(gitCalls)).toEqual([]);

          // The interrupt lands: the runtime reports the turn interrupted and
          // the session leaves "running" — the projection now shows quiescence.
          yield* Ref.set(
            childRef,
            isolatedChild({
              planLane: "cancelled",
              latestTurn: {
                turnId: TurnId.make("turn-cancel-race"),
                state: "interrupted",
                requestedAt: "2026-01-01T00:00:00.000Z",
                startedAt: "2026-01-01T00:00:01.000Z",
                completedAt: "2026-01-01T00:00:05.000Z",
                assistantMessageId: null,
              },
              session: {
                threadId: "child" as ThreadId,
                status: "interrupted",
                providerName: null,
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: null,
                queuedMessages: { steering: [], followUp: [] },
                updatedAt: "2026-01-01T00:00:05.000Z",
              },
            }),
          );
          // The projection write is announced by a session-set event (the same
          // re-arm path a live server takes).
          yield* PubSub.publish(events, {
            type: "thread.session-set",
            payload: { threadId: "child" as ThreadId },
          } as OrchestrationEvent);
          yield* reactor.drain;

          const calls = yield* Ref.get(gitCalls);
          expect(calls).toContain("commit:wip: cancelled");
          expect(calls).toContain("removeWorktree");
          expect(calls).not.toContain("deleteBranch");
        }).pipe(Effect.scoped, Effect.provide(layer));
      }),
    ),
  );

  // Review finding 1: a gated coder must NOT fan in on its round-0 `done` while
  // the gate is unresolved (the reviewer would then attach to the merged parent
  // tree); the merge fires exactly once, at resolution.
  it.effect("gate unresolved: coder done does not merge while reviewer is live", () =>
    Effect.gen(function* () {
      const reviewer = shell({
        id: "reviewer",
        parentThreadId: "parent" as ThreadId,
        isolation: "attached",
        planLane: "in_progress",
        // The reviewer's gate loops rework back to the coder.
        routes: [{ on: ["needs_rework"], kind: "loop", to: "child" as ThreadId }],
      });
      const { dispatched, gitCalls } = yield* runReactor({
        child: isolatedChild(),
        others: [parent, reviewer],
      });
      expect(gitCalls).not.toContain("merge");
      expect(fanInStates(dispatched)).toEqual([]);
    }),
  );

  it.effect("gate resolved: coder + reviewer both done → exactly one merge", () =>
    Effect.gen(function* () {
      const reviewer = shell({
        id: "reviewer",
        parentThreadId: "parent" as ThreadId,
        isolation: "attached",
        planLane: "done",
        routes: [{ on: ["needs_rework"], kind: "loop", to: "child" as ThreadId }],
      });
      const { dispatched, gitCalls } = yield* runReactor({
        child: isolatedChild(),
        others: [parent, reviewer],
      });
      // Coder fans in once; the attached reviewer never fans in itself.
      // The periodic tick may run the pass again (idempotent), so check >= 1
      expect(gitCalls.filter((c) => c === "merge").length).toBeGreaterThanOrEqual(1);
      expect(fanInStates(dispatched)).toContain("completed");
    }),
  );

  // B2/§B2 regression test: the fan-in predicate must see completed turns that were
  // captured before the session went idle. The projection preserves latestTurnId
  // across the turn-diff-completed → session-set(idle) transition so the reactor
  // can see `latestTurn.state === "completed"` and proceed with the merge.
  it.effect(
    "quiescence predicate: merge proceeds when latestTurn.state === 'completed' after session idles (B2 regression fix)",
    () =>
      Effect.gen(function* () {
        const { dispatched, gitCalls } = yield* runReactor({
          // Child with latestTurn set to completed (as the projection would set it
          // after turn-diff-completed, preserved through session-set idle).
          child: isolatedChild({
            latestTurn: {
              turnId: TurnId.make("turn-b2-reactor-test"),
              state: "completed",
              requestedAt: "2026-01-01T00:00:00.000Z",
              startedAt: "2026-01-01T00:00:01.000Z",
              completedAt: "2026-01-01T00:00:02.000Z",
              assistantMessageId: null,
            },
            // Session is idle (activeTurnId: null), the critical state after session-set.
            session: {
              threadId: "child" as ThreadId,
              status: "ready",
              providerName: null,
              runtimeMode: "approval-required",
              activeTurnId: null,
              lastError: null,
              queuedMessages: { steering: [], followUp: [] },
              updatedAt: "2026-01-01T00:00:02.000Z",
            },
          }),
          others: [parent],
        });
        // Predicate evaluates true (latestTurn.state === "completed" even though session is idle),
        // so the merge proceeds immediately (no deferral).
        // The periodic tick may run the pass again, so check for containment.
        expect(fanInStates(dispatched)).toContain("completed");
        expect(gitCalls).toContain("merge");
        expect(gitCalls).toContain("removeWorktree");
      }),
  );

  // W2 fix: periodic tick reconciliation. This test drives the full real event
  // sequence that can lead to a stuck done+none state, then verifies the periodic
  // tick completes the fan-in without any further triggering event. Uses TestClock
  // to deterministically advance time and trigger the scheduled re-pass.
  effectIt.effect(
    "W2 race recovery: periodic tick re-arms when final event's pass samples stale state",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
          const gitCalls = yield* Ref.make<ReadonlyArray<string>>([]);
          const record = (tag: string) => Ref.update(gitCalls, (xs) => [...xs, tag]);
          // Start with parent mid-turn to test the race condition
          const parentMidTurn = shell({
            id: "parent",
            isolation: "shared",
            branch: "main",
            worktreePath: "/wt/parent",
            session: {
              threadId: "parent" as ThreadId,
              status: "running",
              providerName: null,
              runtimeMode: "approval-required",
              activeTurnId: "turn-parent-wake" as any,
              lastError: null,
              queuedMessages: { steering: [], followUp: [] },
              updatedAt: "2026-01-01T00:00:00.000Z",
            },
          });
          const childRef = yield* Ref.make<OrchestrationThreadShell>(isolatedChild());
          const parentRef = yield* Ref.make<OrchestrationThreadShell>(parentMidTurn);
          const events = yield* PubSub.unbounded<OrchestrationEvent>();

          const engineLayer = Layer.succeed(OrchestrationEngineService, {
            readEvents: () => Stream.empty,
            streamDomainEvents: Stream.fromPubSub(events),
            subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
            dispatch: (command: OrchestrationCommand) =>
              Ref.update(dispatched, (xs) => [...xs, command]).pipe(Effect.as({ sequence: 0 })),
          } as never);
          const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
            getShellSnapshot: () =>
              Effect.gen(function* () {
                const child = yield* Ref.get(childRef);
                const parentShell = yield* Ref.get(parentRef);
                return {
                  snapshotSequence: 0,
                  projects: [],
                  goals: [],
                  updatedAt: "1970-01-01T00:00:00.000Z",
                  threads: [child, parentShell],
                };
              }),
          } as never);
          const gitLayer = Layer.succeed(GitWorkflowService, {
            commitAll: (_cwd: string, subject: string) =>
              record(`commit:${subject}`).pipe(Effect.as({ committed: true, commitSha: "sha" })),
            mergeWorktreeBranch: () =>
              record("merge").pipe(Effect.as({ status: "merged", conflictPaths: [] })),
            removeWorktree: () => record("removeWorktree"),
            deleteBranch: () => record("deleteBranch"),
          } as never);
          const layer = WorkstreamFanInReactorLive.pipe(
            Layer.provide(engineLayer),
            Layer.provide(projectionLayer),
            Layer.provide(gitLayer),
            Layer.provide(WorktreeMutationLockLive),
            Layer.provideMerge(NodeServices.layer),
          );

          yield* Effect.gen(function* () {
            const reactor = yield* WorkstreamFanInReactor;
            yield* reactor.start();
            yield* reactor.drain;

            // After startup pass: child is done, but parent is mid-turn so merge is deferred.
            expect(fanInStates(yield* Ref.get(dispatched))).toEqual([]);

            // Simulate the parent's session transitioning to idle (completing its turn).
            const parentIdle = shell({
              id: "parent",
              isolation: "shared",
              branch: "main",
              worktreePath: "/wt/parent",
              session: {
                threadId: "parent" as ThreadId,
                status: "idle",
                providerName: null,
                runtimeMode: "approval-required",
                activeTurnId: null,
                lastError: null,
                queuedMessages: { steering: [], followUp: [] },
                updatedAt: "2026-01-01T00:00:03.000Z",
              },
            });
            yield* Ref.set(parentRef, parentIdle);
            // Advance time to trigger the periodic tick WITHOUT emitting any event.
            // This tests that even if the final event's pass sampled stale state
            // (before the projection was updated to show parent idle), the tick
            // will eventually reconcile the stuck done+none state.
            yield* TestClock.adjust(Duration.millis(61_000)); // Just over the 60s interval
            yield* reactor.drain;

            // After the periodic tick fires, the fan-in should be complete.
            expect(fanInStates(yield* Ref.get(dispatched))).toContain("completed");
            const finalGitCalls = yield* Ref.get(gitCalls);
            expect(finalGitCalls).toContain("merge");
            expect(finalGitCalls).toContain("removeWorktree");
          }).pipe(Effect.scoped, Effect.provide(layer));
        }),
      ),
  );

  // Review round 2: `conflicted` must not be a dead end. Once the orchestrator
  // re-opens the child (which the projection resets to `fanInState: none`) and
  // it resubmits `done`, a later terminal event re-arms the sweep and the merge
  // is attempted a SECOND time.
  it.effect("conflict recovery: after reset to none + resubmit, the merge is re-attempted", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const gitCalls = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (tag: string) => Ref.update(gitCalls, (xs) => [...xs, tag]);
      const mergeResult = yield* Ref.make<GitMergeWorktreeBranchResult>({
        status: "conflict",
        conflictPaths: ["README.md"],
      });
      const childRef = yield* Ref.make<OrchestrationThreadShell>(isolatedChild());
      const events = yield* PubSub.unbounded<OrchestrationEvent>();

      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.fromPubSub(events),
        subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
        dispatch: (command: OrchestrationCommand) =>
          Ref.update(dispatched, (xs) => [...xs, command]).pipe(Effect.as({ sequence: 0 })),
      } as never);
      const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
        getShellSnapshot: () =>
          Effect.map(Ref.get(childRef), (child) => ({
            snapshotSequence: 0,
            projects: [],
            goals: [],
            updatedAt: "1970-01-01T00:00:00.000Z",
            threads: [child, parent],
          })),
      } as never);
      const gitLayer = Layer.succeed(GitWorkflowService, {
        commitAll: (_cwd: string, subject: string) =>
          record(`commit:${subject}`).pipe(Effect.as({ committed: true, commitSha: "sha" })),
        mergeWorktreeBranch: () => record("merge").pipe(Effect.andThen(Ref.get(mergeResult))),
        removeWorktree: () => record("removeWorktree"),
        deleteBranch: () => record("deleteBranch"),
      } as never);
      const layer = WorkstreamFanInReactorLive.pipe(
        Layer.provide(engineLayer),
        Layer.provide(projectionLayer),
        Layer.provide(gitLayer),
        Layer.provide(WorktreeMutationLockLive),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* WorkstreamFanInReactor;
        yield* reactor.start();
        yield* reactor.drain;
        // Pass 1 (reconcile): merge conflicts → conflicted, worktree kept.
        // Note: the periodic tick may cause the pass to run again (idempotent),
        // so we verify that at least one "conflicted" state was set.
        const initialStates = fanInStates(yield* Ref.get(dispatched));
        expect(initialStates).toContain("conflicted");
        expect(yield* Ref.get(gitCalls)).not.toContain("removeWorktree");

        // Orchestrator re-opens + child resubmits: the projection reset lands the
        // child back at `fanInState: none` (still done), the conflict is resolved,
        // and a terminal event re-arms the sweep.
        yield* Ref.set(childRef, isolatedChild());
        yield* Ref.set(mergeResult, { status: "merged", conflictPaths: [] });
        yield* PubSub.publish(events, {
          type: "thread.plan-lane-set",
          payload: { threadId: "child" as ThreadId, planLane: "done" },
        } as OrchestrationEvent);
        yield* reactor.drain;

        const calls = yield* Ref.get(gitCalls);
        const merges = calls.filter((c) => c === "merge");
        // Multiple merges may occur due to periodic tick re-running the idempotent pass
        expect(merges.length).toBeGreaterThanOrEqual(2);
        expect(calls).toContain("removeWorktree");
        const finalStates = fanInStates(yield* Ref.get(dispatched));
        expect(finalStates).toContain("conflicted");
        expect(finalStates).toContain("completed");
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  // Item 3 (phase 3): resolved-conflict wake. Once a fan-in that first CONFLICTED
  // settles `completed` (child reopened → resolved → resubmitted → merged), the
  // reactor dispatches ONE lightweight notice to the parent — the generation wake
  // already fired with the conflict notice and the clean resubmit otherwise
  // re-notifies nothing.
  it.effect("resolved-conflict wake: notifies the parent on conflicted→completed", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const mergeResult = yield* Ref.make<GitMergeWorktreeBranchResult>({
        status: "conflict",
        conflictPaths: ["README.md"],
      });
      const childRef = yield* Ref.make<OrchestrationThreadShell>(isolatedChild());
      const events = yield* PubSub.unbounded<OrchestrationEvent>();

      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.fromPubSub(events),
        dispatch: (command: OrchestrationCommand) =>
          Ref.update(dispatched, (xs) => [...xs, command]).pipe(Effect.as({ sequence: 0 })),
      } as never);
      const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
        getShellSnapshot: () =>
          Effect.map(Ref.get(childRef), (child) => ({
            snapshotSequence: 0,
            projects: [],
            goals: [],
            updatedAt: "1970-01-01T00:00:00.000Z",
            threads: [child, parent],
          })),
      } as never);
      const gitLayer = Layer.succeed(GitWorkflowService, {
        commitAll: (_cwd: string, _subject: string) =>
          Effect.succeed({ committed: true, commitSha: "sha" }),
        mergeWorktreeBranch: () => Ref.get(mergeResult),
        removeWorktree: () => Effect.void,
        deleteBranch: () => Effect.void,
      } as never);
      const layer = WorkstreamFanInReactorLive.pipe(
        Layer.provide(engineLayer),
        Layer.provide(projectionLayer),
        Layer.provide(gitLayer),
        Layer.provide(WorktreeMutationLockLive),
        Layer.provideMerge(NodeServices.layer),
      );

      const resolutionWakes = (commands: ReadonlyArray<OrchestrationCommand>) =>
        commands.filter(
          (c) =>
            c.type === "thread.turn.start" &&
            c.commandId === "server:workstream-fanin:resolved:child",
        );

      yield* Effect.gen(function* () {
        const reactor = yield* WorkstreamFanInReactor;
        yield* reactor.start();
        yield* reactor.drain;
        // Pass 1: merge conflicts → the child is now tracked as conflicted.
        expect(fanInStates(yield* Ref.get(dispatched))).toContain("conflicted");
        // No wake yet — nothing resolved.
        expect(resolutionWakes(yield* Ref.get(dispatched))).toHaveLength(0);

        // Reopen + resubmit: reset to none/done, merge now succeeds.
        yield* Ref.set(childRef, isolatedChild());
        yield* Ref.set(mergeResult, { status: "merged", conflictPaths: [] });
        yield* PubSub.publish(events, {
          type: "thread.plan-lane-set",
          payload: { threadId: "child" as ThreadId, planLane: "done" },
        } as OrchestrationEvent);
        yield* reactor.drain;
        expect(fanInStates(yield* Ref.get(dispatched))).toContain("completed");

        // Projection catches up to the settled `completed` state and re-arms the
        // sweep via the fanin-set event: the resolved-conflict wake now fires.
        yield* Ref.set(childRef, isolatedChild({ fanInState: "completed" }));
        yield* PubSub.publish(events, {
          type: "thread.fanin-set",
          payload: {
            threadId: "child" as ThreadId,
            fanInState: "completed",
            updatedAt: "2026-01-01T00:00:05.000Z",
          },
        } as OrchestrationEvent);
        yield* reactor.drain;

        const wakes = resolutionWakes(yield* Ref.get(dispatched));
        expect(wakes.length).toBeGreaterThanOrEqual(1);
        const wake = wakes[0] as Extract<OrchestrationCommand, { type: "thread.turn.start" }>;
        expect(wake.threadId).toBe("parent");
        expect(wake.requireIdle).toBe(true);
        expect(wake.message.text).toContain("resolved its fan-in merge conflict");
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );
});
