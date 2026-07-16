import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationLatestTurn,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  type ProviderSession,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadPlanLane,
  type TurnId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vite-plus/test";

import {
  buildChildWakeMessage,
  childReportedCommandId,
  buildGateReverifyMessage,
  buildGateReworkMessage,
  buildStandaloneDigest,
  buildDigestPiggyback,
  buildDigestPayload,
  buildYieldPayload,
  buildYieldWakeMessage,
  digestShouldFlush,
  formatWakeTimestamp,
  FYI_DIGEST_FLUSH_MS,
  groupBatchForWake,
  parentWorkstreamQuiet,
  renderWakePair,
  renderWakeSingle,
  renderRecoveredDigestLine,
  renderSlowToolDigestLine,
  type WakeMember,
  gateCommandId,
  yieldWakeCommandId,
  childWakeCommandId,
  classifyChildWake,
  classifyChildWakeFull,
  childWakeEvidenceNeeds,
  type ChildWakeEvidence,
  type DigestExtra,
  formatProcessHealthLine,
  terminalEpisodeKey,
  DEFAULT_IDLE_WAKE_GRACE_MS,
  DEFAULT_WAKE_RATE_GUARD,
  IDLE_WAKE_REPASS_INTERVAL_MS,
  idleLastProgressMs,
  idleWakeWithinGrace,
  selectThreadsToDispatch,
  isBriefNeeded,
  briefNeededSinceMs,
  briefNeededCommandId,
  buildBriefNeededMessage,
  WORKSTREAM_CONTROL_PLANE_MARKER,
  slowToolNoticeIndex,
  WAKE_REPORT_EXCERPT_LIMIT,
  WorkstreamDispatcherLive,
  wakeRateGuardTrips,
} from "./WorkstreamDispatcher.ts";
import { WorktreeProvisioner } from "../../project/WorktreeProvisioner.ts";
import { ServerConfig } from "../../config.ts";
import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";
import { WorkstreamDispatcher } from "../Services/WorkstreamDispatcher.ts";
import { ProcessResourceMonitor } from "../../diagnostics/ProcessResourceMonitor.ts";
import { piSessionIdForThread } from "../../provider/piSessionFiles.ts";
import { decideOrchestrationCommand } from "../decider.ts";
import { createEmptyReadModel, projectEvent } from "../projector.ts";
import { isThreadIdle, shouldRefuseForkLaunch } from "../threadIdle.ts";
import { workstreamChildPrompt } from "../workstreamChildPrompt.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { reconcileStartupStaleSessionState } from "../../loom/startup.ts";

const now = "2026-06-24T00:00:00.000Z";

const shell = (
  overrides: Omit<Partial<OrchestrationThreadShell>, "id"> & { readonly id: string },
): OrchestrationThreadShell =>
  ({
    projectId: "project-1",
    goalId: null,
    parentThreadId: "parent-1" as ThreadId,
    role: "coder",
    purpose: "do the thing",
    // Default to a released lane so the un-started promotion tests exercise the
    // dispatcher; held (`planned`) and other lanes are set per-test.
    planLane: "ready" as ThreadPlanLane,
    attention: [],
    blockedBy: [],
    // Scaffold plan §1: a dispatchable child carries a kickoff brief; the brief
    // gate is held "present" here so the existing gate tests exercise the OTHER
    // preconditions. Brief-gate tests set it to null explicitly.
    kickoffBriefPath: "brief.md",
    graphKey: null,
    // Scaffold plan §3: the lane-transition episode clock. Null here (falls back
    // to createdAt); the transition tests set it explicitly.
    planLaneSince: null,
    // Scaffold plan §3: the dependency-set episode clock (gap c). Null here; the
    // re-enter-via-set_dependencies tests set it explicitly.
    dependenciesSince: null,
    faninSince: null,
    spawnGeneration: null,
    forkFromThreadId: null,
    reportPath: null,
    routes: [],
    gateRounds: 0,
    pendingRework: false,
    lastOutcome: null,
    isolation: "shared" as const,
    fanInState: "none" as const,
    title: "Sub-thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
    id: overrides.id as ThreadId,
  }) as OrchestrationThreadShell;

const ids = (threads: ReadonlyArray<OrchestrationThreadShell>) => threads.map((t) => t.id).sort();

// Worktree isolation: dispatcher-selection tests use only `shared` threads, so
// the provisioner is never invoked — a no-op stub satisfies the layer.
const WorktreeProvisionerStub = Layer.succeed(WorktreeProvisioner, {
  provisionWorktree: () => Effect.succeed({ worktreePath: "", branch: "" }),
  provisionIsolatedChild: () => Effect.succeed({ worktreePath: "", branch: "" }),
  ensureIsolatedChildProvisioned: () => Effect.succeed(true),
  hasPendingProvisionFailure: () => false,
  runSetup: () => Effect.void,
} as never);

describe("selectThreadsToDispatch", () => {
  it("promotes an un-started sub-thread with no dependencies", () => {
    expect(ids(selectThreadsToDispatch([shell({ id: "child-1" })]))).toEqual(["child-1"]);
  });

  it("ignores root threads (no parentThreadId)", () => {
    expect(selectThreadsToDispatch([shell({ id: "root-1", parentThreadId: null })])).toEqual([]);
  });

  it("does not promote a sub-thread that already has a started turn", () => {
    expect(selectThreadsToDispatch([shell({ id: "child-1", latestUserMessageAt: now })])).toEqual(
      [],
    );
  });

  it("does not promote a sub-thread that already has a provider session", () => {
    expect(
      selectThreadsToDispatch([
        shell({
          id: "child-1",
          session: {
            threadId: "child-1" as ThreadId,
            status: "running",
            providerName: "codex",
            providerInstanceId: ProviderInstanceId.make("codex"),
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            queuedMessages: { steering: [], followUp: [] },
            updatedAt: now,
          },
        }),
      ]),
    ).toEqual([]);
  });

  it("does not promote a held `planned` sub-thread even with deps clear (the release gate)", () => {
    expect(selectThreadsToDispatch([shell({ id: "child-1", planLane: "planned" })])).toEqual([]);
  });

  it("promotes the same sub-thread once it is released to `ready`", () => {
    expect(ids(selectThreadsToDispatch([shell({ id: "child-1", planLane: "ready" })]))).toEqual([
      "child-1",
    ]);
  });

  it("gates a sub-thread until every dependency is done (a non-done lane does not release)", () => {
    const threads = [
      shell({
        id: "dep-coder",
        planLane: "in_progress",
        attention: ["awaiting_acceptance"],
        latestUserMessageAt: now,
      }),
      shell({ id: "child-reviewer", blockedBy: ["dep-coder" as ThreadId] }),
    ];
    expect(selectThreadsToDispatch(threads)).toEqual([]);
  });

  it("promotes the dependent once its dependency is done", () => {
    const threads = [
      shell({ id: "dep-coder", planLane: "done", latestUserMessageAt: now }),
      shell({ id: "child-reviewer", blockedBy: ["dep-coder" as ThreadId] }),
    ];
    expect(ids(selectThreadsToDispatch(threads))).toEqual(["child-reviewer"]);
  });

  it("keeps the dependent gated on an `error`-flagged dependency, then promotes it once it reaches `done`", () => {
    // Dependent release is done-only, so an errored dependency keeps the
    // dependent waiting; the same promote pass releases it once the dependency
    // recovers to `done` (no special-casing of the error→done flip needed).
    const errored = [
      shell({ id: "dep-coder", attention: ["error"], latestUserMessageAt: now }),
      shell({ id: "child-reviewer", blockedBy: ["dep-coder" as ThreadId] }),
    ];
    expect(selectThreadsToDispatch(errored)).toEqual([]);
    const recovered = [
      shell({ id: "dep-coder", planLane: "done", latestUserMessageAt: now }),
      shell({ id: "child-reviewer", blockedBy: ["dep-coder" as ThreadId] }),
    ];
    expect(ids(selectThreadsToDispatch(recovered))).toEqual(["child-reviewer"]);
  });

  it("does not gate on a non-sibling dependency (different parentThreadId)", () => {
    const threads = [
      shell({
        id: "cousin-coder",
        parentThreadId: "other-parent" as ThreadId,
        planLane: "in_progress",
        latestUserMessageAt: now,
      }),
      shell({ id: "child-reviewer", blockedBy: ["cousin-coder" as ThreadId] }),
    ];
    expect(ids(selectThreadsToDispatch(threads))).toEqual(["child-reviewer"]);
  });

  it("treats self-refs and dangling dependency ids as non-gating", () => {
    const threads = [
      shell({
        id: "child-1",
        blockedBy: ["child-1" as ThreadId, "ghost-thread" as ThreadId],
      }),
    ];
    expect(ids(selectThreadsToDispatch(threads))).toEqual(["child-1"]);
  });

  it("skips sub-threads missing the role/purpose needed for a kick-off", () => {
    expect(selectThreadsToDispatch([shell({ id: "child-1", purpose: null })])).toEqual([]);
  });

  it("does NOT dispatch an unbriefed child (brief gate) even when deps + release clear", () => {
    expect(selectThreadsToDispatch([shell({ id: "child-1", kickoffBriefPath: null })])).toEqual([]);
  });

  it("dispatches the same child once a brief is attached", () => {
    expect(
      ids(selectThreadsToDispatch([shell({ id: "child-1", kickoffBriefPath: "/briefs/c1.md" })])),
    ).toEqual(["child-1"]);
  });
});

describe("isBriefNeeded (brief-needed eligibility, scaffold plan §2/§3)", () => {
  const map = (threads: ReadonlyArray<OrchestrationThreadShell>) =>
    new Map(threads.map((t) => [t.id, t] as const));

  it("is true for a released, deps-satisfied, unbriefed sub-thread", () => {
    const t = shell({ id: "child-1", kickoffBriefPath: null });
    expect(isBriefNeeded(t, map([t]))).toBe(true);
  });

  it("is false once a brief is attached (then it is dispatchable, not brief-needed)", () => {
    const t = shell({ id: "child-1", kickoffBriefPath: "/briefs/c1.md" });
    expect(isBriefNeeded(t, map([t]))).toBe(false);
  });

  it("is false while a held `planned` node is not yet released", () => {
    const t = shell({ id: "child-1", planLane: "planned", kickoffBriefPath: null });
    expect(isBriefNeeded(t, map([t]))).toBe(false);
  });

  it("is false while a dependency is not done (not yet eligible)", () => {
    const dep = shell({ id: "dep", planLane: "in_progress", latestUserMessageAt: now });
    const child = shell({
      id: "child-1",
      kickoffBriefPath: null,
      blockedBy: ["dep" as ThreadId],
    });
    expect(isBriefNeeded(child, map([dep, child]))).toBe(false);
  });

  it("is disjoint from selectThreadsToDispatch: a child is in exactly one set", () => {
    const unbriefed = shell({ id: "child-1", kickoffBriefPath: null });
    const briefed = shell({ id: "child-2", kickoffBriefPath: "/briefs/c2.md" });
    const threads = [unbriefed, briefed];
    expect(ids(selectThreadsToDispatch(threads))).toEqual(["child-2"]);
    expect(isBriefNeeded(unbriefed, map(threads))).toBe(true);
    expect(isBriefNeeded(briefed, map(threads))).toBe(false);
  });
});

describe("briefNeededSinceMs (eligibility-episode clock, scaffold plan §3)", () => {
  const map = (threads: ReadonlyArray<OrchestrationThreadShell>) =>
    new Map(threads.map((t) => [t.id, t] as const));

  it("dates a born-eligible node (no deps) from its scaffold/createdAt time", () => {
    const created = "2026-06-24T01:00:00.000Z";
    const t = shell({ id: "child-1", kickoffBriefPath: null, createdAt: created });
    expect(briefNeededSinceMs(t, map([t]))).toBe(Date.parse(created));
  });

  it("dates a dep-gated node from its LAST dependency's outcome, not its early createdAt", () => {
    // Scaffolded early, unblocked late: the clock must be the unblock (dep
    // outcome), never createdAt — else the liveness grace would trip on birth.
    const depDone = "2026-06-24T05:00:00.000Z";
    const dep = shell({
      id: "dep",
      planLane: "done",
      latestUserMessageAt: now,
      lastOutcome: {
        outcome: "done",
        decision: "resolve",
        round: 0,
        at: depDone,
        recordedByEventId: EventId.make("11111111-1111-1111-1111-111111111111"),
      } as unknown as OrchestrationThreadShell["lastOutcome"],
    });
    const child = shell({
      id: "child-1",
      kickoffBriefPath: null,
      createdAt: "2026-06-24T00:00:00.000Z",
      blockedBy: ["dep" as ThreadId],
    });
    expect(briefNeededSinceMs(child, map([dep, child]))).toBe(Date.parse(depDone));
  });

  it("takes the MAX across multiple dependencies (the last to finish)", () => {
    const early = shell({
      id: "dep-early",
      planLane: "done",
      latestUserMessageAt: now,
      lastOutcome: {
        outcome: "done",
        decision: "resolve",
        round: 0,
        at: "2026-06-24T03:00:00.000Z",
        recordedByEventId: EventId.make("22222222-2222-2222-2222-222222222222"),
      } as unknown as OrchestrationThreadShell["lastOutcome"],
    });
    const late = shell({
      id: "dep-late",
      planLane: "done",
      latestUserMessageAt: now,
      lastOutcome: {
        outcome: "done",
        decision: "resolve",
        round: 0,
        at: "2026-06-24T06:00:00.000Z",
        recordedByEventId: EventId.make("33333333-3333-3333-3333-333333333333"),
      } as unknown as OrchestrationThreadShell["lastOutcome"],
    });
    const child = shell({
      id: "child-1",
      kickoffBriefPath: null,
      createdAt: "2026-06-24T00:00:00.000Z",
      blockedBy: ["dep-early" as ThreadId, "dep-late" as ThreadId],
    });
    expect(briefNeededSinceMs(child, map([early, late, child]))).toBe(
      Date.parse("2026-06-24T06:00:00.000Z"),
    );
  });

  it("dates a staged-then-released node from its OWN release, not its early createdAt (gap a)", () => {
    // A node scaffolded staged early and released to `ready` much later: the
    // episode must date from the release (`planLaneSince`), else an age-based
    // clock trips the liveness grace immediately on release and a re-release's
    // unchanged key suppresses the fresh wake.
    const released = "2026-06-24T09:00:00.000Z";
    const t = shell({
      id: "child-1",
      kickoffBriefPath: null,
      createdAt: "2026-06-24T00:00:00.000Z",
      planLaneSince: released,
    });
    expect(briefNeededSinceMs(t, map([t]))).toBe(Date.parse(released));
  });

  it("picks up a dependency completed via lane-only set_lane(done) with no outcome (gap b)", () => {
    // The dep reached `done` through `workstream_set_lane`, so it has NO
    // `lastOutcome`; its done-transition time lives on `planLaneSince`. The
    // clock must still advance to it, else the old outcome-only derivation would
    // fall back to the child's stale createdAt.
    const depDone = "2026-06-24T07:00:00.000Z";
    const dep = shell({
      id: "dep",
      planLane: "done",
      latestUserMessageAt: now,
      lastOutcome: null,
      planLaneSince: depDone,
    });
    const child = shell({
      id: "child-1",
      kickoffBriefPath: null,
      createdAt: "2026-06-24T00:00:00.000Z",
      planLaneSince: null,
      blockedBy: ["dep" as ThreadId],
    });
    expect(briefNeededSinceMs(child, map([dep, child]))).toBe(Date.parse(depDone));
  });

  it("ignores a non-terminal dep's planLaneSince (only a DONE dep contributes)", () => {
    // A dep merely released to `ready` (planLaneSince set) but not yet done must
    // NOT advance the clock — only its eventual completion does.
    const child = shell({
      id: "child-1",
      kickoffBriefPath: null,
      createdAt: "2026-06-24T00:00:00.000Z",
      planLaneSince: null,
      blockedBy: ["dep" as ThreadId],
    });
    const dep = shell({
      id: "dep",
      planLane: "ready",
      lastOutcome: null,
      planLaneSince: "2026-06-24T08:00:00.000Z",
    });
    expect(briefNeededSinceMs(child, map([dep, child]))).toBe(
      Date.parse("2026-06-24T00:00:00.000Z"),
    );
  });

  it("advances on a set_dependencies that re-enters eligibility with an already-done dep (gap c)", () => {
    // Re-enter scenario: the node was eligible, left (an unfinished dep added),
    // then a later set_dependencies swapped in an already-`done` dep whose
    // outcome PREDATES the prior episode. Only the dependency-set stamp
    // (`dependenciesSince`) dates the true re-entry — the dep outcome alone
    // would leave the clock stale and suppress the fresh wake.
    const depSetAt = "2026-06-24T10:00:00.000Z";
    const dep = shell({
      id: "dep",
      planLane: "done",
      latestUserMessageAt: now,
      // Outcome long before the re-entry — must NOT be the episode.
      lastOutcome: {
        outcome: "done",
        decision: "resolve",
        round: 0,
        at: "2026-06-24T01:00:00.000Z",
        recordedByEventId: EventId.make("44444444-4444-4444-4444-444444444444"),
      } as unknown as OrchestrationThreadShell["lastOutcome"],
      planLaneSince: "2026-06-24T01:00:00.000Z",
    });
    const child = shell({
      id: "child-1",
      kickoffBriefPath: null,
      createdAt: "2026-06-24T00:00:00.000Z",
      planLaneSince: null,
      dependenciesSince: depSetAt,
      blockedBy: ["dep" as ThreadId],
    });
    expect(briefNeededSinceMs(child, map([dep, child]))).toBe(Date.parse(depSetAt));
    // The receipt/episode key advances with it, so a fresh batched wake fires
    // instead of the prior episode's stale marker suppressing it.
    expect(
      briefNeededCommandId("child-1" as ThreadId, briefNeededSinceMs(child, map([dep, child]))),
    ).not.toBe(briefNeededCommandId("child-1" as ThreadId, Date.parse("2026-06-24T00:00:00.000Z")));
  });

  it("excludes dependenciesSince while the current dep set is UNSATISFIED (added-unfinished-dep state)", () => {
    // A set_dependencies that ADDS an unfinished dep stamps dependenciesSince but
    // leaves the node ineligible; the stamp must not seed a phantom episode.
    const child = shell({
      id: "child-1",
      kickoffBriefPath: null,
      createdAt: "2026-06-24T00:00:00.000Z",
      planLaneSince: null,
      dependenciesSince: "2026-06-24T09:00:00.000Z",
      blockedBy: ["dep" as ThreadId],
    });
    const dep = shell({ id: "dep", planLane: "ready", lastOutcome: null });
    // Deps unsatisfied → dependenciesSince excluded → clock stays at createdAt.
    expect(briefNeededSinceMs(child, map([dep, child]))).toBe(
      Date.parse("2026-06-24T00:00:00.000Z"),
    );
  });

  it("dates the episode from an isolated dep's fan-in completion, not its earlier done (gap d)", () => {
    // The isolated dep went `done` (+ outcome) long ago, but its branch fanned
    // in only much later. `areDependenciesSatisfied` gates on fanInState ===
    // 'completed', so THAT fanin-set is the true eligibility transition — the
    // clock must date from it, else a slow settlement past grace trips the
    // backstop the instant the dependent becomes eligible.
    const faninAt = "2026-06-24T12:00:00.000Z";
    const dep = shell({
      id: "dep",
      planLane: "done",
      latestUserMessageAt: now,
      isolation: "isolated",
      fanInState: "completed",
      lastOutcome: {
        outcome: "done",
        decision: "resolve",
        round: 0,
        at: "2026-06-24T02:00:00.000Z",
        recordedByEventId: EventId.make("55555555-5555-5555-5555-555555555555"),
      } as unknown as OrchestrationThreadShell["lastOutcome"],
      planLaneSince: "2026-06-24T02:00:00.000Z",
      faninSince: faninAt,
    });
    const child = shell({
      id: "child-1",
      kickoffBriefPath: null,
      createdAt: "2026-06-24T00:00:00.000Z",
      planLaneSince: null,
      blockedBy: ["dep" as ThreadId],
    });
    expect(briefNeededSinceMs(child, map([dep, child]))).toBe(Date.parse(faninAt));
  });

  it("does NOT count an isolated dep's fan-in for an ATTACHED dependent (releases on done alone)", () => {
    // An attached dependent (a gated reviewer) joins the coder's pre-merge tree,
    // so the predicate releases it on the dep's `done` alone — fan-in is not
    // load-bearing and must not enter the clock.
    const dep = shell({
      id: "dep",
      planLane: "done",
      latestUserMessageAt: now,
      isolation: "isolated",
      fanInState: "completed",
      lastOutcome: null,
      planLaneSince: "2026-06-24T02:00:00.000Z",
      faninSince: "2026-06-24T12:00:00.000Z",
    });
    const child = shell({
      id: "child-1",
      kickoffBriefPath: null,
      createdAt: "2026-06-24T00:00:00.000Z",
      planLaneSince: null,
      isolation: "attached",
      blockedBy: ["dep" as ThreadId],
    });
    // Fan-in excluded → episode is the dep's done transition (planLaneSince).
    expect(briefNeededSinceMs(child, map([dep, child]))).toBe(
      Date.parse("2026-06-24T02:00:00.000Z"),
    );
  });

  it("dates the episode from the two-hop coder's fan-in behind an attached reviewer (gap d)", () => {
    // The dependent is gated on an attached reviewer that is itself `done`, but
    // the merged output belongs to the isolated coder the reviewer gates, whose
    // fan-in lands at gate resolution — asynchronously after the reviewer's done.
    // The episode must date from THAT coder's fan-in.
    const coderFaninAt = "2026-06-24T13:00:00.000Z";
    const coder = shell({
      id: "coder",
      planLane: "done",
      latestUserMessageAt: now,
      isolation: "isolated",
      fanInState: "completed",
      planLaneSince: "2026-06-24T03:00:00.000Z",
      faninSince: coderFaninAt,
    });
    const reviewer = shell({
      id: "reviewer",
      planLane: "done",
      latestUserMessageAt: now,
      isolation: "attached",
      lastOutcome: null,
      planLaneSince: "2026-06-24T04:00:00.000Z",
      blockedBy: ["coder" as ThreadId],
    });
    const child = shell({
      id: "child-1",
      kickoffBriefPath: null,
      createdAt: "2026-06-24T00:00:00.000Z",
      planLaneSince: null,
      blockedBy: ["reviewer" as ThreadId],
    });
    expect(briefNeededSinceMs(child, map([coder, reviewer, child]))).toBe(Date.parse(coderFaninAt));
  });
});

describe("briefNeededCommandId (episode-keyed marker id)", () => {
  it("keys by (childId, briefNeededSince) so a fresh episode re-arms", () => {
    const a = briefNeededCommandId("child-1" as ThreadId, 1000);
    const b = briefNeededCommandId("child-1" as ThreadId, 2000);
    expect(a).not.toBe(b);
    expect(a).toBe(briefNeededCommandId("child-1" as ThreadId, 1000));
    expect(a.startsWith("server:workstream-brief-needed:")).toBe(true);
  });
});

describe("buildBriefNeededMessage (scaffold plan §2 batched notice)", () => {
  it("names every eligible child by graph key + role + title and instructs workstream_brief", () => {
    const text = buildBriefNeededMessage([
      { id: "child-a" as ThreadId, graphKey: "api", role: "coder", title: "Dedup endpoint" },
      { id: "child-b" as ThreadId, graphKey: null, role: "reviewer", title: "Review it" },
    ]);
    expect(text).toContain(WORKSTREAM_CONTROL_PLANE_MARKER);
    expect(text).toContain("2 of your Workstream sub-threads");
    expect(text).toContain("`api`");
    expect(text).toContain("Dedup endpoint");
    // Keyless child falls back to its thread id.
    expect(text).toContain("`child-b`");
    expect(text).toContain("workstream_brief");
  });

  it("uses the singular lead for exactly one child", () => {
    const text = buildBriefNeededMessage([
      { id: "child-a" as ThreadId, graphKey: "api", role: "coder", title: "Dedup endpoint" },
    ]);
    expect(text).toContain("One of your Workstream sub-threads");
  });
});

const runningSession = (overrides: Partial<OrchestrationSession> = {}): OrchestrationSession => ({
  threadId: "parent-1" as ThreadId,
  status: "running",
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access",
  activeTurnId: "turn-1" as TurnId,
  lastError: null,
  queuedMessages: { steering: [], followUp: [] },
  updatedAt: now,
  ...overrides,
});

describe("isThreadIdle", () => {
  it("is idle with no session, no pending turn-start, and no active turn", () => {
    expect(isThreadIdle(shell({ id: "parent-1", session: null }), new Set())).toBe(true);
  });

  it("is busy while the session is running", () => {
    expect(isThreadIdle(shell({ id: "parent-1", session: runningSession() }), new Set())).toBe(
      false,
    );
  });

  it("is busy while a turn-start is pending even though activeTurnId is null", () => {
    const parent = shell({
      id: "parent-1",
      session: runningSession({ status: "idle", activeTurnId: null }),
    });
    expect(isThreadIdle(parent, new Set(["parent-1" as ThreadId]))).toBe(false);
  });

  it("is busy while an active turn is set", () => {
    const parent = shell({
      id: "parent-1",
      session: runningSession({ status: "ready", activeTurnId: "turn-9" as TurnId }),
    });
    expect(isThreadIdle(parent, new Set())).toBe(false);
  });
});

describe("shouldRefuseForkLaunch", () => {
  const busySource = shell({
    id: "source-1",
    session: runningSession({ threadId: "source-1" as ThreadId }),
  });
  const idleSource = shell({ id: "source-1", session: null });
  const fork = "source-1" as ThreadId;

  it("refuses the FIRST launch of a fork while the source is mid-turn", () => {
    expect(
      shouldRefuseForkLaunch({
        forkFromThreadId: fork,
        childSessionFileExists: false,
        source: busySource,
        pendingTurnStartThreadIds: new Set(),
      }),
    ).toBe(true);
  });

  it("allows the first launch when the source is idle", () => {
    expect(
      shouldRefuseForkLaunch({
        forkFromThreadId: fork,
        childSessionFileExists: false,
        source: idleSource,
        pendingTurnStartThreadIds: new Set(),
      }),
    ).toBe(false);
  });

  it("never re-forks: a later launch (child file already exists) is always allowed", () => {
    expect(
      shouldRefuseForkLaunch({
        forkFromThreadId: fork,
        childSessionFileExists: true,
        source: busySource,
        pendingTurnStartThreadIds: new Set(),
      }),
    ).toBe(false);
  });

  it("does not gate a non-forked thread", () => {
    expect(
      shouldRefuseForkLaunch({
        forkFromThreadId: null,
        childSessionFileExists: false,
        source: busySource,
        pendingTurnStartThreadIds: new Set(),
      }),
    ).toBe(false);
  });

  it("does not block when the source thread is unknown (driver's own guard covers)", () => {
    expect(
      shouldRefuseForkLaunch({
        forkFromThreadId: fork,
        childSessionFileExists: false,
        source: undefined,
        pendingTurnStartThreadIds: new Set(),
      }),
    ).toBe(false);
  });
});

describe("wakeRateGuardTrips", () => {
  it("does not trip on a slow-cadence job (one wake every few minutes)", () => {
    const now = 10_000_000;
    const slow = Array.from({ length: 50 }, (_unused, index) => now - index * 5 * 60_000);
    expect(wakeRateGuardTrips(slow, now)).toBe(false);
  });

  it("trips on a tight spin-loop (many wakes in the rolling window)", () => {
    const now = 10_000_000;
    const tight = Array.from({ length: DEFAULT_WAKE_RATE_GUARD.maxInWindow }, () => now - 100);
    expect(wakeRateGuardTrips(tight, now)).toBe(true);
  });

  it("trips on the absolute backstop regardless of cadence", () => {
    const now = 10_000_000;
    const many = Array.from(
      { length: DEFAULT_WAKE_RATE_GUARD.absoluteBackstop },
      (_unused, index) => now - index * 60 * 60_000,
    );
    expect(wakeRateGuardTrips(many, now)).toBe(true);
  });
});

describe("buildStandaloneDigest (terminal delta items render as FYI)", () => {
  it("carries each child's role, id, plan lane, report reference, and a short report inline", () => {
    const text = buildStandaloneDigest([
      {
        id: "child-1" as ThreadId,
        role: "researcher",
        planLane: "done",
        attention: [],
        reportPath: "child-1.md",
        report: "# Findings\nAll good.",
      },
      {
        id: "child-2" as ThreadId,
        role: "reviewer",
        planLane: "cancelled",
        attention: [],
        reportPath: null,
        report: null,
      },
    ]);
    expect(text).toContain("researcher");
    expect(text).toContain("child-1");
    expect(text).toContain("done");
    // A cancelled child shows its actual lane, never described as finished.
    expect(text).toContain("cancelled");
    expect(text).not.toContain("has finished");
    // Short reports fit inline under the bound.
    expect(text).toContain("All good.");
    // The on-disk pointer is referenced, never the raw content alone.
    expect(text).toContain("child-1.md");
    expect(text).toContain("No report was filed");
    // Digest framing: nothing is blocked on the parent.
    expect(text).toContain("Nothing below is blocked on you");
  });

  it("bounds an oversized report to an excerpt + reference, never the full text", () => {
    const tail = "TAIL_MARKER_SHOULD_NOT_APPEAR";
    const report = `${"x".repeat(WAKE_REPORT_EXCERPT_LIMIT + 50)}${tail}`;
    const text = buildStandaloneDigest([
      {
        id: "child-1" as ThreadId,
        role: "researcher",
        planLane: "done",
        attention: [],
        reportPath: "child-1.md",
        report,
      },
    ]);
    expect(text).toContain("child-1.md");
    expect(text).toContain("excerpt truncated");
    expect(text).not.toContain(tail);
    expect(text).not.toContain(report);
  });
});

describe("buildDigestPayload (structured card source-of-truth)", () => {
  it("emits one item per terminal member plus each extra, with icon + status + bounded excerpt", () => {
    const payload = buildDigestPayload(
      [
        {
          id: "child-1" as ThreadId,
          role: "researcher",
          planLane: "done",
          attention: [],
          reportPath: "child-1.md",
          report: "# Findings\nAll good.",
        },
        {
          id: "child-2" as ThreadId,
          role: "reviewer",
          planLane: "cancelled",
          attention: [],
          reportPath: null,
          report: null,
        },
      ],
      [
        {
          kind: "recovered",
          childId: "child-3" as ThreadId,
          role: "coder",
          line: "- ♻️ recovered",
        },
      ],
    );
    expect(payload.kind).toBe("digest");
    expect(payload.items).toHaveLength(3);
    const [done, cancelled, recovered] = payload.items;
    expect(done).toMatchObject({
      threadId: "child-1",
      role: "researcher",
      status: "done",
      icon: "☑️",
      reportPath: "child-1.md",
    });
    expect(done!.excerpt).toContain("All good.");
    expect(cancelled).toMatchObject({ threadId: "child-2", status: "cancelled", icon: "🚫" });
    expect(cancelled!.reportPath).toBeUndefined();
    expect(recovered).toMatchObject({ threadId: "child-3", status: "recovered", icon: "♻️" });
  });

  it("a resolved gate source carries the verdict as status + ✅ icon", () => {
    const payload = buildDigestPayload([
      {
        id: "rev-1" as ThreadId,
        role: "reviewer",
        planLane: "done",
        attention: [],
        reportPath: "rev-1.md",
        report: "verified",
        lastOutcome: {
          decision: "resolve",
          outcome: "clean",
          round: 0,
          recordedByEventId: "evt-1",
          at: "2026-07-07T14:32:00.000Z",
        } as unknown as NonNullable<WakeMember["lastOutcome"]>,
      },
    ]);
    expect(payload.items[0]).toMatchObject({ status: "clean", icon: "✅" });
    expect(payload.items[0]!.title).toContain("Gate resolved");
  });

  it("bounds an oversized excerpt to the same limit as the inline text", () => {
    const tail = "TAIL_MARKER_SHOULD_NOT_APPEAR";
    const report = `${"x".repeat(WAKE_REPORT_EXCERPT_LIMIT + 50)}${tail}`;
    const payload = buildDigestPayload([
      {
        id: "child-1" as ThreadId,
        role: "researcher",
        planLane: "done",
        attention: [],
        reportPath: "child-1.md",
        report,
      },
    ]);
    expect(payload.items[0]!.excerpt).not.toContain(tail);
    expect(payload.items[0]!.excerpt!.length).toBeLessThanOrEqual(WAKE_REPORT_EXCERPT_LIMIT + 1);
  });
});

describe("buildYieldPayload (structured yield card)", () => {
  it("leads with the yielding child and appends the gate counterpart", () => {
    const payload = buildYieldPayload(
      { id: "coder-1" as ThreadId, role: "coder", reportPath: "coder-1.md" },
      "rework_approach",
      "my report",
      {
        rounds: 2,
        maxRounds: 2,
        counterpart: {
          id: "rev-1" as ThreadId,
          role: "reviewer",
          reportPath: "rev-1.md",
          report: "findings",
        },
      },
    );
    expect(payload.kind).toBe("yield");
    expect(payload.items).toHaveLength(2);
    expect(payload.items[0]).toMatchObject({ threadId: "coder-1", status: "yielded" });
    expect(payload.items[0]!.title).toContain("rework_approach");
    expect(payload.items[1]).toMatchObject({ threadId: "rev-1", status: "counterpart" });
    expect(payload.heading).toContain("round cap exhausted");
  });

  it("a non-gate yield carries just the child", () => {
    const payload = buildYieldPayload(
      { id: "coder-1" as ThreadId, role: "coder", reportPath: null },
      "weird_token",
      null,
    );
    expect(payload.items).toHaveLength(1);
    expect(payload.items[0]!.reportPath).toBeUndefined();
    expect(payload.heading).toContain("unmatched outcome");
  });
});

describe("structured payload / flattened text parity (no-drift contract)", () => {
  const mkMember = (
    overrides: Omit<Partial<WakeMember>, "id"> & { readonly id: string },
  ): WakeMember => ({
    role: "coder",
    planLane: "done" as ThreadPlanLane,
    attention: [],
    reportPath: null,
    report: null,
    fanInState: "completed",
    lastOutcome: null,
    gateRounds: 0,
    routes: [],
    eventAt: "2026-07-07T14:32:00.000Z",
    releasedDependents: [],
    ...overrides,
    id: overrides.id as ThreadId,
  });
  const resolveRoutes = (to: string) =>
    [
      { on: ["needs_rework"], kind: "loop", to, maxRounds: 2 },
      { on: ["clean", "fixed_inline"], kind: "resolve" },
    ] as unknown as NonNullable<WakeMember["routes"]>;
  const resolveOutcome = (outcome: string) =>
    ({
      outcome,
      decision: "resolve",
      round: 0,
      recordedByEventId: "evt-1",
      at: "2026-07-07T14:32:00.000Z",
    }) as unknown as NonNullable<WakeMember["lastOutcome"]>;

  // Every piece of structured content the card would show (excerpt AND
  // timestamp) MUST be a substring of the flattened text the model received —
  // that is the no-drift contract in one assertion.
  const assertContentSubsetOfText = (
    items: ReadonlyArray<{
      readonly excerpt?: string | undefined;
      readonly timestamp?: string | undefined;
    }>,
    text: string,
  ) => {
    for (const item of items) {
      if (item.excerpt !== undefined) expect(text).toContain(item.excerpt);
      if (item.timestamp !== undefined) expect(text).toContain(item.timestamp);
    }
  };

  it("a resolved gate pair: source excerpt is in both text and payload; target is reference-only in both", () => {
    const members = [
      mkMember({
        id: "rev",
        role: "reviewer",
        routes: resolveRoutes("cod"),
        lastOutcome: resolveOutcome("clean"),
        reportPath: "/r/rev.md",
        report: "SOURCE_VERDICT_EXCERPT clean, both findings resolved.",
      }),
      mkMember({
        id: "cod",
        role: "coder",
        reportPath: "/r/cod-r2.md",
        report: "TARGET_ROUND_REPORT_MUST_NOT_APPEAR",
      }),
    ];
    const text = buildStandaloneDigest(members);
    const payload = buildDigestPayload(members);
    // Two items (source + target), source carries the excerpt, target does not.
    expect(payload.items).toHaveLength(2);
    const source = payload.items.find((i) => i.threadId === "rev")!;
    const target = payload.items.find((i) => i.threadId === "cod")!;
    expect(source.excerpt).toContain("SOURCE_VERDICT_EXCERPT");
    expect(target.excerpt).toBeUndefined();
    // The pair header states neither the target's lane nor its own timestamp, so
    // the target item carries neither (only the SOURCE's timestamp is sent).
    expect(target.status).toBeUndefined();
    expect(target.timestamp).toBeUndefined();
    // The target's round-report body appears in NEITHER surface (reference only).
    expect(text).not.toContain("TARGET_ROUND_REPORT_MUST_NOT_APPEAR");
    expect(JSON.stringify(payload)).not.toContain("TARGET_ROUND_REPORT_MUST_NOT_APPEAR");
    // Every structured excerpt AND timestamp in the payload is in the sent text.
    assertContentSubsetOfText(payload.items, text);
  });

  it("a yield with a piggybacked digest: the payload carries the piggyback items the appended text carries", () => {
    const child = { id: "cod" as ThreadId, role: "coder", reportPath: "/r/cod.md" };
    const piggybackMembers = [
      mkMember({
        id: "sib",
        role: "researcher",
        planLane: "done",
        reportPath: "/r/sib.md",
        report: "PIGGYBACK_SIBLING_EXCERPT done and routed.",
      }),
    ];
    const piggyback = { members: piggybackMembers, extras: [] as DigestExtra[] };
    // Mirror the send site: action text + piggyback section = the sent bytes.
    const yieldText = `${buildYieldWakeMessage(child, "rework_approach", "YIELD_CHILD_EXCERPT my report")}\n${buildDigestPiggyback(piggyback.members, piggyback.extras)}`;
    const payload = buildYieldPayload(
      child,
      "rework_approach",
      "YIELD_CHILD_EXCERPT my report",
      undefined,
      piggyback,
    );
    // The piggyback sibling is represented as its own card item, not dropped.
    expect(payload.items.some((i) => i.threadId === "sib")).toBe(true);
    // Both the child's and the piggyback sibling's excerpts (and any stamped
    // timestamps) are in the sent text.
    assertContentSubsetOfText(payload.items, yieldText);
    expect(yieldText).toContain("PIGGYBACK_SIBLING_EXCERPT");
    expect(yieldText).toContain("YIELD_CHILD_EXCERPT");
  });
});

describe("groupBatchForWake + pair rendering (design §4.1/§5.1)", () => {
  const member = (
    overrides: Omit<Partial<WakeMember>, "id"> & { readonly id: string },
  ): WakeMember => ({
    role: "coder",
    planLane: "done" as ThreadPlanLane,
    attention: [],
    reportPath: null,
    report: null,
    fanInState: "completed",
    lastOutcome: null,
    gateRounds: 0,
    routes: [],
    eventAt: "2026-07-07T14:32:00.000Z",
    releasedDependents: [],
    ...overrides,
    id: overrides.id as ThreadId,
  });
  const resolveRoutes = (to: string) =>
    [
      { on: ["needs_rework"], kind: "loop", to, maxRounds: 2 },
      { on: ["clean", "fixed_inline"], kind: "resolve" },
    ] as unknown as NonNullable<WakeMember["routes"]>;
  const resolveOutcome = (outcome: string) =>
    ({
      outcome,
      decision: "resolve",
      round: 0,
      recordedByEventId: "evt-1",
      at: "2026-07-07T14:32:00.000Z",
    }) as unknown as NonNullable<WakeMember["lastOutcome"]>;

  it("pairs a resolve-source with its in-batch loop target; singles pass through", () => {
    const reviewer = member({
      id: "rev",
      role: "reviewer",
      routes: resolveRoutes("cod"),
      lastOutcome: resolveOutcome("clean"),
    });
    const coder = member({ id: "cod", role: "coder" });
    const solo = member({ id: "solo", role: "researcher", routes: [], lastOutcome: null });
    const { pairs, singles } = groupBatchForWake([reviewer, coder, solo]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.source.id).toBe("rev");
    expect(pairs[0]!.target.id).toBe("cod");
    expect(singles.map((s) => s.id)).toEqual(["solo"]);
  });

  it("leaves a resolve-source as a single when its target is absent from the batch", () => {
    const reviewer = member({
      id: "rev",
      role: "reviewer",
      routes: resolveRoutes("cod"),
      lastOutcome: resolveOutcome("clean"),
    });
    const { pairs, singles } = groupBatchForWake([reviewer]);
    expect(pairs).toHaveLength(0);
    expect(singles.map((s) => s.id)).toEqual(["rev"]);
  });

  it("does NOT pair a force-dissolved gate (source terminal without a resolve verdict)", () => {
    // Parent force-`done`/`cancelled` on the reviewer leaves the loop route but
    // no resolve outcome — both parties must fall through to honest singles, and
    // the coder must keep its unreviewed-completion ☑️ first-look treatment.
    const forcedReviewer = member({
      id: "rev",
      role: "reviewer",
      planLane: "cancelled",
      routes: resolveRoutes("cod"),
      lastOutcome: null,
    });
    const coder = member({ id: "cod", role: "coder", reportPath: "/r/cod.md", report: "work" });
    const { pairs, singles } = groupBatchForWake([forcedReviewer, coder]);
    expect(pairs).toHaveLength(0);
    expect(singles.map((s) => s.id).sort()).toEqual(["cod", "rev"]);
    // The coder renders as a plain unreviewed completion (☑️ + excerpt), NOT
    // "reference only — verified by the gate".
    const coderSingle = renderWakeSingle(coder);
    expect(coderSingle).toContain("☑️");
    expect(coderSingle).toContain("work");
    expect(coderSingle).not.toContain("verified by the gate");
    // The forced reviewer does not claim a gate resolution.
    expect(renderWakeSingle(forcedReviewer)).not.toContain("Gate resolved");
  });

  it("does NOT pair a gate looped back (source outcome is loop, not resolve)", () => {
    const loopingReviewer = member({
      id: "rev",
      role: "reviewer",
      routes: resolveRoutes("cod"),
      lastOutcome: {
        outcome: "needs_rework",
        decision: "loop",
        round: 1,
        recordedByEventId: "evt-loop",
        at: "2026-07-07T14:32:00.000Z",
      } as unknown as NonNullable<WakeMember["lastOutcome"]>,
    });
    const coder = member({ id: "cod", role: "coder" });
    const { pairs } = groupBatchForWake([loopingReviewer, coder]);
    expect(pairs).toHaveLength(0);
  });

  it("renders a pair as ONE section: verdict, rounds, fan-in, source excerpt, target reference only", () => {
    const text = renderWakePair({
      source: member({
        id: "rev",
        role: "reviewer",
        routes: resolveRoutes("cod"),
        gateRounds: 2,
        lastOutcome: resolveOutcome("clean"),
        reportPath: "/r/rev.md",
        report: "Clean. Both findings resolved.",
        releasedDependents: [{ id: "tail" as ThreadId, role: "integration" }],
      }),
      target: member({
        id: "cod",
        role: "coder",
        reportPath: "/r/cod-r2.md",
        report: "THIS_TARGET_EXCERPT_MUST_NOT_APPEAR",
        fanInState: "completed",
      }),
    });
    expect(text).toContain("Gate resolved `clean`");
    expect(text).toContain("reviewer `rev`");
    expect(text).toContain("coder `cod`");
    expect(text).toContain("2 rework rounds");
    expect(text).toContain("merged into yours");
    expect(text).toContain("integration `tail`");
    expect(text).toContain("2026-07-07 14:32Z");
    // Source excerpt present; target excerpt absent (reference only).
    expect(text).toContain("Clean. Both findings resolved.");
    expect(text).toContain("/r/cod-r2.md");
    expect(text).not.toContain("THIS_TARGET_EXCERPT_MUST_NOT_APPEAR");
    expect(text).toContain("verified by the gate");
  });

  it("a pair with a conflicted target carries the conflict block instead of a merged clause", () => {
    const text = renderWakePair({
      source: member({
        id: "rev",
        role: "reviewer",
        routes: resolveRoutes("cod"),
        lastOutcome: resolveOutcome("fixed_inline"),
        reportPath: "/r/rev.md",
        report: "Fixed a typo inline.",
      }),
      target: member({ id: "cod", role: "coder", fanInState: "conflicted" }),
    });
    expect(text).toContain("Gate resolved `fixed_inline`");
    expect(text).toContain("CONFLICTED");
    expect(text).toContain("Fan-in merge conflict");
    expect(text).not.toContain("merged into yours");
  });

  it("buildStandaloneDigest: gate-resolved items carry the no-review-owed closing", () => {
    const text = buildStandaloneDigest([
      member({
        id: "rev",
        role: "reviewer",
        routes: resolveRoutes("cod"),
        lastOutcome: resolveOutcome("clean"),
        reportPath: "/r/rev.md",
        report: "Clean.",
      }),
      member({ id: "cod", role: "coder" }),
    ]);
    expect(text).toContain("No first-pass review is owed");
    expect(text).not.toContain("you are the first-pass reviewer");
  });

  it("buildStandaloneDigest: an unreviewed completion is marked ☑️ for the usual first look", () => {
    const text = buildStandaloneDigest([
      member({ id: "solo", role: "researcher", routes: [], fanInState: "none" }),
    ]);
    expect(text).toContain("☑️");
    expect(text).toContain("deserve the usual first look");
  });

  it("buildStandaloneDigest: an info-only digest (no terminal members) never claims anything completed", () => {
    // 2026-07-07 incident: a quiet-window flush carrying only a slow-tool extra
    // told the parent a still-executing coder "completed".
    const slowExtra: DigestExtra = {
      kind: "slow-tool",
      line: renderSlowToolDigestLine({
        id: "cod" as ThreadId,
        role: "coder",
        toolName: "pytest",
        inFlightMinutes: 22,
        quietMinutes: 20,
      }),
    };
    const text = buildStandaloneDigest([], [slowExtra]);
    expect(text).toContain("still executing");
    // Must not claim completion for an in-flight slow-tool line …
    expect(text).not.toContain("the following items completed");
    // … and must not carry the completion-framed "first look" closing.
    expect(text).not.toContain("deserve the usual first look");
    // Neutral info-only framing (true for both slow-tool and recovered).
    expect(text).toContain("status notices");
    expect(text).toContain("No first-pass review is owed");
  });

  it("buildDigestPiggyback: a recovered-only section never claims 'nothing completed' (a recovered item DID complete)", () => {
    const recExtra: DigestExtra = {
      kind: "recovered",
      line: renderRecoveredDigestLine({
        id: "c9" as ThreadId,
        role: "coder",
        reportPath: null,
        eventAt: "2026-07-07T14:35:00.000Z",
      }),
    };
    const text = buildDigestPiggyback([], [recExtra]);
    expect(text).toContain("Also, FYI since you last heard");
    expect(text).toContain("recovered");
    // The recovered item resolved to `done` — the copy must NOT assert nothing
    // completed / no plan lane changed (the contradiction this round fixes).
    expect(text).not.toContain("Nothing above completed");
    expect(text).not.toContain("no plan lane changed");
    expect(text).not.toContain("deserve the usual first look");
    expect(text).toContain("already resolved themselves");
  });
});

describe("digest builders + flush predicates (design §4.3/§5.3)", () => {
  const dm = (id: string): WakeMember => ({
    id: id as ThreadId,
    role: "researcher",
    planLane: "done" as ThreadPlanLane,
    attention: [],
    reportPath: `/r/${id}.md`,
    report: "done",
    fanInState: "none",
    lastOutcome: null,
    gateRounds: 0,
    routes: [],
    eventAt: "2026-07-07T14:35:00.000Z",
    releasedDependents: [],
  });

  it("buildDigestPiggyback leads with a separator + no-action header and the closing", () => {
    const text = buildDigestPiggyback([dm("a1b2")]);
    expect(text).toContain("---");
    expect(text).toContain("Also, FYI since you last heard");
    expect(text).toContain("No first-pass review is owed on gate-resolved items");
    expect(text).toContain("a1b2");
  });

  it("renderRecoveredDigestLine + renderSlowToolDigestLine are one-liners with no excerpt", () => {
    const rec = renderRecoveredDigestLine({
      id: "c1" as ThreadId,
      role: "coder",
      reportPath: "/r/c1.md",
      eventAt: "2026-07-07T14:35:00.000Z",
    });
    expect(rec).toContain("recovered");
    expect(rec).toContain("2026-07-07 14:35Z");
    expect(rec).toContain("/r/c1.md");
    const slow = renderSlowToolDigestLine({
      id: "c2" as ThreadId,
      role: "coder",
      toolName: "bash",
      inFlightMinutes: 7,
      quietMinutes: 6,
    });
    expect(slow).toContain("still executing");
    expect(slow).toContain("`bash`");
    expect(slow).toContain("7 min");
  });

  it("parentWorkstreamQuiet is false with a running/briefed-ready child, true otherwise", () => {
    const p = "p" as ThreadId;
    expect(
      parentWorkstreamQuiet(p, [{ parentThreadId: p, planLane: "in_progress" as ThreadPlanLane }]),
    ).toBe(false);
    // A briefed `ready` child is imminent work — not quiet.
    expect(
      parentWorkstreamQuiet(p, [
        { parentThreadId: p, planLane: "ready" as ThreadPlanLane, kickoffBriefPath: "/b.md" },
      ]),
    ).toBe(false);
    // A `ready` child with no brief cannot dispatch — quiet (orchestrator must
    // write its brief), plan §5.
    expect(
      parentWorkstreamQuiet(p, [
        { parentThreadId: p, planLane: "ready" as ThreadPlanLane, kickoffBriefPath: null },
      ]),
    ).toBe(true);
    // planned (held) / yielded / done do not count as running.
    expect(
      parentWorkstreamQuiet(p, [
        { parentThreadId: p, planLane: "planned" as ThreadPlanLane },
        { parentThreadId: p, planLane: "yielded" as ThreadPlanLane },
        { parentThreadId: p, planLane: "done" as ThreadPlanLane },
      ]),
    ).toBe(true);
  });

  it("digestShouldFlush: quiet flushes now; age flushes past the window; else withholds", () => {
    expect(
      digestShouldFlush({
        oldestEventAtMs: null,
        now: 0,
        quiet: true,
        flushMs: FYI_DIGEST_FLUSH_MS,
      }),
    ).toBe(true);
    expect(
      digestShouldFlush({
        oldestEventAtMs: 0,
        now: FYI_DIGEST_FLUSH_MS,
        quiet: false,
        flushMs: FYI_DIGEST_FLUSH_MS,
      }),
    ).toBe(true);
    expect(
      digestShouldFlush({
        oldestEventAtMs: 0,
        now: FYI_DIGEST_FLUSH_MS - 1,
        quiet: false,
        flushMs: FYI_DIGEST_FLUSH_MS,
      }),
    ).toBe(false);
  });
});

describe("formatWakeTimestamp", () => {
  it("formats a UTC event time and drops null/unparseable", () => {
    expect(formatWakeTimestamp("2026-07-07T14:32:09.000Z")).toBe("2026-07-07 14:32Z");
    expect(formatWakeTimestamp(null)).toBe("");
    expect(formatWakeTimestamp("not-a-date")).toBe("");
  });
});

describe("terminalEpisodeKey (delta reported-marker episode)", () => {
  it("keys on the latest outcome event id when present", () => {
    expect(
      terminalEpisodeKey({
        lastOutcome: { recordedByEventId: EventId.make("evt-outcome-1") },
        spawnGeneration: "gen-1",
      }),
    ).toBe("evt-outcome-1");
  });

  it("falls back to the spawn generation (re-stamped on reopen) when there is no outcome", () => {
    expect(terminalEpisodeKey({ lastOutcome: null, spawnGeneration: "gen-7" })).toBe("gen-7");
  });

  it("falls back to a constant only when neither is present", () => {
    expect(terminalEpisodeKey({ lastOutcome: null, spawnGeneration: null })).toBe("terminal");
  });
});

describe("startup stale session reconciliation", () => {
  const PARENT_ID = "parent-startup-reconcile" as ThreadId;
  const CHILD_ID = "child-startup-reconcile" as ThreadId;
  const defaultThreads = (): ReadonlyArray<OrchestrationThreadShell> => [
    shell({
      id: PARENT_ID,
      parentThreadId: null,
      session: runningSession({
        threadId: PARENT_ID,
        status: "running",
        activeTurnId: "turn-lost-completion" as TurnId,
      }),
    }),
    shell({
      id: CHILD_ID,
      parentThreadId: PARENT_ID,
      spawnGeneration: "gen-startup",
      planLane: "done",
      latestUserMessageAt: now,
      reportPath: "child-startup-reconcile.md",
      session: runningSession({ threadId: CHILD_ID, status: "ready", activeTurnId: null }),
    }),
  ];
  const buildLayer = (
    dispatched: Array<OrchestrationCommand>,
    providerSessions: ReadonlyArray<ProviderSession> = [],
    threadsSeed: ReadonlyArray<OrchestrationThreadShell> = defaultThreads(),
    failTurnStart = false,
  ) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        const pendingTurnStarts = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());
        const threads = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>(threadsSeed);
        const shellSnapshot = Effect.map(Ref.get(threads), (current) => ({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads: current,
          updatedAt: now,
        }));
        const engine = {
          readEvents: () => Stream.empty,
          dispatch: (command: OrchestrationCommand) =>
            Effect.gen(function* () {
              // Per-thread isolation probe: simulate a failed/deferred resume
              // dispatch so tests can prove the sweep swallows it and carries on.
              if (failTurnStart && command.type === "thread.turn.start") {
                return yield* Effect.die(new Error("simulated turn-start dispatch failure"));
              }
              if (command.type === "thread.session.set") {
                yield* Ref.update(threads, (current) =>
                  current.map((thread) =>
                    thread.id === command.threadId
                      ? { ...thread, session: command.session }
                      : thread,
                  ),
                );
              }
              if (command.type === "thread.turn-start.fail") {
                yield* Ref.update(
                  pendingTurnStarts,
                  (ids) => new Set([...ids].filter((id) => id !== command.threadId)),
                );
              }
              dispatched.push(command);
              if (command.type === "thread.session.set") {
                yield* PubSub.publish(events, { type: "thread.session-set" } as OrchestrationEvent);
              }
              return { sequence: dispatched.length };
            }),
          streamDomainEvents: Stream.fromPubSub(events),
          subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
        } satisfies OrchestrationEngineShape;
        const snapshotQuery = {
          getCommandReadModel: () =>
            Effect.map(
              shellSnapshot,
              (snapshot) =>
                ({
                  ...snapshot,
                  threads: snapshot.threads as never,
                }) satisfies OrchestrationReadModel,
            ),
          getShellSnapshot: () => shellSnapshot,
          getPendingTurnStartThreadIds: () => Ref.get(pendingTurnStarts),
          getActivityFreshnessByThreadId: () =>
            Effect.succeed({ maxCreatedAt: null, heartbeatAt: null }),
        } as unknown as ProjectionSnapshotQueryShape;
        const providerService = {
          listSessions: () => Effect.succeed(providerSessions),
        } as unknown as ProviderService["Service"];
        const receipts = {
          upsert: () => Effect.void,
          getByCommandId: () => Effect.succeed(Option.none()),
        };

        const deps = Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3-workstream-startup-reconcile-",
          }),
        ).pipe(Layer.provideMerge(NodeServices.layer));
        return Layer.mergeAll(
          WorkstreamDispatcherLive.pipe(Layer.provide(deps)),
          Layer.succeed(ProviderService, providerService),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationEngineService, engine),
          // Surface Crypto (via NodeServices) to `reconcileStartupStaleSessionState`,
          // which needs it for the restart-continuation message/boot ids.
          NodeServices.layer,
        );
      }),
    );

  effectIt.effect(
    "resets a stale running parent after restart and releases the deferred generation wake",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            expect(dispatched).toEqual([]);

            yield* reconcileStartupStaleSessionState;
            yield* dispatcher.drain;

            const reconcile = dispatched[0];
            if (reconcile?.type !== "thread.session.set") {
              throw new Error(`expected startup reconcile session-set, got ${reconcile?.type}`);
            }
            expect(reconcile.commandId.startsWith("server:startup-session-reconcile:")).toBe(true);
            expect(reconcile.threadId).toBe(PARENT_ID);
            expect(reconcile.session.status).toBe("ready");
            expect(reconcile.session.activeTurnId).toBeNull();

            // Assert the DISPATCHER's generation wake specifically — exclude the
            // reconcile's own restart-continuation turn-start (which also targets
            // this interrupted parent) so this test cannot false-green on it.
            const wake = dispatched.find(
              (command) =>
                command.type === "thread.turn.start" &&
                command.threadId === PARENT_ID &&
                !command.commandId.startsWith("server:startup-turn-continue:"),
            );
            expect(wake).toBeDefined();
            expect(wake?.type === "thread.turn.start" ? wake.requireIdle : false).toBe(true);
          }).pipe(Effect.provide(buildLayer(dispatched)));
        }),
      ),
  );

  effectIt.effect("does not reset a thread that still has an active provider turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        yield* reconcileStartupStaleSessionState.pipe(
          Effect.provide(
            buildLayer(dispatched, [
              {
                threadId: PARENT_ID,
                activeTurnId: "turn-live" as TurnId,
              } as ProviderSession,
            ]),
          ),
        );
        expect(dispatched).toEqual([]);
      }),
    ),
  );

  // ─── Restart turn-continuation (Option 1) ──────────────────────────────────
  const WORKER_ID = "worker-startup-reconcile" as ThreadId;
  const turnStartsFor = (dispatched: ReadonlyArray<OrchestrationCommand>, id: ThreadId) =>
    dispatched.filter((c) => c.type === "thread.turn.start" && c.threadId === id);

  effectIt.effect("resumes an interrupted leaf sub-thread (no children) after restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        yield* reconcileStartupStaleSessionState.pipe(
          Effect.provide(
            buildLayer(
              dispatched,
              [],
              [
                shell({
                  id: WORKER_ID,
                  parentThreadId: "some-parent" as ThreadId,
                  planLane: "in_progress" as ThreadPlanLane,
                  session: runningSession({
                    threadId: WORKER_ID,
                    status: "running",
                    activeTurnId: "turn-interrupted" as TurnId,
                  }),
                }),
              ],
            ),
          ),
        );
        // Reset first, then a resume turn-start.
        expect(dispatched.some((c) => c.type === "thread.session.set")).toBe(true);
        const resumes = turnStartsFor(dispatched, WORKER_ID);
        expect(resumes).toHaveLength(1);
        const resume = resumes[0];
        if (resume?.type !== "thread.turn.start") throw new Error("expected turn-start");
        expect(resume.commandId.startsWith("server:startup-turn-continue:")).toBe(true);
        expect(resume.requireIdle).toBe(true);
        expect(resume.setInProgress).toBeUndefined();
        expect(resume.reopen).toBeUndefined();
        expect(resume.message.origin).toBe("control_notice");
      }),
    ),
  );

  effectIt.effect("resets but does NOT resume a stuck-running session with no active turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        yield* reconcileStartupStaleSessionState.pipe(
          Effect.provide(
            buildLayer(
              dispatched,
              [],
              [
                shell({
                  id: WORKER_ID,
                  parentThreadId: "some-parent" as ThreadId,
                  session: runningSession({
                    threadId: WORKER_ID,
                    status: "running",
                    activeTurnId: null,
                  }),
                }),
              ],
            ),
          ),
        );
        expect(dispatched.some((c) => c.type === "thread.session.set")).toBe(true);
        expect(turnStartsFor(dispatched, WORKER_ID)).toHaveLength(0);
      }),
    ),
  );

  effectIt.effect(
    "does NOT resume an interrupted thread parked on a human (pending approval)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* reconcileStartupStaleSessionState.pipe(
            Effect.provide(
              buildLayer(
                dispatched,
                [],
                [
                  shell({
                    id: WORKER_ID,
                    parentThreadId: "some-parent" as ThreadId,
                    hasPendingApprovals: true,
                    session: runningSession({
                      threadId: WORKER_ID,
                      status: "running",
                      activeTurnId: "turn-interrupted" as TurnId,
                    }),
                  }),
                ],
              ),
            ),
          );
          expect(dispatched.some((c) => c.type === "thread.session.set")).toBe(true);
          expect(turnStartsFor(dispatched, WORKER_ID)).toHaveLength(0);
        }),
      ),
  );

  effectIt.effect("does NOT resume an interrupted thread already flagged for attention", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        yield* reconcileStartupStaleSessionState.pipe(
          Effect.provide(
            buildLayer(
              dispatched,
              [],
              [
                shell({
                  id: WORKER_ID,
                  parentThreadId: "some-parent" as ThreadId,
                  attention: ["needs_guidance"],
                  session: runningSession({
                    threadId: WORKER_ID,
                    status: "running",
                    activeTurnId: "turn-interrupted" as TurnId,
                  }),
                }),
              ],
            ),
          ),
        );
        expect(dispatched.some((c) => c.type === "thread.session.set")).toBe(true);
        expect(turnStartsFor(dispatched, WORKER_ID)).toHaveLength(0);
      }),
    ),
  );

  // Inactive/abandoned threads: reset only, never resumed (reviving hidden or
  // explicitly abandoned work is wrong). `done` remains resumable (covered by
  // the leaf-worker/parent cases above via a non-terminal lane).
  const interruptedShellWith = (
    overrides: Omit<Partial<OrchestrationThreadShell>, "id">,
  ): OrchestrationThreadShell =>
    shell({
      id: WORKER_ID,
      parentThreadId: "some-parent" as ThreadId,
      session: runningSession({
        threadId: WORKER_ID,
        status: "running",
        activeTurnId: "turn-interrupted" as TurnId,
      }),
      ...overrides,
    });

  // `deletedAt` lives on the command read-model thread, not the shell type, so
  // it is attached via a cast; `archivedAt`/`planLane` are shell fields.
  for (const [label, thread] of [
    ["archived", interruptedShellWith({ archivedAt: now })],
    ["cancelled", interruptedShellWith({ planLane: "cancelled" as ThreadPlanLane })],
    [
      "soft-deleted",
      { ...interruptedShellWith({}), deletedAt: now } as unknown as OrchestrationThreadShell,
    ],
  ] as const) {
    effectIt.effect(`resets but does NOT resume an interrupted ${label} thread`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* reconcileStartupStaleSessionState.pipe(
            Effect.provide(buildLayer(dispatched, [], [thread])),
          );
          expect(dispatched.some((c) => c.type === "thread.session.set")).toBe(true);
          expect(turnStartsFor(dispatched, WORKER_ID)).toHaveLength(0);
        }),
      ),
    );
  }

  effectIt.effect(
    "isolates a failed resume dispatch per-thread: the sweep still reconciles others",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const OTHER_ID = "worker-startup-reconcile-2" as ThreadId;
          const dispatched: Array<OrchestrationCommand> = [];
          // Both threads are interrupted; every resume turn-start is made to fail.
          // The sweep must swallow each failure and still reset BOTH sessions.
          yield* reconcileStartupStaleSessionState.pipe(
            Effect.provide(
              buildLayer(
                dispatched,
                [],
                [
                  interruptedShellWith({}),
                  shell({
                    id: OTHER_ID,
                    parentThreadId: "some-parent" as ThreadId,
                    session: runningSession({
                      threadId: OTHER_ID,
                      status: "running",
                      activeTurnId: "turn-interrupted-2" as TurnId,
                    }),
                  }),
                ],
                true,
              ),
            ),
          );
          // Reset happened for both despite the resume failures (no thread stranded).
          const resetIds = dispatched
            .filter((c) => c.type === "thread.session.set")
            .map((c) => c.threadId);
          expect(resetIds).toContain(WORKER_ID);
          expect(resetIds).toContain(OTHER_ID);
        }),
      ),
  );
});

describe("kick-off prompt brief/purpose resolution", () => {
  // The dispatcher's promoteThread feeds `brief ?? purpose` into
  // workstreamChildPrompt, so the full brief drives the child's first turn when
  // present and the short purpose is the fallback when it is absent.
  const resolve = (purpose: string, brief: string | null) =>
    workstreamChildPrompt({ role: "coder", brief: brief ?? purpose });

  it("uses the brief as the prompt body when a brief is present", () => {
    const prompt = resolve("short summary", "the full self-contained kickoff brief");
    expect(prompt).toContain("the full self-contained kickoff brief");
    expect(prompt).not.toContain("short summary");
  });

  it("falls back to the purpose when the brief is absent", () => {
    const prompt = resolve("short summary", null);
    expect(prompt).toContain("short summary");
  });
});

describe("buildChildWakeMessage (recovered re-notifies the parent of an error→done flip)", () => {
  it("tells the parent the prior error verdict is superseded and dependents are released", () => {
    const text = buildChildWakeMessage(
      {
        id: "child-1" as ThreadId,
        role: "reviewer",
        planLane: "done",
        attention: [],
        reportPath: "child-1.md",
      },
      "recovered",
      "# Findings\nAll good.",
    );
    expect(text).toContain("recovered");
    expect(text).toContain("superseded");
    expect(text).toContain("child-1.md");
    expect(text).toContain("All good.");
    // Recovery tail differs from the error/idle tail: deps already released, no
    // manual resolution to do.
    expect(text).toContain("already been released");
    expect(text).not.toContain("stay gated");
  });
});

describe("buildChildWakeMessage (Issue 7: idle backstop distinguishes a routed-but-unlanded submit)", () => {
  const idleChildBase = {
    id: "child-1" as ThreadId,
    role: "coder" as string | null,
    planLane: "in_progress" as ThreadPlanLane,
    attention: [],
    reportPath: "child-1.md",
  };

  it("a never-submitted idle child gets the plain forgot-to-finish copy", () => {
    const text = buildChildWakeMessage({ ...idleChildBase, lastOutcome: null }, "idle", null);
    expect(text).toContain("went quiet without reporting");
    expect(text).toContain("never submitted");
    expect(text).not.toContain("routing never landed");
  });

  it("a child whose submit routed (loop) but never landed gets the wedged-gate copy pointing at the counterpart", () => {
    const text = buildChildWakeMessage(
      {
        ...idleChildBase,
        lastOutcome: { outcome: "fixed", decision: "loop" },
      },
      "idle",
      null,
    );
    expect(text).toContain("submitted but its routing never landed");
    expect(text).toContain("fixed");
    expect(text).toContain("gate counterpart");
    expect(text).not.toContain("went quiet without reporting");
  });
});

describe("buildChildWakeMessage (attention pause notice)", () => {
  it("names the flags + lane and never claims the child finished", () => {
    const text = buildChildWakeMessage(
      {
        id: "child-1" as ThreadId,
        role: "coder",
        planLane: "in_progress",
        attention: ["needs_guidance"],
        reportPath: "child-1.md",
      },
      "attention",
      null,
    );
    expect(text).toContain("paused");
    expect(text).toContain("needs_guidance");
    expect(text).toContain("in_progress");
    expect(text).toContain("NOT finished");
    expect(text).toContain("child-1.md");
    expect(text).toContain("stay gated");
  });
});

describe("buildChildWakeMessage (provisioning-failure park notice)", () => {
  it("says provisioning failed before the child started and points at re-prompting to retry", () => {
    const text = buildChildWakeMessage(
      {
        id: "child-1" as ThreadId,
        role: "coder",
        planLane: "ready",
        attention: ["needs_guidance"],
        reportPath: null,
      },
      "attention",
      null,
      { quietMs: 0, provisionFailed: true },
    );
    expect(text).toContain("never started");
    expect(text).toContain("environment/git error");
    expect(text).toContain("NOT an agent stall");
    expect(text).toContain("workstream_prompt");
    expect(text).toContain("retry provisioning");
    expect(text).toContain("stay gated");
    // Must NOT mislead the parent into treating this as a normal agent pause.
    expect(text).not.toContain("is paused and needs attention");
  });
});

describe("buildChildWakeMessage (frozen attention notice — stall escalation mid-turn)", () => {
  it("names the flags, the frozen turn, and the stop-then-prompt recovery options", () => {
    const text = buildChildWakeMessage(
      {
        id: "child-1" as ThreadId,
        role: "coder",
        planLane: "in_progress",
        attention: ["needs_guidance"],
        reportPath: null,
      },
      "attention",
      null,
      { quietMs: 12 * 60_000, frozen: true },
    );
    expect(text).toContain("frozen");
    expect(text).toContain("needs_guidance");
    expect(text).toContain("~12 min");
    expect(text).toContain("NOT finished");
    expect(text).toContain("workstream_stop");
    expect(text).toContain("workstream_prompt");
    expect(text).toContain("stay gated");
  });
});

describe("buildChildWakeMessage (slow-tool informational notice)", () => {
  it("names the tool + durations, raises no alarm, and lists the parent's options", () => {
    const text = buildChildWakeMessage(
      {
        id: "child-1" as ThreadId,
        role: "coder",
        planLane: "in_progress",
        attention: [],
        reportPath: null,
      },
      "slow-tool",
      null,
      { quietMs: 6 * 60_000, toolName: "bash", inFlightMs: 7 * 60_000 },
    );
    expect(text).toContain("Informational notice");
    expect(text).toContain("`bash`");
    expect(text).toContain("~7 min");
    expect(text).toContain("~6 min");
    expect(text).toContain("will not interrupt");
    expect(text).toContain("workstream_prompt");
    expect(text).toContain("workstream_stop");
    // Reads as informational, not a hang verdict: a busy child IS runtime
    // activity; the notice must say output is not agent-visible, not that
    // nothing is happening.
    expect(text).toContain("long-running tool call");
    expect(text).toContain("no agent-visible output");
    expect(text).toContain("NOT a hang verdict");
    expect(text).not.toContain("no runtime activity");
    // Nothing failed: no fault language, no report boilerplate.
    expect(text).not.toContain("error");
    expect(text).not.toContain("No report was filed");
    // No process-health evidence supplied → no evidence line (clean degrade).
    expect(text).not.toContain("Process health:");
  });

  it("appends the process-health evidence line when supplied", () => {
    const text = buildChildWakeMessage(
      {
        id: "child-1" as ThreadId,
        role: "coder",
        planLane: "in_progress",
        attention: [],
        reportPath: null,
      },
      "slow-tool",
      null,
      {
        quietMs: 6 * 60_000,
        toolName: "bash",
        inFlightMs: 7 * 60_000,
        processHealth:
          "Process health: its tool process tree shows 87% peak CPU over the last 30s across 3 processes — it is actively working, not hung.",
      },
    );
    expect(text).toContain("Process health:");
    expect(text).toContain("87% peak CPU");
    expect(text).toContain("actively working");
  });
});

describe("formatProcessHealthLine (slow-tool process-health evidence)", () => {
  it("states a working subtree plainly with peak CPU and process count", () => {
    const line = formatProcessHealthLine({
      peakCpuPercent: 87.4,
      processCount: 3,
      windowMs: 30_000,
      active: true,
    });
    expect(line).toContain("87% peak CPU over the last 30s");
    expect(line).toContain("across 3 processes");
    expect(line).toContain("actively working, not hung");
  });

  it("hedges an idle subtree as maybe-stuck-or-blocked and omits the count for one process", () => {
    const line = formatProcessHealthLine({
      peakCpuPercent: 0,
      processCount: 1,
      windowMs: 30_000,
      active: false,
    });
    expect(line).toContain("0% peak CPU");
    expect(line).not.toContain("across");
    expect(line).toContain("may be genuinely stuck");
    expect(line).toContain("I/O or network");
  });

  it("returns undefined when no local health is observable (clean degrade)", () => {
    expect(formatProcessHealthLine(null)).toBeUndefined();
  });
});

describe("slowToolNoticeIndex (escalating notice schedule)", () => {
  const m = (mins: number) => mins * 60_000;
  it("is -1 below the first step (no notice due)", () => {
    expect(slowToolNoticeIndex(0)).toBe(-1);
    expect(slowToolNoticeIndex(m(5) - 1)).toBe(-1);
  });
  it("steps 0/1/2 at 5/15/30 minutes of quiet", () => {
    expect(slowToolNoticeIndex(m(5))).toBe(0);
    expect(slowToolNoticeIndex(m(14))).toBe(0);
    expect(slowToolNoticeIndex(m(15))).toBe(1);
    expect(slowToolNoticeIndex(m(29))).toBe(1);
    expect(slowToolNoticeIndex(m(30))).toBe(2);
  });
  it("repeats every 30 minutes past the last step", () => {
    expect(slowToolNoticeIndex(m(59))).toBe(2);
    expect(slowToolNoticeIndex(m(60))).toBe(3);
    expect(slowToolNoticeIndex(m(90))).toBe(4);
  });
});

describe("classifyChildWake (per-child wake rail, §1e)", () => {
  it("classifies an `error`-flagged child as an error wake", () => {
    const child = shell({ id: "child-1", attention: ["error"], session: null });
    expect(classifyChildWake(child, new Set())).toBe("error");
  });

  it("classifies a ran-then-idle non-terminal child as a forgot-to-finish idle wake", () => {
    const child = shell({
      id: "child-1",
      planLane: "in_progress",
      session: runningSession({ status: "ready", activeTurnId: null }),
    });
    expect(classifyChildWake(child, new Set())).toBe("idle");
  });

  it("does NOT wake a never-started held child (no session → waiting on release/deps)", () => {
    const child = shell({ id: "child-1", planLane: "planned", session: null });
    expect(classifyChildWake(child, new Set())).toBeNull();
  });

  it("does NOT wake a child still mid-turn", () => {
    const child = shell({
      id: "child-1",
      planLane: "in_progress",
      session: runningSession({ status: "running", activeTurnId: "turn-1" as TurnId }),
    });
    expect(classifyChildWake(child, new Set())).toBeNull();
  });

  it("does NOT wake a child whose turn-start is still pending (kickoff race)", () => {
    const child = shell({
      id: "child-1",
      planLane: "in_progress",
      session: runningSession({ status: "ready", activeTurnId: null }),
    });
    expect(classifyChildWake(child, new Set(["child-1" as ThreadId]))).toBeNull();
  });

  it("does NOT wake plan-terminal done/cancelled children", () => {
    for (const planLane of ["done", "cancelled"] as const) {
      const child = shell({
        id: "child-1",
        planLane,
        session: runningSession({ status: "ready", activeTurnId: null }),
      });
      expect(classifyChildWake(child, new Set())).toBeNull();
    }
  });

  it("classifies a flagged, non-executing, non-terminal child as a paused `attention` wake", () => {
    for (const attention of [["needs_guidance"], ["awaiting_acceptance"]] as const) {
      const child = shell({
        id: "child-1",
        planLane: "in_progress",
        attention: [...attention],
        session: runningSession({ status: "ready", activeTurnId: null }),
      });
      expect(classifyChildWake(child, new Set())).toBe("attention");
    }
  });

  it("does NOT attention-wake a flagged child that is still executing", () => {
    const child = shell({
      id: "child-1",
      planLane: "in_progress",
      attention: ["needs_guidance"],
      session: runningSession(),
    });
    expect(classifyChildWake(child, new Set())).toBeNull();
  });

  it("does NOT attention-wake a flagged child whose resume turn-start is pending", () => {
    const child = shell({
      id: "child-1",
      planLane: "in_progress",
      attention: ["needs_guidance"],
      session: runningSession({ status: "ready", activeTurnId: null }),
    });
    expect(classifyChildWake(child, new Set(["child-1" as ThreadId]))).toBeNull();
  });

  it("does NOT wake a top-level thread (no agent parent)", () => {
    const child = shell({
      id: "root-1",
      parentThreadId: null,
      attention: ["error"],
      session: null,
    });
    expect(classifyChildWake(child, new Set())).toBeNull();
  });

  it("keys idle episodes on the activity sequence so a quiet child is not re-nagged but re-arms on new work", () => {
    const a = childWakeCommandId("child-1" as ThreadId, "idle:7");
    const b = childWakeCommandId("child-1" as ThreadId, "idle:7");
    const c = childWakeCommandId("child-1" as ThreadId, "idle:12");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("server:")).toBe(true);
  });
});

const latestTurn = (overrides: Partial<OrchestrationLatestTurn> = {}): OrchestrationLatestTurn => ({
  turnId: "turn-1" as TurnId,
  state: "completed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  assistantMessageId: null,
  ...overrides,
});

// `now` (2026-06-24T00:00:00.000Z) is the reference instant; `earlier` is 60s
// before it. ISO literals + Date.parse are used (the `new Date()` constructor is
// banned by an effect lint rule, and the production code parses with Date.parse).
const earlier = "2026-06-23T23:59:00.000Z";
const t0 = Date.parse(now);

describe("idleLastProgressMs", () => {
  it("prefers the newest activity timestamp over the turn timing", () => {
    expect(idleLastProgressMs(now, latestTurn({ completedAt: earlier }))).toBe(t0);
  });

  it("falls back to the turn completion (idle onset) when there is no activity row", () => {
    expect(idleLastProgressMs(null, latestTurn({ completedAt: now }))).toBe(t0);
  });

  it("falls back to the turn start when there is no activity and no completion", () => {
    expect(idleLastProgressMs(null, latestTurn({ startedAt: now, completedAt: null }))).toBe(t0);
  });

  it("is null when nothing is known (session-bearing child with no activity and no turn)", () => {
    expect(idleLastProgressMs(null, null)).toBeNull();
  });
});

// The decisive regression coverage for the false-positive fix: a ran-then-idle
// child must NOT be woken "forgot to finish" the instant its turn completes (the
// between-turns window of a multi-turn child); it is woken only after a full
// grace window of no activity, and that re-evaluation happens via the scheduled
// re-pass even when no further domain event arrives.
describe("idle-wake activity-freshness grace", () => {
  const graceMs = DEFAULT_IDLE_WAKE_GRACE_MS;

  const idleChild = shell({
    id: "child-1",
    planLane: "in_progress",
    session: runningSession({ status: "ready", activeTurnId: null }),
    latestTurn: latestTurn({ completedAt: now }),
  });
  const lastProgress = idleLastProgressMs(now, idleChild.latestTurn);

  it("still classifies the ran-then-idle child as an idle wake (kind unchanged)", () => {
    expect(classifyChildWake(idleChild, new Set())).toBe("idle");
  });

  it("WITHHOLDS the idle wake while activity is fresher than the grace window", () => {
    // 5s after the turn completed — deep inside the 10m grace (between-turns).
    expect(idleWakeWithinGrace(lastProgress, t0 + 5_000, graceMs)).toBe(true);
  });

  it("FIRES the idle wake once activity has been quiet longer than the grace window", () => {
    expect(idleWakeWithinGrace(lastProgress, t0 + graceMs + 1, graceMs)).toBe(false);
  });

  it("re-pass semantics: the SAME suppressed child becomes eligible once the window elapses, with no new event", () => {
    // First (event-driven) pass right after turn completion: suppressed.
    expect(idleWakeWithinGrace(lastProgress, t0 + 5_000, graceMs)).toBe(true);
    // The scheduled re-pass interval is bounded by the grace, so a later tick
    // re-evaluates the child and it then fires exactly once.
    expect(IDLE_WAKE_REPASS_INTERVAL_MS).toBeLessThanOrEqual(graceMs);
    expect(
      idleWakeWithinGrace(lastProgress, t0 + graceMs + IDLE_WAKE_REPASS_INTERVAL_MS, graceMs),
    ).toBe(false);
  });

  it("withholds rather than firing eagerly when last-progress is unknown", () => {
    expect(idleWakeWithinGrace(null, t0 + graceMs * 10, graceMs)).toBe(true);
  });
});

// The two-phase full wake classifier (§A.5): phase 1 (`childWakeEvidenceNeeds`)
// names exactly the async evidence the loop must fetch for a child's shape;
// phase 2 (`classifyChildWakeFull`) turns that evidence into either a wake
// (kind + episode key + measured context) or an assertable skip reason. These
// make the previously comment-only suppressions directly testable; the assembled
// layer harness elsewhere in this file remains the behaviour pin.
const wakeEvidence = (overrides: Partial<ChildWakeEvidence> = {}): ChildWakeEvidence => ({
  provisionFailurePending: false,
  waitingInGate: false,
  ...overrides,
});
const idleShell = (overrides: Partial<Parameters<typeof shell>[0]> = {}) =>
  shell({
    id: "child-1",
    planLane: "in_progress",
    session: runningSession({ status: "ready", activeTurnId: null }),
    ...overrides,
  });
const executingShell = (overrides: Partial<Parameters<typeof shell>[0]> = {}) =>
  shell({
    id: "child-1",
    planLane: "in_progress",
    session: runningSession({ activeTurnId: "turn-1" as TurnId }),
    latestTurn: latestTurn({ turnId: "turn-9" as TurnId }),
    ...overrides,
  });
const fresh = (heartbeatAt: string | null) => ({
  maxCreatedAt: heartbeatAt,
  heartbeatAt,
});

describe("childWakeEvidenceNeeds (phase 1 — lazy evidence planning)", () => {
  const has = (set: ReadonlySet<string>) => [...set].sort();

  it("fetches nothing for an error child", () => {
    const child = shell({ id: "child-1", attention: ["error"], session: null });
    expect(has(childWakeEvidenceNeeds(child, new Set(), false))).toEqual([]);
  });

  it("fetches freshness for an idle child, but NOTHING for a parked gate party", () => {
    expect(has(childWakeEvidenceNeeds(idleShell(), new Set(), false))).toEqual(["freshness"]);
    expect(has(childWakeEvidenceNeeds(idleShell(), new Set(), true))).toEqual([]);
  });

  it("fetches freshness + the idle-wake delivery lookup for an attention child", () => {
    const child = idleShell({ attention: ["needs_guidance"] });
    expect(has(childWakeEvidenceNeeds(child, new Set(), false))).toEqual([
      "freshness",
      "idleWakeDelivered",
    ]);
  });

  it("fetches the error-wake delivery lookup for a done child", () => {
    const child = idleShell({ planLane: "done" });
    expect(has(childWakeEvidenceNeeds(child, new Set(), false))).toEqual(["errorWakeDelivered"]);
  });

  it("fetches freshness (+ in-flight tool only when unflagged) for an executing child", () => {
    expect(has(childWakeEvidenceNeeds(executingShell(), new Set(), false))).toEqual([
      "freshness",
      "inFlightTool",
    ]);
    const flagged = executingShell({ attention: ["needs_guidance"] });
    expect(has(childWakeEvidenceNeeds(flagged, new Set(), false))).toEqual(["freshness"]);
  });

  it("fetches nothing for a healthy / never-started child", () => {
    const child = shell({ id: "child-1", planLane: "planned", session: null });
    expect(has(childWakeEvidenceNeeds(child, new Set(), false))).toEqual([]);
  });
});

describe("classifyChildWakeFull (phase 2 — episode keys + skip reasons)", () => {
  it("error → an `error` wake keyed on nothing but the child", () => {
    const child = shell({ id: "child-1", attention: ["error"], session: null });
    expect(classifyChildWakeFull(child, wakeEvidence(), t0, new Set())).toEqual({
      kind: "error",
      episode: "error",
    });
  });

  it("idle + gate-waiting → skip `gate-waiting` (no fetch, no suppression)", () => {
    expect(
      classifyChildWakeFull(idleShell(), wakeEvidence({ waitingInGate: true }), t0, new Set()),
    ).toEqual({ skip: "gate-waiting" });
  });

  it("idle within grace → skip `within-grace`", () => {
    const evidence = wakeEvidence({ freshness: fresh(now) });
    expect(classifyChildWakeFull(idleShell(), evidence, t0 + 5_000, new Set())).toEqual({
      skip: "within-grace",
    });
  });

  it("idle past grace → an `idle` wake keyed on the newest activity timestamp", () => {
    const evidence = wakeEvidence({ freshness: fresh(now) });
    expect(
      classifyChildWakeFull(idleShell(), evidence, t0 + DEFAULT_IDLE_WAKE_GRACE_MS + 1, new Set()),
    ).toEqual({ kind: "idle", episode: `idle:${now}` });
  });

  it("attention → a paused wake keyed on the latest turn; provisioning park sets the copy", () => {
    const child = idleShell({
      attention: ["needs_guidance"],
      latestTurn: latestTurn({ turnId: "turn-3" as TurnId }),
    });
    expect(
      classifyChildWakeFull(child, wakeEvidence({ idleWakeDelivered: false }), t0, new Set()),
    ).toEqual({ kind: "attention", episode: "attention:turn-3" });
    expect(
      classifyChildWakeFull(
        child,
        wakeEvidence({ idleWakeDelivered: false, provisionFailurePending: true }),
        t0,
        new Set(),
      ),
    ).toEqual({
      kind: "attention",
      episode: "attention:turn-3",
      context: { quietMs: 0, provisionFailed: true },
    });
  });

  it("attention already surfaced by a delivered idle wake → skip `already-notified` + suppress", () => {
    const child = idleShell({
      attention: ["needs_guidance"],
      latestTurn: latestTurn({ turnId: "turn-3" as TurnId }),
    });
    expect(
      classifyChildWakeFull(child, wakeEvidence({ idleWakeDelivered: true }), t0, new Set()),
    ).toEqual({ skip: "already-notified", suppressEpisode: "attention:turn-3" });
  });

  it("done with no error-wake delivery → skip `never-errored` + suppress the recovery id", () => {
    const child = idleShell({ planLane: "done" });
    expect(
      classifyChildWakeFull(child, wakeEvidence({ errorWakeDelivered: false }), t0, new Set()),
    ).toEqual({ skip: "never-errored", suppressEpisode: "recovered" });
  });

  it("done that WAS durably told it errored → a `recovered` wake", () => {
    const child = idleShell({ planLane: "done" });
    expect(
      classifyChildWakeFull(child, wakeEvidence({ errorWakeDelivered: true }), t0, new Set()),
    ).toEqual({ kind: "recovered", episode: "recovered" });
  });

  it("executing with no activity baseline → skip `no-activity-baseline`", () => {
    const child = executingShell({ latestTurn: null });
    expect(
      classifyChildWakeFull(child, wakeEvidence({ freshness: fresh(null) }), t0, new Set()),
    ).toEqual({ skip: "no-activity-baseline" });
  });

  it("executing + flagged + frozen past grace → a frozen `attention` wake", () => {
    const child = executingShell({ attention: ["needs_guidance"] });
    const nowMs = t0 + DEFAULT_IDLE_WAKE_GRACE_MS + 1;
    expect(
      classifyChildWakeFull(child, wakeEvidence({ freshness: fresh(now) }), nowMs, new Set()),
    ).toEqual({
      kind: "attention",
      episode: "attention:turn-9",
      context: { quietMs: DEFAULT_IDLE_WAKE_GRACE_MS + 1, frozen: true },
    });
  });

  it("executing + flagged but still within grace → skip `frozen-within-grace`", () => {
    const child = executingShell({ attention: ["needs_guidance"] });
    expect(
      classifyChildWakeFull(child, wakeEvidence({ freshness: fresh(now) }), t0 + 60_000, new Set()),
    ).toEqual({ skip: "frozen-within-grace" });
  });

  it("executing + unflagged + not yet quiet enough → skip `no-notice-due`", () => {
    expect(
      classifyChildWakeFull(
        executingShell(),
        wakeEvidence({ freshness: fresh(now) }),
        t0 + 60_000,
        new Set(),
      ),
    ).toEqual({ skip: "no-notice-due" });
  });

  it("executing + unflagged + quiet but no tool in flight → skip `no-in-flight-tool`", () => {
    expect(
      classifyChildWakeFull(
        executingShell(),
        wakeEvidence({ freshness: fresh(now), inFlightTool: null }),
        t0 + 360_000,
        new Set(),
      ),
    ).toEqual({ skip: "no-in-flight-tool" });
  });

  it("executing + unflagged + a slow in-flight call → a `slow-tool` notice keyed on the row + step", () => {
    const decision = classifyChildWakeFull(
      executingShell(),
      wakeEvidence({
        freshness: fresh(now),
        inFlightTool: { toolName: "bash", startedAt: now, activityId: "act-1" },
      }),
      t0 + 360_000,
      new Set(),
    );
    expect(decision).toEqual({
      kind: "slow-tool",
      episode: "slow-tool:act-1:0",
      context: { quietMs: 360_000, toolName: "bash", inFlightMs: 360_000 },
    });
  });

  it("a healthy / never-started child → skip `healthy`", () => {
    const child = shell({ id: "child-1", planLane: "planned", session: null });
    expect(classifyChildWakeFull(child, wakeEvidence(), t0, new Set())).toEqual({
      skip: "healthy",
    });
  });
});

// The decisive end-to-end coverage for the scheduled re-pass machinery: not the
// pure grace helper (covered above) but the assembled dispatcher layer driving
// its forked `Schedule.spaced` fiber under a deterministic `TestClock`. This is
// the assertion the reviewer flagged as missing — it proves a genuinely-idle
// child is woken EXACTLY ONCE after the grace elapses with NO triggering domain
// event, and that further re-pass ticks are idempotent.
describe("idle-wake scheduled re-pass (TestClock, full dispatcher layer)", () => {
  const PARENT_ID = "parent-repass" as ThreadId;
  const CHILD_ID = "child-repass" as ThreadId;
  // TestClock starts at epoch (t=0); a last-progress at epoch is "fresh" at t=0
  // (now - lastProgress === 0 < grace) and goes stale only once the clock is
  // advanced past the grace window.
  const epochIso = "1970-01-01T00:00:00.000Z";

  // Root parent (no parentThreadId → never promoted, never itself a child wake)
  // that is idle (no session), so it is an eligible wake target.
  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  // Ran-then-idle sub-thread: latest turn completed, session ready, activeTurnId
  // null → classifyChildWake → "idle". Its freshness (below) is fresh at t=0.
  const child = shell({
    id: CHILD_ID as unknown as string,
    parentThreadId: PARENT_ID,
    planLane: "in_progress",
    session: runningSession({ threadId: CHILD_ID, status: "ready", activeTurnId: null }),
    latestTurn: latestTurn({ completedAt: epochIso }),
  });

  const buildLayer = (dispatched: Array<OrchestrationCommand>) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      // No domain events: the ONLY thing that can re-run a pass is the forked
      // schedule, so any wake delivered after t=0 is proof the re-pass fired.
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as unknown as OrchestrationEngineShape;

    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads: [parent, child],
          updatedAt: epochIso,
        } satisfies OrchestrationShellSnapshot),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: epochIso, heartbeatAt: null }),
    } as unknown as ProjectionSnapshotQueryShape;

    // Empty receipt store: cross-pass dedup must therefore be carried by the
    // in-memory `handledChildWakes` set (the real machinery under test), not by
    // a receipt short-circuit.
    const receipts = {
      upsert: () => Effect.void,
      getByCommandId: () => Effect.succeed(Option.none()),
    };

    return WorkstreamDispatcherLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-dispatcher-repass-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  effectIt.effect(
    "withholds the idle wake while fresh, then delivers exactly one after the grace via the re-pass, idempotent thereafter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();

            // (1) Initial pass(es) at t=0: activity is fresh (within grace) → no
            // idle wake delivered to the parent.
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(0);

            // (2) No domain event arrives; advance past the grace so the next
            // scheduled re-pass tick re-evaluates the now-stale child and wakes
            // the parent exactly once.
            yield* TestClock.adjust(
              Duration.millis(DEFAULT_IDLE_WAKE_GRACE_MS + IDLE_WAKE_REPASS_INTERVAL_MS),
            );
            yield* dispatcher.drain;
            // No-silent-halt backstop (§4.7): the idle child first gets a
            // `needs_guidance` flag raised on IT, then the parent wake — two
            // dispatches.
            expect(dispatched.length).toBe(2);
            const flag = dispatched[0]!;
            if (flag.type !== "thread.attention.raise") {
              throw new Error(`expected a thread.attention.raise, got ${flag.type}`);
            }
            expect(flag.threadId).toBe(CHILD_ID);
            expect(flag.reason).toBe("needs_guidance");
            const wake = dispatched[1]!;
            // The wake is the "forgot to finish" child wake delivered to the
            // parent as a fresh turn-start.
            if (wake.type !== "thread.turn.start") {
              throw new Error(`expected a thread.turn.start wake, got ${wake.type}`);
            }
            expect(wake.threadId).toBe(PARENT_ID);
            expect(wake.message.text).toContain("went quiet");

            // (3) Further re-pass ticks must NOT re-nag: the episode is deduped
            // by the `idle:${maxCreatedAt}` key + in-memory handled set.
            yield* TestClock.adjust(Duration.millis(IDLE_WAKE_REPASS_INTERVAL_MS * 5));
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(2);
          }).pipe(Effect.provide(buildLayer(dispatched)));
        }),
      ),
  );
});

// Bug 1 (primary): an `error → done` recovery must re-notify the parent, whose
// view is otherwise frozen on the stale error verdict. The recovery wake fires
// for a `done` child ONLY when the durable error-wake receipt exists (we
// actually told the parent it errored), exactly once, and never for a `done`
// child that never errored. Exercised through the assembled dispatcher layer.
describe("recovery wake (error→done re-notifies the parent), full dispatcher layer", () => {
  const PARENT_ID = "parent-rec" as ThreadId;
  const CHILD_ID = "child-rec" as ThreadId;
  // Root parent (no parentThreadId → never promoted / never itself a child wake)
  // that is idle (no session) → an eligible wake target.
  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  // Recovered sub-thread: now `done` with a (ready, no active turn) session, so
  // classifyChildWake returns null and the recovery branch owns it.
  const child = shell({
    id: CHILD_ID as unknown as string,
    parentThreadId: PARENT_ID,
    planLane: "done",
    session: runningSession({ threadId: CHILD_ID, status: "ready", activeTurnId: null }),
    reportPath: "child-rec.md",
  });

  const errorCmd = childWakeCommandId(CHILD_ID, "error");

  const buildLayer = (
    dispatched: Array<OrchestrationCommand>,
    opts: { readonly errorReceiptExists: boolean },
  ) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as unknown as OrchestrationEngineShape;

    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads: [parent, child],
          updatedAt: now,
        } satisfies OrchestrationShellSnapshot),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: now, heartbeatAt: null }),
    } as unknown as ProjectionSnapshotQueryShape;

    // Only the error-wake receipt is present (when opts say so); the recovery
    // receipt is absent, so cross-pass dedup is carried by the in-memory
    // handled set — the real machinery under test.
    const receipts = {
      upsert: () => Effect.void,
      getByCommandId: ({ commandId }: { readonly commandId: string }) =>
        Effect.succeed(
          opts.errorReceiptExists && commandId === errorCmd
            ? Option.some({} as never)
            : Option.none(),
        ),
    };

    return WorkstreamDispatcherLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-dispatcher-recovery-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  effectIt.effect(
    "delivers exactly one recovery notice (now via the FYI digest) when the prior error-wake receipt exists, idempotent thereafter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            // Recovered is now an FYI item: the child is done so the workstream
            // is quiet and the digest flushes immediately — one parent wake
            // (the standalone digest) plus its durable marker.
            const wakes = dispatched.filter(
              (c): c is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
                c.type === "thread.turn.start" && c.threadId === PARENT_ID,
            );
            expect(wakes).toHaveLength(1);
            expect(wakes[0]!.message.text).toContain("recovered");
            expect(wakes[0]!.message.text).toContain("FYI digest");
            // Further passes must not re-nag: recovery is one-shot per child.
            yield* dispatcher.drain;
            const wakesAfter = dispatched.filter(
              (c) => c.type === "thread.turn.start" && c.threadId === PARENT_ID,
            );
            expect(wakesAfter).toHaveLength(1);
          }).pipe(Effect.provide(buildLayer(dispatched, { errorReceiptExists: true })));
        }),
      ),
  );

  effectIt.effect(
    "the recovery rail stays silent for a child that reached `done` without ever erroring",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            // The plain completion is reported by the terminal-child delta rail
            // (covered elsewhere); the point here is that the RECOVERY rail does
            // not fire — no wake claims the child "recovered".
            const recoveredWakes = dispatched.filter(
              (c) => c.type === "thread.turn.start" && c.message.text.includes("recovered"),
            );
            expect(recoveredWakes).toHaveLength(0);
          }).pipe(Effect.provide(buildLayer(dispatched, { errorReceiptExists: false })));
        }),
      ),
  );
});

// Perf regression (§A.5 extraction must preserve the inline lazy `wasDelivered`
// pattern): a `done` child that never errored is `markSuppressed`'d once for its
// "recovered" episode, after which later passes must short-circuit on the
// in-memory suppressed set and NOT re-read the receipt store for the error-wake
// delivery. Regression for the two-phase extraction dropping that pre-check.
describe("recovery suppression avoids repeat receipt reads (TestClock, full dispatcher layer)", () => {
  const PARENT_ID = "parent-recperf" as ThreadId;
  const CHILD_ID = "child-recperf" as ThreadId;
  const errorCmd = childWakeCommandId(CHILD_ID, "error");
  const parent = shell({
    id: PARENT_ID as unknown as string,
    parentThreadId: null,
    session: null,
  });
  // Done child that never errored: classifyChildWake → null, planLane done → the
  // recovery/never-errored branch owns it.
  const child = shell({
    id: CHILD_ID as unknown as string,
    parentThreadId: PARENT_ID,
    planLane: "done",
    session: runningSession({ threadId: CHILD_ID, status: "ready", activeTurnId: null }),
    reportPath: "child-recperf.md",
  });

  effectIt.effect(
    "reads the error-wake receipt at most once across a re-pass for a never-errored done child",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          // Count only reads for the error-wake command id — the receipt-store
          // lookup the suppression must stop repeating.
          let errorReceiptReads = 0;
          const receipts = {
            upsert: () => Effect.void,
            getByCommandId: ({ commandId }: { readonly commandId: string }) =>
              Effect.sync(() => {
                if (commandId === errorCmd) errorReceiptReads += 1;
                return Option.none();
              }),
          };
          const engine = {
            readEvents: () => Stream.empty,
            dispatch: (command: OrchestrationCommand) =>
              Effect.sync(() => {
                dispatched.push(command);
                return { sequence: dispatched.length };
              }),
            streamDomainEvents: Stream.empty,
            subscribeDomainEvents: Effect.succeed(Stream.empty),
          } as unknown as OrchestrationEngineShape;
          const snapshotQuery = {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 1,
                goals: [],
                projects: [],
                threads: [parent, child],
                updatedAt: now,
              } satisfies OrchestrationShellSnapshot),
            getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
            getActivityFreshnessByThreadId: () =>
              Effect.succeed({ maxCreatedAt: now, heartbeatAt: null }),
          } as unknown as ProjectionSnapshotQueryShape;
          const layer = WorkstreamDispatcherLive.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(OrchestrationEngineService, engine),
                Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
                Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
                WorktreeProvisionerStub,
                ServerConfig.layerTest(process.cwd(), {
                  prefix: "t3-workstream-dispatcher-recperf-",
                }),
              ).pipe(Layer.provideMerge(NodeServices.layer)),
            ),
          );
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            // Pass 1: the per-child wake rail (recovered branch) and the delta
            // rail's prior-rail check each read the error receipt once, then the
            // per-child rail `markSuppressed`s "recovered" and the delta rail
            // records its terminal marker.
            yield* dispatcher.drain;
            const afterFirstPass = errorReceiptReads;
            expect(afterFirstPass).toBeGreaterThan(0);
            // Force a scheduled re-pass with no domain event. Cross-pass dedup is
            // now carried by the in-memory suppressed/delivered sets, so the
            // error receipt must NOT be read again — the pre-check this regression
            // guards. Without it, the per-child rail re-reads every pass.
            yield* TestClock.adjust(
              Duration.millis(DEFAULT_IDLE_WAKE_GRACE_MS + IDLE_WAKE_REPASS_INTERVAL_MS),
            );
            yield* dispatcher.drain;
            expect(errorReceiptReads).toBe(afterFirstPass);
            const recoveredWakes = dispatched.filter(
              (c) => c.type === "thread.turn.start" && c.message.text.includes("recovered"),
            );
            expect(recoveredWakes).toHaveLength(0);
          }).pipe(Effect.provide(layer));
        }),
      ),
  );
});

// Bug fix regression (human stop must never bubble a "finished" result): a
// single-child generation whose child is paused (attention-flagged, not
// executing, lane still `in_progress`) must NOT join — the parent instead gets
// exactly one honest per-child "paused" notice, and the one-shot generation
// wake stays armed for the child's real completion. Exercised through the
// assembled dispatcher layer.
describe("paused-child attention notice (full dispatcher layer)", () => {
  const PARENT_ID = "parent-pause" as ThreadId;
  const CHILD_ID = "child-pause" as ThreadId;
  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  // Human-stopped mid-turn: interrupt raised `needs_guidance`, pi aborted the
  // turn (session ready, no active turn, latest turn interrupted), lane still
  // `in_progress`, and it is the SOLE member of its spawn generation.
  const child = shell({
    id: CHILD_ID as unknown as string,
    parentThreadId: PARENT_ID,
    planLane: "in_progress",
    spawnGeneration: "gen-1",
    attention: ["needs_guidance"],
    session: runningSession({ threadId: CHILD_ID, status: "ready", activeTurnId: null }),
    latestTurn: latestTurn({ state: "interrupted", completedAt: null }),
  });

  const buildLayer = (
    dispatched: Array<OrchestrationCommand>,
    opts: { readonly idleWakeReceiptExists: boolean },
  ) => {
    const idleCmd = childWakeCommandId(CHILD_ID, `idle:${now}`);
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as unknown as OrchestrationEngineShape;

    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads: [parent, child],
          updatedAt: now,
        } satisfies OrchestrationShellSnapshot),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: now, heartbeatAt: null }),
    } as unknown as ProjectionSnapshotQueryShape;

    const receipts = {
      upsert: () => Effect.void,
      getByCommandId: ({ commandId }: { readonly commandId: string }) =>
        Effect.succeed(
          opts.idleWakeReceiptExists && commandId === idleCmd
            ? Option.some({} as never)
            : Option.none(),
        ),
    };

    return WorkstreamDispatcherLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-dispatcher-pause-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  effectIt.effect(
    "delivers exactly one honest pause notice — never a generation wake — and is idempotent",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(1);
            const wake = dispatched[0]!;
            if (wake.type !== "thread.turn.start") {
              throw new Error(`expected a thread.turn.start wake, got ${wake.type}`);
            }
            expect(wake.threadId).toBe(PARENT_ID);
            expect(wake.message.text).toContain("paused");
            expect(wake.message.text).toContain("needs_guidance");
            // The paused generation must NOT have joined: no "spawn generation
            // … terminal" wake, so its one-shot command id stays unconsumed for
            // the child's real completion.
            expect(wake.message.text).not.toContain("spawn generation");
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(1);
          }).pipe(Effect.provide(buildLayer(dispatched, { idleWakeReceiptExists: false })));
        }),
      ),
  );

  effectIt.effect(
    "does NOT re-notify when this quiet episode was already surfaced by the idle backstop",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(0);
          }).pipe(Effect.provide(buildLayer(dispatched, { idleWakeReceiptExists: true })));
        }),
      ),
  );
});

// Class-2 liveness (slow-but-alive tool call): an executing, unflagged child
// whose in-flight tool call has gone quiet gets the parent an INFORMATIONAL
// notice on the escalating schedule — no attention flag on the child, no
// interruption, one notice per schedule step. Exercised through the assembled
// dispatcher layer with the TestClock driving the scheduled re-pass.
describe("slow-tool informational notice (TestClock, full dispatcher layer)", () => {
  const PARENT_ID = "parent-slow" as ThreadId;
  const CHILD_ID = "child-slow" as ThreadId;
  const epochIso = "1970-01-01T00:00:00.000Z";

  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  // Executing sub-thread: open turn started at epoch, session running. Its
  // freshness (below) is fresh at t=0 and goes quiet as the clock advances.
  const child = shell({
    id: CHILD_ID as unknown as string,
    parentThreadId: PARENT_ID,
    planLane: "in_progress",
    session: runningSession({
      threadId: CHILD_ID,
      status: "running",
      activeTurnId: "turn-1" as TurnId,
    }),
    latestTurn: latestTurn({ startedAt: epochIso, completedAt: null, state: "running" }),
  });

  // `monitor` optionally stubs the ProcessResourceMonitor: `active`/`idle`
  // returns a reading for the child's own pi session marker (null for anything
  // else) so the notice carries a process-health line; omitting it leaves the
  // monitor absent so the notice must degrade to its plain wording (the remote
  // / no-samples path).
  const buildLayer = (
    dispatched: Array<OrchestrationCommand>,
    opts: {
      readonly inFlight?: boolean;
      readonly receipts?: Set<string>;
      readonly monitor?: "active" | "idle";
    } = {},
  ) => {
    const inFlight = opts.inFlight ?? true;
    const receiptSet = opts.receipts;
    const monitor = opts.monitor;
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          receiptSet?.add(command.commandId as unknown as string);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as unknown as OrchestrationEngineShape;

    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads: [parent, child],
          updatedAt: epochIso,
        } satisfies OrchestrationShellSnapshot),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      // Heartbeat frozen at epoch: quiet time === TestClock time.
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: epochIso, heartbeatAt: epochIso }),
      // One tool call in flight since epoch, never completing (unless the test
      // says the tool has since returned — then null, as after a restart).
      getInFlightToolByThreadId: () =>
        Effect.succeed(
          inFlight ? { toolName: "bash", startedAt: epochIso, activityId: "act-1" } : null,
        ),
    } as unknown as ProjectionSnapshotQueryShape;

    const receipts = {
      upsert: () => Effect.void,
      getByCommandId: ({ commandId }: { commandId: unknown }) =>
        Effect.succeed(
          receiptSet?.has(commandId as string)
            ? Option.some({ status: "accepted" } as never)
            : Option.none(),
        ),
    };

    const monitorLayer =
      monitor === undefined
        ? Layer.empty
        : Layer.succeed(ProcessResourceMonitor, {
            readHistory: () => Effect.die("unused"),
            recentActivityFor: (marker: string) =>
              Effect.succeed(
                marker === piSessionIdForThread(CHILD_ID)
                  ? {
                      peakCpuPercent: monitor === "active" ? 87 : 0,
                      processCount: monitor === "active" ? 3 : 1,
                      windowMs: 30_000,
                      active: monitor === "active",
                    }
                  : null,
              ),
          } as never);

    return WorkstreamDispatcherLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          monitorLayer,
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-dispatcher-slowtool-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  const slowToolWakes = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
    dispatched.filter(
      (c): c is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        c.type === "thread.turn.start" && c.threadId === PARENT_ID,
    );

  effectIt.effect(
    "digests the slow-tool notice at the first quiet step, re-notifies at the next step, never flags the child",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();

            // (1) t=0: the call just started, activity is fresh → no notice.
            yield* dispatcher.drain;
            expect(slowToolWakes(dispatched)).toHaveLength(0);

            // (2) Past the first step (5m): the slow-tool item enters the FYI
            // digest; its age (quiet onset ~= epoch) exceeds the flush window,
            // so the digest flushes as exactly one parent notice.
            yield* TestClock.adjust(Duration.millis(6 * 60_000));
            yield* dispatcher.drain;
            const afterFirst = slowToolWakes(dispatched);
            expect(afterFirst).toHaveLength(1);
            expect(afterFirst[0]!.message.text).toContain("FYI digest");
            expect(afterFirst[0]!.message.text).toContain("still executing");
            expect(afterFirst[0]!.message.text).toContain("`bash`");
            // No monitor provided → the notice degrades to plain wording with
            // NO process-health evidence (the remote / no-samples path).
            expect(afterFirst[0]!.message.text).not.toContain("Process health:");

            // (3) Past the second step (15m) → exactly one more notice.
            yield* TestClock.adjust(Duration.millis(10 * 60_000));
            yield* dispatcher.drain;
            expect(slowToolWakes(dispatched)).toHaveLength(2);

            // The child was never attention-flagged and never interrupted — no
            // attention.raise anywhere.
            expect(dispatched.some((c) => c.type === "thread.attention.raise")).toBe(false);
          }).pipe(Effect.provide(buildLayer(dispatched, { inFlight: true })));
        }),
      ),
  );

  // Slow-tool is best-effort ephemeral (design §4.2/§6.1): a withheld slow-tool
  // item is NOT lossless. After a restart, if the tool has since returned the
  // item must simply evaporate (nothing pending, nothing errors); if the tool is
  // still in flight and quiet it re-derives and re-enters the digest.
  effectIt.effect(
    "restart: a withheld slow-tool item evaporates when the tool has returned, and re-derives when it is still in flight",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          // (A) Fresh process, tool has since RETURNED → no in-flight tool, so
          // the slow-tool item is never derived: no notice, no error.
          const dispatchedReturned: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* TestClock.adjust(Duration.millis(6 * 60_000));
            yield* dispatcher.drain;
            expect(slowToolWakes(dispatchedReturned)).toHaveLength(0);
          }).pipe(Effect.provide(buildLayer(dispatchedReturned, { inFlight: false })));

          // (B) Fresh process, tool STILL in flight + quiet → the item
          // re-derives (same episode-key scheme) and re-enters the digest.
          const dispatchedStill: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* TestClock.adjust(Duration.millis(6 * 60_000));
            yield* dispatcher.drain;
            const wakes = slowToolWakes(dispatchedStill);
            expect(wakes).toHaveLength(1);
            expect(wakes[0]!.message.text).toContain("still executing");
          }).pipe(Effect.provide(buildLayer(dispatchedStill, { inFlight: true })));
        }),
      ),
  );

  effectIt.effect(
    "attaches a process-health evidence line when the monitor observes the child's process tree",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* TestClock.adjust(Duration.millis(6 * 60_000));
            yield* dispatcher.drain;
            const wakes = slowToolWakes(dispatched);
            expect(wakes).toHaveLength(1);
            // The grinding reading is surfaced as one honest evidence line.
            expect(wakes[0]!.message.text).toContain("Process health:");
            expect(wakes[0]!.message.text).toContain("87% peak CPU");
            expect(wakes[0]!.message.text).toContain("actively working, not hung");
          }).pipe(Effect.provide(buildLayer(dispatched, { monitor: "active" })));
        }),
      ),
  );
});

// Frozen-attention notice: a stall escalation raises `needs_guidance` while the
// child's turn is wedged OPEN, so the idle-gated attention rail can never fire.
// The executing branch must surface it to the parent once the quiet grace
// elapses — exactly once per pause episode.
describe("frozen-attention notice (flagged mid-turn, TestClock, full dispatcher layer)", () => {
  const PARENT_ID = "parent-frozen" as ThreadId;
  const CHILD_ID = "child-frozen" as ThreadId;
  const epochIso = "1970-01-01T00:00:00.000Z";

  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  // Stall-escalated sub-thread: flagged `needs_guidance`, turn still open and
  // frozen since epoch.
  const child = shell({
    id: CHILD_ID as unknown as string,
    parentThreadId: PARENT_ID,
    planLane: "in_progress",
    attention: ["needs_guidance"],
    session: runningSession({
      threadId: CHILD_ID,
      status: "running",
      activeTurnId: "turn-1" as TurnId,
    }),
    latestTurn: latestTurn({ startedAt: epochIso, completedAt: null, state: "running" }),
  });

  const buildLayer = (dispatched: Array<OrchestrationCommand>) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as unknown as OrchestrationEngineShape;

    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads: [parent, child],
          updatedAt: epochIso,
        } satisfies OrchestrationShellSnapshot),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: epochIso, heartbeatAt: epochIso }),
      getInFlightToolByThreadId: () => Effect.succeed(null),
    } as unknown as ProjectionSnapshotQueryShape;

    const receipts = {
      upsert: () => Effect.void,
      getByCommandId: () => Effect.succeed(Option.none()),
    };

    return WorkstreamDispatcherLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-dispatcher-frozen-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  effectIt.effect(
    "delivers exactly one frozen pause notice once the quiet grace elapses, idempotent thereafter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();

            // Within the grace: flagged but recently active → no notice yet.
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(0);

            yield* TestClock.adjust(
              Duration.millis(DEFAULT_IDLE_WAKE_GRACE_MS + IDLE_WAKE_REPASS_INTERVAL_MS),
            );
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(1);
            const wake = dispatched[0]!;
            if (wake.type !== "thread.turn.start") {
              throw new Error(`expected a thread.turn.start wake, got ${wake.type}`);
            }
            expect(wake.threadId).toBe(PARENT_ID);
            expect(wake.message.text).toContain("frozen");
            expect(wake.message.text).toContain("needs_guidance");
            expect(wake.message.text).toContain("NOT finished");

            // One notice per pause episode (keyed on the wedged turn id).
            yield* TestClock.adjust(Duration.millis(IDLE_WAKE_REPASS_INTERVAL_MS * 5));
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(1);
          }).pipe(Effect.provide(buildLayer(dispatched)));
        }),
      ),
  );
});

// Review gates Phase 2 (design §6): a child whose submit routed to `yielded`
// wakes its parent exactly once per yield episode (keyed by the recording
// outcome event id), through the shared receipt-deduped + idle-gated rail.
// Exercised through the assembled dispatcher layer.
describe("yield wake (yielded child hands its turn to the orchestrator), full dispatcher layer", () => {
  const PARENT_ID = "parent-yield" as ThreadId;
  const CHILD_ID = "child-yield" as ThreadId;
  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  const child = shell({
    id: CHILD_ID as unknown as string,
    parentThreadId: PARENT_ID,
    planLane: "yielded",
    session: runningSession({ threadId: CHILD_ID, status: "ready", activeTurnId: null }),
    reportPath: "child-yield.md",
    lastOutcome: {
      outcome: "rework_approach",
      decision: "yield",
      round: 0,
      recordedByEventId: "evt-outcome-1",
      at: now,
    } as unknown as OrchestrationThreadShell["lastOutcome"],
  });

  const buildLayer = (dispatched: Array<OrchestrationCommand>) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as unknown as OrchestrationEngineShape;

    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads: [parent, child],
          updatedAt: now,
        } satisfies OrchestrationShellSnapshot),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: now, heartbeatAt: null }),
    } as unknown as ProjectionSnapshotQueryShape;

    const receipts = {
      upsert: () => Effect.void,
      getByCommandId: () => Effect.succeed(Option.none()),
    };

    return WorkstreamDispatcherLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-dispatcher-yield-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  effectIt.effect(
    "delivers exactly one yield wake per episode (deterministic command id), idempotent thereafter",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(1);
            const wake = dispatched[0]!;
            if (wake.type !== "thread.turn.start") {
              throw new Error(`expected a thread.turn.start wake, got ${wake.type}`);
            }
            expect(wake.threadId).toBe(PARENT_ID);
            expect(wake.commandId).toBe(yieldWakeCommandId(CHILD_ID, "evt-outcome-1"));
            expect(wake.requireIdle).toBe(true);
            expect(wake.message.text).toContain("YIELDED");
            expect(wake.message.text).toContain("rework_approach");
            expect(wake.message.text).toContain("child-yield.md");
            expect(wake.message.text).toContain("NOT finished");
            // A yielded child is neither idle-nagged nor generation-joined: the
            // yield wake is the only dispatch, and further passes are no-ops.
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(1);
          }).pipe(Effect.provide(buildLayer(dispatched)));
        }),
      ),
  );
});

describe("buildYieldWakeMessage", () => {
  it("marks the notice as control-plane, names the outcome, and lays out the decision menu", () => {
    const text = buildYieldWakeMessage(
      { id: "child-1" as ThreadId, role: "reviewer", reportPath: "child-1.md" },
      "rework_approach",
      "# Why\nThe approach is wrong.",
    );
    expect(text).toContain("[T3 Workstream control plane");
    expect(text).toContain("`rework_approach`");
    expect(text).toContain("child-1.md");
    expect(text).toContain("The approach is wrong.");
    expect(text).toContain("NOT finished");
    expect(text).toContain("workstream_prompt");
    expect(text).toContain("workstream_set_lane");
  });
});

// ---------------------------------------------------------------------------
// Review gates Phase 3 (design §4.3/§6): the gate traversal pass, cap-breach
// yield copy, idle-rail gate suppression, and generation-join gating.
// ---------------------------------------------------------------------------

describe("gate resume messages (pure builders)", () => {
  it("gateCommandId is deterministic per (source, round, leg)", () => {
    expect(gateCommandId("rev-1" as ThreadId, 2, "rework")).toBe(
      "server:workstream-gate:rev-1:2:rework",
    );
    expect(gateCommandId("rev-1" as ThreadId, 2, "reverify")).toBe(
      "server:workstream-gate:rev-1:2:reverify",
    );
  });

  it("rework message carries marker, round, reference, adjudication rules, and routing visibility", () => {
    const text = buildGateReworkMessage(
      { id: "rev-1" as ThreadId, role: "reviewer", reportPath: "/reports/rev-1.round-1.md" },
      1,
      "## Findings\n1. Fix the null guard.",
    );
    expect(text).toContain("[T3 Workstream control plane");
    expect(text).toContain("Review round 1");
    expect(text).toContain("/reports/rev-1.round-1.md");
    expect(text).toContain("Fix the null guard.");
    expect(text).toContain("claims, not verdicts");
    expect(text).toContain("routes back to the reviewer");
    expect(text).toContain("NOT to done");
  });

  it("reverify message carries the delta-review discipline and the verdict routing", () => {
    const text = buildGateReverifyMessage(
      { id: "coder-1" as ThreadId, role: "coder", reportPath: "/reports/coder-1.round-1.md" },
      1,
      "## Round report\nImplemented finding 1; rejected finding 2 (reasons).",
    );
    expect(text).toContain("[T3 Workstream control plane");
    expect(text).toContain("re-verification");
    expect(text).toContain("DELTA review");
    expect(text).toContain("rejected finding 2");
    expect(text).toContain("`clean` or `fixed_inline` resolves the gate");
    expect(text).toContain("`needs_rework` loops again");
  });
});

describe("buildYieldWakeMessage (gate cap breach + copy)", () => {
  it("does not duplicate 'sub-thread' when the child has no role", () => {
    const text = buildYieldWakeMessage(
      { id: "child-1" as ThreadId, role: null, reportPath: null },
      "rework_approach",
      null,
    );
    expect(text).not.toContain("sub-thread sub-thread");
    expect(text).toContain("Your Workstream sub-thread `child-1`");
  });

  it("cap breach carries the round count and BOTH parties' reports", () => {
    const text = buildYieldWakeMessage(
      { id: "rev-1" as ThreadId, role: "reviewer", reportPath: "/reports/rev-1.md" },
      "needs_rework",
      "Still two must-fix findings.",
      {
        rounds: 2,
        maxRounds: 2,
        counterpart: {
          id: "coder-1" as ThreadId,
          role: "coder",
          reportPath: "/reports/coder-1.round-2.md",
          report: "Round 2: contested finding 3 again.",
        },
      },
    );
    expect(text).toContain("round cap is exhausted (2/2");
    expect(text).toContain("Still two must-fix findings.");
    expect(text).toContain("coder `coder-1`");
    expect(text).toContain("/reports/coder-1.round-2.md");
    expect(text).toContain("contested finding 3 again");
    expect(text).toContain("dissolves the gate");
    expect(text).toContain("NOT resolved");
  });
});

// Layered gate-traversal coverage: the pass recomputes owed loop legs purely
// from shell state and delivers them under deterministic, receipt-deduped
// command ids — crash-safe across redrives.
describe("routeGateTraversals (full dispatcher layer)", () => {
  const PARENT_ID = "parent-gate" as ThreadId;
  const REVIEWER_ID = "reviewer-gate" as ThreadId;
  const CODER_ID = "coder-gate" as ThreadId;
  const epochIso = "1970-01-01T00:00:00.000Z";

  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  const gateRoutes = [
    { on: ["needs_rework"], kind: "loop", to: CODER_ID, maxRounds: 2 },
    { on: ["clean", "fixed_inline"], kind: "resolve" },
  ] as unknown as OrchestrationThreadShell["routes"];

  const buildLayer = (
    dispatched: Array<OrchestrationCommand>,
    threads: ReadonlyArray<OrchestrationThreadShell>,
    options: { readonly receiptIds?: ReadonlySet<string>; readonly prefix: string },
  ) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as unknown as OrchestrationEngineShape;

    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads,
          updatedAt: epochIso,
        } satisfies OrchestrationShellSnapshot),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: epochIso, heartbeatAt: null }),
      getInFlightToolByThreadId: () => Effect.succeed(null),
    } as unknown as ProjectionSnapshotQueryShape;

    const receipts = {
      upsert: () => Effect.void,
      getByCommandId: ({ commandId }: { commandId: string }) =>
        Effect.succeed(
          options.receiptIds?.has(commandId) ? Option.some({ commandId }) : Option.none(),
        ),
    };

    return WorkstreamDispatcherLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: options.prefix }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  const run = (
    threads: ReadonlyArray<OrchestrationThreadShell>,
    options: { readonly receiptIds?: ReadonlySet<string>; readonly prefix: string },
    body: (args: {
      readonly dispatched: Array<OrchestrationCommand>;
      readonly dispatcher: { readonly drain: Effect.Effect<void> };
    }) => Effect.Effect<void>,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        yield* Effect.gen(function* () {
          const dispatcher = yield* WorkstreamDispatcher;
          yield* dispatcher.start();
          yield* dispatcher.drain;
          yield* body({ dispatched, dispatcher });
        }).pipe(Effect.provide(buildLayer(dispatched, threads, options)));
      }),
    );

  // A reviewer that actually issued a rework round carries a `loop` lastOutcome
  // (projected from its `thread.outcome-recorded`). The rework leg is guarded on
  // this so a replacement reviewer that never reviewed cannot deliver a rework
  // "from" itself (2026-07-07 incident).
  const loopOutcome = {
    outcome: "needs_rework",
    decision: "loop",
    round: 1,
    recordedByEventId: "evt-loop-1",
    at: epochIso,
  } as unknown as NonNullable<OrchestrationThreadShell["lastOutcome"]>;

  effectIt.effect(
    "rework leg: an open round resumes the done coder with reopen, exactly once (round-trip start)",
    () => {
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        role: "reviewer",
        planLane: "in_progress",
        routes: gateRoutes,
        gateRounds: 1,
        lastOutcome: loopOutcome,
        reportPath: "/nonexistent/reviewer-gate.round-1.md",
      });
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        role: "coder",
        planLane: "done",
        pendingRework: true,
      });
      return run(
        [parent, reviewer, coder],
        { prefix: "t3-workstream-gate-rework-" },
        ({ dispatched, dispatcher }) =>
          Effect.gen(function* () {
            expect(dispatched.length).toBe(1);
            const resume = dispatched[0]!;
            if (resume.type !== "thread.turn.start") {
              throw new Error(`expected thread.turn.start, got ${resume.type}`);
            }
            expect(resume.threadId).toBe(CODER_ID);
            expect(resume.commandId).toBe(gateCommandId(REVIEWER_ID, 1, "rework"));
            expect(resume.reopen).toBe(true);
            expect(resume.requireIdle).toBeUndefined();
            expect(resume.message.text).toContain("Review round 1");
            expect(resume.message.text).toContain("routes back to the reviewer");
            // Idempotent across passes (in-memory handled set + receipts).
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(1);
          }),
      );
    },
  );

  effectIt.effect(
    "scaffold plan §4/§5: a gate rework round resumes the coder even with NO brief (the brief gates only the first launch)",
    () => {
      // Both gate parties are brief-less (kickoffBriefPath null): the brief gate
      // must NOT touch gate-round re-prompts, which flow through the traversal
      // pass, not the promote path.
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        role: "reviewer",
        planLane: "in_progress",
        routes: gateRoutes,
        gateRounds: 1,
        lastOutcome: loopOutcome,
        kickoffBriefPath: null,
      });
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        role: "coder",
        planLane: "done",
        pendingRework: true,
        kickoffBriefPath: null,
      });
      return run(
        [parent, reviewer, coder],
        { prefix: "t3-workstream-gate-rework-nobrief-" },
        ({ dispatched }) =>
          Effect.sync(() => {
            const resume = dispatched.find(
              (c): c is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
                c.type === "thread.turn.start" && c.threadId === CODER_ID,
            );
            expect(resume).toBeDefined();
            expect(resume!.commandId).toBe(gateCommandId(REVIEWER_ID, 1, "rework"));
            expect(resume!.reopen).toBe(true);
            // No brief-read-failure park despite the null brief — the gate path
            // never consults the brief gate.
            expect(
              dispatched.filter(
                (c) =>
                  c.type === "thread.attention.raise" && c.commandId.includes("brief-read-failed"),
              ),
            ).toHaveLength(0);
          }),
      );
    },
  );

  effectIt.effect(
    "crash between route-taken and resume: a redrive with the receipt present never re-dispatches",
    () => {
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "in_progress",
        routes: gateRoutes,
        gateRounds: 1,
        lastOutcome: loopOutcome,
      });
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "done",
        pendingRework: true,
      });
      return run(
        [parent, reviewer, coder],
        {
          prefix: "t3-workstream-gate-redrive-",
          receiptIds: new Set([gateCommandId(REVIEWER_ID, 1, "rework")]),
        },
        ({ dispatched }) =>
          Effect.sync(() => {
            expect(dispatched.length).toBe(0);
          }),
      );
    },
  );

  effectIt.effect(
    "Issue 1: a replacement reviewer that has NOT reviewed fires no rework leg on a coder with a lingering open round",
    () => {
      // 2026-07-08 incident: the predecessor gate was cancelled but the coder's
      // `pendingRework` lingered. A fresh replacement reviewer (gateRounds 0,
      // lastOutcome null — it never issued a round) must NOT deliver a rework
      // message "from" itself. (The projector also dissolves the residual round
      // on the predecessor's cancel; this is the dispatcher-side guard.)
      const replacement = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        role: "reviewer",
        planLane: "in_progress",
        routes: gateRoutes,
        gateRounds: 0,
        lastOutcome: null,
      });
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        role: "coder",
        planLane: "done",
        pendingRework: true,
      });
      return run(
        [parent, replacement, coder],
        { prefix: "t3-workstream-gate-replacement-" },
        ({ dispatched }) =>
          Effect.sync(() => {
            // No rework/reverify resume to either gate party.
            expect(
              dispatched.filter(
                (c) =>
                  c.type === "thread.turn.start" &&
                  (c.threadId === CODER_ID || c.threadId === REVIEWER_ID),
              ),
            ).toHaveLength(0);
          }),
      );
    },
  );

  effectIt.effect(
    "reverify leg: a routed-back coder resumes the reviewer with the delta report, no reopen",
    () => {
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        role: "reviewer",
        planLane: "in_progress",
        routes: gateRoutes,
        gateRounds: 1,
      });
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        role: "coder",
        planLane: "in_progress",
        pendingRework: false,
        lastOutcome: {
          outcome: "done",
          decision: "loop",
          round: 1,
          recordedByEventId: "evt-coder-loop",
          at: now,
        } as unknown as OrchestrationThreadShell["lastOutcome"],
      });
      return run(
        [parent, reviewer, coder],
        { prefix: "t3-workstream-gate-reverify-" },
        ({ dispatched }) =>
          Effect.sync(() => {
            expect(dispatched.length).toBe(1);
            const resume = dispatched[0]!;
            if (resume.type !== "thread.turn.start") {
              throw new Error(`expected thread.turn.start, got ${resume.type}`);
            }
            expect(resume.threadId).toBe(REVIEWER_ID);
            expect(resume.commandId).toBe(gateCommandId(REVIEWER_ID, 1, "reverify"));
            expect(resume.reopen).toBeUndefined();
            expect(resume.message.text).toContain("DELTA review");
          }),
      );
    },
  );

  effectIt.effect(
    "parent dissolution: a done reviewer stops all traversal even with an open round",
    () => {
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "done",
        routes: gateRoutes,
        gateRounds: 1,
      });
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "done",
        pendingRework: true,
      });
      return run(
        [parent, reviewer, coder],
        { prefix: "t3-workstream-gate-dissolved-" },
        ({ dispatched }) =>
          Effect.sync(() => {
            // No gate traversal: no rework/reverify resume is sent to either
            // gate party. (The dissolved done pair is instead reported to the
            // parent by the terminal-child delta rail — a wake to PARENT_ID.)
            expect(
              dispatched.filter(
                (c) =>
                  c.type === "thread.turn.start" &&
                  (c.threadId === CODER_ID || c.threadId === REVIEWER_ID),
              ),
            ).toHaveLength(0);
          }),
      );
    },
  );

  effectIt.effect(
    "R4: a cancelled coder gets no traversal, and the waiting reviewer's idle wake un-suppresses",
    () => {
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        role: "reviewer",
        planLane: "in_progress",
        routes: gateRoutes,
        gateRounds: 1,
        session: runningSession({ threadId: REVIEWER_ID, status: "ready", activeTurnId: null }),
        latestTurn: latestTurn({ completedAt: epochIso }),
      });
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "cancelled",
        pendingRework: true,
      });
      return run(
        [parent, reviewer, coder],
        { prefix: "t3-workstream-gate-r4-" },
        ({ dispatched, dispatcher }) =>
          Effect.gen(function* () {
            // No gate traversal into the dead coder.
            expect(dispatched.length).toBe(0);
            // Once the idle grace elapses the reviewer is NOT gate-suppressed
            // (cancelled counterpart): the forgot-to-finish rail flags it and
            // wakes the parent.
            yield* TestClock.adjust(
              Duration.millis(DEFAULT_IDLE_WAKE_GRACE_MS + IDLE_WAKE_REPASS_INTERVAL_MS),
            );
            yield* dispatcher.drain;
            expect(dispatched.length).toBe(2);
            const flag = dispatched[0]!;
            if (flag.type !== "thread.attention.raise") {
              throw new Error(`expected thread.attention.raise, got ${flag.type}`);
            }
            expect(flag.threadId).toBe(REVIEWER_ID);
            const wake = dispatched[1]!;
            if (wake.type !== "thread.turn.start") {
              throw new Error(`expected thread.turn.start, got ${wake.type}`);
            }
            expect(wake.threadId).toBe(PARENT_ID);
          }),
      );
    },
  );

  effectIt.effect(
    "parent interrupt mid-loop: a stopped coder is never re-sent its rework resume; the idle backstop owns it",
    () => {
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "in_progress",
        routes: gateRoutes,
        gateRounds: 1,
      });
      // The coder was resumed for rework (receipt durable), then the parent
      // stopped it mid-turn: in_progress, idle, round still open.
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "in_progress",
        pendingRework: true,
        session: runningSession({ threadId: CODER_ID, status: "stopped", activeTurnId: null }),
        latestTurn: latestTurn({ completedAt: epochIso, state: "interrupted" }),
      });
      return run(
        [parent, reviewer, coder],
        {
          prefix: "t3-workstream-gate-interrupt-",
          receiptIds: new Set([gateCommandId(REVIEWER_ID, 1, "rework")]),
        },
        ({ dispatched, dispatcher }) =>
          Effect.gen(function* () {
            // The gate pass never fights the parent's pause: the rework leg is
            // receipt-deduped, so nothing is re-dispatched to the coder.
            expect(dispatched).toHaveLength(0);
            // …but the coder still owes a submit, so once the idle grace
            // elapses the forgot-to-finish backstop surfaces it (needs_guidance
            // flag + parent wake) — gate suppression does NOT apply to a party
            // holding the open round.
            yield* TestClock.adjust(
              Duration.millis(DEFAULT_IDLE_WAKE_GRACE_MS + IDLE_WAKE_REPASS_INTERVAL_MS),
            );
            yield* dispatcher.drain;
            expect(
              dispatched.filter(
                (c) => c.type === "thread.attention.raise" && c.threadId === CODER_ID,
              ),
            ).toHaveLength(1);
            expect(
              dispatched.filter((c) => c.type === "thread.turn.start" && c.threadId === PARENT_ID),
            ).toHaveLength(1);
            // Still no rework re-dispatch to the coder.
            expect(
              dispatched.filter((c) => c.type === "thread.turn.start" && c.threadId === CODER_ID),
            ).toHaveLength(0);
          }),
      );
    },
  );

  effectIt.effect(
    "suppression: a reviewer idling while the coder holds the open round is never idle-nagged",
    () => {
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "in_progress",
        routes: gateRoutes,
        gateRounds: 1,
        session: runningSession({ threadId: REVIEWER_ID, status: "ready", activeTurnId: null }),
        latestTurn: latestTurn({ completedAt: epochIso }),
      });
      // The coder is mid-rework (in_progress with the open round) — resumed by
      // an earlier pass whose rework receipt is durable.
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "in_progress",
        pendingRework: true,
        session: runningSession({
          threadId: CODER_ID,
          status: "running",
          activeTurnId: "turn-rework" as TurnId,
        }),
      });
      return run(
        [parent, reviewer, coder],
        {
          prefix: "t3-workstream-gate-suppress-",
          receiptIds: new Set([gateCommandId(REVIEWER_ID, 1, "rework")]),
        },
        ({ dispatched, dispatcher }) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(
              Duration.millis(DEFAULT_IDLE_WAKE_GRACE_MS + IDLE_WAKE_REPASS_INTERVAL_MS),
            );
            yield* dispatcher.drain;
            // No idle flag, no idle wake — the reviewer is waiting in the gate.
            expect(dispatched.filter((c) => c.type === "thread.attention.raise")).toHaveLength(0);
            expect(
              dispatched.filter((c) => c.type === "thread.turn.start" && c.threadId === PARENT_ID),
            ).toHaveLength(0);
          }),
      );
    },
  );

  effectIt.effect(
    "suppression: a reviewer with an open loop verdict is not idle-nagged after the coder stops holding rework",
    () => {
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "in_progress",
        routes: gateRoutes,
        gateRounds: 1,
        session: runningSession({ threadId: REVIEWER_ID, status: "ready", activeTurnId: null }),
        latestTurn: latestTurn({ completedAt: epochIso }),
        lastOutcome: {
          outcome: "needs_rework",
          decision: "loop",
          round: 1,
          recordedByEventId: "evt-reviewer-loop",
          at: now,
        } as unknown as OrchestrationThreadShell["lastOutcome"],
      });
      // This is the previously-bad gap: the target no longer has pendingRework,
      // but the source's loop round remains unresolved and should stay parked
      // while the non-terminal target has its own wake rail.
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "in_progress",
        pendingRework: false,
        session: runningSession({
          threadId: CODER_ID,
          status: "running",
          activeTurnId: "turn-after-rework" as TurnId,
        }),
      });
      return run(
        [parent, reviewer, coder],
        {
          prefix: "t3-workstream-gate-suppress-loop-source-",
          receiptIds: new Set([gateCommandId(REVIEWER_ID, 1, "rework")]),
        },
        ({ dispatched, dispatcher }) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(
              Duration.millis(DEFAULT_IDLE_WAKE_GRACE_MS + IDLE_WAKE_REPASS_INTERVAL_MS),
            );
            yield* dispatcher.drain;
            expect(
              dispatched.filter(
                (c) => c.type === "thread.attention.raise" && c.threadId === REVIEWER_ID,
              ),
            ).toHaveLength(0);
            expect(
              dispatched.filter((c) => c.type === "thread.turn.start" && c.threadId === PARENT_ID),
            ).toHaveLength(0);
          }),
      );
    },
  );

  effectIt.effect(
    "suppression: a reviewer with a plain-done target is idle-nagged so a dead gate surfaces",
    () => {
      const reviewer = shell({
        id: REVIEWER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "in_progress",
        routes: gateRoutes,
        gateRounds: 1,
        session: runningSession({ threadId: REVIEWER_ID, status: "ready", activeTurnId: null }),
        latestTurn: latestTurn({ completedAt: epochIso }),
        lastOutcome: {
          outcome: "needs_rework",
          decision: "loop",
          round: 1,
          recordedByEventId: "evt-reviewer-loop-dead",
          at: now,
        } as unknown as OrchestrationThreadShell["lastOutcome"],
      });
      const coder = shell({
        id: CODER_ID as unknown as string,
        parentThreadId: PARENT_ID,
        planLane: "done",
        pendingRework: false,
      });
      return run(
        [parent, reviewer, coder],
        { prefix: "t3-workstream-gate-unsuppress-done-target-" },
        ({ dispatched, dispatcher }) =>
          Effect.gen(function* () {
            expect(dispatched).toHaveLength(0);
            yield* TestClock.adjust(
              Duration.millis(DEFAULT_IDLE_WAKE_GRACE_MS + IDLE_WAKE_REPASS_INTERVAL_MS),
            );
            yield* dispatcher.drain;
            expect(
              dispatched.filter(
                (c) => c.type === "thread.attention.raise" && c.threadId === REVIEWER_ID,
              ),
            ).toHaveLength(1);
            expect(
              dispatched.filter((c) => c.type === "thread.turn.start" && c.threadId === PARENT_ID),
            ).toHaveLength(1);
          }),
      );
    },
  );
});

// Gate holdback, per child (design §6): a terminal child that is a party of an
// unresolved gate is held back from the delta rail; it becomes reportable once
// the gate source is terminal, and the cleanly-resolved coder+reviewer pair is
// then reported together in ONE delta wake.
describe("terminal child is held back by an unresolved gate (full dispatcher layer)", () => {
  const PARENT_ID = "parent-join-gate" as ThreadId;
  const REVIEWER_ID = "reviewer-join-gate" as ThreadId;
  const CODER_ID = "coder-join-gate" as ThreadId;

  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  const gateRoutes = [
    { on: ["needs_rework"], kind: "loop", to: CODER_ID, maxRounds: 2 },
    { on: ["clean", "fixed_inline"], kind: "resolve" },
  ] as unknown as OrchestrationThreadShell["routes"];

  const buildLayer = (
    dispatched: Array<OrchestrationCommand>,
    threads: ReadonlyArray<OrchestrationThreadShell>,
    prefix: string,
  ) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as unknown as OrchestrationEngineShape;
    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads,
          updatedAt: now,
        } satisfies OrchestrationShellSnapshot),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: now, heartbeatAt: null }),
      getInFlightToolByThreadId: () => Effect.succeed(null),
    } as unknown as ProjectionSnapshotQueryShape;
    const receipts = {
      upsert: () => Effect.void,
      getByCommandId: () => Effect.succeed(Option.none()),
    };
    return WorkstreamDispatcherLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  const drainWith = (threads: ReadonlyArray<OrchestrationThreadShell>, prefix: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        yield* Effect.gen(function* () {
          const dispatcher = yield* WorkstreamDispatcher;
          yield* dispatcher.start();
          yield* dispatcher.drain;
        }).pipe(Effect.provide(buildLayer(dispatched, threads, prefix)));
        return dispatched;
      }),
    );

  effectIt.effect("holds the coder-only generation while the reviewer can still reopen it", () =>
    Effect.gen(function* () {
      const dispatched = yield* drainWith(
        [
          parent,
          shell({
            id: CODER_ID as unknown as string,
            parentThreadId: PARENT_ID,
            planLane: "done",
            spawnGeneration: "gen-1",
          }),
          shell({
            id: REVIEWER_ID as unknown as string,
            parentThreadId: PARENT_ID,
            planLane: "in_progress",
            routes: gateRoutes,
            session: runningSession({
              threadId: REVIEWER_ID,
              status: "running",
              activeTurnId: "turn-review" as TurnId,
            }),
          }),
        ],
        "t3-workstream-join-held-",
      );
      expect(
        dispatched.filter((c) => c.type === "thread.turn.start" && c.threadId === PARENT_ID),
      ).toHaveLength(0);
    }),
  );

  effectIt.effect("releases the join once the gate source is terminal (resolution)", () =>
    Effect.gen(function* () {
      const dispatched = yield* drainWith(
        [
          parent,
          shell({
            id: CODER_ID as unknown as string,
            parentThreadId: PARENT_ID,
            planLane: "done",
            spawnGeneration: "gen-1",
          }),
          shell({
            id: REVIEWER_ID as unknown as string,
            parentThreadId: PARENT_ID,
            planLane: "done",
            routes: gateRoutes,
            spawnGeneration: "gen-1",
          }),
        ],
        "t3-workstream-join-released-",
      );
      const wakes = dispatched.filter(
        (c) => c.type === "thread.turn.start" && c.threadId === PARENT_ID,
      );
      expect(wakes).toHaveLength(1);
    }),
  );
});

// Cap-breach yield wake (design §6): carries the round count and the
// counterpart's latest round report alongside the yielding reviewer's.
describe("cap-breach yield wake carries both reports (full dispatcher layer)", () => {
  const PARENT_ID = "parent-cap" as ThreadId;
  const REVIEWER_ID = "reviewer-cap" as ThreadId;
  const CODER_ID = "coder-cap" as ThreadId;

  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  const reviewer = shell({
    id: REVIEWER_ID as unknown as string,
    parentThreadId: PARENT_ID,
    role: "reviewer",
    planLane: "yielded",
    routes: [
      { on: ["needs_rework"], kind: "loop", to: CODER_ID, maxRounds: 2 },
      { on: ["clean", "fixed_inline"], kind: "resolve" },
    ] as unknown as OrchestrationThreadShell["routes"],
    gateRounds: 2,
    reportPath: "/nonexistent/reviewer-cap.md",
    lastOutcome: {
      outcome: "needs_rework",
      decision: "cap-breach",
      round: 2,
      recordedByEventId: "evt-cap-1",
      at: now,
    } as unknown as OrchestrationThreadShell["lastOutcome"],
  });
  const coder = shell({
    id: CODER_ID as unknown as string,
    parentThreadId: PARENT_ID,
    role: "coder",
    planLane: "in_progress",
    reportPath: "/nonexistent/coder-cap.round-2.md",
  });

  const buildLayer = (dispatched: Array<OrchestrationCommand>) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as unknown as OrchestrationEngineShape;
    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads: [parent, reviewer, coder],
          updatedAt: now,
        } satisfies OrchestrationShellSnapshot),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: now, heartbeatAt: null }),
      getInFlightToolByThreadId: () => Effect.succeed(null),
    } as unknown as ProjectionSnapshotQueryShape;
    const receipts = {
      upsert: () => Effect.void,
      getByCommandId: () => Effect.succeed(Option.none()),
    };
    return WorkstreamDispatcherLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-cap-breach-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  effectIt.effect("the yield wake names the exhausted cap and references both reports", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        yield* Effect.gen(function* () {
          const dispatcher = yield* WorkstreamDispatcher;
          yield* dispatcher.start();
          yield* dispatcher.drain;
          const wakes = dispatched.filter(
            (c): c is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
              c.type === "thread.turn.start" && c.threadId === PARENT_ID,
          );
          expect(wakes).toHaveLength(1);
          const text = wakes[0]!.message.text;
          expect(text).toContain("round cap is exhausted (2/2");
          expect(text).toContain("/nonexistent/reviewer-cap.md");
          expect(text).toContain("coder `coder-cap`");
          expect(text).toContain("/nonexistent/coder-cap.round-2.md");
        }).pipe(Effect.provide(buildLayer(dispatched)));
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Re-engagement epoch regression (parent reopen of a done child), delta rail.
//
// Incident: child submits → done → parent is notified (durable reported marker)
// → parent reopens the child (`workstream_set_lane` ready) and prompts it →
// child submits again → done. The delta rail marks a reported child durably by
// `(childId, terminalEpisodeKey)`. The re-run records a FRESH outcome event (and
// the lane-set reopen re-stamps `spawnGeneration`), so the second completion's
// episode key — and hence its reported-marker command id — differs from the
// first and carries no receipt: the parent is notified again. This drives the
// REAL decider + projector through the full episode loop and checks the marker
// keying at each step.
// ---------------------------------------------------------------------------
effectIt.layer(NodeServices.layer)(
  "re-engagement epoch (reopened child re-notifies parent)",
  (it) => {
    const t = "2026-01-01T00:00:00.000Z";
    const PARENT = ThreadId.make("parent-epoch");
    const CHILD = ThreadId.make("child-epoch");

    const applyEvents = (
      readModel: OrchestrationReadModel,
      events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
      seqStart: number,
    ) =>
      Effect.gen(function* () {
        let model = readModel;
        for (const [index, event] of events.entries()) {
          model = yield* projectEvent(model, {
            ...event,
            sequence: seqStart + index,
          } as OrchestrationEvent);
        }
        return model;
      });

    const threadCreated = (threadId: ThreadId, parent: ThreadId | null) =>
      ({
        eventId: EventId.make(`evt-${threadId}`),
        aggregateKind: "thread",
        aggregateId: threadId,
        type: "thread.created",
        occurredAt: t,
        commandId: CommandId.make(`cmd-${threadId}`),
        causationEventId: null,
        correlationId: CommandId.make(`cmd-${threadId}`),
        metadata: {},
        payload: {
          threadId,
          projectId: ProjectId.make("project-epoch"),
          ...(parent !== null
            ? {
                parentThreadId: parent,
                role: "coder",
                purpose: "do the thing",
                planLane: "ready",
                spawnGeneration: "gen-epoch-0",
              }
            : {}),
          title: `Thread ${threadId}`,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: null,
          worktreePath: null,
          createdAt: t,
          updatedAt: t,
        },
      }) as Omit<OrchestrationEvent, "sequence">;

    it.effect(
      "second completion after a lane-set reopen gets a FRESH reported-marker id that carries no receipt",
      () =>
        Effect.gen(function* () {
          let model = createEmptyReadModel(t);
          model = yield* projectEvent(model, {
            sequence: 1,
            eventId: EventId.make("evt-project-epoch"),
            aggregateKind: "project",
            aggregateId: ProjectId.make("project-epoch"),
            type: "project.created",
            occurredAt: t,
            commandId: CommandId.make("cmd-project-epoch"),
            causationEventId: null,
            correlationId: CommandId.make("cmd-project-epoch"),
            metadata: {},
            payload: {
              projectId: ProjectId.make("project-epoch"),
              title: "Project",
              workspaceRoot: "/tmp/project-epoch",
              defaultModelSelection: null,
              scripts: [],
              createdAt: t,
              updatedAt: t,
            },
          });
          model = yield* applyEvents(model, [threadCreated(PARENT, null)], 2);
          model = yield* applyEvents(model, [threadCreated(CHILD, PARENT)], 3);

          const decide = (command: OrchestrationCommand) =>
            decideOrchestrationCommand({ command, readModel: model }).pipe(
              Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
            );

          // Episode 1: submit → done. The delta rail reports the child under a
          // marker keyed by its terminal episode; simulate that marker's receipt.
          model = yield* applyEvents(
            model,
            yield* decide({
              type: "thread.work.submit",
              commandId: CommandId.make("server:workstream-submit:episode-1"),
              threadId: CHILD,
              reportPath: "/reports/child-epoch.md",
              createdAt: t,
            }),
            10,
          );
          const done1 = model.threads.find((thread) => thread.id === CHILD)!;
          expect(done1.planLane).toBe("done");
          const marker1 = childReportedCommandId(CHILD, terminalEpisodeKey(done1));
          const receipts = new Set([marker1]);

          // Parent reopens via the lane-set path (bare/client commandId — the
          // workstream_set_lane tool): the SAME event stamps a fresh generation.
          model = yield* applyEvents(
            model,
            yield* decide({
              type: "thread.plan-lane.set",
              commandId: CommandId.make("11111111-2222-3333-4444-555555555555"),
              threadId: CHILD,
              planLane: "ready",
              createdAt: t,
            }),
            20,
          );
          const reopened = model.threads.find((thread) => thread.id === CHILD)!;
          expect(reopened.spawnGeneration).not.toBe("gen-epoch-0");
          expect(reopened.spawnGeneration).not.toBeNull();
          // The fresh epoch is not terminal yet → nothing reportable (no premature wake).
          expect(reopened.planLane).toBe("ready");

          // Episode 2: the re-run submits again → done. Its terminal episode key —
          // and thus its reported-marker id — differs, so it carries no receipt and
          // is re-reported (the regression: an immutable key deduped it forever).
          model = yield* applyEvents(
            model,
            yield* decide({
              type: "thread.work.submit",
              commandId: CommandId.make("server:workstream-submit:episode-2"),
              threadId: CHILD,
              reportPath: "/reports/child-epoch.round-2.md",
              createdAt: t,
            }),
            30,
          );
          const done2 = model.threads.find((thread) => thread.id === CHILD)!;
          expect(done2.planLane).toBe("done");
          const marker2 = childReportedCommandId(CHILD, terminalEpisodeKey(done2));
          expect(marker2).not.toBe(marker1);
          expect(receipts.has(marker2)).toBe(false);
        }),
    );
  },
);

describe("fan-in settlement releases dependents", () => {
  const DEP_ID = "dep-coder" as ThreadId;
  const DEPENDENT_ID = "dependent-coder" as ThreadId;

  // Review finding 2: the dispatcher must re-run its promote pass on a
  // `thread.fanin-set` event. A dependent blocked on an isolated dep that is
  // `done` but not yet fanned in stays gated; once the reactor settles the dep
  // to `completed` (a `thread.fanin-set` event), the dependent is promoted
  // without waiting for the periodic tick.
  effectIt.effect("promotes a dependent once its isolated dependency's fan-in completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: Array<OrchestrationCommand> = [];
        const events = yield* PubSub.unbounded<OrchestrationEvent>();
        // The dependent must carry a readable kickoff brief for promotion to
        // fire (scaffold plan §1 brief gate + read-at-kickoff).
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const briefDir = yield* fs.makeTempDirectory({ prefix: "t3-fanin-brief-" });
        const dependentBrief = path.join(briefDir, "dependent.md");
        yield* fs.writeFileString(dependentBrief, "dependent kickoff brief");
        const threads = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([
          shell({
            id: DEP_ID,
            parentThreadId: "parent-1" as ThreadId,
            isolation: "isolated",
            planLane: "done",
            fanInState: "none",
          }),
          shell({
            id: DEPENDENT_ID,
            parentThreadId: "parent-1" as ThreadId,
            isolation: "isolated",
            planLane: "ready",
            blockedBy: [DEP_ID],
            kickoffBriefPath: dependentBrief,
          }),
        ]);
        const shellSnapshot = Effect.map(Ref.get(threads), (current) => ({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads: current,
          updatedAt: now,
        }));
        const engine = {
          readEvents: () => Stream.empty,
          dispatch: (command: OrchestrationCommand) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: dispatched.length };
            }),
          streamDomainEvents: Stream.fromPubSub(events),
          subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
        } satisfies OrchestrationEngineShape;
        const snapshotQuery = {
          getShellSnapshot: () => shellSnapshot,
          getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
          getActivityFreshnessByThreadId: () =>
            Effect.succeed({ maxCreatedAt: null, heartbeatAt: null }),
        } as unknown as ProjectionSnapshotQueryShape;
        const receipts = {
          upsert: () => Effect.void,
          getByCommandId: () => Effect.succeed(Option.none()),
        };
        const deps = Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-fanin-release-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer));
        yield* Effect.gen(function* () {
          const dispatcher = yield* WorkstreamDispatcher;
          yield* dispatcher.start();
          yield* dispatcher.drain;
          // Blocked: the dep is done but its isolated fan-in has not settled.
          expect(
            dispatched.some((c) => c.type === "thread.turn.start" && c.threadId === DEPENDENT_ID),
          ).toBe(false);
          // The reactor settles the fan-in → a `thread.fanin-set` event re-runs the
          // dispatcher pass → the dependent is promoted.
          yield* Ref.update(threads, (current) =>
            current.map((t) => (t.id === DEP_ID ? { ...t, fanInState: "completed" as const } : t)),
          );
          yield* PubSub.publish(events, { type: "thread.fanin-set" } as OrchestrationEvent);
          yield* dispatcher.drain;
          expect(
            dispatched.some((c) => c.type === "thread.turn.start" && c.threadId === DEPENDENT_ID),
          ).toBe(true);
        }).pipe(Effect.provide(WorkstreamDispatcherLive.pipe(Layer.provide(deps))));
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
});

// ---------------------------------------------------------------------------
// Terminal-child delta rail (full dispatcher layer): "everything new since you
// last heard", batched per parent — replacing the all-members-terminal barrier.
// dispatch writes a receipt for the command id (mirroring the engine writing a
// receipt on every accepted command); the delta wake uses a random id so it
// never dedups, while the per-child `child-reported` markers (deterministic ids)
// DO — the durable dedup. A `receipts` Set shared across dispatcher instances
// models durable receipts surviving a restart (fresh in-memory caches).
// ---------------------------------------------------------------------------
describe("terminal-child delta rail (full dispatcher layer)", () => {
  const PARENT_ID = "parent-delta" as ThreadId;
  const A = "child-delta-a" as ThreadId;
  const B = "child-delta-b" as ThreadId;
  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });

  const buildDeps = (
    threadsRef: Ref.Ref<ReadonlyArray<OrchestrationThreadShell>>,
    dispatched: Array<OrchestrationCommand>,
    receipts: Set<string>,
    events: PubSub.PubSub<OrchestrationEvent>,
    freshness: () => {
      maxCreatedAt: string | null;
      heartbeatAt: string | null;
    },
  ) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          receipts.add(command.commandId as unknown as string);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.fromPubSub(events),
      subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
    } satisfies OrchestrationEngineShape;
    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.map(Ref.get(threadsRef), (threads) => ({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads,
          updatedAt: now,
        })),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () => Effect.succeed(freshness()),
      getInFlightToolByThreadId: () => Effect.succeed(null),
    } as unknown as ProjectionSnapshotQueryShape;
    const receiptRepo = {
      upsert: () => Effect.void,
      getByCommandId: ({ commandId }: { commandId: unknown }) =>
        Effect.succeed(
          receipts.has(commandId as string)
            ? Option.some({ status: "accepted" } as never)
            : Option.none(),
        ),
    };
    return Layer.mergeAll(
      Layer.succeed(OrchestrationEngineService, engine),
      Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
      Layer.succeed(OrchestrationCommandReceiptRepository, receiptRepo as never),
      WorktreeProvisionerStub,
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-delta-" }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
  };

  const parentWakes = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
    dispatched.filter(
      (c): c is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        c.type === "thread.turn.start" && c.threadId === PARENT_ID,
    );
  const freshAt = (maxCreatedAt: string) => () => ({
    maxCreatedAt,
    heartbeatAt: null,
  });

  effectIt.effect(
    "terminal deltas are withheld while a sibling runs, then flushed as ONE quiet-workstream digest",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          const receipts = new Set<string>();
          const events = yield* PubSub.unbounded<OrchestrationEvent>();
          const threadsRef = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([
            parent,
            shell({
              id: A as unknown as string,
              parentThreadId: PARENT_ID,
              planLane: "done",
              spawnGeneration: "gen-1",
            }),
            shell({
              id: B as unknown as string,
              parentThreadId: PARENT_ID,
              planLane: "in_progress",
              spawnGeneration: "gen-1",
              session: null,
            }),
          ]);
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            // Pass 1: A is terminal but B still runs (workstream not quiet) and
            // A is fresh → the terminal delta is WITHHELD into the digest, no
            // wake and no reported-marker yet.
            expect(parentWakes(dispatched)).toHaveLength(0);
            expect(
              dispatched.some((c) => c.type === "thread.activity.append" && c.threadId === A),
            ).toBe(false);

            // B goes terminal too → the workstream is now quiet, so the digest
            // flushes immediately as ONE wake naming BOTH A and B.
            yield* Ref.update(threadsRef, (current) =>
              current.map((t) => (t.id === B ? { ...t, planLane: "done" as const } : t)),
            );
            yield* PubSub.publish(events, { type: "thread.plan-lane-set" } as OrchestrationEvent);
            yield* dispatcher.drain;
            const wakes = parentWakes(dispatched);
            expect(wakes).toHaveLength(1);
            expect(wakes[0]!.message.text).toContain(A);
            expect(wakes[0]!.message.text).toContain(B);
            // Both reported-markers were written on the flush.
            expect(
              dispatched.some((c) => c.type === "thread.activity.append" && c.threadId === A),
            ).toBe(true);
            expect(
              dispatched.some((c) => c.type === "thread.activity.append" && c.threadId === B),
            ).toBe(true);
          }).pipe(
            Effect.provide(
              WorkstreamDispatcherLive.pipe(
                Layer.provide(buildDeps(threadsRef, dispatched, receipts, events, freshAt(now))),
              ),
            ),
          );
        }),
      ),
  );

  effectIt.effect(
    "restart idempotency: a child already reported (marker receipt) is not re-delivered by a fresh process",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          const receipts = new Set<string>();
          const events = yield* PubSub.unbounded<OrchestrationEvent>();
          const threadsRef = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([
            parent,
            shell({
              id: A as unknown as string,
              parentThreadId: PARENT_ID,
              planLane: "done",
              spawnGeneration: "gen-1",
            }),
          ]);
          // Instance 1 delivers the wake + writes the durable marker receipt.
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            expect(parentWakes(dispatched)).toHaveLength(1);
          }).pipe(
            Effect.provide(
              WorkstreamDispatcherLive.pipe(
                Layer.provide(buildDeps(threadsRef, dispatched, receipts, events, freshAt(now))),
              ),
            ),
          );
          expect(receipts.has(childReportedCommandId(A, "gen-1"))).toBe(true);

          // Instance 2 = "after restart": fresh caches, SAME durable receipts.
          const dispatched2: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            // No re-delivery: the marker receipt is the durable truth.
            expect(parentWakes(dispatched2)).toHaveLength(0);
          }).pipe(
            Effect.provide(
              WorkstreamDispatcherLive.pipe(
                Layer.provide(buildDeps(threadsRef, dispatched2, receipts, events, freshAt(now))),
              ),
            ),
          );
        }),
      ),
  );

  effectIt.effect(
    "suppression by a prior idle wake; a child that ran again after IS reported",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<OrchestrationEvent>();
          const child = shell({
            id: A as unknown as string,
            parentThreadId: PARENT_ID,
            planLane: "done",
            spawnGeneration: "gen-1",
          });
          // Suppressed: the parent already got the idle wake at the child's
          // newest activity timestamp, and the child went terminal with no new
          // activity (still that same timestamp).
          const idleAtS = "2026-06-24T00:00:05.000Z";
          const dispatchedS: Array<OrchestrationCommand> = [];
          const receiptsS = new Set<string>([childWakeCommandId(A, `idle:${idleAtS}`)]);
          const refS = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([parent, child]);
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            expect(parentWakes(dispatchedS)).toHaveLength(0);
          }).pipe(
            Effect.provide(
              WorkstreamDispatcherLive.pipe(
                Layer.provide(buildDeps(refS, dispatchedS, receiptsS, events, freshAt(idleAtS))),
              ),
            ),
          );

          // Ran again: activity advanced to a newer timestamp, so the earlier
          // idle receipt no longer matches → the terminal child is news and IS
          // reported.
          const dispatchedR: Array<OrchestrationCommand> = [];
          const receiptsR = new Set<string>([childWakeCommandId(A, `idle:${idleAtS}`)]);
          const refR = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([parent, child]);
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            expect(parentWakes(dispatchedR)).toHaveLength(1);
          }).pipe(
            Effect.provide(
              WorkstreamDispatcherLive.pipe(
                Layer.provide(
                  buildDeps(
                    refR,
                    dispatchedR,
                    receiptsR,
                    events,
                    freshAt("2026-06-24T00:00:06.000Z"),
                  ),
                ),
              ),
            ),
          );
        }),
      ),
  );

  effectIt.effect(
    "a done isolated child with fan-in still pending is held back until it settles",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<OrchestrationEvent>();
          const dispatched: Array<OrchestrationCommand> = [];
          const receipts = new Set<string>();
          const refT = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([
            parent,
            shell({
              id: A as unknown as string,
              parentThreadId: PARENT_ID,
              planLane: "done",
              isolation: "isolated",
              fanInState: "none",
              spawnGeneration: "gen-1",
            }),
          ]);
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            // fan-in "none" → held back, no wake.
            expect(parentWakes(dispatched)).toHaveLength(0);
            // Fan-in settles → the child becomes reportable.
            yield* Ref.update(refT, (current) =>
              current.map((t) => (t.id === A ? { ...t, fanInState: "completed" as const } : t)),
            );
            yield* PubSub.publish(events, { type: "thread.fanin-set" } as OrchestrationEvent);
            yield* dispatcher.drain;
            expect(parentWakes(dispatched)).toHaveLength(1);
          }).pipe(
            Effect.provide(
              WorkstreamDispatcherLive.pipe(
                Layer.provide(buildDeps(refT, dispatched, receipts, events, freshAt(now))),
              ),
            ),
          );
        }),
      ),
  );

  effectIt.effect(
    "a conflicted-fan-in child is reportable with the reactor-consistent copy (no stale advice, no paths-less line)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<OrchestrationEvent>();
          const dispatched: Array<OrchestrationCommand> = [];
          const receipts = new Set<string>();
          const refC = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([
            parent,
            shell({
              id: A as unknown as string,
              parentThreadId: PARENT_ID,
              planLane: "done",
              isolation: "isolated",
              fanInState: "conflicted",
              spawnGeneration: "gen-1",
            }),
          ]);
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            const wakes = parentWakes(dispatched);
            expect(wakes).toHaveLength(1);
            const text = wakes[0]!.message.text;
            expect(text).toContain("Fan-in merge conflict");
            expect(text).toContain("control plane completes the fan-in");
            // No fabricated paths line and no stale re-open recovery advice that
            // contradicts the fan-in reactor's dedicated notice.
            expect(text).not.toContain("conflict paths not yet available");
            expect(text).not.toContain("Re-open this child");
            expect(text).not.toContain("resolve the conflicts manually");
          }).pipe(
            Effect.provide(
              WorkstreamDispatcherLive.pipe(
                Layer.provide(buildDeps(refC, dispatched, receipts, events, freshAt(now))),
              ),
            ),
          );
        }),
      ),
  );
});

// ---------------------------------------------------------------------------
// The :1109 poisoning class, pinned through the assembled layer. A parked error
// wake is SUPPRESSED locally (no receipt behind it). The old raw
// `handledChildWakes` set could not tell that apart from a real delivery, so the
// recovered rail had to consult the durable receipt directly (a comment-enforced
// discipline). The receipt-dedup module makes it structural: park →
// `markSuppressed`, and the recovered rail asks `wasDelivered` (delivered ∪
// receipt, never suppressed), so a parked-then-done child NEVER fires a spurious
// "recovered" wake.
// ---------------------------------------------------------------------------
describe("parked error wake never poisons the recovered rail (full dispatcher layer)", () => {
  const PARENT_ID = "parent-poison" as ThreadId;
  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });
  // The child whose error wake we force to be PARKED (suppressed, no receipt) by
  // exhausting the parent's per-window wake budget with sibling error wakes.
  const TARGET = "child-poison-target" as ThreadId;

  const errorChild = (id: string) =>
    shell({
      id,
      parentThreadId: PARENT_ID,
      planLane: "in_progress",
      spawnGeneration: "gen-1",
      attention: ["error"],
      session: runningSession({ threadId: id as ThreadId, status: "ready", activeTurnId: null }),
    });

  const buildDeps = (
    threadsRef: Ref.Ref<ReadonlyArray<OrchestrationThreadShell>>,
    dispatched: Array<OrchestrationCommand>,
    receipts: Set<string>,
  ) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          receipts.add(command.commandId as unknown as string);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as unknown as OrchestrationEngineShape;
    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.map(Ref.get(threadsRef), (threads) => ({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads,
          updatedAt: now,
        })),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: now, heartbeatAt: null }),
      getInFlightToolByThreadId: () => Effect.succeed(null),
    } as unknown as ProjectionSnapshotQueryShape;
    const receiptRepo = {
      upsert: () => Effect.void,
      getByCommandId: ({ commandId }: { commandId: unknown }) =>
        Effect.succeed(
          receipts.has(commandId as string)
            ? Option.some({ status: "accepted" } as never)
            : Option.none(),
        ),
    };
    return WorkstreamDispatcherLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receiptRepo as never),
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-poison-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  effectIt.effect(
    "a rate-guard-parked error wake (suppressed, no receipt) fires no recovered wake once the child reaches done",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          const receipts = new Set<string>();
          // Enough sibling error children to exhaust the per-window budget
          // (`maxInWindow`), then the target — the pass parks the one that trips
          // the guard. The target is ordered last so the budget is spent first.
          const siblings = Array.from({ length: DEFAULT_WAKE_RATE_GUARD.maxInWindow }, (_u, i) =>
            errorChild(`child-poison-sib-${i}`),
          );
          const threadsRef = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([
            parent,
            ...siblings,
            errorChild(TARGET as unknown as string),
          ]);
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;

            // The guard tripped: a park (needs_guidance raise on the parent)
            // fired, and NO error-wake receipt exists for the parked target.
            const parked = dispatched.some(
              (c) => c.type === "thread.attention.raise" && c.threadId === PARENT_ID,
            );
            expect(parked).toBe(true);
            expect(receipts.has(childWakeCommandId(TARGET, "error"))).toBe(false);

            // The target reaches `done` (its error was never durably delivered).
            yield* Ref.update(threadsRef, (current) =>
              current.map((t) =>
                t.id === TARGET ? { ...t, planLane: "done" as const, attention: [] } : t,
              ),
            );
            const before = dispatched.length;
            yield* dispatcher.drain;

            // No "recovered" wake — the parked (suppressed) error id is invisible
            // to `wasDelivered`, so the recovered rail correctly stays silent.
            const recoveredWakes = dispatched
              .slice(before)
              .filter(
                (c) => c.type === "thread.turn.start" && c.message.text.includes("recovered"),
              );
            expect(recoveredWakes).toHaveLength(0);
          }).pipe(Effect.provide(buildDeps(threadsRef, dispatched, receipts)));
        }),
      ),
  );
});

// ---------------------------------------------------------------------------
// Notice-coalescing acceptance (docs/design/workstream-notice-coalescing.md §7):
// the pair holdback + one combined wake, piggyback, age-flush, and the
// restart-mid-window recompute. A Ref-backed snapshot + PubSub re-arm mirror the
// delta-rail harness; receipts are a Set so a "restart" keeps durable markers
// while dropping the in-memory caches.
// ---------------------------------------------------------------------------
describe("notice-coalescing: gate-pair coalescing + digest tiering (full dispatcher layer)", () => {
  const PARENT_ID = "parent-nc" as ThreadId;
  const REVIEWER_ID = "reviewer-nc" as ThreadId;
  const CODER_ID = "coder-nc" as ThreadId;
  const SIB_ID = "sibling-nc" as ThreadId;
  const parent = shell({ id: PARENT_ID as unknown as string, parentThreadId: null, session: null });

  const gateRoutes = [
    { on: ["needs_rework"], kind: "loop", to: CODER_ID, maxRounds: 2 },
    { on: ["clean", "fixed_inline"], kind: "resolve" },
  ] as unknown as OrchestrationThreadShell["routes"];
  const resolveOutcome = {
    outcome: "clean",
    decision: "resolve",
    round: 0,
    recordedByEventId: "evt-nc-resolve",
    at: "2026-07-07T14:32:00.000Z",
  } as unknown as OrchestrationThreadShell["lastOutcome"];

  const buildDeps = (
    threadsRef: Ref.Ref<ReadonlyArray<OrchestrationThreadShell>>,
    dispatched: Array<OrchestrationCommand>,
    receipts: Set<string>,
    events: PubSub.PubSub<OrchestrationEvent>,
    prefix: string,
  ) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          receipts.add(command.commandId as unknown as string);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.fromPubSub(events),
      subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(events)),
    } satisfies OrchestrationEngineShape;
    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.map(Ref.get(threadsRef), (threads) => ({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads,
          updatedAt: now,
        })),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: now, heartbeatAt: null }),
      getInFlightToolByThreadId: () => Effect.succeed(null),
    } as unknown as ProjectionSnapshotQueryShape;
    const receiptRepo = {
      upsert: () => Effect.void,
      getByCommandId: ({ commandId }: { commandId: unknown }) =>
        Effect.succeed(
          receipts.has(commandId as string)
            ? Option.some({ status: "accepted" } as never)
            : Option.none(),
        ),
    };
    return Layer.mergeAll(
      Layer.succeed(OrchestrationEngineService, engine),
      Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
      Layer.succeed(OrchestrationCommandReceiptRepository, receiptRepo as never),
      WorktreeProvisionerStub,
      ServerConfig.layerTest(process.cwd(), { prefix }),
    ).pipe(Layer.provideMerge(NodeServices.layer));
  };

  const parentWakes = (dispatched: ReadonlyArray<OrchestrationCommand>) =>
    dispatched.filter(
      (c): c is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
        c.type === "thread.turn.start" && c.threadId === PARENT_ID,
    );

  const resolvedReviewer = () =>
    shell({
      id: REVIEWER_ID as unknown as string,
      parentThreadId: PARENT_ID,
      role: "reviewer",
      planLane: "done",
      isolation: "shared",
      routes: gateRoutes,
      lastOutcome: resolveOutcome,
      reportPath: "/nonexistent/reviewer-nc.md",
      spawnGeneration: "gen-nc",
    });
  const isolatedCoder = (fanInState: "none" | "completed") =>
    shell({
      id: CODER_ID as unknown as string,
      parentThreadId: PARENT_ID,
      role: "coder",
      planLane: "done",
      isolation: "isolated",
      fanInState,
      reportPath: "/nonexistent/coder-nc.md",
      spawnGeneration: "gen-nc",
    });

  effectIt.effect(
    "the headline: gate resolves clean with an isolated coder → no wake while fan-in pending, then ONE wake with the pair section on fanin-set",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          const receipts = new Set<string>();
          const events = yield* PubSub.unbounded<OrchestrationEvent>();
          const ref = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([
            parent,
            resolvedReviewer(),
            isolatedCoder("none"),
          ]);
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            // Fan-in pending → the reviewer is held for its counterpart, the
            // coder is fan-in-pending: NO wake at all.
            expect(parentWakes(dispatched)).toHaveLength(0);

            // Fan-in settles completed → both reportable in one batch; the
            // workstream is quiet → ONE wake carrying the combined pair section.
            yield* Ref.update(ref, (cur) =>
              cur.map((t) => (t.id === CODER_ID ? { ...t, fanInState: "completed" as const } : t)),
            );
            yield* PubSub.publish(events, { type: "thread.fanin-set" } as OrchestrationEvent);
            yield* dispatcher.drain;
            const wakes = parentWakes(dispatched);
            expect(wakes).toHaveLength(1);
            const text = wakes[0]!.message.text;
            expect(text).toContain("Gate resolved `clean`");
            expect(text).toContain("reviewer `reviewer-nc`");
            expect(text).toContain("coder `coder-nc`");
            expect(text).toContain("merged into yours");
            // No first-pass review owed on a gate-resolved batch.
            expect(text).toContain("No first-pass review is owed");
          }).pipe(
            Effect.provide(
              WorkstreamDispatcherLive.pipe(
                Layer.provide(buildDeps(ref, dispatched, receipts, events, "t3-nc-headline-")),
              ),
            ),
          );
        }),
      ),
  );

  effectIt.effect(
    "restart mid-window: a fresh process (empty caches, same receipts) recomputes the pending pair and flushes it once",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const receipts = new Set<string>();
          const events = yield* PubSub.unbounded<OrchestrationEvent>();
          const ref = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([
            parent,
            resolvedReviewer(),
            isolatedCoder("completed"),
          ]);
          // Instance 1 delivers the coalesced pair wake + writes the markers.
          const dispatched1: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            expect(parentWakes(dispatched1)).toHaveLength(1);
          }).pipe(
            Effect.provide(
              WorkstreamDispatcherLive.pipe(
                Layer.provide(buildDeps(ref, dispatched1, receipts, events, "t3-nc-restart-1-")),
              ),
            ),
          );
          expect(receipts.has(childReportedCommandId(REVIEWER_ID, "evt-nc-resolve"))).toBe(true);

          // Instance 2 = "after restart": fresh caches, SAME durable receipts →
          // the pending pair is recomputed but already-markered, so NO
          // re-delivery.
          const dispatched2: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            expect(parentWakes(dispatched2)).toHaveLength(0);
          }).pipe(
            Effect.provide(
              WorkstreamDispatcherLive.pipe(
                Layer.provide(buildDeps(ref, dispatched2, receipts, events, "t3-nc-restart-2-")),
              ),
            ),
          );
        }),
      ),
  );

  effectIt.effect(
    "age flush: a withheld terminal delta flushes standalone once past the window while a sibling still runs",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          const receipts = new Set<string>();
          const events = yield* PubSub.unbounded<OrchestrationEvent>();
          const doneSibling = shell({
            id: SIB_ID as unknown as string,
            parentThreadId: PARENT_ID,
            role: "researcher",
            planLane: "done",
            spawnGeneration: "gen-nc",
            reportPath: "/nonexistent/sibling-nc.md",
            // Durable event time at epoch (TestClock starts at t=0) so the item's
            // age crosses the flush window as the clock advances.
            updatedAt: "1970-01-01T00:00:00.000Z",
          });
          const runningChild = shell({
            id: CODER_ID as unknown as string,
            parentThreadId: PARENT_ID,
            role: "coder",
            planLane: "in_progress",
            spawnGeneration: "gen-nc",
            session: runningSession({
              threadId: CODER_ID,
              status: "running",
              activeTurnId: "turn-nc" as TurnId,
            }),
          });
          const ref = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([
            parent,
            doneSibling,
            runningChild,
          ]);
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            // t=0: fresh item, sibling running (not quiet) → withheld, no wake.
            yield* dispatcher.drain;
            expect(parentWakes(dispatched)).toHaveLength(0);
            // Advance past the flush window and re-pass → standalone digest.
            yield* TestClock.adjust(Duration.millis(FYI_DIGEST_FLUSH_MS + 1000));
            yield* dispatcher.drain;
            const wakes = parentWakes(dispatched);
            expect(wakes).toHaveLength(1);
            expect(wakes[0]!.message.text).toContain("FYI digest");
            expect(wakes[0]!.message.text).toContain(SIB_ID);
          }).pipe(
            Effect.provide(
              WorkstreamDispatcherLive.pipe(
                Layer.provide(buildDeps(ref, dispatched, receipts, events, "t3-nc-age-")),
              ),
            ),
          );
        }),
      ),
  );

  // Piggyback: an action-required wake (idle backstop) for the parent carries
  // the pending FYI digest (a plain terminal completion) appended after its
  // action copy, and writes the digest item's marker on delivery.
  effectIt.effect(
    "an idle-backstop action wake piggybacks the pending terminal-delta digest (action first, FYI after)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          const receipts = new Set<string>();
          const events = yield* PubSub.unbounded<OrchestrationEvent>();
          // A plain done sibling (FYI, withheld) + an idle child (action wake)
          // while another child still runs so the workstream is NOT quiet.
          const doneSibling = shell({
            id: SIB_ID as unknown as string,
            parentThreadId: PARENT_ID,
            role: "researcher",
            planLane: "done",
            spawnGeneration: "gen-nc",
            reportPath: "/nonexistent/sibling-nc.md",
          });
          // An error-flagged child is an action-required wake (immediate, no
          // grace) and keeps the workstream non-quiet so the sibling's terminal
          // delta stays withheld and must piggyback.
          const errorChild = shell({
            id: CODER_ID as unknown as string,
            parentThreadId: PARENT_ID,
            role: "coder",
            planLane: "in_progress",
            spawnGeneration: "gen-nc",
            attention: ["error"],
            session: runningSession({
              threadId: CODER_ID,
              status: "ready",
              activeTurnId: null,
            }),
            reportPath: "/nonexistent/coder-nc.md",
          });
          const ref = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([
            parent,
            doneSibling,
            errorChild,
          ]);
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            const wakes = parentWakes(dispatched);
            // One wake: the idle-backstop action wake, carrying the piggybacked
            // digest section for the done sibling.
            expect(wakes).toHaveLength(1);
            const text = wakes[0]!.message.text;
            // Action copy leads.
            expect(text).toContain("raised an `error` attention flag");
            // FYI digest rides after the separator.
            expect(text).toContain("Also, FYI since you last heard");
            expect(text).toContain(SIB_ID);
            const actionIdx = text.indexOf("raised an `error` attention flag");
            const fyiIdx = text.indexOf("Also, FYI since you last heard");
            expect(actionIdx).toBeLessThan(fyiIdx);
            // The sibling's reported-marker was written on delivery.
            expect(
              dispatched.some((c) => c.type === "thread.activity.append" && c.threadId === SIB_ID),
            ).toBe(true);
            // Budget: the piggyback rides the action wake's SINGLE charge — the
            // whole notice is exactly one parent turn.start, not two.
            expect(wakes).toHaveLength(1);
          }).pipe(
            Effect.provide(
              WorkstreamDispatcherLive.pipe(
                Layer.provide(buildDeps(ref, dispatched, receipts, events, "t3-nc-piggyback-")),
              ),
            ),
          );
        }),
      ),
  );

  // Crash between the digest wake and its markers (design §6.1 / §4.3): the wake
  // was delivered but the per-item `child-reported` markers never landed. On the
  // next pass the item is still pending (no marker receipt) and is re-delivered
  // — a duplicate mention, never a loss. Simulated by dropping the marker
  // receipt the first flush wrote, mirroring a crash before the marker commit.
  effectIt.effect(
    "crash between the digest wake and its markers re-delivers on the next pass (duplicate, never loss)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          const receipts = new Set<string>();
          const events = yield* PubSub.unbounded<OrchestrationEvent>();
          const doneChild = shell({
            id: CODER_ID as unknown as string,
            parentThreadId: PARENT_ID,
            role: "coder",
            planLane: "done",
            spawnGeneration: "gen-nc",
            reportPath: "/nonexistent/coder-nc.md",
          });
          const ref = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([parent, doneChild]);
          const marker = childReportedCommandId(CODER_ID, "gen-nc");
          // Instance 1 delivers the digest wake and writes the marker.
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            expect(parentWakes(dispatched)).toHaveLength(1);
            expect(receipts.has(marker)).toBe(true);
          }).pipe(
            Effect.provide(
              WorkstreamDispatcherLive.pipe(
                Layer.provide(buildDeps(ref, dispatched, receipts, events, "t3-nc-crash-1-")),
              ),
            ),
          );
          // Simulate a CRASH after the wake but before the marker commit landed:
          // drop the marker receipt. Instance 2 = a fresh process (empty caches)
          // finds no durable marker and re-delivers — a duplicate, never a loss.
          receipts.delete(marker);
          const dispatched2: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            expect(parentWakes(dispatched2)).toHaveLength(1);
            // The marker is written again on the re-delivery.
            expect(receipts.has(marker)).toBe(true);
          }).pipe(
            Effect.provide(
              WorkstreamDispatcherLive.pipe(
                Layer.provide(buildDeps(ref, dispatched2, receipts, events, "t3-nc-crash-2-")),
              ),
            ),
          );
        }),
      ),
  );

  // Gate + conflicted fan-in (design §4.1/§7): a cleanly resolved pair whose
  // isolated coder's fan-in CONFLICTED is settled-for-wake, so the pair reports
  // together carrying the conflict block — while the fan-in reactor's own
  // conflict wake remains a separate, immediate rail (not exercised here).
  effectIt.effect(
    "a resolved gate pair with a conflicted-fan-in target delivers as ONE pair item with the conflict block",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          const receipts = new Set<string>();
          const events = yield* PubSub.unbounded<OrchestrationEvent>();
          const ref = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([
            parent,
            resolvedReviewer(),
            {
              ...isolatedCoder("none"),
              fanInState: "conflicted" as const,
            } as OrchestrationThreadShell,
          ]);
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
            const wakes = parentWakes(dispatched);
            expect(wakes).toHaveLength(1);
            const text = wakes[0]!.message.text;
            expect(text).toContain("Gate resolved `clean`");
            expect(text).toContain("coder `coder-nc`");
            // Conflict block present; no false "merged into yours" clause.
            expect(text).toContain("CONFLICTED");
            expect(text).toContain("Fan-in merge conflict");
            expect(text).not.toContain("merged into yours");
          }).pipe(
            Effect.provide(
              WorkstreamDispatcherLive.pipe(
                Layer.provide(buildDeps(ref, dispatched, receipts, events, "t3-nc-conflict-")),
              ),
            ),
          );
        }),
      ),
  );

  // Wake-rate budget (design §4.3/§6): a standalone digest flush charges the
  // per-parent budget, so a spin of standalone flushes trips the guard and parks
  // exactly like any other rail. Drives one fresh quiet-workstream flush per
  // pass; after `maxInWindow` charged flushes the next parks (needs_guidance +
  // no wake) — which can only happen if each flush charged the budget.
  effectIt.effect(
    "standalone digest flushes each charge the parent's wake-rate budget (the guard trips + parks after maxInWindow)",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const dispatched: Array<OrchestrationCommand> = [];
          const receipts = new Set<string>();
          const events = yield* PubSub.unbounded<OrchestrationEvent>();
          const ref = yield* Ref.make<ReadonlyArray<OrchestrationThreadShell>>([parent]);
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            // Each pass adds ONE fresh done child (its own episode) to a quiet
            // workstream → one standalone flush = one budget charge per pass.
            for (let i = 0; i < DEFAULT_WAKE_RATE_GUARD.maxInWindow; i++) {
              yield* Ref.update(ref, (cur) => [
                ...cur,
                shell({
                  id: `nc-budget-${i}`,
                  parentThreadId: PARENT_ID,
                  role: "researcher",
                  planLane: "done",
                  spawnGeneration: `gen-budget-${i}`,
                  reportPath: `/nonexistent/nc-budget-${i}.md`,
                }),
              ]);
              yield* PubSub.publish(events, {
                type: "thread.plan-lane-set",
              } as OrchestrationEvent);
              yield* dispatcher.drain;
            }
            // maxInWindow flushes delivered, each charging once.
            expect(parentWakes(dispatched)).toHaveLength(DEFAULT_WAKE_RATE_GUARD.maxInWindow);
            expect(dispatched.some((c) => c.type === "thread.attention.raise")).toBe(false);
            // One more fresh item → the budget is at cap, so the flush PARKS.
            const before = dispatched.length;
            yield* Ref.update(ref, (cur) => [
              ...cur,
              shell({
                id: "nc-budget-over",
                parentThreadId: PARENT_ID,
                role: "researcher",
                planLane: "done",
                spawnGeneration: "gen-budget-over",
                reportPath: "/nonexistent/nc-budget-over.md",
              }),
            ]);
            yield* PubSub.publish(events, { type: "thread.plan-lane-set" } as OrchestrationEvent);
            yield* dispatcher.drain;
            const after = dispatched.slice(before);
            expect(after.some((c) => c.type === "thread.attention.raise")).toBe(true);
            expect(
              after.filter((c) => c.type === "thread.turn.start" && c.threadId === PARENT_ID),
            ).toHaveLength(0);
          }).pipe(
            Effect.provide(
              WorkstreamDispatcherLive.pipe(
                Layer.provide(buildDeps(ref, dispatched, receipts, events, "t3-nc-budget-")),
              ),
            ),
          );
        }),
      ),
  );
});

// Scaffold-first graph authoring (scaffold plan §1/§2): the dispatcher gates a
// child's first launch on BOTH deps AND a brief, reads the brief from disk at
// kickoff (honouring pre-launch edits), parks on a read failure, and wakes the
// parent with one batched notice for every simultaneously-eligible unbriefed
// child. Exercised through the assembled dispatcher layer.
describe("brief gate + read-at-kickoff + brief-needed wake (full dispatcher layer)", () => {
  const PARENT_ID = "parent-scaffold" as ThreadId;

  const buildLayer = (
    dispatched: Array<OrchestrationCommand>,
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ) => {
    const engine = {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as unknown as OrchestrationEngineShape;

    const snapshotQuery = {
      getShellSnapshot: () =>
        Effect.succeed({
          snapshotSequence: 1,
          goals: [],
          projects: [],
          threads,
          updatedAt: now,
        } satisfies OrchestrationShellSnapshot),
      getPendingTurnStartThreadIds: () => Effect.succeed(new Set<ThreadId>()),
      getActivityFreshnessByThreadId: () =>
        Effect.succeed({ maxCreatedAt: now, heartbeatAt: null }),
    } as unknown as ProjectionSnapshotQueryShape;

    const receipts = {
      upsert: () => Effect.void,
      getByCommandId: () => Effect.succeed(Option.none()),
    };

    return WorkstreamDispatcherLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(OrchestrationEngineService, engine),
          Layer.succeed(ProjectionSnapshotQuery, snapshotQuery),
          Layer.succeed(OrchestrationCommandReceiptRepository, receipts as never),
          WorktreeProvisionerStub,
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-workstream-scaffold-" }),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  };

  const rootParent = shell({
    id: PARENT_ID as unknown as string,
    parentThreadId: null,
    session: null,
  });

  effectIt.effect("reads the brief file at kickoff and feeds its CURRENT content", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectory({ prefix: "t3-brief-read-" });
        const briefPath = path.join(dir, "child.md");
        yield* fs.writeFileString(briefPath, "THE FULL SELF-CONTAINED KICKOFF BRIEF");
        const child = shell({
          id: "child-briefed",
          parentThreadId: PARENT_ID,
          kickoffBriefPath: briefPath,
        });
        const dispatched: Array<OrchestrationCommand> = [];
        yield* Effect.gen(function* () {
          const dispatcher = yield* WorkstreamDispatcher;
          yield* dispatcher.start();
          yield* dispatcher.drain;
        }).pipe(Effect.provide(buildLayer(dispatched, [rootParent, child])));

        const kickoff = dispatched.find(
          (c): c is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
            c.type === "thread.turn.start" && c.threadId === ("child-briefed" as ThreadId),
        );
        expect(kickoff).toBeDefined();
        expect(kickoff!.message.origin).toBe("kickoff");
        expect(kickoff!.message.text).toContain("THE FULL SELF-CONTAINED KICKOFF BRIEF");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  effectIt.effect("parks the node (needs_guidance) when the brief file cannot be read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const child = shell({
          id: "child-unreadable",
          parentThreadId: PARENT_ID,
          kickoffBriefPath: "/nonexistent-dir/does-not-exist.md",
        });
        const dispatched: Array<OrchestrationCommand> = [];
        yield* Effect.gen(function* () {
          const dispatcher = yield* WorkstreamDispatcher;
          yield* dispatcher.start();
          yield* dispatcher.drain;
        }).pipe(Effect.provide(buildLayer(dispatched, [rootParent, child])));

        // No kickoff turn was started for the un-launchable child…
        expect(
          dispatched.filter(
            (c) =>
              c.type === "thread.turn.start" && c.threadId === ("child-unreadable" as ThreadId),
          ),
        ).toHaveLength(0);
        // …instead it was parked with needs_guidance.
        const park = dispatched.find(
          (c): c is Extract<OrchestrationCommand, { type: "thread.attention.raise" }> =>
            c.type === "thread.attention.raise" && c.threadId === ("child-unreadable" as ThreadId),
        );
        expect(park).toBeDefined();
        expect(park!.reason).toBe("needs_guidance");
        expect(park!.commandId).toContain("brief-read-failed");
      }),
    ),
  );

  effectIt.effect(
    "wakes the idle parent with ONE batched brief-needed notice naming every eligible unbriefed child",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const childA = shell({
            id: "child-a",
            parentThreadId: PARENT_ID,
            graphKey: "api",
            title: "Dedup endpoint",
            kickoffBriefPath: null,
          });
          const childB = shell({
            id: "child-b",
            parentThreadId: PARENT_ID,
            graphKey: "review",
            title: "Review the endpoint",
            kickoffBriefPath: null,
          });
          const dispatched: Array<OrchestrationCommand> = [];
          yield* Effect.gen(function* () {
            const dispatcher = yield* WorkstreamDispatcher;
            yield* dispatcher.start();
            yield* dispatcher.drain;
          }).pipe(Effect.provide(buildLayer(dispatched, [rootParent, childA, childB])));

          // Exactly one notice to the parent, naming BOTH children, and NO
          // kickoff for either unbriefed child.
          const notices = dispatched.filter(
            (c): c is Extract<OrchestrationCommand, { type: "thread.turn.start" }> =>
              c.type === "thread.turn.start" && c.threadId === PARENT_ID,
          );
          expect(notices).toHaveLength(1);
          expect(notices[0]!.message.origin).toBe("control_notice");
          expect(notices[0]!.message.text).toContain("workstream_brief");
          expect(notices[0]!.message.text).toContain("`api`");
          expect(notices[0]!.message.text).toContain("`review`");
          expect(
            dispatched.filter(
              (c) =>
                c.type === "thread.turn.start" &&
                (c.threadId === ("child-a" as ThreadId) || c.threadId === ("child-b" as ThreadId)),
            ),
          ).toHaveLength(0);
          // One durable per-child receipt marker written after delivery.
          const markers = dispatched.filter(
            (c) =>
              c.type === "thread.activity.append" && c.activity.kind === "workstream.brief-needed",
          );
          expect(markers).toHaveLength(2);
        }),
      ),
  );
});
