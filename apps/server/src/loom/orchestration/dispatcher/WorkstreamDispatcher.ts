/**
 * The workstream control plane's pass (Phase 3 plan Track 3b): one idempotent
 * recompute from durable state that re-drives the graph, promotes ready
 * children and delivers every wake, run by a coalescing worker on the trigger
 * set (`isPassTrigger`), on a 60 s tick, and once at startup from
 * `loomStartupRecovery` (DL-386). It absorbs Phase
 * 2's re-drive reactor (DL-247).
 *
 * The steps run in `PASS_STEPS` order over one `PassContext`: re-drive and
 * promotion here, the quiescence rail in `quiescenceRail.ts`, the wake rails in
 * `rails.ts`. Every `server:` dispatch goes through `PassContext.dispatch`,
 * which applies the receipt discipline (`dispatchServerCommand`) and records
 * deferrals and dead episodes. Nothing here is persisted: "already told" is
 * read back from the target's stored control messages (`PassContext.delivered`)
 * and the receipts.
 *
 * @module loom/orchestration/dispatcher/WorkstreamDispatcher
 */
import {
  CommandId,
  type ControlPayload,
  DEFAULT_SERVER_SETTINGS,
  type ControlPayloadItem,
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
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import type { ServerConfig } from "../../../config.ts";
import {
  CommandReceiptStoreV2,
  type CommandReceiptStoreV2Error,
} from "../../../orchestration-v2/CommandReceiptStore.ts";
import {
  OrchestratorV2,
  type OrchestratorV2Error,
} from "../../../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../../../serverActivation.ts";
import * as ServerSettings from "../../../serverSettings.ts";
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
import type { DigestExtra } from "./digest.ts";
import { makeGateLegComposer } from "./gateLegs.ts";
import { quiescenceRail } from "./quiescenceRail.ts";
import {
  attentionRail,
  briefNeededRail,
  deadlockRail,
  digestFlush,
  notifyDelivery,
  surfaceDeferredWakes,
  terminalDeltas,
  yieldRail,
} from "./rails.ts";
import { steerRedelivery } from "./steerRedelivery.ts";
import type { WakeMember } from "./wakes.ts";

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
  readonly atMs: number;
}

/**
 * One FYI item withheld for a parent's digest: a terminal child (`member`) or
 * a pre-rendered line (`extra`). `key` is its episode key (the digest id
 * hashes them); `settle` forgets an in-memory item once a message carried it.
 */
export interface PendingDigestItem {
  readonly key: string;
  readonly eventAtMs: number | null;
  readonly member?: WakeMember;
  readonly extra?: DigestExtra;
  readonly settle?: () => void;
}

/** A liveness advisory (3b-3's sweep) waiting for its parent's next digest; process memory only. */
export interface AdviseInput {
  readonly parentId: ThreadId;
  /** `threadId` is the child; `excerpt` (else `title`) is the digest line's text, without a leading bullet. */
  readonly item: ControlPayloadItem & {
    readonly kind: DigestExtra["kind"];
    readonly threadId: ThreadId;
  };
  /** Stable per episode: a repeated `advise` with the same key is one item. */
  readonly episodeKey: string;
  /** ISO time the episode began: a parent message carrying the item after it means "already told". */
  readonly episodeStartedAt: string;
}

/** A control-payload item a thread already received, with the message's time. */
export interface DeliveredItem {
  readonly payload: ControlPayload;
  readonly item: ControlPayloadItem;
  readonly atMs: number;
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
  /** Wakes a target deferred this pass (no receipt), per thread and rail; `surfaceDeferredWakes` reads it. */
  readonly deferredWakes: Map<ThreadId, Map<string, number>>;
  /** FYI items withheld per parent this pass: decision-bearing wakes piggyback them, the flush sends the rest. */
  readonly pendingDigests: Map<ThreadId, Array<PendingDigestItem>>;
  /** Advisories per parent by episode key (service lifetime; the sweep re-advises after a restart). */
  readonly advisories: Map<ThreadId, Map<string, AdviseInput>>;
  /**
   * Stashed steers the startup pass LEFT on threads rule 0 did not continue, by thread: the
   * text as it was at startup (service lifetime; the next startup re-records them from disk).
   * Only these are the redelivery rail's — any other stash is the adapter's live-turn record.
   */
  readonly leftStashes: Map<ThreadId, string>;
  /** The quiescence grace windows (`quiescenceGraceMs` / `quiescenceHumanGraceMs`). */
  readonly grace: { readonly controlStartedMs: number; readonly humanStartedMs: number | null };
  /** When this dispatcher started (ms): floors the deferred-wake silence clock. */
  readonly startedAtMs: number;
  /** Items of the Loom control messages `threadId` has received, oldest first (cached until its next delivery). */
  readonly delivered: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<DeliveredItem>, PassError, PassServices>;
  /** Whether a `server:` id already has a receipt (sent, or dead). */
  readonly sent: (id: string) => Effect.Effect<boolean, PassError, PassServices>;
  /**
   * Rejected `server:` commands not yet reported to a parent. Lives for the
   * service's lifetime (a dead episode is receipted, so it is never seen
   * again); the message that carries one as a digest item removes it.
   */
  readonly deadEpisodes: Set<DeadEpisode>;
  /** Dispatches one `server:` command under the receipt discipline, recording a deferral (`count` items) under `rail`. */
  readonly dispatch: (
    rail: string,
    command: ThreadServerCommand,
    count?: number,
  ) => Effect.Effect<PassDispatchOutcome, never, PassServices>;
}

/** True when the dispatch put the message (or command) in place, now or earlier. */
export const landed = (outcome: PassDispatchOutcome) =>
  outcome.status === "accepted" || (outcome.status === "receipted" && outcome.accepted);

/** The services a pass step may read. */
export type PassServices =
  | OrchestratorV2
  | LoomStoreV2
  | CommandReceiptStoreV2
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ServerSettings.ServerSettingsService;

/** What a failing step can fail with; a failure ends the pass (logged) and the next pass retries. */
export type PassError = LoomStoreError | OrchestratorV2Error | CommandReceiptStoreV2Error;

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
        if (!landed(prepared)) continue;
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

/**
 * The pass, in order. Later steps read the pass-start snapshot: what an earlier
 * step changed (a quiescent submit, a gate resolve) emits a trigger event, so
 * the next pass sees it.
 */
export const PASS_STEPS: ReadonlyArray<PassStep> = [
  reDrive,
  promotion,
  steerRedelivery,
  quiescenceRail,
  terminalDeltas,
  attentionRail,
  yieldRail,
  briefNeededRail,
  deadlockRail,
  digestFlush,
  notifyDelivery,
  surfaceDeferredWakes,
];

/** Service-lifetime state a pass reads; all of it is recomputable or deliberately ephemeral. */
interface DispatcherMemory {
  readonly deadEpisodes: Set<DeadEpisode>;
  readonly advisories: Map<ThreadId, Map<string, AdviseInput>>;
  readonly leftStashes: Map<ThreadId, string>;
  /** `delivered` cache, valid while the thread's `latestUserMessageAt` is `stamp`; dropped on each delivery. */
  readonly deliveredCache: Map<
    ThreadId,
    { readonly stamp: string; readonly items: ReadonlyArray<DeliveredItem> }
  >;
  readonly startedAtMs: number;
}

/** Builds the pass context: the active rows, their archived dependencies, the joined shells. */
const makePassContext = Effect.fn("loom.dispatcher.passContext")(function* (
  memory: DispatcherMemory,
) {
  const loomStore = yield* LoomStoreV2;
  const orchestrator = yield* OrchestratorV2;
  const receipts = yield* CommandReceiptStoreV2;
  // A settings read failure must not stop the control plane: fall back to the schema defaults.
  const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings.pipe(
    Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS),
  );
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
  const shells = new Map(
    [...snapshot.threads, ...snapshot.archivedThreads].map((shell) => [shell.id, shell]),
  );
  const deferredWakes = new Map<ThreadId, Map<string, number>>();
  const now = yield* DateTime.now;
  return {
    now,
    rows,
    nodesById,
    shells,
    deferredWakes,
    deadEpisodes: memory.deadEpisodes,
    pendingDigests: new Map(),
    advisories: memory.advisories,
    leftStashes: memory.leftStashes,
    grace: {
      controlStartedMs: settings.quiescenceGraceMs,
      humanStartedMs: settings.quiescenceHumanGraceMs,
    },
    startedAtMs: memory.startedAtMs,
    delivered: (threadId) =>
      Effect.gen(function* () {
        const stamp = String(shells.get(threadId)?.latestUserMessageAt ?? null);
        const cached = memory.deliveredCache.get(threadId);
        if (cached?.stamp === stamp) return cached.items;
        const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"], {
          messageRoles: ["user"],
        });
        const items = messages.flatMap((message) => {
          const payload = message.loom?.controlPayload;
          const atMs = DateTime.toEpochMillis(message.createdAt);
          return payload === undefined
            ? []
            : payload.items.map((item) => ({ payload, item, atMs }));
        });
        memory.deliveredCache.set(threadId, { stamp, items });
        return items;
      }),
    sent: (id) => Effect.map(receipts.getByCommandId(CommandId.make(id)), Option.isSome),
    dispatch: (rail, command, count = 1) =>
      dispatchServerCommand(command).pipe(
        Effect.map((outcome) => {
          if (outcome.status === "deferred") {
            const rails = deferredWakes.get(command.threadId) ?? new Map<string, number>();
            rails.set(rail, (rails.get(rail) ?? 0) + count);
            deferredWakes.set(command.threadId, rails);
          } else if (outcome.status === "dead") {
            memory.deadEpisodes.add({
              commandId: command.commandId,
              commandType: command.type,
              threadId: command.threadId,
              error: outcome.error,
              atMs: DateTime.toEpochMillis(now),
            });
          }
          if (outcome.status === "accepted" && command.type === "message.dispatch")
            memory.deliveredCache.delete(command.threadId);
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
  /** Subscribes to the trigger set and starts the tick, after server activation. */
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  /** Resolves once no pass is running or pending (tests: the deterministic wait, never a sleep). */
  readonly drain: Effect.Effect<void>;
  /** Requests a pass and waits for it (coalesced with any pending one). */
  readonly runPass: Effect.Effect<void>;
  /**
   * The liveness sweep's hook (3b-3): an advisory item for `parentId`'s next FYI
   * digest, deduped by `episodeKey` in memory and by the parent's stored
   * digests; requests a pass.
   */
  readonly advise: (input: AdviseInput) => Effect.Effect<void>;
  /**
   * The startup pass's hook (seam 20): a stashed steer it left on a thread rule 0 did not
   * continue, for the redelivery rail to carry into that thread's next human- or parent-started turn.
   */
  readonly leaveStash: (threadId: ThreadId, steer: string) => Effect.Effect<void>;
  /** The last finished pass's deferrals per thread and rail (diagnostics). */
  readonly deferredWakes: Effect.Effect<ReadonlyMap<ThreadId, ReadonlyMap<string, number>>>;
}

export class WorkstreamDispatcher extends Context.Service<
  WorkstreamDispatcher,
  WorkstreamDispatcherShape
>()("t3/loom/orchestration/dispatcher/WorkstreamDispatcher") {}

const make = Effect.gen(function* () {
  const services = yield* Effect.context<PassServices>();
  const orchestrator = yield* OrchestratorV2;
  const memory: DispatcherMemory = {
    deadEpisodes: new Set(),
    advisories: new Map(),
    leftStashes: new Map(),
    deliveredCache: new Map(),
    startedAtMs: DateTime.toEpochMillis(yield* DateTime.now),
  };
  const lastDeferredWakes = yield* Ref.make<ReadonlyMap<ThreadId, ReadonlyMap<string, number>>>(
    new Map(),
  );
  const pass = Effect.gen(function* () {
    const ctx = yield* makePassContext(memory);
    for (const step of PASS_STEPS) yield* step.run(ctx);
    yield* Ref.set(lastDeferredWakes, ctx.deferredWakes);
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
    // The startup pass is `loomStartupRecovery`'s (ordered after the held-queue release and the
    // steer redelivery; activation follows it, DL-386). The tick's first beat here is the
    // catch-up for what landed between that pass and this subscription (the stream is live-only).
    start: forkParked(
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          worker.enqueue().pipe(Effect.repeat(Schedule.spaced(PASS_TICK_INTERVAL))),
        );
        yield* orchestrator.streamDomainEvents.pipe(
          // Plus a run starting on a thread holding a left stash (the redelivery rail).
          Stream.filter(
            (event) =>
              isPassTrigger(event) ||
              (event.type === "run.updated" &&
                event.payload.status === "running" &&
                memory.leftStashes.has(event.threadId)),
          ),
          Stream.runForEach(() => worker.enqueue()),
          Effect.catchCause((cause) =>
            Effect.logWarning("loom.dispatcher.stream-stopped", { cause }),
          ),
        );
      }),
    ),
    drain: worker.drain,
    runPass: worker.enqueue().pipe(Effect.andThen(worker.drain)),
    advise: (input) =>
      Effect.suspend(() => {
        const byKey = memory.advisories.get(input.parentId) ?? new Map<string, AdviseInput>();
        if (!byKey.has(input.episodeKey)) byKey.set(input.episodeKey, input);
        memory.advisories.set(input.parentId, byKey);
        return worker.enqueue();
      }),
    leaveStash: (threadId, steer) =>
      Effect.sync(() => void memory.leftStashes.set(threadId, steer)),
    deferredWakes: Ref.get(lastDeferredWakes),
  } satisfies WorkstreamDispatcherShape;
});

/** The dispatcher service (not started); tests drive `runPass`. */
export const WorkstreamDispatcherLive = Layer.effect(WorkstreamDispatcher, make);

/** The dispatcher, started post-activation: the production layer. */
export const WorkstreamDispatcherStartedLive = Layer.effectDiscard(
  Effect.flatMap(WorkstreamDispatcher, (dispatcher) => dispatcher.start),
).pipe(Layer.provideMerge(WorkstreamDispatcherLive));
