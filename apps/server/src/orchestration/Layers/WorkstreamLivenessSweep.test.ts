import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  ProviderInstanceId,
  type ThreadId,
  type ThreadPlanLane,
  type TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { ProviderHealthRegistry } from "../../provider/Services/ProviderHealthRegistry.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderLaunchClaims } from "../../provider/Services/ProviderLaunchClaims.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { WorkstreamLivenessSweep } from "../Services/WorkstreamLivenessSweep.ts";
import {
  buildStallNudgeMessage,
  classifyLiveness,
  computeProgressFingerprint,
  decideProgressLoop,
  decideStallAction,
  decideStuckLaunchAction,
  DEFAULT_LIVENESS_THRESHOLDS,
  makeWorkstreamLivenessSweepLive,
  submitSupersedesFailure,
  type ProgressLoopState,
} from "./WorkstreamLivenessSweep.ts";
import { buildStuckLaunchResumeMessage, isStuckLaunch } from "../stuckLaunchRecovery.ts";

const now = Date.parse("2026-06-24T00:00:00.000Z");
const minsAgo = (m: number) => DateTime.formatIso(DateTime.makeUnsafe(now - m * 60_000));
const iso = (msFromNow: number) => DateTime.formatIso(DateTime.makeUnsafe(now + msFromNow));

const session = (overrides: Partial<OrchestrationSession> = {}): OrchestrationSession => ({
  threadId: "child-1" as ThreadId,
  status: "running",
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access",
  activeTurnId: "turn-1" as TurnId,
  lastError: null,
  queuedMessages: { steering: [], followUp: [] },
  updatedAt: minsAgo(0),
  ...overrides,
});

const thread = (overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell =>
  ({
    id: "child-1" as ThreadId,
    projectId: "project-1",
    goalId: null,
    parentThreadId: "parent-1" as ThreadId,
    role: "coder",
    purpose: "x",
    planLane: "in_progress" as ThreadPlanLane,
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
    title: "Sub-thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: "turn-1" as TurnId,
      state: "running",
      requestedAt: minsAgo(30),
      startedAt: minsAgo(30),
      completedAt: null,
      assistantMessageId: null,
    },
    createdAt: minsAgo(60),
    updatedAt: minsAgo(0),
    archivedAt: null,
    session: session(),
    latestUserMessageAt: minsAgo(30),
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  }) as OrchestrationThreadShell;

const base = {
  thread: thread(),
  session: session(),
  maxActivityCreatedAtMs: now,
  heartbeatMs: now,
  hasInFlightTool: false,
  failureCount: 0,
  now,
  thresholds: DEFAULT_LIVENESS_THRESHOLDS,
};

describe("classifyLiveness", () => {
  it("returns null for a healthy, recently-active turn", () => {
    expect(classifyLiveness(base)).toBeNull();
  });

  it("trips the circuit breaker once consecutive failures reach the cap", () => {
    expect(classifyLiveness({ ...base, failureCount: 3 })?.kind).toBe("dead");
    expect(classifyLiveness({ ...base, failureCount: 2 })).toBeNull();
  });

  it("flags a mid-turn stall when the heartbeat is frozen past the stale window", () => {
    const verdict = classifyLiveness({
      ...base,
      maxActivityCreatedAtMs: now - 11 * 60_000,
      heartbeatMs: now - 11 * 60_000,
    });
    expect(verdict?.kind).toBe("stalled");
  });

  it("does NOT flag a stall when the heartbeat is fresh despite stale activity rows (long reasoning)", () => {
    // The core Phase-1 fix: a child streaming reasoning for >10 min with no
    // tool/activity row keeps a fresh heartbeat and must not read as stalled.
    const verdict = classifyLiveness({
      ...base,
      maxActivityCreatedAtMs: now - 11 * 60_000,
      heartbeatMs: now - 1_000,
    });
    expect(verdict).toBeNull();
  });

  it("never flags a child waiting on an approval as stalled or dead (State B)", () => {
    const stale = { heartbeatMs: now - 11 * 60_000, maxActivityCreatedAtMs: now - 11 * 60_000 };
    expect(
      classifyLiveness({ ...base, ...stale, thread: thread({ hasPendingApprovals: true }) }),
    ).toBeNull();
    expect(
      classifyLiveness({
        ...base,
        thread: thread({ hasPendingApprovals: true }),
        failureCount: 3,
      }),
    ).toBeNull();
  });

  // A pending QUESTION is deliberately NOT exempt: this exemption was what
  // disarmed the one component that escalates a thread parked forever on a
  // question nobody can see. The caller's attention-aware handling stops the
  // nudging; judgement itself must continue.
  it("keeps judging a child waiting on a question (the exemption is deleted)", () => {
    const stale = { heartbeatMs: now - 11 * 60_000, maxActivityCreatedAtMs: now - 11 * 60_000 };
    expect(
      classifyLiveness({ ...base, ...stale, thread: thread({ hasPendingUserInput: true }) })?.kind,
    ).toBe("stalled");
    expect(
      classifyLiveness({
        ...base,
        thread: thread({ hasPendingUserInput: true }),
        failureCount: 3,
      })?.kind,
    ).toBe("dead");
  });

  it("respects the startup grace so a slow first tool call is not a stall", () => {
    const young = thread({
      latestTurn: { ...thread().latestTurn!, startedAt: minsAgo(1), requestedAt: minsAgo(1) },
    });
    const verdict = classifyLiveness({
      ...base,
      thread: young,
      maxActivityCreatedAtMs: now - 11 * 60_000,
      heartbeatMs: now - 11 * 60_000,
    });
    expect(verdict).toBeNull();
  });

  it("does not run the stall detector when there is no active turn", () => {
    const verdict = classifyLiveness({
      ...base,
      session: session({ status: "ready", activeTurnId: null }),
      maxActivityCreatedAtMs: now - 11 * 60_000,
      heartbeatMs: now - 11 * 60_000,
    });
    expect(verdict).toBeNull();
  });

  it("does NOT flag a stall while a tool call is in flight (class 2 — slow-but-alive)", () => {
    // A quiet-but-running tool call is informational territory (the
    // dispatcher's slow-tool notice rail), never a State-C fault: a steer
    // cannot penetrate a blocked call and long calls are often legitimate.
    const verdict = classifyLiveness({
      ...base,
      hasInFlightTool: true,
      maxActivityCreatedAtMs: now - 25 * 60_000,
      heartbeatMs: now - 25 * 60_000,
    });
    expect(verdict).toBeNull();
  });

  it("tags the stalled verdict with the effective-activity episode key", () => {
    const frozenAt = now - 11 * 60_000;
    const verdict = classifyLiveness({
      ...base,
      maxActivityCreatedAtMs: frozenAt,
      heartbeatMs: frozenAt,
    });
    expect(verdict?.kind).toBe("stalled");
    expect(verdict?.effectiveActivityMs).toBe(frozenAt);
  });
});

describe("submitSupersedesFailure (Issue 3: a submit out-votes a stale error)", () => {
  const outcome = (at: string) =>
    ({
      outcome: "needs_rework",
      decision: "loop",
      round: 1,
      recordedByEventId: "evt-1",
      at,
    }) as unknown as OrchestrationThreadShell["lastOutcome"];

  it("treats an error session as superseded when a submit is newer than the session state", () => {
    // The provider errored, then recovered and the thread submitted a verdict:
    // the submit (0m ago) post-dates the error session-set (2m ago).
    expect(
      submitSupersedesFailure(
        thread({ lastOutcome: outcome(minsAgo(0)) }),
        session({ status: "error", updatedAt: minsAgo(2) }),
      ),
    ).toBe(true);
  });

  it("does NOT supersede when the error observation is newer than the last submit", () => {
    // A submit at 5m ago, then a fresh error at 1m ago — the error is real, live.
    expect(
      submitSupersedesFailure(
        thread({ lastOutcome: outcome(minsAgo(5)) }),
        session({ status: "error", updatedAt: minsAgo(1) }),
      ),
    ).toBe(false);
  });

  it("does NOT supersede when the thread has never submitted", () => {
    expect(
      submitSupersedesFailure(thread({ lastOutcome: null }), session({ status: "error" })),
    ).toBe(false);
  });
});

describe("decideStallAction (escalation ladder)", () => {
  const ladder = {
    msSinceNudge: null as number | null,
    nudgeGraceMs: DEFAULT_LIVENESS_THRESHOLDS.stallNudgeGraceMs,
  };

  it("nudges on the first sweep of a stall episode (open turn)", () => {
    expect(
      decideStallAction({ ...ladder, priorEpisodeMs: null, episodeMs: 100, hasOpenTurn: true }),
    ).toBe("nudge");
  });

  it("escalates when the same episode is still frozen after the nudge grace", () => {
    expect(
      decideStallAction({
        ...ladder,
        priorEpisodeMs: 100,
        episodeMs: 100,
        hasOpenTurn: true,
        msSinceNudge: DEFAULT_LIVENESS_THRESHOLDS.stallNudgeGraceMs,
      }),
    ).toBe("escalate");
  });

  it("waits (neither re-nudges nor escalates) while the nudge is within its grace", () => {
    expect(
      decideStallAction({
        ...ladder,
        priorEpisodeMs: 100,
        episodeMs: 100,
        hasOpenTurn: true,
        msSinceNudge: DEFAULT_LIVENESS_THRESHOLDS.stallNudgeGraceMs - 1,
      }),
    ).toBe("wait");
  });

  it("re-arms to nudge when the heartbeat advanced (new episode)", () => {
    expect(
      decideStallAction({
        ...ladder,
        priorEpisodeMs: 100,
        episodeMs: 250,
        hasOpenTurn: true,
        msSinceNudge: 30_000,
      }),
    ).toBe("nudge");
  });

  it("escalates instead of nudging when there is no open turn to steer into", () => {
    expect(
      decideStallAction({ ...ladder, priorEpisodeMs: null, episodeMs: 100, hasOpenTurn: false }),
    ).toBe("escalate");
  });
});

describe("computeProgressFingerprint (State D)", () => {
  it("changes when the within-turn tool content changes (real progress)", () => {
    const a = computeProgressFingerprint({ recentInputsSource: "editA", checkpointSource: "1|x" });
    const b = computeProgressFingerprint({ recentInputsSource: "editB", checkpointSource: "1|x" });
    expect(a).not.toBe(b);
  });

  it("is stable when the exact same content is re-emitted (spin)", () => {
    const sig = { recentInputsSource: "same-call", checkpointSource: "1|x" };
    expect(computeProgressFingerprint(sig)).toBe(computeProgressFingerprint(sig));
  });

  it("changes when only the checkpoint advances (cross-turn corroborator)", () => {
    const a = computeProgressFingerprint({ recentInputsSource: "r", checkpointSource: "1|x" });
    const b = computeProgressFingerprint({ recentInputsSource: "r", checkpointSource: "2|y" });
    expect(a).not.toBe(b);
  });

  it("does not collide null-vs-empty across the two source fields", () => {
    // Guards the delimiter: "a"+null must differ from null+"a".
    const a = computeProgressFingerprint({ recentInputsSource: "a", checkpointSource: null });
    const b = computeProgressFingerprint({ recentInputsSource: null, checkpointSource: "a" });
    expect(a).not.toBe(b);
  });
});

describe("decideProgressLoop (State D)", () => {
  const window = DEFAULT_LIVENESS_THRESHOLDS.noProgressWindowMs;
  const armed = (over: Partial<ProgressLoopState> = {}): ProgressLoopState => ({
    fingerprint: "fp1",
    flatSinceMs: now - window - 1,
    advised: false,
    ...over,
  });

  it("first observation arms the clock and never advises", () => {
    const r = decideProgressLoop({
      prior: null,
      fingerprint: "fp1",
      now,
      noProgressWindowMs: window,
    });
    expect(r.advise).toBe(false);
    expect(r.next).toEqual({ fingerprint: "fp1", flatSinceMs: now, advised: false });
  });

  it("a growing/oscillating diff re-arms and NEVER advises (the false-positive shape)", () => {
    const r = decideProgressLoop({
      prior: armed(),
      fingerprint: "fp2",
      now,
      noProgressWindowMs: window,
    });
    expect(r.advise).toBe(false);
    expect(r.next).toEqual({ fingerprint: "fp2", flatSinceMs: now, advised: false });
  });

  it("flat but still within the window does not advise yet", () => {
    const r = decideProgressLoop({
      prior: { fingerprint: "fp1", flatSinceMs: now - window + 1000, advised: false },
      fingerprint: "fp1",
      now,
      noProgressWindowMs: window,
    });
    expect(r.advise).toBe(false);
  });

  it("flat past the window advises exactly once per episode", () => {
    const first = decideProgressLoop({
      prior: armed(),
      fingerprint: "fp1",
      now,
      noProgressWindowMs: window,
    });
    expect(first.advise).toBe(true);
    expect(first.next.advised).toBe(true);
    const second = decideProgressLoop({
      prior: first.next,
      fingerprint: "fp1",
      now: now + 60_000,
      noProgressWindowMs: window,
    });
    expect(second.advise).toBe(false);
  });

  it("re-arms after progress so a later flat episode can advise again", () => {
    const advised = armed({ advised: true });
    const rearmed = decideProgressLoop({
      prior: advised,
      fingerprint: "fp9",
      now,
      noProgressWindowMs: window,
    });
    expect(rearmed.next.advised).toBe(false);
    const later = decideProgressLoop({
      prior: { ...rearmed.next, flatSinceMs: now - window - 1 },
      fingerprint: "fp9",
      now,
      noProgressWindowMs: window,
    });
    expect(later.advise).toBe(true);
  });
});

describe("buildStallNudgeMessage", () => {
  const verdict = {
    kind: "stalled" as const,
    reason: "Mid-turn stall: ...",
    effectiveActivityMs: 1,
  };

  it("carries the control-plane marker and the extracted tool error", () => {
    const text = buildStallNudgeMessage(verdict, {
      source: "tool-error",
      toolName: "edit",
      detail: "Validation failed for tool edit",
    });
    expect(text).toContain("control plane");
    expect(text).toContain("not from the user");
    expect(text).toContain("`edit`");
    expect(text).toContain("Validation failed for tool edit");
  });

  it("degrades to a generic account when no context was extracted", () => {
    const text = buildStallNudgeMessage(verdict, null);
    expect(text).toContain("control plane");
    expect(text).toContain("no specific error");
  });
});

describe("decideStuckLaunchAction", () => {
  const cap = 2;

  it("recovers a freshly-observed wedge", () => {
    expect(decideStuckLaunchAction({ prior: null, episodeMs: 1_000, cap }).action).toBe("recover");
  });

  it("waits on every later sighting of the SAME episode (one action per wedge)", () => {
    // The episode key is the `session-set` that wrote `starting`, so it only
    // changes when a recovery reset lands. Re-firing on the same key would spam
    // resets/resumes at the sweep cadence.
    const prior = { attempts: 1, lastEpisodeMs: 1_000 };
    expect(decideStuckLaunchAction({ prior, episodeMs: 1_000, cap }).action).toBe("wait");
  });

  it("recovers a re-wedge (new episode) while attempts remain", () => {
    const prior = { attempts: 1, lastEpisodeMs: 1_000 };
    expect(decideStuckLaunchAction({ prior, episodeMs: 2_000, cap }).action).toBe("recover");
  });

  it("escalates once the recovery cap is reached rather than resetting forever", () => {
    const prior = { attempts: cap, lastEpisodeMs: 1_000 };
    const decision = decideStuckLaunchAction({ prior, episodeMs: 2_000, cap });
    expect(decision.action).toBe("escalate");
    // And it does not re-escalate on the same episode.
    expect(decideStuckLaunchAction({ prior: decision.next, episodeMs: 2_000, cap }).action).toBe(
      "wait",
    );
  });
});

describe("isStuckLaunch", () => {
  const wedged = {
    status: "starting" as const,
    activeTurnId: null,
    updatedAt: iso(-30 * 60_000),
  };
  const graceMs = DEFAULT_LIVENESS_THRESHOLDS.stuckLaunchGraceMs;
  const base = { session: wedged, hasLiveProviderLaunch: false, now, graceMs };

  it("detects a `starting` session with no active turn past the grace window", () => {
    expect(isStuckLaunch(base)).toBe(true);
  });

  it("does NOT fire while the provider launch is actually live (the safety case)", () => {
    // The single guard between the recovery and killing live work. `true` here
    // is what a fail-closed liveness lookup produces whenever it cannot vouch
    // for the thread.
    expect(isStuckLaunch({ ...base, hasLiveProviderLaunch: true })).toBe(false);
  });

  it("does NOT fire within the grace window (a slow-but-real launch)", () => {
    expect(isStuckLaunch({ ...base, session: { ...wedged, updatedAt: iso(-60_000) } })).toBe(false);
  });

  it("does NOT fire once a turn is genuinely open (that is State C's territory)", () => {
    expect(
      isStuckLaunch({ ...base, session: { ...wedged, activeTurnId: "turn-1" as TurnId } }),
    ).toBe(false);
  });

  it("does NOT fire for any other session status", () => {
    for (const status of ["running", "ready", "stopped", "error"] as const) {
      expect(isStuckLaunch({ ...base, session: { ...wedged, status } })).toBe(false);
    }
  });
});

describe("classifyLiveness does not own the stuck-launch state", () => {
  // Documents the coverage gap this work closed: the pure classifier is
  // deliberately silent on a `starting`+no-turn session (it only judges an OPEN
  // turn), which is exactly why the sweep needs its own stuck-launch branch.
  it("returns null for a wedged `starting` session with no active turn", () => {
    expect(
      classifyLiveness({
        ...base,
        session: session({ status: "starting", activeTurnId: null, updatedAt: minsAgo(60) }),
        maxActivityCreatedAtMs: now - 60 * 60_000,
        heartbeatMs: now - 60 * 60_000,
      }),
    ).toBeNull();
  });
});

// ─── Stuck-launch backstop: the sweep loop end-to-end ────────────────────────
// The pure-predicate tests above prove the DECISIONS; these prove the sweep
// actually reaches them and writes the right commands — and, critically, writes
// NOTHING whenever provider liveness is asserted or merely unknown.
describe("liveness sweep loop (stuck-launch backstop + honest delivery reporting)", () => {
  const CHILD_ID = "child-stuck-launch" as ThreadId;

  const wedgedChild = (overrides: Partial<OrchestrationThreadShell> = {}) =>
    thread({
      id: CHILD_ID,
      planLane: "in_progress" as ThreadPlanLane,
      latestTurn: null,
      session: session({
        threadId: CHILD_ID,
        status: "starting",
        activeTurnId: null,
        // Well past the 15m grace.
        updatedAt: minsAgo(60),
      }),
      ...overrides,
    });

  interface SweepHarness {
    readonly threads: ReadonlyArray<OrchestrationThreadShell>;
    /** Adapter-reported live provider sessions. */
    readonly providerSessions?: ReadonlyArray<{ readonly threadId: ThreadId }>;
    /** Persisted runtime bindings (a non-`stopped` one also counts as live). */
    readonly bindings?: ReadonlyArray<{ readonly threadId: ThreadId; readonly status: string }>;
    readonly pendingTurnStarts?: ReadonlySet<ThreadId>;
    /** Make `listSessions` fail, to prove the fail-closed posture. */
    readonly livenessFails?: boolean;
    /**
     * Threads with a provider launch in flight RIGHT NOW — i.e. the original
     * turn-start is blocked inside `startSession`, having already written
     * `session.starting` and its user message and writing nothing further until it
     * resolves. No projection or table can see this; only the claim can.
     */
    readonly claimedThreadIds?: ReadonlySet<ThreadId>;
    /** Extra sweep passes beyond the first (used for the one-action-per-episode proof). */
    readonly extraPasses?: number;
    /** Clock advance between passes (default: one sweep interval). */
    readonly passAdvanceMs?: number;
    /**
     * Injected dispatch failure: reject a command the FIRST time it is seen (its
     * id is recorded as attempted, so a later pass succeeds). Reproduces the
     * partial-failure interleaving inside a multi-command action helper.
     */
    readonly failFirstDispatch?: (command: OrchestrationCommand) => boolean;
    /**
     * Keep the runtime heartbeat pinned to "now" on every pass — a thread that is
     * busy AND alive, which is State D's territory (a frozen heartbeat is State
     * C's stall).
     */
    readonly heartbeatFresh?: boolean;
    /** Work-product fingerprint source (State D); constant ⇒ flat. */
    readonly progressSignal?: { readonly recentInputsSource: string | null };
    /**
     * Re-wedge the thread with a FRESH episode before each extra pass, simulating
     * a thread that keeps returning to `starting` after every recovery.
     */
    readonly reWedgeBetweenPasses?: boolean;
    /**
     * Interleaving probe: mutate the live thread state the instant the sweep asks
     * for the pending-turn-start set — i.e. AFTER it has sampled liveness and
     * decided "wedged", but BEFORE the repair command is dispatched. This is the
     * exact race window the compare-and-swap must close.
     */
    readonly raceBeforeRepair?: (current: OrchestrationThreadShell) => OrchestrationThreadShell;
  }

  const runSweep = (input: SweepHarness) =>
    Effect.gen(function* () {
      const dispatched: Array<OrchestrationCommand> = [];
      // Live mutable thread state, so the stub can enforce the real decider's
      // compare-and-swap against state that a racing turn-start may have changed.
      let live: ReadonlyArray<OrchestrationThreadShell> = input.threads;
      const failedOnce = new Set<string>();
      const engine = {
        readEvents: () => Stream.empty,
        readStreamEvents: () => Stream.empty,
        dispatch: (command: OrchestrationCommand) =>
          Effect.suspend(() => {
            // Mirror the real decider's CAS: reject the WHOLE repair (writing
            // nothing) unless the thread is still in the exact session state the
            // sweep observed. Modelling this is what makes the interleaving test a
            // real proof rather than a stub artefact.
            if (command.type === "thread.stuck-launch.recover") {
              const target = live.find((t) => t.id === command.threadId);
              const current = target?.session ?? null;
              if (
                current === null ||
                current.updatedAt !== command.expectedSessionUpdatedAt ||
                current.status !== "starting" ||
                current.activeTurnId !== null ||
                // The second token: a turn-start accepted since the snapshot bumps
                // the latest user message even though it writes no session event.
                (target?.latestUserMessageAt ?? null) !== command.expectedLatestUserMessageAt
              ) {
                return Effect.die(new Error("stuck-launch CAS rejected: state moved"));
              }
              live = live.map((t) =>
                t.id === command.threadId ? { ...t, session: command.session } : t,
              );
            }
            if (input.failFirstDispatch?.(command) === true && !failedOnce.has(command.commandId)) {
              failedOnce.add(command.commandId);
              return Effect.die(new Error(`injected dispatch failure: ${command.commandId}`));
            }
            dispatched.push(command);
            return Effect.succeed({ sequence: dispatched.length });
          }),
        streamDomainEvents: Stream.empty,
        subscribeDomainEvents: Effect.succeed(Stream.empty),
        latestSequence: Effect.succeed(0),
      } as unknown as OrchestrationEngineShape;
      let passIndex = 0;
      const snapshotQuery = {
        getShellSnapshot: () =>
          Effect.sync(() => {
            if (input.reWedgeBetweenPasses === true) {
              // Return the thread to the wedged shape with a FRESH episode, as a
              // thread that keeps failing to launch would: the previous pass's CAS
              // left it `ready`, and the next launch attempt re-stamps `starting`.
              live = live.map((t) =>
                t.session === null
                  ? t
                  : ({
                      ...t,
                      session: {
                        ...t.session,
                        status: "starting",
                        activeTurnId: null,
                        updatedAt: minsAgo(60 - passIndex),
                      },
                    } as OrchestrationThreadShell),
              );
            }
            const threads = live;
            passIndex += 1;
            return {
              snapshotSequence: 1,
              goals: [],
              projects: [],
              threads,
              updatedAt: minsAgo(0),
            };
          }),
        // The sweep reads this immediately before dispatching the repair, which
        // makes it the natural injection point for the pre-repair race.
        getPendingTurnStartThreadIds: () =>
          Effect.sync(() => {
            if (input.raceBeforeRepair !== undefined) {
              live = live.map((t) => input.raceBeforeRepair!(t));
            }
            return input.pendingTurnStarts ?? new Set<ThreadId>();
          }),
        getActivityFreshnessByThreadId: () =>
          input.heartbeatFresh === true
            ? Clock.currentTimeMillis.pipe(
                Effect.map((nowMs) => ({
                  maxCreatedAt: null,
                  heartbeatAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
                })),
              )
            : Effect.succeed({ maxCreatedAt: null, heartbeatAt: null }),
        getInFlightToolByThreadId: () => Effect.succeed(null),
        getThreadProgressSignal: () =>
          Effect.succeed({
            recentInputsSource: input.progressSignal?.recentInputsSource ?? null,
            checkpointSource: null,
          }),
      } as unknown as ProjectionSnapshotQueryShape;
      const deps = Layer.mergeAll(
        Layer.succeed(OrchestrationEngineService, engine),
        Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
        Layer.succeed(ProviderSessionDirectory, {
          listBindings: () => Effect.succeed(input.bindings ?? []),
        } as unknown as ProviderSessionDirectory["Service"]),
        Layer.succeed(ProviderLaunchClaims, {
          withClaim: (_id: ThreadId, effect: unknown) => effect,
          isClaimed: (id: ThreadId) => Effect.sync(() => input.claimedThreadIds?.has(id) ?? false),
        } as unknown as ProviderLaunchClaims["Service"]),
        Layer.succeed(ProviderService, {
          listSessions: () =>
            input.livenessFails === true
              ? Effect.die(new Error("provider unavailable"))
              : Effect.succeed(input.providerSessions ?? []),
        } as unknown as ProviderService["Service"]),
        Layer.succeed(ProviderHealthRegistry, {
          isExhausted: () => Effect.succeed(false),
          exhaustedUntil: () => Effect.succeed(null),
          markExhausted: () => Effect.void,
          snapshot: Effect.succeed([]),
          streamChanges: Stream.empty,
        } as unknown as ProviderHealthRegistry["Service"]),
        Layer.succeed(ServerSettingsService, {
          getSettings: Effect.succeed({ providerInstances: [] }),
        } as unknown as ServerSettingsService["Service"]),
        // No durable receipts in the fixture: cross-restart dedup is the engine's
        // job, and within a run the sweep's own delivered-set is what proves the
        // honest-reporting change (a second pass over unchanged state must write,
        // log, and count nothing).
        Layer.succeed(OrchestrationCommandReceiptRepository, {
          getByCommandId: () => Effect.succeed(Option.none()),
        } as unknown as OrchestrationCommandReceiptRepository["Service"]),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-liveness-stuck-launch-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer));

      // Align the TestClock with the fixture's `now` so the sweep's grace
      // arithmetic sees the intended session ages (it defaults to epoch 0).
      yield* TestClock.setTime(now);
      // `start()` forks the sweep on its 60s schedule; each `adjust` past the
      // interval drives one more pass on the SAME instance, so the in-memory
      // episode bookkeeping is shared across passes.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sweep = yield* WorkstreamLivenessSweep;
          yield* sweep.start();
          yield* TestClock.adjust(Duration.millis(1));
          for (let pass = 0; pass < (input.extraPasses ?? 0); pass += 1) {
            yield* TestClock.adjust(
              Duration.millis(input.passAdvanceMs ?? DEFAULT_LIVENESS_THRESHOLDS.sweepIntervalMs),
            );
          }
        }).pipe(Effect.provide(makeWorkstreamLivenessSweepLive().pipe(Layer.provide(deps)))),
      );
      return dispatched;
    });

  effectIt.effect("recovers a child wedged in `starting` past the grace window", () =>
    Effect.gen(function* () {
      const dispatched = yield* runSweep({ threads: [wedgedChild()] });
      // ONE compare-and-swap repair, carrying the observed session as its
      // precondition — never an unconditional session write.
      const repair = dispatched.find((c) => c.type === "thread.stuck-launch.recover");
      if (repair?.type !== "thread.stuck-launch.recover") {
        throw new Error("expected a stuck-launch CAS repair");
      }
      expect(repair.commandId.startsWith("server:stuck-launch-recover:sweep:")).toBe(true);
      expect(repair.expectedSessionUpdatedAt).toBe(minsAgo(60));
      expect(repair.session.status).toBe("ready");
      expect(repair.session.activeTurnId).toBeNull();
      expect(dispatched.some((c) => c.type === "thread.session.set")).toBe(false);

      const resume = dispatched.find((c) => c.type === "thread.turn.start");
      if (resume?.type !== "thread.turn.start") throw new Error("expected a resume turn-start");
      // Defence in depth on top of the CAS.
      expect(resume.requireIdle).toBe(true);
      expect(resume.message.origin).toBe("control_notice");
      // Repair before resume, else requireIdle would defer against the old state.
      expect(dispatched.indexOf(repair)).toBeLessThan(dispatched.indexOf(resume));

      // Plus an audit row so the wedge and its repair are visible in the log.
      const audit = dispatched.find(
        (c) =>
          c.type === "thread.activity.append" &&
          c.activity.kind === "workstream.liveness.stuck-launch",
      );
      if (audit?.type !== "thread.activity.append") throw new Error("expected an audit row");
      expect(audit.activity.payload).toMatchObject({ resumed: true });
    }),
  );

  effectIt.effect("does NOTHING when the provider reports a live session (safety)", () =>
    Effect.gen(function* () {
      expect(
        yield* runSweep({
          threads: [wedgedChild()],
          providerSessions: [{ threadId: CHILD_ID }],
        }),
      ).toEqual([]);
    }),
  );

  effectIt.effect("does NOTHING when a non-`stopped` runtime binding exists (safety)", () =>
    Effect.gen(function* () {
      // A persisted binding that is not `stopped` means a launch is under way
      // even if no adapter has reported a session yet.
      expect(
        yield* runSweep({
          threads: [wedgedChild()],
          bindings: [{ threadId: CHILD_ID, status: "starting" }],
        }),
      ).toEqual([]);
    }),
  );

  effectIt.effect("fails CLOSED when provider liveness cannot be read (safety)", () =>
    Effect.gen(function* () {
      expect(yield* runSweep({ threads: [wedgedChild()], livenessFails: true })).toEqual([]);
    }),
  );

  effectIt.effect("does NOTHING while the wedge is still within its grace window", () =>
    Effect.gen(function* () {
      expect(
        yield* runSweep({
          threads: [
            wedgedChild({
              session: session({
                threadId: CHILD_ID,
                status: "starting",
                activeTurnId: null,
                updatedAt: minsAgo(2),
              }),
            }),
          ],
        }),
      ).toEqual([]);
    }),
  );

  effectIt.effect("clears a stale pending turn-start before the resume", () =>
    Effect.gen(function* () {
      const dispatched = yield* runSweep({
        threads: [wedgedChild()],
        pendingTurnStarts: new Set([CHILD_ID]),
      });
      // The clear rides INSIDE the CAS transaction, so there is never a window
      // where the pending row is gone but the session is not yet reset.
      const repair = dispatched.find((c) => c.type === "thread.stuck-launch.recover");
      if (repair?.type !== "thread.stuck-launch.recover") {
        throw new Error("expected a stuck-launch CAS repair");
      }
      expect(repair.clearPendingTurnStart).toBe(true);
      expect(dispatched.some((c) => c.type === "thread.turn-start.fail")).toBe(false);
      // Otherwise the requireIdle resume would defer forever.
      expect(dispatched.indexOf(repair)).toBeLessThan(
        dispatched.findIndex((c) => c.type === "thread.turn.start"),
      );
    }),
  );

  // The interleaving proof for the double-launch bar: liveness says "dead", then a
  // genuine turn-start lands before the repair is dispatched. The compare-and-swap
  // must refuse the repair outright — no pending-clear, no reset, and above all no
  // resume, because an unconditional reset would have manufactured the very
  // idleness `requireIdle` checks for and waved a second launch through.
  effectIt.effect(
    "writes NOTHING when a real turn-start lands between the liveness sample and the repair",
    () =>
      Effect.gen(function* () {
        const dispatched = yield* runSweep({
          threads: [wedgedChild()],
          pendingTurnStarts: new Set([CHILD_ID]),
          // A fresh turn-start rewrites the session row (ProviderCommandReactor
          // re-stamps `starting` with a new updatedAt), which is exactly the CAS
          // token changing under the sweep.
          raceBeforeRepair: (t) =>
            t.session === null
              ? t
              : ({
                  ...t,
                  session: { ...t.session, updatedAt: minsAgo(0) },
                } as OrchestrationThreadShell),
        });
        expect(dispatched.some((c) => c.type === "thread.turn.start")).toBe(false);
        expect(dispatched.some((c) => c.type === "thread.session.set")).toBe(false);
        expect(dispatched.some((c) => c.type === "thread.turn-start.fail")).toBe(false);
        // No audit row either: nothing was repaired, so nothing is narrated.
        expect(dispatched.some((c) => c.type === "thread.activity.append")).toBe(false);
      }),
  );

  effectIt.effect(
    "writes NOTHING when the racing turn-start has already reached a confirmed turn",
    () =>
      Effect.gen(function* () {
        // The other shape of the same race: the turn got as far as `running` with a
        // live turn id before our repair arrived.
        const dispatched = yield* runSweep({
          threads: [wedgedChild()],
          raceBeforeRepair: (t) =>
            t.session === null
              ? t
              : ({
                  ...t,
                  session: {
                    ...t.session,
                    status: "running",
                    activeTurnId: "turn-raced-in" as TurnId,
                  },
                } as OrchestrationThreadShell),
        });
        expect(dispatched.some((c) => c.type === "thread.turn.start")).toBe(false);
        expect(dispatched.some((c) => c.type === "thread.session.set")).toBe(false);
      }),
  );

  // The precise boundary the session-only CAS could NOT see (round-2 finding). A
  // real `thread.turn.start` writes no session event in its own transaction — it
  // commits `message-sent` + `turn-start-requested`, and ProviderCommandReactor
  // restamps `starting` only later. So here the session is left byte-identical and
  // ONLY the accepted user message moves. The repair must still be refused.
  effectIt.effect("writes NOTHING when a turn-start is accepted with session state UNCHANGED", () =>
    Effect.gen(function* () {
      const dispatched = yield* runSweep({
        threads: [wedgedChild()],
        pendingTurnStarts: new Set([CHILD_ID]),
        raceBeforeRepair: (t) =>
          ({
            ...t,
            // Session deliberately untouched — this is the whole point.
            latestUserMessageAt: minsAgo(0),
          }) as OrchestrationThreadShell,
      });
      expect(dispatched.some((c) => c.type === "thread.turn.start")).toBe(false);
      expect(dispatched.some((c) => c.type === "thread.session.set")).toBe(false);
      expect(dispatched.some((c) => c.type === "thread.turn-start.fail")).toBe(false);
      // Nothing repaired ⇒ nothing narrated.
      expect(dispatched.some((c) => c.type === "thread.activity.append")).toBe(false);
    }),
  );

  // The round-3 interleaving, end to end. The ORIGINAL turn-start is still blocked
  // inside `providerService.startSession`: it has already written `session.starting`
  // and its user message, and it writes nothing further until it resolves — so both
  // CAS tokens match, no binding exists yet, and no adapter session is reported.
  // Every signal except the in-flight claim says "wedged". The sweep must write
  // NOTHING while the launch is unresolved, and the original prompt must be the
  // only one that ever lands.
  effectIt.effect("writes NOTHING while the original startSession is still in flight", () =>
    Effect.gen(function* () {
      const dispatched = yield* runSweep({
        threads: [wedgedChild()],
        pendingTurnStarts: new Set([CHILD_ID]),
        // The launch is on the stack right now.
        claimedThreadIds: new Set([CHILD_ID]),
      });
      expect(dispatched).toEqual([]);
    }),
  );

  effectIt.effect("recovers only AFTER the in-flight launch resolves and stays wedged", () =>
    Effect.gen(function* () {
      // Same thread, same wedged projection — the claim released (launch resolved)
      // and the session genuinely never came alive. Recovery is deferred, not
      // disabled: one sweep cycle later it proceeds normally.
      const dispatched = yield* runSweep({
        threads: [wedgedChild()],
        pendingTurnStarts: new Set([CHILD_ID]),
        claimedThreadIds: new Set(),
      });
      expect(dispatched.some((c) => c.type === "thread.stuck-launch.recover")).toBe(true);
    }),
  );

  effectIt.effect("resets but does NOT resume an attention-flagged wedge", () =>
    Effect.gen(function* () {
      // A flagged thread has a human as its way forward and a turn-start would
      // clear the flag — but the reset still lands so the UI stops lying.
      const dispatched = yield* runSweep({
        threads: [wedgedChild({ attention: ["needs_guidance"] })],
      });
      expect(dispatched.some((c) => c.type === "thread.stuck-launch.recover")).toBe(true);
      expect(dispatched.some((c) => c.type === "thread.turn.start")).toBe(false);
      // The audit row must say so rather than claiming a re-launch that never happened.
      const audit = dispatched.find(
        (c) =>
          c.type === "thread.activity.append" &&
          c.activity.kind === "workstream.liveness.stuck-launch",
      );
      if (audit?.type !== "thread.activity.append") throw new Error("expected an audit row");
      expect(audit.activity.payload).toMatchObject({ resumed: false });
    }),
  );

  effectIt.effect("ignores a wedged thread that is plan-terminal", () =>
    Effect.gen(function* () {
      expect(
        yield* runSweep({ threads: [wedgedChild({ planLane: "done" as ThreadPlanLane })] }),
      ).toEqual([]);
    }),
  );

  effectIt.effect("ignores a wedged ROOT thread (the sweep only judges sub-threads)", () =>
    Effect.gen(function* () {
      expect(yield* runSweep({ threads: [wedgedChild({ parentThreadId: null })] })).toEqual([]);
    }),
  );

  effectIt.effect("acts at most once per wedge episode across repeated passes", () =>
    Effect.gen(function* () {
      // The snapshot is static, so later passes see the SAME wedge episode. One
      // action per wedge is what keeps the sweep from re-resetting/re-resuming a
      // thread every 60s while the projection catches up.
      const dispatched = yield* runSweep({ threads: [wedgedChild()], extraPasses: 3 });
      expect(dispatched.filter((c) => c.type === "thread.stuck-launch.recover")).toHaveLength(1);
      expect(dispatched.filter((c) => c.type === "thread.turn.start")).toHaveLength(1);
    }),
  );

  effectIt.effect("escalates to a human once the recovery cap is exhausted", () =>
    Effect.gen(function* () {
      // A thread that returns to `starting` after every recovery has a problem
      // resets cannot fix, so the ladder stops looping and asks for a human
      // rather than resetting it forever.
      const dispatched = yield* runSweep({
        threads: [wedgedChild()],
        extraPasses: 3,
        reWedgeBetweenPasses: true,
      });
      const cap = DEFAULT_LIVENESS_THRESHOLDS.stuckLaunchRecoveryCap;
      expect(dispatched.filter((c) => c.type === "thread.stuck-launch.recover")).toHaveLength(cap);
      const escalation = dispatched.find(
        (c) => c.type === "thread.attention.raise" && c.reason === "needs_guidance",
      );
      expect(escalation).toBeDefined();
      expect(
        escalation?.commandId.startsWith("server:workstream-liveness:stuck-launch-escalate:"),
      ).toBe(true);
    }),
  );

  // ─── Honest delivery reporting + the dead rail's daily buckets (§3.1/§3.4) ──
  // The defect: the engine receipt-dedups every deterministic command and returns
  // SUCCESS for the resulting no-op, so the sweep logged an action and bumped
  // `actionedCount` for writes that never happened — one wedged node pinned
  // `actionedCount > 0` forever, suppressing the only "all quiet" signal, and
  // emitted two lying log lines a minute for 26 hours in production.
  const deadChild = () =>
    thread({
      id: "child-dead" as ThreadId,
      planLane: "in_progress" as ThreadPlanLane,
      latestTurn: null,
      lastOutcome: null,
      session: session({ threadId: "child-dead" as ThreadId, status: "error", activeTurnId: null }),
    });
  // `failureCap` consecutive failed observations before the circuit breaker trips.
  const passesToDead = DEFAULT_LIVENESS_THRESHOLDS.failureCap;

  effectIt.effect(
    "re-running the sweep over an already-actioned, unchanged thread writes, logs, and counts NOTHING",
    () => {
      const logs: Array<string> = [];
      return Effect.gen(function* () {
        // Two full circuit-breaker cycles' worth of passes: the first trips and
        // writes; the second reaches the same verdict and must be silent, because
        // its command ids are already delivered.
        const dispatched = yield* runSweep({
          threads: [deadChild()],
          extraPasses: passesToDead * 2,
        });
        expect(
          dispatched.filter((c) => c.type === "thread.attention.raise" && c.reason === "error"),
        ).toHaveLength(1);
        expect(
          dispatched.filter(
            (c) =>
              c.type === "thread.activity.append" && c.activity.kind === "workstream.liveness.dead",
          ),
        ).toHaveLength(1);
        // And the observable half of `actionedCount`: exactly one action log and
        // one sweep-complete line, not one per pass.
        expect(logs.filter((m) => m === "workstream.liveness.dead")).toHaveLength(1);
        expect(logs.filter((m) => m === "workstream.liveness.sweep-complete")).toHaveLength(1);
      }).pipe(
        Effect.provide(
          Logger.layer(
            [
              Logger.make<unknown, void>(({ message }) => {
                logs.push(String(Array.isArray(message) ? message[0] : message));
              }),
            ],
            { mergeWithExisting: false },
          ),
        ),
      );
    },
  );

  effectIt.effect("a still-dead, still-unflagged thread re-raises once the day bucket rolls", () =>
    Effect.gen(function* () {
      // §3.4: the un-bucketed id was at-most-once FOREVER, so a thread whose flag
      // §7 erased at the next turn-start was never re-flagged. The bucket re-arms
      // it at most daily.
      const dispatched = yield* runSweep({
        threads: [deadChild()],
        extraPasses: 2,
        passAdvanceMs: 86_400_000,
      });
      const raises = dispatched.filter(
        (c) => c.type === "thread.attention.raise" && c.reason === "error",
      );
      // One raise per day bucket the run spans, and never twice within a bucket:
      // re-arming without regressing to the per-sweep spam the dedup prevents.
      const ids = raises.map((c) => c.commandId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toHaveLength(2);
    }),
  );

  // ─── Multi-command partial failure must stay RETRYABLE (plan §3.1) ─────────
  // Per-command `deliverOnce` stops an accepted write from being re-sent, but it
  // cannot make anything ask again: a caller that records "already advised"
  // regardless of outcome silences the rail for good. State D is the case that
  // owes two commands (evidence row + the actionable attention raise) AND
  // remembers having acted.
  const SPINNING_ID = "child-spinning" as ThreadId;
  const spinningChild = () =>
    thread({
      id: SPINNING_ID,
      planLane: "in_progress" as ThreadPlanLane,
      lastOutcome: null,
      session: session({ threadId: SPINNING_ID, activeTurnId: "t-1" as TurnId }),
    });

  effectIt.effect(
    "retries ONLY the unwritten command when a progress-loop advisory half-fails",
    () =>
      Effect.gen(function* () {
        const dispatched = yield* runSweep({
          threads: [spinningChild()],
          // A live runtime binding, so the circuit breaker sees a healthy thread
          // and State D is the branch under test.
          bindings: [{ threadId: SPINNING_ID, status: "running" }],
          // Heartbeat fresh ⇒ busy-and-alive (State D territory, not State C);
          // a constant fingerprint ⇒ flat work product across the window.
          heartbeatFresh: true,
          progressSignal: { recentInputsSource: "flat" },
          // Two passes past the no-progress window, so the advisory becomes due
          // and — after the injected failure — is retried.
          extraPasses: 2,
          passAdvanceMs: DEFAULT_LIVENESS_THRESHOLDS.noProgressWindowMs,
          // The SECOND command the helper owes fails, once, AFTER the first was
          // accepted — the exact interleaving that used to be unrecoverable.
          failFirstDispatch: (command) =>
            command.type === "thread.attention.raise" &&
            command.commandId.includes("progress-loop-attn"),
        });

        const activities = dispatched.filter(
          (c) =>
            c.type === "thread.activity.append" &&
            c.activity.kind === "workstream.liveness.progress-loop",
        );
        const raises = dispatched.filter(
          (c) => c.type === "thread.attention.raise" && c.commandId.includes("progress-loop-attn"),
        );
        // The actionable half eventually lands — the hole left it at 0 forever,
        // because the caller had already recorded the episode as advised.
        expect(raises).toHaveLength(1);
        // And ONLY that half is retried: the accepted evidence row short-circuits
        // as `already-handled`, so no duplicate is written.
        expect(activities).toHaveLength(1);
      }),
  );
});

describe("buildStuckLaunchResumeMessage", () => {
  it("re-delivers the composed kickoff when the brief never reached the provider", () => {
    // The D8 contract: "continue where you left off" is silent corruption for a
    // thread that never received its brief, so the brief is sent instead.
    const message = buildStuckLaunchResumeMessage("KICKOFF BODY");
    expect(message).toContain("kickoff brief was never delivered");
    expect(message).toContain("KICKOFF BODY");
  });

  it("sends a neutral continue notice when the kickoff was already delivered", () => {
    // A delivered-then-wedged brief must never be re-prepended to a transcript
    // that already contains it.
    const message = buildStuckLaunchResumeMessage(null);
    expect(message).toContain("Resume from where you left off");
    expect(message).not.toContain("never delivered");
  });

  it("frames both variants as control-plane notices, not user messages", () => {
    for (const message of [
      buildStuckLaunchResumeMessage(null),
      buildStuckLaunchResumeMessage("x"),
    ]) {
      expect(message).toContain("not from the user");
    }
  });
});
