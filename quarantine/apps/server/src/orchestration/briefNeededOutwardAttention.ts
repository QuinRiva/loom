import type {
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { ProjectionSnapshotQueryShape } from "./Services/ProjectionSnapshotQuery.ts";

/**
 * The OUTWARD-ONLY half of the derived brief-needed parent attention (liveness
 * plan §3.3).
 *
 * The flag is applied here rather than inside `getShellSnapshot` /
 * `getThreadShellById` because those are also the dispatcher's and liveness
 * sweep's control-plane reads, and both judge `attention.length` as *stored*
 * state: a derived member there makes a parent look internally paused — the
 * sweep stops nudging its own stalls, the dispatcher wakes ITS parent on the
 * generic attention rail — merely because a grandchild is unbriefed. The plan's
 * constraint is explicit: outward shell only, internal stored-attention checks
 * untouched.
 *
 * Being derived also means no event is published when the predicate flips, so
 * the tracker owns the other half of the contract: the flag must SELF-CLEAR in
 * the live shell stream. Briefing, holding, or cancelling a child emits a CHILD
 * event, so the parent's recomputed shell is republished ALONGSIDE it.
 */
export interface BriefNeededOutwardAttention {
  /** Decorate a whole outward snapshot, and seed the tracker's memo from it. */
  readonly decorateSnapshot: (
    snapshot: OrchestrationShellSnapshot,
  ) => Effect.Effect<OrchestrationShellSnapshot, ProjectionRepositoryError>;
  /**
   * Decorate one upserted thread, returning it plus any OTHER thread whose
   * derived flag this event just changed (normally none).
   */
  readonly decorateUpsert: (
    thread: OrchestrationThreadShell,
  ) => Effect.Effect<ReadonlyArray<OrchestrationThreadShell>, ProjectionRepositoryError>;
  /**
   * A thread left the graph (deleted/archived). Its removal can clear a parent's
   * flag, but a `thread-removed` event carries no shell to decorate — so mark the
   * memo stale and let the next upsert republish whoever changed.
   */
  readonly invalidate: Effect.Effect<void>;
}

/**
 * How long a memoised parent-id set may be trusted before an upserted thread
 * forces a recheck. This bounds how late the flag can APPEAR: unlike clearing,
 * nothing happens in the graph when a node merely ages past 24 h. (The rung
 * ladder does write a marker on the child at that boundary, but only once its
 * wake actually lands, so this is the independent backstop.) One narrow scan a
 * minute per live subscriber, and only while events are flowing at all.
 */
const MEMO_TTL_MS = 60_000;

/**
 * The union site. Two properties are load-bearing here.
 *
 * IDEMPOTENT AGAINST A STORED FLAG, by construction: a parent that already
 * carries `needs_guidance` is returned untouched. This is the same principle the
 * superseded `a81963cfa` had to enforce with an explicit `parentFlagged` guard
 * on its raise path — "if a human already has a reason to look at this
 * orchestrator, adding another is noise". A stored raise plus a derived one
 * cannot stack into a doubled flag, so no suppression logic is needed: set union
 * IS the suppression. Pinned by the outward-attention suite in
 * `ProjectionSnapshotQuery.test.ts`.
 */
const withDerived = (
  thread: OrchestrationThreadShell,
  derived: boolean,
): OrchestrationThreadShell =>
  !derived || thread.attention.includes("needs_guidance")
    ? thread
    : { ...thread, attention: [...thread.attention, "needs_guidance"] };

/** Apply a known parent-id set to a whole snapshot — the one-shot form, for
 * outward reads with no live stream to keep in sync (the shell HTTP route). */
export const applyBriefNeededParentAttention = (
  snapshot: OrchestrationShellSnapshot,
  parents: ReadonlySet<ThreadId>,
): OrchestrationShellSnapshot =>
  parents.size === 0
    ? snapshot
    : {
        ...snapshot,
        threads: snapshot.threads.map((thread) => withDerived(thread, parents.has(thread.id))),
      };

/**
 * ONE tracker PER SUBSCRIPTION: the memo is a record of what that client was
 * last told, and the republish diff is computed against it. A tracker shared
 * across subscribers would let whichever one happened to refresh first absorb
 * the transition, leaving every other client stale.
 */
export const makeBriefNeededOutwardAttention = (
  projectionSnapshotQuery: ProjectionSnapshotQueryShape,
): Effect.Effect<BriefNeededOutwardAttention> =>
  Effect.sync((): BriefNeededOutwardAttention => {
    // Plain mutable state is safe: one shell stream is mapped by one fibre,
    // serially.
    let memo: ReadonlySet<ThreadId> | null = null;
    let memoAtMs = 0;

    const refresh = Effect.gen(function* () {
      const parents = yield* projectionSnapshotQuery.getBriefNeededAttentionParentIds();
      memo = parents;
      memoAtMs = yield* Clock.currentTimeMillis;
      return parents;
    });

    return {
      decorateSnapshot: (snapshot) =>
        refresh.pipe(Effect.map((parents) => applyBriefNeededParentAttention(snapshot, parents))),

      decorateUpsert: (thread) =>
        Effect.gen(function* () {
          const before = memo;
          // Recheck when the memo is cold or past its TTL, and ALWAYS when this
          // thread's parent is currently flagged — that is the clearing case
          // (brief attached / held / cancelled), which must never lag.
          const stale =
            before === null ||
            (yield* Clock.currentTimeMillis) - memoAtMs >= MEMO_TTL_MS ||
            (thread.parentThreadId !== null && before.has(thread.parentThreadId));
          if (!stale) return [withDerived(thread, before.has(thread.id))];

          const parents = yield* refresh;
          const decorated = withDerived(thread, parents.has(thread.id));
          if (before === null) return [decorated];
          // Republish every OTHER thread whose answer this event changed, so a
          // client never carries a stale flag on a thread it hears nothing about.
          const changed = [...new Set([...before, ...parents])].filter(
            (id) => id !== thread.id && before.has(id) !== parents.has(id),
          );
          const republished = yield* Effect.forEach(changed, (id) =>
            projectionSnapshotQuery
              .getThreadShellById(id)
              .pipe(Effect.map(Option.map((shell) => withDerived(shell, parents.has(id))))),
          );
          return [
            decorated,
            ...republished.flatMap((shell) => (Option.isSome(shell) ? [shell.value] : [])),
          ];
        }),

      invalidate: Effect.sync(() => void (memoAtMs = 0)),
    };
  });
