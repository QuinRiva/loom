import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";
import {
  ProviderLaunchClaims,
  ProviderLaunchClaimsLive,
} from "../provider/Services/ProviderLaunchClaims.ts";
import { markKickoffDelivered } from "./workstreamLaunchIdentity.ts";
import {
  isRecoveryResumable,
  resolveStuckLaunchResumeText,
  type StuckLaunchThread,
} from "./stuckLaunchRecovery.ts";

describe("isRecoveryResumable", () => {
  const resumable = {
    attentionCount: 0,
    parkedOnHuman: false,
    archived: false,
    deleted: false,
    cancelled: false,
  };

  it("resumes an ordinary active thread", () => {
    expect(isRecoveryResumable(resumable)).toBe(true);
  });

  // Each exclusion is a case where a resume would do harm rather than good: it
  // would clear a human-facing wait / an existing flag, or revive work that was
  // deliberately hidden or abandoned.
  for (const [label, override] of [
    ["attention is already raised", { attentionCount: 1 }],
    ["parked on a human", { parkedOnHuman: true }],
    ["archived", { archived: true }],
    ["soft-deleted", { deleted: true }],
    ["cancelled", { cancelled: true }],
  ] as const) {
    it(`withholds the resume when the thread is ${label}`, () => {
      expect(isRecoveryResumable({ ...resumable, ...override })).toBe(false);
    });
  }
});

// The highest-consequence branch in the recovery: getting this wrong either
// drops a child's brief entirely ("continue from where you left off" when
// nothing was ever started) or re-prepends a brief the transcript already has.
describe("resolveStuckLaunchResumeText", () => {
  const THREAD_ID = "thread-stuck-launch-resume" as ThreadId;
  const thread = (overrides: Partial<StuckLaunchThread> = {}): StuckLaunchThread =>
    ({
      id: THREAD_ID,
      title: "Wedged child",
      role: "coder",
      kickoffBriefPath: null,
      runtimeMode: "full-access",
      interactionMode: "default",
      ...overrides,
    }) as OrchestrationThreadShell;

  const withTempDirs = <A>(
    body: (dirs: {
      readonly launchIdentityDir: string;
      readonly briefPath: string;
    }) => Effect.Effect<A, never, FileSystem.FileSystem>,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const launchIdentityDir = yield* fs.makeTempDirectoryScoped();
      const briefPath = `${launchIdentityDir}/brief.md`;
      yield* fs.writeFileString(briefPath, "THE ORIGINAL KICKOFF BRIEF");
      return yield* body({ launchIdentityDir, briefPath });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), Effect.orDie);

  effectIt.effect("re-delivers the composed kickoff when the marker is ABSENT", () =>
    withTempDirs(({ launchIdentityDir, briefPath }) =>
      Effect.gen(function* () {
        // No marker ⇒ pi never accepted the prompt ⇒ nothing was started, so the
        // brief must be sent rather than a "continue" the child cannot act on.
        const text = yield* resolveStuckLaunchResumeText({
          thread: thread({ kickoffBriefPath: briefPath }),
          launchIdentityDir,
          providerName: "pi",
        });
        expect(text).toContain("never delivered");
        expect(text).toContain("THE ORIGINAL KICKOFF BRIEF");
      }),
    ),
  );

  effectIt.effect("sends the neutral continue notice when the marker is PRESENT", () =>
    withTempDirs(({ launchIdentityDir, briefPath }) =>
      Effect.gen(function* () {
        markKickoffDelivered(launchIdentityDir, THREAD_ID);
        const text = yield* resolveStuckLaunchResumeText({
          thread: thread({ kickoffBriefPath: briefPath }),
          launchIdentityDir,
          providerName: "pi",
        });
        expect(text).toContain("Resume from where you left off");
        expect(text).not.toContain("THE ORIGINAL KICKOFF BRIEF");
      }),
    ),
  );

  effectIt.effect("falls back to the continue notice when the brief file is missing", () =>
    withTempDirs(({ launchIdentityDir }) =>
      Effect.gen(function* () {
        const text = yield* resolveStuckLaunchResumeText({
          thread: thread({ kickoffBriefPath: `${launchIdentityDir}/does-not-exist.md` }),
          launchIdentityDir,
          providerName: "pi",
        });
        expect(text).toContain("Resume from where you left off");
      }),
    ),
  );

  // Provider-capability gate: only pi writes the kickoff-delivered marker, so for
  // every other driver ABSENCE proves nothing and must not trigger replay.
  // Re-sending a brief to an agent that already acted on it can duplicate real
  // work; the neutral notice is merely unhelpful. So replay needs positive
  // capability evidence.
  for (const providerName of ["claudeAgent", "codex", "openCode", "cursor", "grok"] as const) {
    effectIt.effect(
      `does NOT replay the kickoff for ${providerName} (marker is pi-only, absence proves nothing)`,
      () =>
        withTempDirs(({ launchIdentityDir, briefPath }) =>
          Effect.gen(function* () {
            // Marker deliberately absent — exactly the state a delivered-but-
            // lifecycle-lost non-pi child is in.
            const text = yield* resolveStuckLaunchResumeText({
              thread: thread({ kickoffBriefPath: briefPath }),
              launchIdentityDir,
              providerName,
            });
            expect(text).toContain("Resume from where you left off");
            expect(text).not.toContain("THE ORIGINAL KICKOFF BRIEF");
          }),
        ),
    );
  }

  effectIt.effect("does NOT replay the kickoff when the provider is unknown (fail safe)", () =>
    withTempDirs(({ launchIdentityDir, briefPath }) =>
      Effect.gen(function* () {
        const text = yield* resolveStuckLaunchResumeText({
          thread: thread({ kickoffBriefPath: briefPath }),
          launchIdentityDir,
          providerName: null,
        });
        expect(text).toContain("Resume from where you left off");
        expect(text).not.toContain("THE ORIGINAL KICKOFF BRIEF");
      }),
    ),
  );

  effectIt.effect("falls back to the continue notice for a thread with no brief at all", () =>
    withTempDirs(({ launchIdentityDir }) =>
      Effect.gen(function* () {
        // A root/handoff thread has no kickoff brief to recompose.
        const text = yield* resolveStuckLaunchResumeText({
          thread: thread({ kickoffBriefPath: null, role: null }),
          launchIdentityDir,
          providerName: "pi",
        });
        expect(text).toContain("Resume from where you left off");
      }),
    ),
  );
});

// ─── The compare-and-swap, against the REAL decider ──────────────────────────
// These bypass every stub: they run the actual `decideOrchestrationCommand` over
// a real projected read model, so they prove the precondition that makes the
// double-launch impossible rather than a test double's imitation of it.
describe("thread.stuck-launch.recover CAS (real decider)", () => {
  const t = "2026-06-24T00:00:00.000Z";
  const PROJECT = ProjectId.make("project-cas");
  const THREAD = "thread-cas" as ThreadId;

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

  const eventBase = (id: string) => ({
    eventId: EventId.make(id),
    occurredAt: t,
    commandId: CommandId.make(`cmd-${id}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-${id}`),
    metadata: {},
  });

  /** A read model with one thread whose session sits in the given state. */
  const modelWithSession = (session: {
    readonly status: string;
    readonly activeTurnId: string | null;
    readonly updatedAt: string;
  }) =>
    Effect.gen(function* () {
      let model = createEmptyReadModel(t);
      model = yield* applyEvents(
        model,
        [
          {
            ...eventBase("evt-project-cas"),
            aggregateKind: "project",
            aggregateId: PROJECT,
            type: "project.created",
            payload: {
              projectId: PROJECT,
              title: "Project",
              workspaceRoot: "/tmp/project-cas",
              defaultModelSelection: null,
              defaultStartFromOrigin: null,
              scripts: [],
              createdAt: t,
              updatedAt: t,
            },
          } as unknown as Omit<OrchestrationEvent, "sequence">,
          {
            ...eventBase(`evt-${THREAD}`),
            aggregateKind: "thread",
            aggregateId: THREAD,
            type: "thread.created",
            payload: {
              threadId: THREAD,
              projectId: PROJECT,
              parentThreadId: "parent-cas" as ThreadId,
              role: "coder",
              purpose: "do the thing",
              planLane: "in_progress",
              title: "Wedged child",
              modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "pi-model" },
              interactionMode: "default",
              runtimeMode: "full-access",
              branch: null,
              worktreePath: null,
              createdAt: t,
              updatedAt: t,
            },
          } as unknown as Omit<OrchestrationEvent, "sequence">,
        ],
        1,
      );
      return yield* applyEvents(
        model,
        [
          {
            ...eventBase("evt-session-cas"),
            aggregateKind: "thread",
            aggregateId: THREAD,
            type: "thread.session-set",
            payload: {
              threadId: THREAD,
              session: {
                threadId: THREAD,
                providerName: "pi",
                providerInstanceId: ProviderInstanceId.make("pi"),
                runtimeMode: "full-access",
                lastError: null,
                queuedMessages: { steering: [], followUp: [] },
                ...session,
              },
            },
          } as unknown as Omit<OrchestrationEvent, "sequence">,
        ],
        10,
      );
    });

  const recoverCommand = (
    expectedSessionUpdatedAt: string,
    expectedLatestUserMessageAt: string | null = null,
  ) =>
    ({
      type: "thread.stuck-launch.recover",
      commandId: CommandId.make("server:stuck-launch-recover:sweep:thread-cas:1"),
      threadId: THREAD,
      expectedSessionUpdatedAt,
      expectedLatestUserMessageAt,
      session: {
        threadId: THREAD,
        status: "ready",
        providerName: "pi",
        providerInstanceId: ProviderInstanceId.make("pi"),
        runtimeMode: "full-access",
        activeTurnId: null,
        lastError: null,
        queuedMessages: { steering: [], followUp: [] },
        updatedAt: t,
      },
      clearPendingTurnStart: true,
      detail: "test repair",
      createdAt: t,
    }) as unknown as OrchestrationCommand;

  const WEDGED = { status: "starting", activeTurnId: null, updatedAt: t };

  effectIt.effect("applies the repair when the observed session state still holds", () =>
    Effect.gen(function* () {
      const readModel = yield* modelWithSession(WEDGED);
      const decided = yield* decideOrchestrationCommand({
        command: recoverCommand(t),
        readModel,
      }).pipe(Effect.provide(NodeServices.layer));
      const events = Array.isArray(decided) ? decided : [decided];
      // Both writes in ONE transaction: clear the pending row, then reset.
      expect(events.map((e) => e.type)).toEqual(["thread.turn-start-failed", "thread.session-set"]);
    }),
  );

  effectIt.effect("REFUSES the repair when the session moved on (the CAS token changed)", () =>
    Effect.gen(function* () {
      // A real turn-start re-stamped the session row after we sampled it. Nothing
      // may be emitted — not even the pending-row clear.
      const readModel = yield* modelWithSession({
        ...WEDGED,
        updatedAt: "2026-06-24T00:05:00.000Z",
      });
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({ command: recoverCommand(t), readModel }).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  effectIt.effect("REFUSES the repair once the session reached a confirmed turn", () =>
    Effect.gen(function* () {
      const readModel = yield* modelWithSession({
        status: "running",
        activeTurnId: "turn-live",
        updatedAt: t,
      });
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({ command: recoverCommand(t), readModel }).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  effectIt.effect("REFUSES to act as a general force-session-to-ready primitive", () =>
    Effect.gen(function* () {
      // Same CAS token, but the session is not wedged mid-launch. The wedge shape
      // is re-asserted so this command can only ever repair its intended state.
      const readModel = yield* modelWithSession({
        status: "ready",
        activeTurnId: null,
        updatedAt: t,
      });
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({ command: recoverCommand(t), readModel }).pipe(
          Effect.provide(NodeServices.layer),
        ),
      );
      expect(exit._tag).toBe("Failure");
    }),
  );

  // The round-2 boundary, against the REAL decider. A genuine `thread.turn.start`
  // commits `thread.message-sent` + `thread.turn-start-requested` and NO session
  // event; the `starting` restamp arrives later from ProviderCommandReactor. So we
  // append a real user message and leave the session byte-identical: the session
  // token still matches, and only the second token can catch this.
  effectIt.effect(
    "REFUSES the repair when a user message landed but the session is unchanged",
    () =>
      Effect.gen(function* () {
        let readModel = yield* modelWithSession(WEDGED);
        readModel = yield* applyEvents(
          readModel,
          [
            {
              ...eventBase("evt-raced-turn-start"),
              aggregateKind: "thread",
              aggregateId: THREAD,
              type: "thread.message-sent",
              payload: {
                threadId: THREAD,
                messageId: "msg-raced-in",
                role: "user",
                text: "a genuine prompt that raced in",
                turnId: null,
                streaming: false,
                createdAt: "2026-06-24T00:04:00.000Z",
                updatedAt: "2026-06-24T00:04:00.000Z",
              },
            } as unknown as Omit<OrchestrationEvent, "sequence">,
          ],
          20,
        );
        // Sanity: the session really is untouched, so a session-only CAS would pass.
        expect(readModel.threads[0]?.session?.updatedAt).toBe(t);

        const exit = yield* Effect.exit(
          // The recovery observed "no user message" when it judged the wedge.
          decideOrchestrationCommand({ command: recoverCommand(t, null), readModel }).pipe(
            Effect.provide(NodeServices.layer),
          ),
        );
        expect(exit._tag).toBe("Failure");
      }),
  );

  effectIt.effect("applies the repair when BOTH tokens still match", () =>
    Effect.gen(function* () {
      // Control for the test above: same wedge, no racing message, and the caller
      // correctly reports the observed user-message state.
      const readModel = yield* modelWithSession(WEDGED);
      const decided = yield* decideOrchestrationCommand({
        command: recoverCommand(t, null),
        readModel,
      }).pipe(Effect.provide(NodeServices.layer));
      const events = Array.isArray(decided) ? decided : [decided];
      expect(events.map((e) => e.type)).toEqual(["thread.turn-start-failed", "thread.session-set"]);
    }),
  );
});

// ─── The in-flight launch claim (round-3 finding) ─────────────────────────────
// The interleaving neither CAS token can see: the ORIGINAL turn-start is still
// blocked inside `providerService.startSession` — it has already written
// `session.starting` and its user message, and it writes NOTHING further (no
// session event, no runtime binding) until it resolves. So the sweep samples state
// that is quiet, current, and matches both tokens, with no binding to consult.
// Only an in-process claim held across the launch span distinguishes it.
describe("ProviderLaunchClaims (in-flight launch exclusion)", () => {
  const THREAD = "thread-in-flight" as ThreadId;

  effectIt.effect("reports a claim as held for the whole span and clears it after", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderLaunchClaims;
      const release = yield* Deferred.make<void>();
      expect(yield* claims.isClaimed(THREAD)).toBe(false);

      // Model the blocked `startSession`: a launch that does not resolve yet.
      const launch = yield* Effect.forkChild(claims.withClaim(THREAD, Deferred.await(release)));
      yield* Effect.yieldNow;
      // While it is in flight, recovery must see it as live.
      expect(yield* claims.isClaimed(THREAD)).toBe(true);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.await(launch);
      // Once the launch resolves the claim is gone, so a genuine later wedge is
      // still recoverable — the guard defers recovery, it does not disable it.
      expect(yield* claims.isClaimed(THREAD)).toBe(false);
    }).pipe(Effect.provide(ProviderLaunchClaimsLive)),
  );

  effectIt.effect("releases the claim even when the launch FAILS or is interrupted", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderLaunchClaims;
      // A failed launch must not leave the thread permanently unrecoverable.
      yield* Effect.exit(claims.withClaim(THREAD, Effect.fail("launch blew up")));
      expect(yield* claims.isClaimed(THREAD)).toBe(false);

      const started = yield* Deferred.make<void>();
      const fiber = yield* Effect.forkChild(
        claims.withClaim(
          THREAD,
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          }),
        ),
      );
      yield* Deferred.await(started);
      expect(yield* claims.isClaimed(THREAD)).toBe(true);
      yield* Fiber.interrupt(fiber);
      expect(yield* claims.isClaimed(THREAD)).toBe(false);
    }).pipe(Effect.provide(ProviderLaunchClaimsLive)),
  );

  effectIt.effect("ref-counts overlapping claims so the last holder clears it", () =>
    Effect.gen(function* () {
      const claims = yield* ProviderLaunchClaims;
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      // Two overlapping claims for one thread (the turn-start span and the
      // sendTurn it hands off to). Forked as SIBLINGS so neither is torn down by
      // the other finishing — what matters is that the count, not the first
      // release, decides when the thread stops looking live.
      const a = yield* Effect.forkChild(claims.withClaim(THREAD, Deferred.await(first)));
      const b = yield* Effect.forkChild(claims.withClaim(THREAD, Deferred.await(second)));
      yield* Effect.yieldNow;
      expect(yield* claims.isClaimed(THREAD)).toBe(true);

      // One holder released, one still in flight ⇒ STILL claimed.
      yield* Deferred.succeed(first, undefined);
      yield* Fiber.await(a);
      expect(yield* claims.isClaimed(THREAD)).toBe(true);

      yield* Deferred.succeed(second, undefined);
      yield* Fiber.await(b);
      expect(yield* claims.isClaimed(THREAD)).toBe(false);
    }).pipe(Effect.provide(ProviderLaunchClaimsLive)),
  );
});
