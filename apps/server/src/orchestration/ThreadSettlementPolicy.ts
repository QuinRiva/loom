import type { OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { isTerminalLane } from "@t3tools/shared/workstreamGraph"; // loom: finished-work trigger

export interface SettlementPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt?: string | null;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

function latestTimestamp(values: ReadonlyArray<string | null | undefined>): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value == null) continue;
    const valueMs = Date.parse(value);
    if (valueMs > latestMs) {
      latest = value;
      latestMs = valueMs;
    }
  }
  return latest;
}

/** A recent user message stays queued until a turn adopts its timestamp.
 * Absolute age bounds client clock skew in both directions and stops stale
 * pre-adoption data from blocking the thread forever. */
export function threadHasQueuedTurnStart(
  thread: Pick<OrchestrationThreadShell, "latestUserMessageAt" | "latestTurn" | "session">,
  now: string,
): boolean {
  if (thread.latestUserMessageAt === null || thread.session?.status === "error") return false;
  const messageAt = Date.parse(thread.latestUserMessageAt);
  const age = Date.parse(now) - messageAt;
  if (Number.isNaN(age) || Math.abs(age) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.latestTurn === null) return true;
  return [
    thread.latestTurn.requestedAt,
    thread.latestTurn.startedAt,
    thread.latestTurn.completedAt,
  ].every((value) => value == null || Date.parse(value) < messageAt);
}

function pullRequestSettles(
  thread: Pick<OrchestrationThreadShell, "createdAt" | "latestUserMessageAt" | "latestTurn">,
  pullRequest: SettlementPullRequest,
  autoSettleOnMerge: boolean,
): boolean {
  if (pullRequest.state !== "closed" && (pullRequest.state !== "merged" || !autoSettleOnMerge)) {
    return false;
  }
  const terminalAt = pullRequest.state === "merged" ? pullRequest.mergedAt : pullRequest.closedAt;
  if (terminalAt == null) return false;
  const userAnchor = latestTimestamp([
    thread.createdAt,
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
  ]);
  if (userAnchor === null) return false;
  const pullRequestAt = Date.parse(terminalAt);
  const userAnchorAt = Date.parse(userAnchor);
  if (Number.isNaN(pullRequestAt) || Number.isNaN(userAnchorAt)) return false;
  return pullRequestAt >= userAnchorAt;
}

export function resolveAutoSettlementAt(input: {
  readonly thread: OrchestrationThreadShell;
  readonly pullRequest: SettlementPullRequest | null;
  readonly now: string;
  readonly autoSettleAfterDays: number | null;
  readonly autoSettleOnMerge: boolean;
}): string | null {
  const { thread } = input;
  let pullRequest = input.pullRequest;
  const links = visibleThreadPullRequests(thread.pullRequests);
  if (links.some((link) => link.snapshot === null || link.snapshot.state === "open")) return null;
  if (links.length > 0) {
    const terminalTimestamp = (link: (typeof links)[number]) => {
      const snapshot = link.snapshot;
      const value = snapshot?.state === "merged" ? snapshot.mergedAt : snapshot?.closedAt;
      const timestamp = Date.parse(value ?? "");
      return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
    };
    const latest = links.reduce((current, candidate) =>
      terminalTimestamp(candidate) > terminalTimestamp(current) ? candidate : current,
    );
    pullRequest =
      latest.snapshot === null
        ? null
        : {
            state: latest.snapshot.state,
            mergedAt: latest.snapshot.mergedAt ?? null,
            closedAt: latest.snapshot.closedAt ?? null,
          };
  }
  if (!isAutoSettlementCandidate(thread, input.now)) return null;
  const activityAt = threadActivityAt(thread);
  if (pullRequest !== null) {
    if (pullRequestSettles(thread, pullRequest, input.autoSettleOnMerge)) {
      return activityAt;
    }
  }
  if (input.autoSettleAfterDays === null) return null;
  return Date.parse(activityAt) < Date.parse(input.now) - input.autoSettleAfterDays * DAY_MS
    ? activityAt
    : null;
}

/** Last real activity on a thread.
 * loom: the `createdAt` fallback is load-bearing — a never-run thread has no
 * message and no turn, so without it the inactivity policy can never be
 * satisfied and the thread stays permanently unsettleable. */
function threadActivityAt(thread: OrchestrationThreadShell): string {
  return (
    latestTimestamp([
      thread.latestUserMessageAt,
      thread.latestTurn?.requestedAt,
      thread.latestTurn?.startedAt,
      thread.latestTurn?.completedAt,
    ]) ?? thread.createdAt
  );
}

/**
 * loom: the finished-work trigger's settle stamp, or null when the thread is
 * not a finished root. A ROOT whose plan lane has reached `done`/`cancelled`
 * has nothing left to show, so it leaves the active inbox rather than ageing
 * out over the inactivity window. Roots only — a child is not an inbox row.
 *
 * Only the lane and the stamp are decided here. Every blocker stays where it
 * already lives: the caller applies `isAutoSettlementCandidate` (which is why a
 * root that finishes while its OWN session is still running settles when that
 * session goes quiet, not at the lane transition), and the decider's
 * `thread.auto-settle` arm owns the plan blockers. The stamp is the thread's
 * own last activity, so a finished root sorts on the settled shelf exactly
 * where the inactivity path would have put it. Rationale and the full rule:
 * `docs/upstream-sync/23-sidebar-v2-rehome.md` §J.
 */
export function finishedRootSettlesAt(thread: OrchestrationThreadShell): string | null {
  return thread.parentThreadId === null && isTerminalLane(thread.planLane)
    ? threadActivityAt(thread)
    : null;
}

/**
 * loom: the sweep-side mirror of the two workstream blockers the decider
 * enforces on `thread.auto-settle` (`decider.ts`) — the ids the sweep must not
 * aim at, alongside upstream's own pre-filter below.
 *
 * Upstream pre-filters ITS blockers in `isAutoSettlementCandidate`, so a
 * decider rejection is a rare race and worth the reactor's WARN. Loom's two
 * blockers lived ONLY in the decider, so every thread they protect was
 * dispatched and rejected on every one-minute sweep — 198
 * `automatic thread settlement skipped` warnings, each with a pretty-printed
 * cause, in 30 minutes across 20 threads. The decider stays the enforcement
 * point; this only keeps the ordinary case off the dispatch path.
 *
 * A graph pass rather than a per-thread predicate, because the live-descendant
 * blocker is a graph question: any non-terminal thread blocks all of its
 * ancestors. Walking up stops at the first already-blocked ancestor — it was
 * reached by a walk that ran to the root — so the whole pass is linear.
 *
 * The shell snapshot carries only ACTIVE threads while the decider walks its
 * read model through archived ones, so a live descendant hidden behind an
 * archived parent is admitted here and still refused (with a warning) there.
 * That residual is the right direction: this filter can never suppress a
 * settle the decider would have allowed.
 */
export function loomAutoSettleBlockedThreadIds(
  threads: ReadonlyArray<Pick<OrchestrationThreadShell, "id" | "parentThreadId" | "planLane">>,
): ReadonlySet<ThreadId> {
  const parentOf = new Map(threads.map((thread) => [thread.id, thread.parentThreadId]));
  const blocked = new Set<ThreadId>();
  for (const thread of threads) {
    if (isTerminalLane(thread.planLane)) continue;
    for (
      let ancestor = thread.parentThreadId;
      ancestor !== null && !blocked.has(ancestor);
      ancestor = parentOf.get(ancestor) ?? null
    ) {
      blocked.add(ancestor);
    }
  }
  // Yielded is a thread's OWN blocker (quiescent by every runtime signal, yet
  // owed a decision). Added after the ancestor walk, whose early exit assumes
  // every id already in the set had its own ancestors marked.
  for (const thread of threads) if (thread.planLane === "yielded") blocked.add(thread.id);
  return blocked;
}

/** Cheap checks that run before any source control lookup. */
export function isAutoSettlementCandidate(thread: OrchestrationThreadShell, now: string): boolean {
  if (thread.archivedAt !== null || thread.settledOverride !== null) return false;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
  if (thread.backgroundLiveness != null) return false;
  if (threadHasQueuedTurnStart(thread, now)) return false;
  if (thread.snoozedUntil == null || Date.parse(thread.snoozedUntil) <= Date.parse(now))
    return true;
  const wokeOnError =
    thread.session?.status === "error" &&
    (thread.snoozedAt == null ||
      Date.parse(thread.session.updatedAt) > Date.parse(thread.snoozedAt));
  const wokeOnCompletion =
    thread.snoozedAt != null &&
    thread.latestTurn?.state === "completed" &&
    thread.latestTurn.completedAt != null &&
    Date.parse(thread.latestTurn.completedAt) > Date.parse(thread.snoozedAt);
  return wokeOnError || wokeOnCompletion;
}
