// @effect-diagnostics globalDate:off -- UI snooze presets use local calendar boundaries and Intl labels.
import type { OrchestrationThreadShell } from "@t3tools/contracts";
// loom: the canonical "a done isolated child still owes its branch merge"
// predicate, shared with the dispatcher's generation-join gate.
import { isFanInPending } from "./workstreamIsolation.ts";

export type ChangeRequestStateLike = "open" | "closed" | "merged";

/**
 * loom: the thread fields settle classification actually reads. Narrower than
 * `OrchestrationThreadShell` so the SERVER can classify from a lean projection
 * row (W2-2) without assembling a full shell — a full shell still satisfies it
 * structurally, so every client call site is unchanged.
 */
export type ThreadSettledShell = Pick<
  OrchestrationThreadShell,
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "session"
  | "latestUserMessageAt"
  | "latestTurn"
  | "settledOverride"
  | "settledAt"
  | "attention"
  | "planLane"
  | "pendingRework"
  | "isolation"
  | "fanInState"
  | "createdAt"
>;

/**
 * The slice of a change request the settle rules need. `updatedAt` is the
 * provider's last-activity timestamp; for a merged/closed request it bounds
 * when the terminal state landed.
 */
export interface ChangeRequestSettleSource {
  readonly state: ChangeRequestStateLike;
  readonly updatedAt?: string | null | undefined;
}

/** What the settle rules need to know about the thread's own timeline. */
export type ThreadActivitySource = Pick<
  OrchestrationThreadShell,
  "createdAt" | "latestUserMessageAt" | "latestTurn"
>;

/**
 * Latest USER-initiated activity: messages and the turn requests they start,
 * deliberately not the agent-side started/completed stamps. The settle-on-
 * merge anchor uses this so a merge landing mid-turn still settles the
 * thread when that turn finishes, while a user re-engaging after the merge
 * blocks it for good. Falls back to creation time for untouched threads.
 */
function threadUserActivityAnchorAt(thread: ThreadActivitySource): string {
  const messageAt = thread.latestUserMessageAt;
  const requestedAt = thread.latestTurn?.requestedAt;
  let anchor = thread.createdAt;
  for (const candidate of [messageAt, requestedAt]) {
    if (candidate != null && Date.parse(candidate) > Date.parse(anchor)) {
      anchor = candidate;
    }
  }
  return anchor;
}

/**
 * Returns whether the change request settles the thread immediately. A
 * terminal request settles the thread only while it postdates every user-
 * initiated event in it: settling on a merge happens ONCE. A request last
 * touched before the thread was created is inherited branch history (a new
 * thread started at a worktree root whose PR already merged), and one older
 * than the user's latest engagement was already adjudicated — re-engaging a
 * thread whose PR merged is the user saying the conversation outlived the
 * PR. Unknown timestamps keep the old always-settle behavior.
 */
export function changeRequestAutoSettles(
  changeRequest: ChangeRequestSettleSource | null | undefined,
  options: {
    readonly autoSettleOnMerge?: boolean | undefined;
    readonly thread?: ThreadActivitySource | null | undefined;
  } = {},
): boolean {
  if (changeRequest == null) return false;
  const terminal =
    changeRequest.state === "closed" ||
    (changeRequest.state === "merged" && options.autoSettleOnMerge !== false);
  if (!terminal) return false;
  if (changeRequest.updatedAt == null || options.thread == null) return true;
  const updatedAtMs = Date.parse(changeRequest.updatedAt);
  const anchorAtMs = Date.parse(threadUserActivityAnchorAt(options.thread));
  // Malformed timestamps fall back to settling, matching servers that never
  // report updatedAt.
  if (Number.isNaN(updatedAtMs) || Number.isNaN(anchorAtMs)) return true;
  return updatedAtMs >= anchorAtMs;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Last real activity on a thread, falling back to `createdAt`.
 *
 * loom: the fallback is load-bearing (W2-2). A thread that has never run —
 * scaffolded but un-briefed, or briefed and never dispatched — has no user
 * message and no turn, so every candidate below is null. Returning null there
 * made `effectiveSettled` bail before the inactivity check, which meant such a
 * thread could NEVER auto-settle at any age. `createdAt` is non-null on every
 * thread and is the honest "nothing has happened since" timestamp, so the
 * inactivity window measures from it.
 */
export function threadLastActivityAt(
  shell: Pick<OrchestrationThreadShell, "createdAt" | "latestUserMessageAt" | "latestTurn">,
): string {
  const candidates = [
    shell.latestUserMessageAt,
    shell.latestTurn?.requestedAt,
    shell.latestTurn?.startedAt,
    shell.latestTurn?.completedAt,
  ];
  let latest: string = shell.createdAt;
  let latestTimestamp = Date.parse(shell.createdAt);

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const timestamp = Date.parse(candidate);
    if (timestamp > latestTimestamp) {
      latest = candidate;
      latestTimestamp = timestamp;
    }
  }

  return latest;
}

/**
 * A queued turn start lives for at most this long: session adoption takes
 * seconds, so a user message still unadopted after the grace window is a
 * failed start (or stale data — shells from older servers can carry user
 * messages with no latestTurn at all), not pending work. Without this bound
 * such threads would be permanently unsettleable.
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/**
 * A user message no turn has picked up yet: the turn.start command was
 * dispatched (message-sent + turn-start-requested) but no session has
 * adopted it, so `session` is still null and the pending work is invisible
 * to the session-status checks. Detectable as a user message strictly newer
 * than every timestamp on the latest turn — on adoption the new turn's
 * requestedAt equals the message time, clearing the condition — and only
 * within the adoption grace window.
 */
export function hasQueuedTurnStart(
  shell: Pick<OrchestrationThreadShell, "latestUserMessageAt" | "latestTurn" | "session">,
  options: { readonly now: string },
): boolean {
  if (shell.latestUserMessageAt == null) return false;
  // A failed session start clears the queued state: the failure is already
  // visible (status edge / error).
  if (shell.session?.status === "error") return false;
  const messageAt = Date.parse(shell.latestUserMessageAt);
  if (Number.isNaN(messageAt)) return false;
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(nowMs)) return false;
  // Bounded on both sides: message timestamps originate on whichever device
  // sent the message, so a clock ahead of this one yields a negative age
  // that would otherwise hold the queued state for the whole skew. Mirrors
  // the decider's guard.
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  const turn = shell.latestTurn;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  );
}

/**
 * A thread may be settled only when none of effectiveSettled's activity
 * blockers hold. This is deliberately the same list: anything the partition
 * refuses to CLASSIFY as settled must also be refused as a settle TARGET.
 * The server enforces its own invariants; this client-side twin exists so
 * the UI can disable/reject before a round trip.
 *
 * loom: the workstream blockers are deliberately NOT here — they suppress
 * auto-settle only, so an abandoned graph stays a legal settle target.
 */
export function canSettle(
  shell: Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "session" | "latestUserMessageAt" | "latestTurn"
  >,
  options: { readonly now: string },
): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  if (shell.session?.status === "starting" || shell.session?.status === "running") return false;
  // Queued work is as blocked-on-progress as a live session: settling it
  // (or auto-settling it on a closed PR) would hide a just-requested turn.
  if (hasQueuedTurnStart(shell, options)) return false;
  return true;
}

/**
 * The snooze lifecycle fields plus everything needed to detect a raised
 * hand. Snooze is an overlay on the active state: a snoozed thread stays
 * "active" in the data model and is only suppressed from the inbox until
 * its wake time passes or the thread demands attention.
 */
export type ThreadSnoozeShell = Pick<
  OrchestrationThreadShell,
  | "snoozedUntil"
  | "snoozedAt"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "session"
  | "latestTurn"
>;

/**
 * A snoozed thread "raises its hand" when something happens that outranks
 * the user's snooze: the agent is blocked on them (approval / user input),
 * the session failed, or a run completed after the snooze was set — the
 * v1 taste of event-based snooze ("something happened" wakes early).
 * Raising a hand never clears the server-side snooze fields; it only stops
 * the thread from CLASSIFYING as snoozed, exactly like blocked work and
 * effectiveSettled.
 */
export function threadRaisedHandWhileSnoozed(shell: ThreadSnoozeShell): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return true;
  // Only a FRESH failure raises the hand: a thread snoozed while already
  // failed stays snoozed — that snooze was the user saying "I saw it, not
  // now". session.updatedAt stamps the status edge, so an error newer than
  // the snooze is new information.
  if (
    shell.session?.status === "error" &&
    (shell.snoozedAt == null || Date.parse(shell.session.updatedAt) > Date.parse(shell.snoozedAt))
  ) {
    return true;
  }
  if (
    shell.snoozedAt != null &&
    shell.latestTurn?.state === "completed" &&
    shell.latestTurn.completedAt != null &&
    Date.parse(shell.latestTurn.completedAt) > Date.parse(shell.snoozedAt)
  ) {
    return true;
  }
  return false;
}

/**
 * A thread may be snoozed unless the agent is blocked on the user: hiding a
 * pending approval or user-input request defeats the request, and a queued
 * turn start (a message no turn has adopted yet) is invisible pending work
 * the same way it is for settle. A running session IS snoozable — snooze
 * only affects visibility, never the agent. Client-side twin of the server
 * invariants so the UI can reject before a round trip.
 */
export function canSnooze(
  shell: Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "latestUserMessageAt" | "latestTurn" | "session"
  >,
  options: { readonly now: string },
): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  if (hasQueuedTurnStart(shell, options)) return false;
  return true;
}

/**
 * Snoozed resolution: hidden from the inbox while the wake time is in the
 * future and the thread has not raised its hand. Timer wakes are derived —
 * no server event fires when snoozedUntil passes; the stale fields simply
 * stop classifying as snoozed (and feed the woke indicator until the user
 * visits or re-engages).
 */
export function effectiveSnoozed(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): boolean {
  if (shell.snoozedUntil == null) return false;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  // Malformed data never hides a thread.
  if (Number.isNaN(wakeAtMs)) return false;
  if (wakeAtMs <= Date.parse(options.now)) return false;
  return !threadRaisedHandWhileSnoozed(shell);
}

/**
 * When a previously-snoozed thread woke, or null if it never snoozed / is
 * still snoozed. Used for the "Woke" indicator: the thread reappears in its
 * original sort position (the inbox sort is deliberately static), so the
 * wake signal has to carry the weight. Compare against the client's
 * lastVisitedAt — visiting clears the indicator like it clears unread.
 *
 * Timer wakes report the wake time itself; raised-hand wakes report the
 * triggering timestamp so a visit BEFORE the early wake doesn't suppress
 * the indicator.
 */
export function threadWokeAt(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): string | null {
  if (shell.snoozedUntil == null) return null;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  if (Number.isNaN(wakeAtMs)) return null;
  // An early hand-raise wake stays authoritative even after the scheduled
  // wake time passes: reporting snoozedUntil then would resurface a Woke
  // indicator the user already cleared by visiting (snoozedUntil is newer
  // than that visit's lastVisitedAt).
  if (threadRaisedHandWhileSnoozed(shell)) {
    if (
      shell.snoozedAt != null &&
      shell.latestTurn?.state === "completed" &&
      shell.latestTurn.completedAt != null &&
      Date.parse(shell.latestTurn.completedAt) > Date.parse(shell.snoozedAt)
    ) {
      return shell.latestTurn.completedAt;
    }
    return shell.session?.updatedAt ?? shell.snoozedAt ?? null;
  }
  // No raised hand: woke iff the timer elapsed (still-snoozed → null).
  return wakeAtMs <= Date.parse(options.now) ? shell.snoozedUntil : null;
}

// ---------------------------------------------------------------------------
// loom: workstream lifecycle → settle classification, ONE DIRECTION ONLY.
// The plan lane never writes `settledOverride` and settle state never writes
// the plan lane; workstream state only enters here, at read time, as blockers
// and triggers. Everything below is additive and opt-in: `effectiveSettled`
// applies it only when the caller passes a `workstream` context, so callers
// that do not (mobile, ChatView) keep upstream behaviour exactly.
// ---------------------------------------------------------------------------

/**
 * The one workstream input that is not on the shell. Descendant liveness is a
 * subtree fact, so the caller supplies it — the sidebar derives it from the
 * rollup it already builds rather than walking the graph again.
 */
export interface WorkstreamSettleContext {
  /** Any descendant in a lane other than done/cancelled, anywhere in the subtree. */
  readonly hasNonTerminalDescendant: boolean;
}

/**
 * AUTO-settle blockers — plan state, so they suppress the inactivity/PR
 * auto-settle but an explicit settle outranks them (see `effectiveSettled`):
 *  1. a stored attention flag (`error`, `awaiting_acceptance`,
 *     `needs_guidance`) — something needs a human, and only a human clears it;
 *  2. `yielded` — parked awaiting a decision: quiescent by every runtime
 *     signal, yet owed. The single sharpest divergence between the two axes;
 *  3. a non-terminal descendant — the idle orchestrator whose subtree is still
 *     burning tokens is quiescent but load-bearing.
 * `planned` is deliberately neither blocker nor trigger. The derived attention
 * reasons are covered by `workstreamLiveAttentionBlocked` instead, and are
 * included here too only because they trivially also block auto-settle.
 */
export function workstreamAutoSettleBlocked(
  shell: Pick<OrchestrationThreadShell, "attention" | "planLane">,
  workstream: WorkstreamSettleContext,
): boolean {
  return (
    shell.attention.length > 0 ||
    shell.planLane === "yielded" ||
    workstream.hasNonTerminalDescendant
  );
}

/**
 * The attention reasons that describe LIVE runtime rather than plan state:
 * `awaiting_approval` / `awaiting_input` are derived from open approval and
 * user-input requests (never stored), so they mirror upstream's
 * `hasPendingApprovals` / `hasPendingUserInput` blockers and rank with them —
 * outranking an explicit settle, and clearing themselves when the request
 * resolves. Deliberately redundant with those two shell flags: it is the
 * derivation, not this predicate, that could drift.
 */
export function workstreamLiveAttentionBlocked(
  shell: Pick<OrchestrationThreadShell, "attention">,
): boolean {
  return shell.attention.some(
    (reason) => reason === "awaiting_approval" || reason === "awaiting_input",
  );
}

/**
 * The finished-work trigger: a plan-terminal thread that owes nothing settles
 * immediately instead of loitering for the whole inactivity window. Two
 * exceptions keep it honest — `pendingRework` marks a `done` thread a gate can
 * reopen at any moment (settling then un-settling on the reopen is churn that
 * hides a coder the reviewer is actively bouncing), and a `done` isolated child
 * whose fan-in has not landed still owes a branch merge that must stay visible.
 * `cancelled` never fans in, so it always qualifies.
 */
export function workstreamSettleTriggered(
  shell: Pick<OrchestrationThreadShell, "planLane" | "pendingRework" | "isolation" | "fanInState">,
): boolean {
  if (shell.planLane !== "done" && shell.planLane !== "cancelled") return false;
  return !shell.pendingRework && !isFanInPending(shell);
}

/**
 * Settled resolution over the server-backed settled lifecycle. Activity
 * blockers (pending approval/user-input, a live session, an unadjudicated
 * queued turn) are checked first and hold a thread active regardless of any
 * override. Past the blockers, the explicit user override (thread.settle /
 * thread.unsettle commands, projected into settledOverride + settledAt)
 * wins in both directions; without one, a thread can auto-settle on a
 * merged PR or always on a closed PR (both only while the terminal state is
 * the thread's latest event, see changeRequestAutoSettles), or settles on
 * inactivity past the window.
 * An open PR blocks the inactivity path entirely. The server
 * un-settles on real activity (user message, session start, approval/
 * user-input request), so an override never goes stale silently.
 */
export function effectiveSettled(
  shell: ThreadSettledShell,
  options: {
    readonly now: string;
    readonly autoSettleAfterDays: number | null;
    readonly autoSettleOnMerge?: boolean;
    readonly changeRequest?: ChangeRequestSettleSource | null;
    // loom: opt-in workstream lifecycle inputs (see WorkstreamSettleContext).
    // Absent/null ⇒ upstream classification, unchanged.
    readonly workstream?: WorkstreamSettleContext | null;
  },
): boolean {
  // Blocked work must remain visible even when a user explicitly settled it.
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  if (shell.session?.status === "starting" || shell.session?.status === "running") return false;
  if (hasQueuedTurnStart(shell, { now: options.now })) {
    // The queued-turn blocker alone is forgivable: it is clock-derived, and
    // list callers pass a coarser `now` than the settle action used. When
    // the server already adjudicated the queued message by accepting a
    // settle after it (settledAt stamps server accept time), trust that
    // ruling — otherwise a settle near the grace boundary leaves the row
    // pinned active until the caller's clock ticks over. A message NEWER
    // than settledAt is genuinely new work and keeps the block until the
    // server's auto-unsettle lands.
    const serverAdjudicated =
      shell.settledOverride === "settled" &&
      shell.settledAt !== null &&
      shell.latestUserMessageAt !== null &&
      Date.parse(shell.settledAt) >= Date.parse(shell.latestUserMessageAt);
    if (!serverAdjudicated) return false;
  }
  // loom: derived attention (`awaiting_approval` / `awaiting_input`) ranks with
  // the activity blockers above — it mirrors the very pending requests they
  // check, so it outranks an explicit settle for the same reason.
  if (options.workstream != null && workstreamLiveAttentionBlocked(shell)) return false;
  if (shell.settledOverride === "settled") return true;
  // "active" is the explicit keep-active pin: it suppresses auto-settle
  // until real activity clears it server-side.
  if (shell.settledOverride === "active") return false;
  // loom: workstream blockers suppress AUTO-settle only, and are therefore
  // checked BELOW the override. Upstream's blockers outrank an explicit settle
  // because they describe live runtime that clears itself; loom's describe PLAN
  // state, which can stay stale indefinitely with only a human to clear it — so
  // an abandoned graph (children left `ready`, a lingering `needs_guidance`)
  // must still be manually settleable, or the Settle action silently does
  // nothing. Nothing is hidden by that: any real news re-opens the row, because
  // the server un-settles on activity and the dispatcher's parent wake arrives
  // as a turn start on the root itself.
  if (options.workstream != null && workstreamAutoSettleBlocked(shell, options.workstream))
    return false;
  // loom: the finished-work trigger, no-override case only. A settled row
  // has no `settledAt`, so it sorts by last activity like every other
  // derived settle (`resolveSettledTimestamp`) — a just-finished thread
  // lands at the head of the shelf, which is the wanted order.
  if (options.workstream != null && workstreamSettleTriggered(shell)) return true;
  if (
    changeRequestAutoSettles(options.changeRequest, {
      autoSettleOnMerge: options.autoSettleOnMerge,
      thread: shell,
    })
  ) {
    return true;
  }
  // An open PR is unfinished business regardless of how long the thread has
  // been quiet: review can take days, and hiding the thread would bury the
  // work waiting on it. A configured merge, a close, or an explicit user
  // settle resolves it.
  if (options.changeRequest?.state === "open") return false;
  if (options.autoSettleAfterDays === null) return false;

  // A malformed `now` yields NaN, the comparison is false, and the thread stays
  // active (never a surprise auto-settle on bad input).
  return (
    Date.parse(threadLastActivityAt(shell)) <
    Date.parse(options.now) - options.autoSettleAfterDays * DAY_MS
  );
}

const HOUR_MS = 60 * 60 * 1_000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

export type SnoozePresetId = "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";

export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  /** Menu-row time column. Complements the label instead of repeating it:
      "Tomorrow" pairs with "9:00 AM", not "tomorrow 9:00 AM". */
  readonly whenLabel: string;
  /** ISO wake time. */
  readonly snoozedUntil: string;
}

function snoozeTimeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function snoozeAtHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions (a spring-forward day
// is 23 hours, so 23:30 + 24h skips the whole next day).
function addSnoozeDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

/**
 * Shared "snooze until" choices for every client. "This evening" only
 * appears while it is meaningfully before evening; after that the calendar
 * choices start at "Tomorrow".
 */
export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const inThreeHours = new Date(now.getTime() + 3 * HOUR_MS);
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: snoozeTimeOfDayLabel(inAnHour),
      snoozedUntil: inAnHour.toISOString(),
    },
    {
      id: "three-hours",
      label: "In 3 hours",
      whenLabel: snoozeTimeOfDayLabel(inThreeHours),
      snoozedUntil: inThreeHours.toISOString(),
    },
  ];

  const evening = snoozeAtHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: snoozeTimeOfDayLabel(evening),
      snoozedUntil: evening.toISOString(),
    });
  }

  const tomorrow = snoozeAtHour(addSnoozeDays(now, 1), MORNING_HOUR);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: snoozeTimeOfDayLabel(tomorrow),
    snoozedUntil: tomorrow.toISOString(),
  });

  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = snoozeAtHour(addSnoozeDays(now, daysUntilMonday), MORNING_HOUR);
  presets.push({
    id: "next-week",
    label: "Next week",
    whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${snoozeTimeOfDayLabel(nextWeek)}`,
    snoozedUntil: nextWeek.toISOString(),
  });

  return presets;
}

/**
 * Compact "wakes in" label for snoozed rows: "2h", "18h", "3d". Minutes
 * round up so a snooze never reads "0m" while still hidden. Shared by web
 * and mobile so the same wake time never reads differently per client.
 */
export function snoozeWakeLabel(snoozedUntil: string, options: { readonly now: string }): string {
  const wakeMs = Date.parse(snoozedUntil);
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(wakeMs) || Number.isNaN(nowMs)) return "now";
  const remainingMs = wakeMs - nowMs;
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}
