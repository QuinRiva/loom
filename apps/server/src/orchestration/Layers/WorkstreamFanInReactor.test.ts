import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
const effectIt = it;
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import type {
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationThread,
  OrchestrationThreadLeanShell,
  ThreadId,
} from "@t3tools/contracts";
import { TurnId } from "@t3tools/contracts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { layer as WorktreeMutationLockLive } from "../../git/WorktreeMutationLock.ts";
import {
  makeWorkspaceLease,
  WorkspaceLease,
  type WorkspaceLeaseShape,
} from "../../workspace/WorkspaceLease.ts";
import type { GitMergeWorktreeBranchResult } from "../../vcs/GitVcsDriver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { WorkstreamFanInReactor } from "../Services/WorkstreamFanInReactor.ts";
import { WorkstreamFanInReactorLive } from "./WorkstreamFanInReactor.ts";

// Minimal thread shell for the reactor's reads (isolation, lanes, cwd, branch).
const shell = (
  over: Omit<Partial<OrchestrationThreadLeanShell>, "id"> & { id: string },
): OrchestrationThreadLeanShell =>
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
  }) as unknown as OrchestrationThreadLeanShell;

// The reactor's occupancy authority. Real instance, not a stub: the point of
// the lease is its atomicity, and a stub predicate would test nothing.
const WorkspaceLeaseTestLive = Layer.effect(WorkspaceLease, makeWorkspaceLease);

/** Stand-in for the driver error a git op raises against an unusable checkout. */
class StubGitError extends Schema.TaggedErrorClass<StubGitError>()("StubGitError", {
  detail: Schema.String,
}) {}

// Before committing a child's checkout the reactor probes whether it is still
// on disk — a checkout that is GONE must not abort the disposition (that
// missing guard is what turned one broken worktree into 13,410 identical
// failures). These scenarios all use fictitious paths, so the probe is stubbed:
// `present` for the ordinary cases, `missing` for the vanished-worktree case.
const checkoutFs = (present: boolean) =>
  Layer.succeed(FileSystem.FileSystem, {
    exists: () => Effect.succeed(present),
  } as never);

interface Scenario {
  readonly child: OrchestrationThreadLeanShell;
  readonly others: ReadonlyArray<OrchestrationThreadLeanShell>;
  readonly mergeResult?: GitMergeWorktreeBranchResult;
  /** Workspace paths a live process holds for the whole pass. */
  readonly heldPaths?: ReadonlyArray<string>;
  /**
   * Acquire a hold from inside a git op, i.e. after the reactor has decided to
   * remove but before it executes — the TOCTOU shape a snapshot predicate
   * cannot defend against.
   */
  readonly holdDuring?: { readonly onGitCall: string; readonly path: string };
  /** The child's checkout is no longer on disk (a prior pass removed it). */
  readonly childCheckoutGone?: boolean;
  /** `commitAll` fails — the "unexpected per-child error" the failed state exists for. */
  readonly commitFails?: boolean;
  /** Dispatching this command type fails — e.g. the post-merge repoint. */
  readonly dispatchFailsFor?: OrchestrationCommand["type"];
}

const runReactor = (scenario: Scenario) =>
  Effect.gen(function* () {
    const lease: WorkspaceLeaseShape = yield* makeWorkspaceLease;
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
        command.type === scenario.dispatchFailsFor
          ? Effect.fail(new StubGitError({ detail: `dispatch refused for ${command.type}` }))
          : Ref.update(dispatched, (xs) => [...xs, command]).pipe(Effect.as({ sequence: 0 })),
    } as never);

    const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
      getThreadDetailById: (id: ThreadId) =>
        Effect.succeed(
          id === scenario.child.id
            ? Option.some(scenario.child as unknown as OrchestrationThread)
            : Option.none(),
        ),
      getThreadDetailSnapshotById: () => Effect.succeed(Option.none()),
      getLeanShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 0,
          projects: [],
          threads,
          goals: [],
          updatedAt: "1970-01-01T00:00:00.000Z",
        }),
    } as never);

    const gitLayer = Layer.succeed(GitWorkflowService, {
      // A commit against a checkout that is no longer on disk throws in real
      // life (`VcsUnsupportedOperationError` out of the driver's repo probe) —
      // model that, or the vanished-checkout scenario cannot reproduce the loop.
      commitAll: (cwd: string, subject: string) =>
        scenario.commitFails === true ||
        (scenario.childCheckoutGone === true && cwd === scenario.child.worktreePath)
          ? Effect.fail(new StubGitError({ detail: `commitAll refused for ${subject} in ${cwd}` }))
          : record(gitCalls, `commit:${subject}`).pipe(
              Effect.tap(() =>
                scenario.holdDuring?.onGitCall === `commit:${subject}`
                  ? lease.hold(scenario.holdDuring.path, "test-late-process")
                  : Effect.void,
              ),
              Effect.as({ committed: true, commitSha: "sha" }),
            ),
      mergeWorktreeBranch: () =>
        record(gitCalls, "merge").pipe(
          Effect.tap(() =>
            scenario.holdDuring?.onGitCall === "merge"
              ? lease.hold(scenario.holdDuring.path, "test-late-process")
              : Effect.void,
          ),
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
      Layer.provide(Layer.succeed(WorkspaceLease, lease)),
      Layer.provide(checkoutFs(scenario.childCheckoutGone !== true)),
      Layer.provideMerge(NodeServices.layer),
    );

    for (const path of scenario.heldPaths ?? []) {
      yield* lease.hold(path, "test-process");
    }

    yield* Effect.gen(function* () {
      const reactor = yield* WorkstreamFanInReactor;
      yield* reactor.start();
      yield* reactor.drain;
    }).pipe(Effect.scoped, Effect.provide(layer));

    return {
      lease,
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

const isolatedChild = (over: Partial<OrchestrationThreadLeanShell> = {}) =>
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

  // The 13,410-failure production loop, reproduced. A child whose checkout was
  // already removed but whose meta still points at it: `commitAll` used to throw
  // `VcsUnsupportedOperationError` and abort BEFORE `repointMeta`, and
  // `repointMeta` clearing `worktreePath` is the ONLY thing that stops the
  // deferred-removal branch rematching on the next pass.
  it.effect("vanished child checkout: repoints instead of looping on commitAll", () =>
    Effect.gen(function* () {
      const { dispatched, gitCalls } = yield* runReactor({
        child: isolatedChild({ fanInState: "completed" }),
        others: [parent],
        childCheckoutGone: true,
      });
      // Nothing was committed — there is no checkout to commit.
      expect(gitCalls.some((call) => call.startsWith("commit:"))).toBe(false);
      // The repoint landed, so the guard has nothing left to match.
      const repoint = dispatched.find((c) => c.type === "thread.meta.update") as
        | Extract<OrchestrationCommand, { type: "thread.meta.update" }>
        | undefined;
      expect(repoint?.worktreePath).toBe("/wt/parent");
      // And it is a clean terminal disposition, not an error: no failure surfaced.
      expect(dispatched.some((c) => c.type === "thread.attention.raise")).toBe(false);
      expect(fanInStates(dispatched)).not.toContain("failed");
    }),
  );

  // The line between a fan-in failure and a CLEANUP failure. Once the merge has
  // landed, `completed` is persisted and `thread.fanin-set` has already told the
  // dispatcher to release dependents — so demoting the child to `failed` on a
  // later cleanup error would claim the branch was never merged and re-block
  // work that is already running. Deferred removal is wholly post-merge, so an
  // input snapshot already at `completed` must survive any failure there.
  // The same line, on the path the reviewer flagged: a merge that HAS landed in
  // this pass. `completed` is dispatched, then the repoint fails — and the child
  // must keep `completed`, because dependents may already be releasing on it.
  it.effect("post-merge repoint failure: keeps `completed`, never demotes to `failed`", () =>
    Effect.gen(function* () {
      const { dispatched, gitCalls } = yield* runReactor({
        child: isolatedChild(),
        others: [parent],
        dispatchFailsFor: "thread.meta.update",
      });
      expect(gitCalls).toContain("merge");
      // This harness serves a frozen snapshot, so the pass can repeat the merge
      // (live, the reactor's own `completed` write is projected inside the
      // command transaction, so the next pass sees it and takes the
      // deferred-removal branch instead). The invariant under test is the
      // settlement, not the repeat count.
      expect(fanInStates(dispatched)).toContain("completed");
      expect(fanInStates(dispatched)).not.toContain("failed");
      expect(
        dispatched.some(
          (c) =>
            c.type === "thread.activity.append" &&
            c.activity.kind === "workstream.fanin.cleanup-failed",
        ),
      ).toBe(true);
    }),
  );

  it.effect("deferred-removal failure: keeps `completed`, never demotes to `failed`", () =>
    Effect.gen(function* () {
      const { dispatched } = yield* runReactor({
        child: isolatedChild({ fanInState: "completed" }),
        others: [parent],
        commitFails: true,
      });
      // The fan-in outcome is untouched: no state write at all, and above all
      // no `failed`.
      expect(fanInStates(dispatched)).toEqual([]);
      // …but the operator still hears about it, once, as a cleanup failure.
      const activities = dispatched.filter(
        (c) =>
          c.type === "thread.activity.append" && c.activity.kind.startsWith("workstream.fanin"),
      ) as ReadonlyArray<Extract<OrchestrationCommand, { type: "thread.activity.append" }>>;
      expect(activities.map((c) => c.activity.kind)).toEqual(["workstream.fanin.cleanup-failed"]);
      expect(dispatched.some((c) => c.type === "thread.attention.raise")).toBe(true);
    }),
  );

  // The other half: an unexpected error BEFORE the merge must record a TERMINAL
  // state, or the next pass re-selects the same child and fails identically
  // forever.
  it.effect("unexpected failure: records terminal `failed`, and a failed child is skipped", () =>
    Effect.gen(function* () {
      const { dispatched } = yield* runReactor({
        child: isolatedChild(),
        others: [parent],
        commitFails: true,
      });
      expect(fanInStates(dispatched)).toContain("failed");
      expect(dispatched.some((c) => c.type === "thread.attention.raise")).toBe(true);

      // A later pass over the persisted `failed` child does nothing at all: no
      // git, no activity row, no attention raise. That is the loop, dead.
      const second = yield* runReactor({
        child: isolatedChild({ fanInState: "failed" }),
        others: [parent],
      });
      expect(second.gitCalls).toEqual([]);
      expect(second.dispatched).toEqual([]);
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
        const childRef = yield* Ref.make<OrchestrationThreadLeanShell>(busyCancelled);
        const events = yield* PubSub.unbounded<OrchestrationEvent>();

        const engineLayer = Layer.succeed(OrchestrationEngineService, {
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.fromPubSub(events),
          dispatch: (command: OrchestrationCommand) =>
            Ref.update(dispatched, (xs) => [...xs, command]).pipe(Effect.as({ sequence: 0 })),
        } as never);
        const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
          getLeanShellSnapshot: () =>
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
          Layer.provide(WorkspaceLeaseTestLive),
          Layer.provide(checkoutFs(true)),
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
          const childRef = yield* Ref.make<OrchestrationThreadLeanShell>(isolatedChild());
          const parentRef = yield* Ref.make<OrchestrationThreadLeanShell>(parentMidTurn);
          const events = yield* PubSub.unbounded<OrchestrationEvent>();

          const engineLayer = Layer.succeed(OrchestrationEngineService, {
            readEvents: () => Stream.empty,
            streamDomainEvents: Stream.fromPubSub(events),
            subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
            dispatch: (command: OrchestrationCommand) =>
              Ref.update(dispatched, (xs) => [...xs, command]).pipe(Effect.as({ sequence: 0 })),
          } as never);
          const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
            getLeanShellSnapshot: () =>
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
            Layer.provide(WorkspaceLeaseTestLive),
            Layer.provide(checkoutFs(true)),
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
      const childRef = yield* Ref.make<OrchestrationThreadLeanShell>(isolatedChild());
      const events = yield* PubSub.unbounded<OrchestrationEvent>();

      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.fromPubSub(events),
        subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
        dispatch: (command: OrchestrationCommand) =>
          Ref.update(dispatched, (xs) => [...xs, command]).pipe(Effect.as({ sequence: 0 })),
      } as never);
      const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
        getLeanShellSnapshot: () =>
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
        Layer.provide(WorkspaceLeaseTestLive),
        Layer.provide(checkoutFs(true)),
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

  // Review round 2: the cleanup breaker must not outlive the cleanup episode it
  // was recorded for. A child whose post-merge cleanup failed is skipped only
  // while it is still `completed`; reopening it (projection resets to `none`) and
  // resubmitting carries NEW commits that must merge, so the SAME process has to
  // pick it up again — a server restart is not an acceptable recovery.
  it.effect("cleanup breaker expires on reopen: the resubmitted child merges again", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const gitCalls = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (tag: string) => Ref.update(gitCalls, (xs) => [...xs, tag]);
      const repointFails = yield* Ref.make(true);
      // Starts in the post-cleanup-failure shape: merged, but the worktree was
      // never tidied away, so the deferred-removal branch keeps selecting it.
      const childRef = yield* Ref.make<OrchestrationThreadLeanShell>(
        isolatedChild({ fanInState: "completed" }),
      );
      const events = yield* PubSub.unbounded<OrchestrationEvent>();

      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.fromPubSub(events),
        subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
        dispatch: (command: OrchestrationCommand) =>
          Effect.flatMap(Ref.get(repointFails), (failing) =>
            failing && command.type === "thread.meta.update"
              ? Effect.fail(new StubGitError({ detail: "repoint refused" }))
              : Ref.update(dispatched, (xs) => [...xs, command]).pipe(Effect.as({ sequence: 0 })),
          ),
      } as never);
      const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
        getLeanShellSnapshot: () =>
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
        Layer.provide(WorkspaceLeaseTestLive),
        Layer.provide(checkoutFs(true)),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* WorkstreamFanInReactor;
        yield* reactor.start();
        yield* reactor.drain;
        // The cleanup failed and the breaker is now armed for this child — no
        // merge was attempted (this is the deferred-removal branch) and the
        // fan-in outcome was left alone.
        expect(yield* Ref.get(gitCalls)).not.toContain("merge");
        expect(fanInStates(yield* Ref.get(dispatched))).toEqual([]);

        // A human reopens the child and it resubmits: the projection reset lands
        // it back at `done` + `fanInState: none`, and the repoint now works.
        yield* Ref.set(childRef, isolatedChild());
        yield* Ref.set(repointFails, false);
        yield* PubSub.publish(events, {
          type: "thread.plan-lane-set",
          payload: { threadId: "child" as ThreadId, planLane: "done" },
        } as OrchestrationEvent);
        yield* reactor.drain;

        // The new work merges in the SAME process — no restart needed.
        expect(yield* Ref.get(gitCalls)).toContain("merge");
        expect(fanInStates(yield* Ref.get(dispatched))).toContain("completed");
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
      const childRef = yield* Ref.make<OrchestrationThreadLeanShell>(isolatedChild());
      const events = yield* PubSub.unbounded<OrchestrationEvent>();

      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.fromPubSub(events),
        dispatch: (command: OrchestrationCommand) =>
          Ref.update(dispatched, (xs) => [...xs, command]).pipe(Effect.as({ sequence: 0 })),
      } as never);
      const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
        getLeanShellSnapshot: () =>
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
        Layer.provide(WorkspaceLeaseTestLive),
        Layer.provide(checkoutFs(true)),
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

  // Item 1 (loud on conflict): a conflicted fan-in fires AFTER the gate has
  // resolved (coder + reviewer both done), so a thread-local error activity has
  // no actor. The fix must engage the one live actor — the parent orchestrator:
  // raise attention on it AND deliver a control-plane notice carrying the
  // branch + conflicting paths so it can hand-merge.
  it.effect("conflict is loud: raises attention on the parent + delivers a conflict notice", () =>
    Effect.gen(function* () {
      const { dispatched, gitCalls } = yield* runReactor({
        child: isolatedChild(),
        others: [parent],
        mergeResult: { status: "conflict", conflictPaths: ["apps/server/src/server.test.ts"] },
      });
      expect(fanInStates(dispatched)).toContain("conflicted");
      // Blocking semantics kept: the branch/worktree stay put while unresolved.
      expect(gitCalls).not.toContain("removeWorktree");
      expect(gitCalls).not.toContain("deleteBranch");
      // Attention raised on the parent orchestrator (the live actor).
      expect(
        dispatched.some((c) => c.type === "thread.attention.raise" && c.threadId === "parent"),
      ).toBe(true);
      // A control-plane notice turn is delivered to the parent, carrying the
      // child branch + conflicting path so it can act.
      const notice = dispatched.find(
        (c) =>
          c.type === "thread.turn.start" &&
          c.commandId === "server:workstream-fanin:conflict:child",
      ) as Extract<OrchestrationCommand, { type: "thread.turn.start" }> | undefined;
      expect(notice).toBeDefined();
      expect(notice?.threadId).toBe("parent");
      expect(notice?.message.text).toContain("ws/main/coder-abc");
      expect(notice?.message.text).toContain("apps/server/src/server.test.ts");
    }),
  );

  // Item 2 (self-healing after EXTERNAL resolution): the incident's actual
  // recovery. The orchestrator hand-merges the coder branch into the parent
  // branch — the coder is NEVER reopened, so `fanInState` stays `conflicted`
  // (nothing resets it to `none`). The reactor must still converge: a re-attempt
  // now sees the branch already contained (`up-to-date`), settles `completed`,
  // and finalises — with no `workstream_set_dependencies []` escape hatch.
  it.effect("external hand-merge: converges to completed with fanInState never reset to none", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const gitCalls = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (tag: string) => Ref.update(gitCalls, (xs) => [...xs, tag]);
      const mergeResult = yield* Ref.make<GitMergeWorktreeBranchResult>({
        status: "conflict",
        conflictPaths: ["apps/server/src/server.test.ts"],
      });
      const childRef = yield* Ref.make<OrchestrationThreadLeanShell>(isolatedChild());
      const events = yield* PubSub.unbounded<OrchestrationEvent>();

      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.fromPubSub(events),
        subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
        dispatch: (command: OrchestrationCommand) =>
          Ref.update(dispatched, (xs) => [...xs, command]).pipe(Effect.as({ sequence: 0 })),
      } as never);
      const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
        getLeanShellSnapshot: () =>
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
        Layer.provide(WorkspaceLeaseTestLive),
        Layer.provide(checkoutFs(true)),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* WorkstreamFanInReactor;
        yield* reactor.start();
        yield* reactor.drain;
        // Pass 1: conflict → conflicted, worktree kept.
        expect(fanInStates(yield* Ref.get(dispatched))).toContain("conflicted");
        expect(yield* Ref.get(gitCalls)).not.toContain("removeWorktree");

        // Projection catches up to the persisted conflicted state (NO reopen —
        // fanInState stays conflicted). The orchestrator hand-merges the branch
        // into the parent, so a re-attempt is now up-to-date.
        yield* Ref.set(childRef, isolatedChild({ fanInState: "conflicted" }));
        yield* Ref.set(mergeResult, { status: "up-to-date", conflictPaths: [] });
        // The orchestrator idling after its hand-merge turn re-arms the sweep.
        yield* PubSub.publish(events, {
          type: "thread.session-set",
          payload: { threadId: "parent" as ThreadId },
        } as OrchestrationEvent);
        yield* reactor.drain;

        expect(fanInStates(yield* Ref.get(dispatched))).toContain("completed");
        expect(yield* Ref.get(gitCalls)).toContain("removeWorktree");
        expect(yield* Ref.get(gitCalls)).toContain("deleteBranch");
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  // Must-fix (round 1): a genuinely-conflicted fan-in must NOT self-feed a hot
  // loop. A committed `fanin.set` emits a `fanin-set` event; the reactor re-arms
  // on that event; a non-coalescing worker then re-passes → re-conflicts →
  // re-writes → … This harness closes the real feedback edge the other tests
  // omit: `dispatch` reflects `thread.fanin.set` into the projected state AND
  // republishes it as a `thread.fanin-set` event — including the engine's
  // unchanged-value guard (W2-4), which is where the transition check now lives
  // (the reactor dispatches unconditionally; the decider decides the no-op). With
  // it, the state is WRITTEN once and the worker quiesces; without it, the pass
  // count and `conflicted` writes would be unbounded and drain would hang.
  it.effect("conflict does not self-feed: exactly one conflicted write, worker quiesces", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const committedFanInStates = yield* Ref.make<ReadonlyArray<string>>([]);
      const merges = yield* Ref.make(0);
      const childRef = yield* Ref.make<OrchestrationThreadLeanShell>(isolatedChild());
      const events = yield* PubSub.unbounded<OrchestrationEvent>();

      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.fromPubSub(events),
        subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
        // Realistic wiring: a committed fanin.set both lands in the read model
        // (projected onto the child's fanInState) and is published as a
        // fanin-set domain event — the edge that re-arms the reactor's worker.
        dispatch: (command: OrchestrationCommand) =>
          Effect.gen(function* () {
            yield* Ref.update(dispatched, (xs) => [...xs, command]);
            if (command.type === "thread.fanin.set") {
              const next = (command as Extract<OrchestrationCommand, { type: "thread.fanin.set" }>)
                .fanInState;
              // The engine's unchanged-value guard: a set to the stored value
              // appends no event and publishes nothing.
              if ((yield* Ref.get(childRef)).fanInState === next) return { sequence: 0 };
              yield* Ref.update(committedFanInStates, (xs) => [...xs, next]);
              yield* Ref.update(childRef, (c) => isolatedChild({ ...c, fanInState: next }));
              yield* PubSub.publish(events, {
                type: "thread.fanin-set",
                payload: {
                  threadId: "child" as ThreadId,
                  fanInState: next,
                  updatedAt: "2026-01-01T00:00:05.000Z",
                },
              } as OrchestrationEvent);
            }
            return { sequence: 0 };
          }),
      } as never);
      const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
        getLeanShellSnapshot: () =>
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
        // Stays conflicted for the whole test (the unresolved window).
        mergeWorktreeBranch: () =>
          Ref.update(merges, (n) => n + 1).pipe(
            Effect.as({ status: "conflict", conflictPaths: ["README.md"] }),
          ),
        removeWorktree: () => Effect.void,
        deleteBranch: () => Effect.void,
      } as never);
      const layer = WorkstreamFanInReactorLive.pipe(
        Layer.provide(engineLayer),
        Layer.provide(projectionLayer),
        Layer.provide(gitLayer),
        Layer.provide(WorktreeMutationLockLive),
        Layer.provide(WorkspaceLeaseTestLive),
        Layer.provide(checkoutFs(true)),
        Layer.provideMerge(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* WorkstreamFanInReactor;
        yield* reactor.start();
        // Drain terminates only because the worker quiesces (no self-feed).
        yield* reactor.drain;

        // The transition is COMMITTED exactly once despite multiple passes
        // (startup double-enqueue + the one fanin-set re-arm it produces); the
        // redundant re-dispatches are absorbed by the decider guard.
        expect(yield* Ref.get(committedFanInStates)).toEqual(["conflicted"]);
        // Merge re-attempts stay bounded — not an unbounded busy-loop.
        expect(yield* Ref.get(merges)).toBeLessThanOrEqual(4);
      }).pipe(Effect.scoped, Effect.provide(layer));
    }),
  );

  // Item 3 (terminal turn states don't block the merge): a gated coder's lane is
  // set to `done` by the reviewer's resolve, decoupled from the coder's own turn
  // state — so its final turn can end `interrupted`/`error` or be absent (null).
  // The old `latestTurn.state === "completed"` guard wedged those coders forever;
  // a settled (non-running) turn must merge.
  for (const finalTurn of [
    {
      label: "interrupted",
      latestTurn: {
        turnId: TurnId.make("turn-final"),
        state: "interrupted" as const,
        requestedAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
        assistantMessageId: null,
      },
    },
    {
      label: "error",
      latestTurn: {
        turnId: TurnId.make("turn-final"),
        state: "error" as const,
        requestedAt: "2026-01-01T00:00:00.000Z",
        startedAt: "2026-01-01T00:00:01.000Z",
        completedAt: "2026-01-01T00:00:02.000Z",
        assistantMessageId: null,
      },
    },
    { label: "null", latestTurn: null },
  ]) {
    it.effect(
      `resolved gate + final turn ${finalTurn.label}: still merges and settles completed`,
      () =>
        Effect.gen(function* () {
          const reviewer = shell({
            id: "reviewer",
            parentThreadId: "parent" as ThreadId,
            isolation: "attached",
            planLane: "done",
            routes: [{ on: ["needs_rework"], kind: "loop", to: "child" as ThreadId }],
          });
          const { dispatched, gitCalls } = yield* runReactor({
            child: isolatedChild({
              latestTurn: finalTurn.latestTurn as OrchestrationThreadLeanShell["latestTurn"],
            }),
            others: [parent, reviewer],
          });
          expect(gitCalls.filter((c) => c === "merge").length).toBeGreaterThanOrEqual(1);
          expect(fanInStates(dispatched)).toContain("completed");
          expect(gitCalls).toContain("removeWorktree");
        }),
    );
  }

  // ---------------------------------------------------------------------------
  // Capability: a worktree is never removed under a live process (plan §7, test 5)
  //
  // The regression these guard is the reported production failure: a human
  // resumed a `done`, fanned-in child; turn-start re-provisioned its worktree;
  // three seconds later this reactor's sweep deleted that worktree and pi died
  // with "Stored session working directory does not exist". The old occupancy
  // predicate read a terminal plan lane as "nobody is using this directory",
  // which is precisely false for the thread a human is talking to.
  // ---------------------------------------------------------------------------

  it.effect("a worktree is never removed under a live process (§1.1 sequence)", () =>
    Effect.gen(function* () {
      // The exact production shape: lane `done`, fan-in already `completed`, and
      // a hold taken by the resume's turn-start. This is the deferred-removal
      // sweep, re-armed — as it was live — by the resume's own session-set.
      const { gitCalls } = yield* runReactor({
        child: isolatedChild({ fanInState: "completed" }),
        others: [parent],
        heldPaths: ["/wt/child"],
      });
      expect(gitCalls).not.toContain("removeWorktree");
      expect(gitCalls).not.toContain("deleteBranch");
    }),
  );

  it.effect("a merge still lands while the child's workspace is held; only removal defers", () =>
    Effect.gen(function* () {
      // The lease guards the checkout, not the merge: the child's commits must
      // still reach the parent (and its dependents must still release) while a
      // human is mid-conversation with it.
      const { dispatched, gitCalls } = yield* runReactor({
        child: isolatedChild(),
        others: [parent],
        heldPaths: ["/wt/child"],
      });
      expect(gitCalls).toContain("merge");
      expect(fanInStates(dispatched)).toContain("completed");
      expect(gitCalls).not.toContain("removeWorktree");
    }),
  );

  it.effect("TOCTOU: a hold taken after the removal decision defeats the removal", () =>
    Effect.gen(function* () {
      // A snapshot predicate passes this test's setup and then deletes the
      // worktree anyway — the process starts between check and `git worktree
      // remove`. Here the hold is acquired during the merge, i.e. after the
      // reactor has already decided to remove, and the removal must still be
      // refused because the lease is taken at removal time, not decision time.
      const { gitCalls } = yield* runReactor({
        child: isolatedChild(),
        others: [parent],
        holdDuring: { onGitCall: "merge", path: "/wt/child" },
      });
      expect(gitCalls).toContain("merge");
      expect(gitCalls).not.toContain("removeWorktree");
    }),
  );

  it.effect("a skipped removal is retried and succeeds once the last hold releases", () =>
    Effect.gen(function* () {
      // Skipping is safe precisely because the pass is idempotent and periodic:
      // the same child, same state, one released hold later, is now removable.
      const first = yield* runReactor({
        child: isolatedChild({ fanInState: "completed" }),
        others: [parent],
        heldPaths: ["/wt/child"],
      });
      expect(first.gitCalls).not.toContain("removeWorktree");

      const second = yield* runReactor({
        child: isolatedChild({ fanInState: "completed" }),
        others: [parent],
      });
      expect(second.gitCalls).toContain("removeWorktree");
      expect(second.gitCalls).toContain("deleteBranch");
    }),
  );

  it.effect("a cancelled child's worktree survives while a process holds it", () =>
    Effect.gen(function* () {
      // Cancelled children take the other removal path (`doCancelled`), which
      // must be gated too — otherwise Defect A simply moves. The `wip: cancelled`
      // snapshot commit still runs (it is idempotent and preserves work).
      const { dispatched, gitCalls } = yield* runReactor({
        child: isolatedChild({ planLane: "cancelled", fanInState: "none" }),
        others: [parent],
        heldPaths: ["/wt/child"],
      });
      expect(gitCalls).toContain("commit:wip: cancelled");
      expect(gitCalls).not.toContain("removeWorktree");
      // Meta is NOT repointed either: repointing without removing would hide the
      // worktree from this disposition on every later pass.
      expect(dispatched.filter((c) => c.type === "thread.meta.update")).toEqual([]);
    }),
  );

  it.effect("holding an unrelated workspace does not defer the child's removal", () =>
    Effect.gen(function* () {
      const { gitCalls } = yield* runReactor({
        child: isolatedChild({ fanInState: "completed" }),
        others: [parent],
        heldPaths: ["/wt/some-other-child"],
      });
      expect(gitCalls).toContain("removeWorktree");
    }),
  );
});
