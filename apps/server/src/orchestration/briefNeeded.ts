import type { ThreadId } from "@t3tools/contracts";
import {
  areDependenciesSatisfied,
  type DependencyGateThread,
} from "@t3tools/shared/workstreamDependencies";

/**
 * The brief-needed condition, its episode clock, its re-arming rung ladder, and
 * the derived parent-attention predicate — extracted here because three layers
 * need them (`WorkstreamDispatcher` owns the notification rail,
 * `WorkstreamLivenessSweep` reads the condition, `ProjectionSnapshotQuery`
 * derives parent attention from it) and the projection query must not pull in
 * the dispatcher's whole service graph to ask one pure question.
 */

/**
 * The minimum thread shape the brief-needed predicates read.
 * `OrchestrationThreadShell` satisfies it; so does a narrow projection row
 * (`getThreadShellById`'s children lookup), which is why this is structural
 * rather than the full shell.
 */
export interface BriefNeededThread extends DependencyGateThread {
  readonly role: string | null;
  readonly purpose: string | null;
  /** `null` ⇔ the thread never started — the only thing the predicate reads. */
  readonly session: unknown;
  readonly latestUserMessageAt: string | null;
  readonly kickoffBriefPath: string | null;
  readonly createdAt: string;
  readonly planLaneSince: string | null;
  readonly dependenciesSince: string | null;
  readonly faninSince: string | null;
  readonly lastOutcome: { readonly at: string } | null;
}

/**
 * Brief-needed eligibility (scaffold plan §2/§3): an un-started sub-thread whose
 * release + dependency gates are all clear but which has NO kickoff brief yet —
 * the "awaiting brief" stall state. Exactly `selectThreadsToDispatch`'s gates
 * with the brief gate INVERTED (`kickoffBriefPath === null`): the two sets are
 * disjoint and partition the ready-and-unstarted children into dispatchable
 * (briefed) and brief-needed (unbriefed). Drives the dispatcher's rung ladder
 * and the derived parent attention.
 */
export const isBriefNeeded = <T extends BriefNeededThread>(
  thread: T,
  threadsById: ReadonlyMap<ThreadId, T>,
): boolean =>
  thread.parentThreadId !== null &&
  thread.role !== null &&
  thread.purpose !== null &&
  thread.planLane === "ready" &&
  thread.session === null &&
  thread.latestUserMessageAt === null &&
  thread.kickoffBriefPath === null &&
  areDependenciesSatisfied(thread, threadsById);

/**
 * The `briefNeededSince` eligibility-episode clock (scaffold plan §3): the ms
 * timestamp of the LATEST transition that made this node brief-eligible. Three
 * transitions can be the latest one, and all three feed the max below:
 *   - its scaffold time (`createdAt`) when it was born eligible;
 *   - its OWN `planned → ready` release (`planLaneSince`) — a staged node held
 *     then released dates from the release, not scaffold time, and a re-release
 *     starts a FRESH episode (new receipt key, new rung namespace);
 *   - a dependency reaching `done`, whether by a submit outcome (`lastOutcome.at`)
 *     OR a lane-only `workstream_set_lane(done)` that records no outcome
 *     (`dep.planLaneSince` while the dep is `done`).
 * NOT `createdAt` alone: a node scaffolded early but unblocked only much later
 * must date from the unblock, else an age-based clock would trip the ladder the
 * instant the node is created.
 *
 * Only STABLE, transition-derived sources feed it — `createdAt`, a
 * `plan-lane-set` timestamp (`planLaneSince`, bumped ONLY by real lane
 * transitions), and a dependency's `lastOutcome.at` (fixed for the life of that
 * outcome) — never a mutable `updatedAt`. This matters because the derived value
 * keys the wake's durable receipt: an `updatedAt`-based clock would drift under
 * any unrelated thread event (a receipt-marker/activity append bumps
 * `updatedAt`) and re-arm the wake in a loop. `planLaneSince` is immune to that
 * because activity appends do not emit a `plan-lane-set`.
 */
export const briefNeededSinceMs = <T extends BriefNeededThread>(
  thread: T,
  threadsById: ReadonlyMap<ThreadId, T>,
): number => {
  const parseIso = (iso: string | null | undefined): number =>
    iso === null || iso === undefined ? NaN : Date.parse(iso);
  let sinceMs = parseIso(thread.createdAt);
  if (Number.isNaN(sinceMs)) sinceMs = 0;
  const bump = (iso: string | null | undefined) => {
    const ms = parseIso(iso);
    if (!Number.isNaN(ms) && ms > sinceMs) sinceMs = ms;
  };
  // Gap (a): the node's own release to `ready`.
  bump(thread.planLaneSince);
  // Gap (c): a `set_dependencies` that re-enters eligibility (removes/replaces a
  // dep). Only counts while the CURRENT set is satisfied — a set that added an
  // unfinished dep leaves the node ineligible (isBriefNeeded is false), and its
  // stamp must not seed a phantom episode; once the set is satisfied again the
  // stamp is the true re-entry transition, later than any pre-existing dep
  // outcome (which may predate the prior episode).
  if (areDependenciesSatisfied(thread, threadsById)) bump(thread.dependenciesSince);
  for (const depId of thread.blockedBy) {
    if (depId === thread.id) continue;
    const dep = threadsById.get(depId);
    if (dep === undefined || dep.parentThreadId !== thread.parentThreadId) continue;
    // A dependency's completion time: its submit outcome, or — gap (b) — the
    // lane transition that carried it to `done` with no recorded outcome.
    bump(dep.lastOutcome?.at ?? null);
    if (dep.planLane === "done") bump(dep.planLaneSince);
    // Gap (d): fan-in settlement. `areDependenciesSatisfied` requires more than
    // `done` for an isolated dep (`fanInState === "completed"`), and for a node
    // behind an attached reviewer, the gated isolated coder's fan-in. When that
    // is load-bearing, the `fanin-set` that reached `completed` is the true
    // eligibility transition — it can land long after the dep's `done`. Mirror
    // the predicate's two fan-in branches exactly (incl. the `attached`
    // dependent short-circuit, which releases on `done` alone and needs no
    // fan-in), so the clock and the gate never disagree.
    if (thread.isolation === "attached") continue;
    if (dep.isolation === "attached") {
      // Two-hop: the reviewer itself never fans in; the merged output belongs to
      // the isolated coder(s) it gates, whose fan-in fires at gate resolution.
      for (const gatedId of dep.blockedBy) {
        const gated = threadsById.get(gatedId);
        if (
          gated !== undefined &&
          gated.parentThreadId === dep.parentThreadId &&
          gated.isolation === "isolated" &&
          gated.fanInState === "completed"
        )
          bump(gated.faninSince);
      }
    } else if (dep.isolation === "isolated" && dep.fanInState === "completed") {
      bump(dep.faninSince);
    }
  }
  return sinceMs;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * The brief-needed re-arming ladder (liveness plan §3.2). A delivery receipt is
 * NOT condition state: `briefNeededSinceMs` is derived from stable transitions,
 * so it cannot advance while a node just sits there — once the single un-runged
 * receipt was spent the parent was never told again. The rung is wall-clock
 * arithmetic over the episode age, so time advancing mints the next at-most-once
 * marker id and the notice re-arms deterministically across restarts.
 *
 * Schedule: rung 0 immediately (today's behaviour — the immediate wake is
 * preserved, never delayed), rung 1 at ≥1 h, rung 2 at ≥6 h, then one rung per
 * day indefinitely. Only the CURRENT (highest due) rung is ever dispatched, so
 * downtime does not backfill a burst of skipped rungs.
 */
export const rungFor = (ageMs: number): number =>
  ageMs < HOUR_MS ? 0 : ageMs < 6 * HOUR_MS ? 1 : 2 + Math.floor(ageMs / DAY_MS);

/**
 * Brief-needed marker id: the deterministic, receipt-deduped per-child marker
 * for the batched rail. Keyed by the eligibility episode
 * `(childId, briefNeededSince)` — so a node that leaves and re-enters the state
 * on a fresh episode re-arms as news — AND by the rung, so a node that simply
 * keeps sitting there re-arms on the wall clock.
 */
export const briefNeededCommandId = (childId: ThreadId, sinceMs: number, rung: number): string =>
  `server:workstream-brief-needed:${childId}:${sinceMs}:${rung}`;

/**
 * How long a node may sit brief-needed before its PARENT carries a derived
 * `needs_guidance` for a human (liveness plan §3.3). Deliberately late: a human
 * never writes a sub-thread's brief, so the only actionable human moves are
 * prompting the parent or cancelling the node — worth surfacing only once the
 * agent-facing rungs have plainly failed.
 */
export const BRIEF_NEEDED_ATTENTION_MS = DAY_MS;

/**
 * Derived parent attention (liveness plan §3.3): the set of parents that have at
 * least one child sitting brief-needed past {@link BRIEF_NEEDED_ATTENTION_MS}.
 * Recomputed at the outward read boundary and never stored, so the turn-start
 * clear-all has nothing to erase and the flag self-clears the moment the node is
 * briefed, held, or cancelled.
 */
export const briefNeededAttentionParentIds = <T extends BriefNeededThread & { id: ThreadId }>(
  threads: Iterable<T>,
  threadsById: ReadonlyMap<ThreadId, T>,
  nowMs: number,
): ReadonlySet<ThreadId> => {
  const parents = new Set<ThreadId>();
  for (const thread of threads)
    if (
      thread.parentThreadId !== null &&
      isBriefNeeded(thread, threadsById) &&
      nowMs - briefNeededSinceMs(thread, threadsById) >= BRIEF_NEEDED_ATTENTION_MS
    )
      parents.add(thread.parentThreadId);
  return parents;
};
