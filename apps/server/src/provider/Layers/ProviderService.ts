/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  ModelSelection,
  NonNegativeInt,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
  DEFAULT_USER_INPUT_RESOLVED_OUTCOME,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stream from "effect/Stream";

import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import { type ProviderAdapterError, ProviderValidationError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { WorkspaceLease, type WorkspaceHold } from "../../workspace/WorkspaceLease.ts";
const isModelSelection = Schema.is(ModelSelection);

/**
 * How long a released launch's `session.exited` may still be in flight before its
 * attribution token lapses (see `noteLaunchEnded`). Generous relative to the real
 * delay — drivers emit from a floating async block on process exit
 * (`PiDriver.ts:1854-1876`), i.e. microseconds to milliseconds — and bounded so a
 * driver that never emits cannot leave a token that swallows a later real exit.
 */
const STRAGGLER_EXIT_WINDOW = Duration.seconds(30);

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

function readPersistedModelSelection(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): ModelSelection | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw = "modelSelection" in runtimePayload ? runtimePayload.modelSelection : undefined;
  return isModelSelection(raw) ? raw : undefined;
}

function readPersistedCwd(
  runtimePayload: ProviderSessionDirectory.ProviderRuntimeBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService.AnalyticsService);
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const workspaceLease = yield* WorkspaceLease;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  // Workspace occupancy (plan §7). Adapters register a live child only AFTER
  // spawn, so an occupancy check that scraped them would miss a launch already
  // in flight — the exact gap in which a worktree got deleted from under a
  // starting pi process. Instead the lease is taken HERE, before
  // `adapter.startSession`, and released on exit or on a failed launch. A leaked
  // hold makes a worktree permanently immortal, so every path out of a start is
  // accounted for: failure/interrupt via `Effect.onExit` at the acquisition
  // site, and process death via the `session.exited` runtime event below.
  //
  // Holds are LAUNCH-scoped, not thread-scoped (round-1 review finding 2). A
  // restart on a model/instance/runtime-mode change re-launches into the SAME
  // cwd without `cwdChanged` (`ProviderCommandReactor.ts:751-757`), so one
  // thread legitimately has a superseded launch and a live launch on one
  // workspace. A thread-keyed release would let the superseded process's late
  // `session.exited` drop the LIVE launch's hold and expose a running process to
  // removal — the same hazard `PiDriver.replacedProcesses`
  // (`PiDriver.ts:1841-1851`) exists to prevent for session teardown. Each
  // launch therefore gets a unique holder token and releases only its own.
  let nextLaunchSeq = 0;
  interface LaunchHold {
    readonly hold: WorkspaceHold;
    readonly generation: number;
  }
  const currentLaunchHold = new Map<ThreadId, LaunchHold>();

  /**
   * Drop a specific launch's hold. Only clears the thread's current-launch
   * pointer if it still points at THIS launch, so a superseded launch releasing
   * can never disown its replacement.
   */
  const releaseLaunchHold = (threadId: ThreadId, launch: LaunchHold) =>
    Effect.suspend(() => {
      if (currentLaunchHold.get(threadId) === launch) currentLaunchHold.delete(threadId);
      return Effect.andThen(launch.hold.release, workspaceLease.releaseHolder(launch.hold.holder));
    });

  /**
   * Drop whichever launch currently holds this thread's workspace, whatever its
   * generation. Used by every path that ends a launch: a start superseding its
   * predecessor, a stop, a failed start, and shutdown.
   */
  const releaseCurrentLaunchHold = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const launch = currentLaunchHold.get(threadId);
      return launch === undefined ? Effect.void : releaseLaunchHold(threadId, launch);
    });

  /**
   * Hold the session's workspace across a start, keeping the hold only if the
   * start succeeds.
   *
   * The invariant, enforced structurally rather than by bookkeeping: **at most
   * one live hold per thread, and none once no process is live.** Acquiring a
   * new launch's hold releases the previous one, so a second hold for the same
   * thread cannot exist; a failed start releases its own.
   *
   * Note the acquire-before-release ordering below is deliberate on the restart
   * path: releasing first would open a window in which the workspace looks
   * unoccupied even though a process is (briefly) still there. Holding two at
   * once momentarily is safe — it can only over-protect — whereas holding none
   * is the deletion race this whole component exists to prevent.
   */
  const withWorkspaceHold = <A, E, R>(
    threadId: ThreadId,
    cwd: string | undefined,
    start: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    cwd === undefined
      ? start
      : Effect.gen(function* () {
          const previous = currentLaunchHold.get(threadId);
          const generation = nextLaunchSeq++;
          const acquired: LaunchHold = {
            hold: yield* workspaceLease.hold(cwd, `provider-session:${threadId}:${generation}`),
            generation,
          };
          currentLaunchHold.set(threadId, acquired);
          if (previous !== undefined) {
            // The superseded launch's process may still emit; record its generation
            // so that exit spends the token instead of the live launch's hold.
            yield* noteLaunchEnded(threadId, previous.generation);
            yield* releaseLaunchHold(threadId, previous);
          }
          return yield* start.pipe(
            // A failed start releases its own hold — and records a token, because
            // a start can fail AFTER spawning a process that will later emit
            // `session.exited`: `PiDriver.ts:2159-2162` stops the process when
            // `applyModelSelection` fails, which routes through the exit handler
            // (`:1850-1876`). Without the token that late exit would release a
            // RETRY's live hold. Same rule as every other path that ends a launch.
            Effect.onExit((exit) =>
              exit._tag === "Success"
                ? Effect.void
                : noteLaunchEnded(threadId, acquired.generation).pipe(
                    Effect.andThen(releaseLaunchHold(threadId, acquired)),
                  ),
            ),
          );
        });

  /**
   * Release on `session.exited`.
   *
   * A runtime event carries no launch identity (`ProviderRuntimeEventBase` has no
   * launch/generation field), so an arriving exit cannot be attributed to a
   * particular launch by inspecting it. An earlier round tried a per-thread "owed
   * exits" COUNTER, which provably cannot work: it must answer both "is an exit
   * still owed?" and "will an exit ever come?" with one number, and the release
   * paths need opposite answers. Guessing one way deletes a live worktree; the
   * other immortalises one.
   *
   * So the debt is IDENTIFIED: `endedLaunches` records, per thread, the GENERATION
   * of the launch whose hold we dropped while its process still owed an exit. An
   * arriving exit spends that token — it belongs to a known-dead launch and must
   * NOT touch the live one — and otherwise releases the live launch, the ordinary
   * death path.
   *
   * A token is recorded ONLY when an exit is genuinely owed, which is what keeps it
   * from leaking into a permanent hold. "Is one owed?" is answered by the adapter's
   * declared {@link ProviderAdapterCapabilities.emitsExitOnStop}, not guessed: a
   * silent stop records nothing, so there is no stale token for a later genuine
   * exit to be absorbed by. That distinction cannot be made at exit time (see the
   * capability's docs), so it is made at stop time, where it is statically known.
   *
   * Why generations and not liveness: `hasSession` cannot be the signal. PiDriver
   * keys sessions by THREAD and its exit handler deletes that entry
   * unconditionally (`PiDriver.ts:1850-1853`), so a superseded launch's exit
   * transiently reports no live session while its replacement is genuinely running.
   */
  const endedLaunches = new Map<ThreadId, number>();

  /**
   * Record that `generation`'s hold was dropped while its process still owed a
   * `session.exited`, replacing any earlier token for the thread: only the most
   * recently ended launch can still owe an in-flight exit.
   */
  const noteLaunchEnded = (threadId: ThreadId, generation: number) =>
    Effect.sync(() => endedLaunches.set(threadId, generation)).pipe(
      // Expire the token after the straggler window — a BOUNDED BACKSTOP, no longer
      // the primary guard.
      //
      // `emitsExitOnStop` now decides the stop path structurally, which is the case
      // that was actually broken (a silent stop's token absorbed the next launch's
      // genuine exit, leaking the hold with no recovery). But three record sites
      // remain where "an exit is owed" cannot be known for certain even in
      // principle, so a token can still be recorded and never redeemed:
      //   1. a restart superseding a LIVE launch — the orphaned process emits only
      //      when it eventually dies, which may be much later or never if it hangs;
      //   2. a start that failed BEFORE spawning (validation, disabled instance) —
      //      no process exists, so no exit is ever coming;
      //   3. `OpenCodeAdapter`, whose stop emits only when `stopOpenCodeContext`
      //      reports it actually stopped something (`:1679-1690`), so even
      //      `emitsExitOnStop: true` does not guarantee an event.
      // Distinguishing these at record time is not possible, so they are bounded in
      // time instead of guessed.
      //
      // A lapsed token is the safe direction: it degrades to "an exit releases the
      // live hold", and for a straggler arriving absurdly late the worst case is
      // releasing early — where the removers' structural predicates and the
      // exclusive lease still stand between that and a deletion. The failure it
      // prevents (a permanently leaked hold) has no backstop at all.
      Effect.andThen(
        Effect.forkDetach(
          Effect.sleep(STRAGGLER_EXIT_WINDOW).pipe(
            Effect.andThen(
              Effect.sync(() => {
                if (endedLaunches.get(threadId) === generation) endedLaunches.delete(threadId);
              }),
            ),
          ),
        ),
      ),
      Effect.asVoid,
    );

  const releaseWorkspaceHoldOnExit = (threadId: ThreadId) =>
    Effect.suspend(() => {
      // An exit releases the live launch only if that launch could plausibly be the
      // one that exited: it must have been established BEFORE any later launch
      // superseded it. `endedLaunches` records the newest generation whose hold we
      // dropped while its process might still emit; an exit arriving while the live
      // launch is NEWER than that token is a straggler from the dead predecessor and
      // must not touch the live hold.
      //
      // The token is consumed on that straggler, so it cannot linger to swallow a
      // later genuine exit. When a driver stops silently no straggler ever arrives,
      // and the token is instead discarded by the next launch that supersedes it
      // (see `withWorkspaceHold`), which is what keeps a silent stop from
      // immortalising the workspace.
      const endedGeneration = endedLaunches.get(threadId);
      const live = currentLaunchHold.get(threadId);
      if (
        endedGeneration !== undefined &&
        live !== undefined &&
        live.generation > endedGeneration
      ) {
        endedLaunches.delete(threadId);
        return Effect.void;
      }
      endedLaunches.delete(threadId);
      return releaseCurrentLaunchHold(threadId);
    });

  const prepareMcpSession = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) =>
    McpSessionRegistry.issueActiveMcpCredential({ threadId, providerInstanceId }).pipe(
      Effect.tap((credential) =>
        credential
          ? Effect.sync(() => McpProviderSession.setMcpProviderSession(credential.config))
          : Effect.void,
      ),
    );
  const clearMcpSession = (threadId: ThreadId) =>
    McpSessionRegistry.revokeActiveMcpThread(threadId).pipe(
      Effect.tap(() => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger
          ? canonicalEventLogger.write(canonicalEvent, canonicalEvent.threadId)
          : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  // Death-time reconciliation (plan §7.4). A driver deletes its in-memory entry
  // and emits `session.exited` when its process dies, but nothing used to
  // persist the stop: ten runtime rows were observed claiming `running` against
  // zero live processes. So the exit releases the lease AND marks the row
  // stopped in the same breath — without the release a crashed process would
  // make its worktree immortal, and without the row write the projections keep
  // lying about liveness until the next startup reconciliation.
  const reconcileExitedSession = (
    source: { readonly instanceId: ProviderInstanceId; readonly provider: ProviderDriverKind },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      yield* releaseWorkspaceHoldOnExit(event.threadId);
      yield* directory.upsert({
        threadId: event.threadId,
        provider: source.provider,
        providerInstanceId: source.instanceId,
        status: "stopped",
        runtimePayload: {
          activeTurnId: null,
          lastRuntimeEvent: "session.exited",
          lastRuntimeEventAt: yield* nowIso,
        },
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to reconcile exited provider session", {
          threadId: event.threadId,
          errorTag: causeErrorTag(cause),
        }),
      ),
    );

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.sync(() => correlateRuntimeEventWithInstance(source, event)).pipe(
      Effect.flatMap((canonicalEvent) =>
        increment(providerRuntimeEventsTotal, {
          provider: canonicalEvent.provider,
          eventType: canonicalEvent.type,
        }).pipe(
          Effect.andThen(
            canonicalEvent.type === "session.exited"
              ? reconcileExitedSession(source, canonicalEvent)
              : Effect.void,
          ),
          Effect.andThen(publishRuntimeEvent(canonicalEvent)),
        ),
      ),
    );

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          processRuntimeEvent(
            {
              instanceId: id,
              provider: adapter.provider,
            },
            event,
          ),
        ).pipe(Effect.forkScoped);
      }
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(bindingInstanceId);
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          yield* upsertSessionBinding(
            { ...existing, providerInstanceId: bindingInstanceId },
            input.binding.threadId,
          );
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          return { adapter, session: existing } as const;
        }
      }

      const persistedCwd = readPersistedCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedModelSelection(input.binding.runtimePayload);

      // A cursor is not the only shape resume state comes in. A `session-file`
      // driver (pi) owns a deterministic per-thread session on disk and
      // create-or-resumes it on every start, so disk — not a cursor — is the
      // source of truth for its resume; pi never produces a cursor at all, so
      // demanding one made every stopped pi thread permanently unrecoverable.
      // Ask the DRIVER whether resumable state exists rather than special-casing
      // a kind here; a cursor-only driver has no such answer and still fails.
      // The probe is handed the SAME cwd the resume below launches with, so a
      // driver whose resume state IS cwd-scoped answers about the launch that
      // actually follows rather than a hypothetical one.
      const canResumeFromDriverState =
        !hasResumeCursor &&
        adapter.capabilities.resumeState === "session-file" &&
        adapter.canResumeThread !== undefined
          ? yield* adapter.canResumeThread({
              threadId: input.binding.threadId,
              ...(persistedCwd !== undefined ? { cwd: persistedCwd } : {}),
            })
          : false;
      if (!hasResumeCursor && !canResumeFromDriverState) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      yield* prepareMcpSession(input.binding.threadId, bindingInstanceId);
      const resumed = yield* withWorkspaceHold(
        input.binding.threadId,
        persistedCwd ?? undefined,
        adapter
          .startSession({
            threadId: input.binding.threadId,
            provider: input.binding.provider,
            providerInstanceId: bindingInstanceId,
            ...(persistedCwd ? { cwd: persistedCwd } : {}),
            ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
            ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
            runtimeMode: input.binding.runtimeMode ?? "full-access",
          })
          .pipe(Effect.onError(() => clearMcpSession(input.binding.threadId))),
      );
      if (resumed.provider !== adapter.provider) {
        yield* clearMcpSession(input.binding.threadId);
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }

      yield* upsertSessionBinding(
        { ...resumed, providerInstanceId: bindingInstanceId },
        input.binding.threadId,
      );
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: canResumeFromDriverState ? "resume-session-file" : "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return { adapter, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: true,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        isActive: false,
      } as const;
    }

    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
    });
    return {
      adapter: recovered.adapter,
      instanceId,
      threadId: input.threadId,
      isActive: true,
    } as const;
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        instanceId === input.currentInstanceId
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* adapter.stopSession(input.threadId).pipe(
                Effect.tap(() =>
                  analytics.record("provider.session.stopped", {
                    provider: adapter.provider,
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause: Cause.pretty(cause),
                  }),
                ),
              );
            }),
      { discard: true },
    );
  });

  const startSession: ProviderServiceMethod<"startSession"> = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );
      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
        const resolvedProvider = instanceInfo.driverKind;
        metricProvider = resolvedProvider;
        if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
          );
        }
        const input = {
          ...parsed,
          threadId,
          provider: resolvedProvider,
        };
        if (!instanceInfo.enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' is disabled in T3 Code settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        const effectiveResumeCursor =
          input.resumeCursor ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? persistedBinding.resumeCursor
            : undefined);
        const effectiveCwd =
          input.cwd ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? readPersistedCwd(persistedBinding.runtimePayload)
            : undefined);
        yield* Effect.annotateCurrentSpan({
          "provider.kind": resolvedProvider,
          "provider.resume_cursor.source":
            input.resumeCursor !== undefined
              ? "request"
              : effectiveResumeCursor !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
          "provider.cwd.source":
            input.cwd !== undefined
              ? "request"
              : effectiveCwd !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.cwd.effective": effectiveCwd ?? "",
        });
        const adapter = yield* registry.getByInstance(resolvedInstanceId);
        // Post-completion engagement — Discuss launch (plan §5.1): a read-only
        // resume prepares NO workstream MCP session (and clears any stale one),
        // so the pi launch carries no workstream extension and no
        // `T3_WORKSTREAM_*` env — the engagement structurally cannot mutate
        // orchestration. Every other launch prepares the session as before.
        yield* input.readOnly === true
          ? clearMcpSession(threadId)
          : prepareMcpSession(threadId, resolvedInstanceId);
        // The pre-spawn hold: from here until the process exits (or this start
        // fails), no remover may delete `effectiveCwd`.
        const session = yield* withWorkspaceHold(
          threadId,
          effectiveCwd,
          adapter
            .startSession({
              ...input,
              providerInstanceId: resolvedInstanceId,
              ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
              ...(effectiveResumeCursor !== undefined
                ? { resumeCursor: effectiveResumeCursor }
                : {}),
            })
            .pipe(Effect.onError(() => clearMcpSession(threadId))),
        );

        if (session.provider !== adapter.provider) {
          yield* clearMcpSession(threadId);
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }
        const sessionWithInstance = {
          ...session,
          providerInstanceId: resolvedInstanceId,
        };

        yield* stopStaleSessionsForThread({
          threadId,
          currentInstanceId: resolvedInstanceId,
        });
        yield* upsertSessionBinding(sessionWithInstance, threadId, {
          modelSelection: input.modelSelection,
        });
        yield* analytics.record("provider.session.started", {
          provider: sessionWithInstance.provider,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
          hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
          hasModel:
            typeof input.modelSelection?.model === "string" &&
            input.modelSelection.model.trim().length > 0,
        });

        return sessionWithInstance;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "start",
            }),
        }),
      );
    },
  );

  const sendTurn: ProviderServiceMethod<"sendTurn"> = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const input = {
      ...parsed,
      attachments: parsed.attachments ?? [],
    };
    if (!input.input && input.attachments.length === 0) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": input.attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      const turn = yield* routed.adapter.sendTurn(input);
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          activeTurnId: turn.turnId,
          lastRuntimeEvent: "provider.sendTurn",
          lastRuntimeEventAt: yield* nowIso,
        },
      });
      yield* analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
        attachmentCount: input.attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const interruptTurn: ProviderServiceMethod<"interruptTurn"> = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const respondToRequest: ProviderServiceMethod<"respondToRequest"> = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceMethod<"respondToUserInput"> = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      return yield* routed.adapter.respondToUserInput(
        routed.threadId,
        input.requestId,
        input.answers,
        {
          outcome: input.outcome ?? DEFAULT_USER_INPUT_RESOLVED_OUTCOME,
          ...(input.message !== undefined ? { message: input.message } : {}),
        },
      );
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceMethod<"stopSession"> = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        // A stop ends the launch, so its hold goes now rather than waiting for an
        // exit event that may never come.
        //
        // Whether to record an owed-exit token is decided by the adapter's declared
        // `emitsExitOnStop`, NOT guessed — and only when a session was actually
        // live, since a stop against an already-dead adapter emits nothing whatever
        // the driver would normally do. Recording when nothing is coming is the
        // permanent-leak bug (the stale token later absorbs a genuine exit);
        // omitting it when an exit IS coming lets that straggler release a
        // subsequent launch's hold. This is the single place the two are told
        // apart, because at exit time they are indistinguishable.
        if (routed.isActive && routed.adapter.capabilities.emitsExitOnStop) {
          yield* Effect.suspend(() => {
            const launch = currentLaunchHold.get(input.threadId);
            return launch === undefined
              ? Effect.void
              : noteLaunchEnded(input.threadId, launch.generation);
          });
        } else {
          // No exit is owed for this thread any more. Clear any token so it cannot
          // outlive the launch that owed it and swallow a later real exit.
          endedLaunches.delete(input.threadId);
        }
        yield* releaseCurrentLaunchHold(input.threadId);
        yield* clearMcpSession(input.threadId);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
          },
        });
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      // One query for every persisted binding. Re-reading each row by id (the
      // former shape) made this O(rows) queries, and since the runtime table
      // retains stopped sessions that cost grew with every session ever run.
      const persistedBindings = yield* directory
        .listBindings()
        .pipe(
          Effect.orElseSucceed(
            () => [] as ReadonlyArray<ProviderSessionDirectory.ProviderRuntimeBinding>,
          ),
        );
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();
      for (const binding of persistedBindings) {
        bindingsByThreadId.set(binding.threadId, binding);
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }
        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  // loom: single-thread lookup for callers that only need one session.
  // Thread-addressed: every adapter read is a keyed `getSession(threadId)`, so
  // cost never grows with the number of persisted rows OR the number of active
  // sessions. That is what makes it safe on the per-event ingestion path
  // (`listSessions` was O(rows) queries, and a listSessions-based scan would
  // still have been O(active sessions) — for Codex, a serial read per live
  // runtime, per event).
  //
  // The persisted binding is a HINT that orders the adapters, not the source of
  // truth: truth is what the adapters report, exactly as in `listSessions`.
  // Consequently this preserves `listSessions`' semantics — a live session is
  // still found with no binding at all, and a session live on an instance the
  // binding disagrees with is still reported as a mismatch rather than hidden.
  const getSession: ProviderServiceMethod<"getSession"> = Effect.fn("getSession")(
    function* (threadId) {
      const bindingOption = yield* directory
        .getBinding(threadId)
        .pipe(
          Effect.orElseSucceed(() =>
            Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
          ),
        );
      const binding = Option.getOrUndefined(bindingOption);
      const currentAdapters = yield* getAdapterEntries;
      // The binding names the likely owner, so try that adapter FIRST: in the
      // steady state this is one keyed lookup and the loop below never runs.
      // But the binding is only a hint — `listSessions` derives truth from the
      // adapters, so a session that is genuinely live must still be found when
      // the binding is missing, unreadable, or names the wrong instance.
      // Skipping that fallback would report a live session as absent, which on
      // the hot paths means ingestion loses its expected turn id and the command
      // reactor starts a SECOND session for a thread that already has one.
      const orderedAdapters =
        binding?.providerInstanceId !== undefined
          ? [
              ...currentAdapters.filter(([id]) => id === binding.providerInstanceId),
              ...currentAdapters.filter(([id]) => id !== binding.providerInstanceId),
            ]
          : currentAdapters;
      for (const [instanceId, adapter] of orderedAdapters) {
        const session = yield* adapter
          .getSession(threadId)
          .pipe(Effect.orElseSucceed(() => undefined));
        if (!session) {
          continue;
        }
        // Same invariants `listSessions` enforces, and for the same reason:
        // callers route turns from this result, so a session whose live location
        // contradicts its persisted binding must fail loudly rather than be
        // routed as if consistent.
        if (binding !== undefined) {
          if (binding.provider !== session.provider) {
            return yield* Effect.die(
              new Error(
                `ProviderService.getSession: thread '${threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
              ),
            );
          }
          if (
            binding.providerInstanceId !== undefined &&
            binding.providerInstanceId !== instanceId
          ) {
            return yield* Effect.die(
              new Error(
                `ProviderService.getSession: thread '${threadId}' is active on provider instance '${instanceId}' but persisted binding names '${binding.providerInstanceId}'.`,
              ),
            );
          }
        }
        return { ...session, providerInstanceId: instanceId };
      }
      return undefined;
    },
  );

  const getCapabilities: ProviderServiceMethod<"getCapabilities"> = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceMethod<"getInstanceInfo"> = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const rollbackConversation: ProviderServiceMethod<"rollbackConversation"> = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const currentAdapters = yield* getAdapterEntries;
    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));
    yield* Effect.forEach(activeSessions, (session) =>
      Effect.flatMap(nowIso, (lastRuntimeEventAt) =>
        upsertSessionBinding(session, session.threadId, {
          lastRuntimeEvent: "provider.stopAll",
          lastRuntimeEventAt,
        }),
      ),
    ).pipe(Effect.asVoid);
    yield* Effect.forEach(currentAdapters, ([, adapter]) => adapter.stopAll()).pipe(Effect.asVoid);
    // Same rule as the single-session stop, minus the token bookkeeping: this runs
    // as the shutdown finalizer, so there is no subsequent launch for a late exit
    // to affect. Clear both hold and residue outright.
    yield* Effect.forEach(
      activeSessions,
      (session) =>
        releaseCurrentLaunchHold(session.threadId).pipe(
          Effect.andThen(Effect.sync(() => endedLaunches.delete(session.threadId))),
        ),
      { discard: true },
    );
    yield* McpSessionRegistry.revokeAllActiveMcpCredentials();
    McpProviderSession.clearAllMcpProviderSessions();
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        // loom: already-stopped bindings need no rewrite. This runs as a scope
        // finalizer after the HTTP grace period is exhausted, and each upsert is
        // a read-then-write pair on the single serial SQL connection — so
        // rewriting every historical row cost ~2x(row count) statements on the
        // shutdown path. It also reset `lastSeenAt` on every stopped row at once
        // (observed: 1311 of 1326 rows sharing one minute), destroying the only
        // age signal the runtime table carries.
        if (binding.status === "stopped") {
          return;
        }
        const providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.stopAll",
          binding,
        );
        return yield* directory.upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
      }),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  );

  return {
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getSession,
    getCapabilities,
    getInstanceInfo,
    rollbackConversation,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceMethod<"streamEvents"> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderService.ProviderService["Service"];
});

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  makeProviderService(),
);

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService.ProviderService, makeProviderService(options));
}
