/**
 * The workstream control plane's pass (Phase 3 plan Track 3b): one idempotent
 * recompute from durable state that re-drives the graph, promotes ready
 * children and delivers every wake, run by a coalescing worker on the trigger
 * set (`isPassTrigger`), once at startup and on a 60 s tick. It absorbs Phase
 * 2's re-drive reactor (DL-247).
 *
 * The steps run in `PASS_STEPS` order over one `PassContext`. 3b-1 builds
 * re-drive and promotion; the rest are named no-ops 3b-2 fills, reading the
 * context's `deferredWakes` and `deadEpisodes`. Every `server:` dispatch goes
 * through `PassContext.dispatch`, which applies the receipt discipline
 * (`dispatchServerCommand`) and records deferrals and dead episodes.
 *
 * @module loom/orchestration/dispatcher/WorkstreamDispatcher
 */
import {
  CommandId,
  type LoomThreadWorkstream,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { makeCoalescingWorker } from "@t3tools/shared/DrainableWorker";
import { isEligibleToStart } from "@t3tools/shared/workstreamStart.loom";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { ServerConfig } from "../../../config.ts";
import { CommandReceiptStoreV2 } from "../../../orchestration-v2/CommandReceiptStore.ts";
import {
  OrchestratorV2,
  type OrchestratorV2Error,
} from "../../../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../../../serverActivation.ts";
import { type LoomStoreError, LoomStoreV2 } from "../../projection/LoomStore.ts";
import { readWorkstreamReportAt } from "../../workstream/report.ts";
import {
  dispatchServerCommand,
  isPassTrigger,
  runReDrivePass,
  type ThreadServerCommand,
} from "../redrive.ts";
import {
  briefReadParkCommandId,
  controlMessage,
  forkPrepareCommandId,
  kickoffCommandId,
} from "./controlMessage.ts";
import { makeGateLegComposer } from "./gateLegs.ts";

/** How often the pass re-runs with no trigger (time-based rails: grace windows, rungs, flush ages). */
export const PASS_TICK_INTERVAL = "60 seconds";

/** A sidecar row as a graph node (`id` = `threadId`) for the shared start and dependency predicates. */
export type WorkstreamNode = LoomThreadWorkstream & { readonly id: ThreadId };

/** A `server:` command rejected (and receipted): its episode is dead and never retried; the parent hears of it as a `dead-episode` digest item. */
export interface DeadEpisode {
  readonly commandId: CommandId;
  readonly commandType: string;
  readonly threadId: ThreadId;
  readonly error: string;
}

/** What a `server:` dispatch came to: `receipted` = sent before (accepted, or dead when `accepted` is false). */
export type PassDispatchOutcome =
  | { readonly status: "accepted" | "deferred" | "dead" }
  | { readonly status: "receipted"; readonly accepted: boolean };

/** Everything one pass reads and writes; built once per pass, threaded through every step. */
export interface PassContext {
  readonly now: DateTime.Utc;
  /** Every sidecar row neither archived nor deleted. */
  readonly rows: ReadonlyArray<LoomThreadWorkstream>;
  /**
   * The rows as graph nodes by id, plus every archived (not deleted) row an
   * active row depends on — the sibling map DL-211 requires (an archived `done`
   * dependency releases; a deleted one never gates). The dependency predicates
   * only read same-parent entries, so one map serves every parent.
   */
  readonly nodesById: ReadonlyMap<ThreadId, WorkstreamNode>;
  /** The V2 thread shells (active and archived), joined with `shell.workstream`. */
  readonly shells: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>;
  /** Steered wakes a busy target deferred this pass, per thread and rail; 3b-2's `surfaceDeferredWakes` reads it. */
  readonly deferredWakes: Map<ThreadId, Map<string, number>>;
  /**
   * Rejected `server:` commands not yet reported to a parent. Lives for the
   * service's lifetime (a dead episode is receipted, so it is never seen
   * again): 3b-2's digest flush removes the entries it delivers.
   */
  readonly deadEpisodes: Array<DeadEpisode>;
  /** Dispatches one `server:` command under the receipt discipline, recording a deferral under `rail`. */
  readonly dispatch: (
    rail: string,
    command: ThreadServerCommand,
  ) => Effect.Effect<PassDispatchOutcome, never, PassServices>;
}

/** The services a pass step may read. */
export type PassServices =
  | OrchestratorV2
  | LoomStoreV2
  | CommandReceiptStoreV2
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig;

/** What a failing step can fail with; a failure ends the pass (logged) and the next pass retries. */
export type PassError = LoomStoreError | OrchestratorV2Error;

/** One named step of the pass. */
export interface PassStep {
  readonly name: string;
  readonly run: (ctx: PassContext) => Effect.Effect<void, PassError, PassServices>;
}

/**
 * Step 1 — re-drive: cascades, wedged dependents, archive / unarchive / delete,
 * goal attach and gate legs (`planReDrive`), with the real gate-leg composer.
 * The reports of live gate parties are read first so the composer stays pure.
 */
const reDrive: PassStep = {
  name: "reDrive",
  run: Effect.fn("loom.dispatcher.reDrive")(function* (ctx: PassContext) {
    const reports = new Map<string, string | null>();
    for (const row of ctx.rows) {
      if (
        row.reportPath === null ||
        row.lastRoute === null ||
        row.lastRoute.kind === "resolve" ||
        (row.outcome !== null && !row.pendingRework)
      )
        continue;
      reports.set(row.reportPath, Option.getOrNull(yield* readWorkstreamReportAt(row.reportPath)));
    }
    yield* runReDrivePass(makeGateLegComposer(reports), (command) =>
      ctx.dispatch("re-drive", command),
    );
  }),
};

/**
 * Step 2 — promotion: every eligible child with a brief is kicked off exactly
 * once. A forkFrom child first gets `thread.fork.prepare` (P3-28): a deferral
 * (the source still runs) leaves it for a later pass; a rejection is a dead
 * episode and it is not kicked off. The kickoff carries the brief file's
 * current bytes and no `controlPayload` (DL-333); an unreadable brief parks the
 * child with `needs_guidance`. The kickoff's receipt and the arm's `kickoffAt`
 * stamp make a second kickoff impossible.
 */
const promotion: PassStep = {
  name: "promotion",
  run: Effect.fn("loom.dispatcher.promotion")(function* (ctx: PassContext) {
    const fs = yield* FileSystem.FileSystem;
    const createdAt = DateTime.formatIso(ctx.now);
    for (const row of ctx.rows) {
      const node = ctx.nodesById.get(row.threadId)!;
      if (!isEligibleToStart(node, ctx.nodesById)) continue;
      if (row.forkFromThreadId !== null) {
        const prepared = yield* ctx.dispatch("fork-prepare", {
          type: "thread.fork.prepare",
          commandId: CommandId.make(forkPrepareCommandId(row.threadId)),
          threadId: row.threadId,
          createdAt,
          sourceThreadId: row.forkFromThreadId,
        });
        if (
          prepared.status !== "accepted" &&
          !(prepared.status === "receipted" && prepared.accepted)
        )
          continue;
      }
      const brief = yield* fs.readFileString(row.kickoffBriefPath!).pipe(Effect.option);
      yield* Option.match(brief, {
        onNone: () =>
          ctx.dispatch("brief-read", {
            type: "thread.attention.raise",
            commandId: CommandId.make(briefReadParkCommandId(row.threadId)),
            threadId: row.threadId,
            createdAt,
            reason: "needs_guidance",
          }),
        onSome: (text) =>
          ctx.dispatch(
            "kickoff",
            controlMessage({
              threadId: row.threadId,
              id: kickoffCommandId(row.threadId),
              tier: "steered",
              origin: "kickoff",
              text,
            }),
          ),
      });
    }
  }),
};

const stub = (name: string): PassStep => ({ name, run: () => Effect.void });

/**
 * The pass, in order. Steps 3–11 are 3b-2's: quiescence rail, terminal deltas,
 * per-child rails, yields, brief-needed, deadlock, digest flush, notify
 * delivery, deferred-wake surfacing.
 */
export const PASS_STEPS: ReadonlyArray<PassStep> = [
  reDrive,
  promotion,
  stub("quiescence"),
  stub("terminalDeltas"),
  stub("childRails"),
  stub("yields"),
  stub("briefNeeded"),
  stub("deadlock"),
  stub("digestFlush"),
  stub("notifyDelivery"),
  stub("deferredWakes"),
];

/** Builds the pass context: the active rows, their archived dependencies, the joined shells. */
const makePassContext = Effect.fn("loom.dispatcher.passContext")(function* (
  deadEpisodes: Array<DeadEpisode>,
) {
  const loomStore = yield* LoomStoreV2;
  const orchestrator = yield* OrchestratorV2;
  const rows = yield* loomStore.listActiveWorkstreams();
  const nodesById = new Map<ThreadId, WorkstreamNode>(
    rows.map((row) => [row.threadId, { ...row, id: row.threadId }]),
  );
  for (const depId of new Set(rows.flatMap((row) => row.blockedBy))) {
    if (nodesById.has(depId)) continue;
    const dep = yield* loomStore.getWorkstream(depId);
    if (dep !== null && dep.deletedAt === null) nodesById.set(depId, { ...dep, id: depId });
  }
  const snapshot = yield* orchestrator.getShellSnapshot();
  const deferredWakes = new Map<ThreadId, Map<string, number>>();
  return {
    now: yield* DateTime.now,
    rows,
    nodesById,
    shells: new Map(
      [...snapshot.threads, ...snapshot.archivedThreads].map((shell) => [shell.id, shell]),
    ),
    deferredWakes,
    deadEpisodes,
    dispatch: (rail, command) =>
      dispatchServerCommand(command).pipe(
        Effect.map((outcome) => {
          if (outcome.status === "deferred") {
            const rails = deferredWakes.get(command.threadId) ?? new Map<string, number>();
            rails.set(rail, (rails.get(rail) ?? 0) + 1);
            deferredWakes.set(command.threadId, rails);
          } else if (outcome.status === "dead") {
            deadEpisodes.push({
              commandId: command.commandId,
              commandType: command.type,
              threadId: command.threadId,
              error: outcome.error,
            });
          }
          return outcome.status === "dead" ? { status: "dead" as const } : outcome;
        }),
        // A receipt-store read failure is this command's problem only; the next pass retries it.
        Effect.catch((error) =>
          Effect.logWarning("loom.dispatcher.dispatch-failed", {
            rail,
            commandId: command.commandId,
            error,
          }).pipe(Effect.as({ status: "deferred" as const })),
        ),
      ),
  } satisfies PassContext;
});

export interface WorkstreamDispatcherShape {
  /** Subscribes to the trigger set and starts the tick, after server activation; one startup pass. */
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  /** Resolves once no pass is running or pending (tests: the deterministic wait, never a sleep). */
  readonly drain: Effect.Effect<void>;
  /** Requests a pass and waits for it (coalesced with any pending one). */
  readonly runPass: Effect.Effect<void>;
}

export class WorkstreamDispatcher extends Context.Service<
  WorkstreamDispatcher,
  WorkstreamDispatcherShape
>()("t3/loom/orchestration/dispatcher/WorkstreamDispatcher") {}

const make = Effect.gen(function* () {
  const services = yield* Effect.context<PassServices>();
  const orchestrator = yield* OrchestratorV2;
  const deadEpisodes: Array<DeadEpisode> = [];
  const pass = Effect.gen(function* () {
    const ctx = yield* makePassContext(deadEpisodes);
    for (const step of PASS_STEPS) yield* step.run(ctx);
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("loom.dispatcher.pass-failed", { cause: Cause.pretty(cause) }),
    ),
    Effect.provideContext(services),
  );
  const worker = yield* makeCoalescingWorker(pass);
  return {
    start: forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue();
        yield* Effect.forkScoped(
          worker.enqueue().pipe(Effect.repeat(Schedule.spaced(PASS_TICK_INTERVAL))),
        );
        yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(isPassTrigger),
          Stream.runForEach(() => worker.enqueue()),
          Effect.catchCause((cause) =>
            Effect.logWarning("loom.dispatcher.stream-stopped", { cause }),
          ),
        );
      }),
    ),
    drain: worker.drain,
    runPass: worker.enqueue().pipe(Effect.andThen(worker.drain)),
  } satisfies WorkstreamDispatcherShape;
});

/** The dispatcher service (not started); tests drive `runPass`. */
export const WorkstreamDispatcherLive = Layer.effect(WorkstreamDispatcher, make);

/** The dispatcher, started post-activation: the production layer. */
export const WorkstreamDispatcherStartedLive = Layer.effectDiscard(
  Effect.flatMap(WorkstreamDispatcher, (dispatcher) => dispatcher.start),
).pipe(Layer.provideMerge(WorkstreamDispatcherLive));
