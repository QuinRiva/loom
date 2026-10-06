/**
 * Settles `/handoff` drafters (Phase 3 plan Track 3b, DT-22/24), ported from V1's
 * `HandoffDrafterReactor` onto V2. A drafter is a Loom root with role
 * `handoff-drafter` (`handoffDraft.ts`); once its kickoff run has ended the pass
 * decides, from durable state only:
 *
 * - **success** — the drafter placed ≥1 handoff (`goal_handoff` records it on the
 *   drafter's own row): outcome `done`, then `thread.archive` (archived-after-handoff
 *   is how the drafter is hidden; upstream's archive detaches its provider session
 *   through the outbox, so V1's stop-before-archive dance is not needed);
 * - **guidance** — the run ended with no handoff, or the kickoff is still not
 *   finished past `HANDOFF_HUNG_GRACE_MS`: `needs_guidance` on the SOURCE (the
 *   thread the human typed `/handoff` in) when it has a live Loom row, else on the
 *   drafter, which then stays visible as the recovery surface.
 *
 * Every command has a deterministic `server:` id under the receipt discipline
 * (`dispatchServerCommand`), so a pass is an idempotent recompute: a coalescing
 * worker runs it on a drafter's run end or handoff record, and on a 60 s tick (the
 * hung leg is timer-driven; the tick's first beat recovers drafters a restart
 * stranded).
 *
 * @module loom/handoff/HandoffDrafterReactor
 */
import {
  CommandId,
  type LoomThreadWorkstream,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { makeCoalescingWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../../serverActivation.ts";
import { dispatchServerCommand } from "../orchestration/redrive.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";
import { HANDOFF_DRAFTER_ROLE } from "./handoffDraft.ts";

/**
 * Grace before a kickoff that has not finished is declared hung. The zero-handoff
 * leg catches the common failures (a failed run is a finished run); this only
 * catches a truly stuck kickoff, so it can afford to be slow.
 */
export const HANDOFF_HUNG_GRACE_MS = 300_000;

const RECONCILIATION_INTERVAL = "60 seconds";

const TERMINAL_RUN = new Set(["completed", "failed", "interrupted", "cancelled", "rolled_back"]);

export type HandoffSettlementAction =
  | { readonly kind: "none" }
  | { readonly kind: "success"; readonly runId: string }
  | { readonly kind: "guidance"; readonly reasonKey: string };

/** The settlement decision for one drafter (pure). */
export const classifyHandoffSettlement = (
  row: Pick<LoomThreadWorkstream, "threadId" | "archivedAt" | "createdAt" | "handoffDestinations">,
  shell: Pick<
    OrchestrationV2ThreadShell,
    "latestRunId" | "activityRunStatus" | "latestRunStartedAt" | "latestRunRequestedAt"
  > | null,
  nowMs: number,
  graceMs: number = HANDOFF_HUNG_GRACE_MS,
): HandoffSettlementAction => {
  if (row.archivedAt !== null || shell === null) return { kind: "none" };
  if (shell.latestRunId !== null && shell.activityRunStatus == null) {
    // Only destinations THIS drafter placed count: `goal_handoff` also copies the
    // marker onto the drafter's fork source, which may itself be a failed drafter
    // the human re-ran `/handoff` from. A null attribution is pre-field data.
    return row.handoffDestinations.some(
      (destination) =>
        destination.drafterThreadId === null || destination.drafterThreadId === row.threadId,
    )
      ? { kind: "success", runId: shell.latestRunId }
      : { kind: "guidance", reasonKey: `zero:${shell.latestRunId}` };
  }
  const startedAt = shell.latestRunStartedAt ?? shell.latestRunRequestedAt;
  const startedMs =
    startedAt == null ? Date.parse(row.createdAt) : DateTime.toEpochMillis(startedAt);
  return nowMs - startedMs > graceMs
    ? { kind: "guidance", reasonKey: "kickoff-hung" }
    : { kind: "none" };
};

export interface HandoffDrafterReactorShape {
  /** Subscribes to drafter run ends and handoff records, and starts the tick, after activation. */
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  /** Requests a pass and waits for it (tests: the deterministic wait). */
  readonly runPass: Effect.Effect<void>;
}

export class HandoffDrafterReactor extends Context.Service<
  HandoffDrafterReactor,
  HandoffDrafterReactorShape
>()("t3/loom/handoff/HandoffDrafterReactor") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const loomStore = yield* LoomStoreV2;
  const services = yield* Effect.context<CommandReceiptStoreV2 | OrchestratorV2>();

  const settle = (row: LoomThreadWorkstream, nowMs: number) =>
    Effect.gen(function* () {
      const id = (step: string) =>
        CommandId.make(`server:loom:handoff-settle:${step}:${row.threadId}`);
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      const action = classifyHandoffSettlement(
        row,
        yield* orchestrator.getThreadShell(row.threadId),
        nowMs,
      );
      if (action.kind === "success") {
        yield* dispatchServerCommand({
          type: "thread.outcome.set",
          commandId: CommandId.make(`${id("done")}:${action.runId}`),
          threadId: row.threadId,
          createdAt,
          outcome: "done",
        });
        yield* dispatchServerCommand({
          type: "thread.archive",
          commandId: CommandId.make(`${id("archive")}:${action.runId}`),
          threadId: row.threadId,
        });
      } else if (action.kind === "guidance") {
        const source =
          row.forkFromThreadId === null
            ? null
            : yield* loomStore.getWorkstream(row.forkFromThreadId);
        const target =
          source !== null &&
          source.outcome === null &&
          source.archivedAt === null &&
          source.deletedAt === null
            ? source.threadId
            : row.threadId;
        yield* dispatchServerCommand({
          type: "thread.attention.raise",
          commandId: CommandId.make(`${id("guidance")}:${action.reasonKey}`),
          threadId: target,
          createdAt,
          reason: "needs_guidance",
        });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("loom.handoff-drafter.settle-failed", {
              threadId: row.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  const pass = Effect.gen(function* () {
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    for (const row of yield* loomStore.listActiveWorkstreams()) {
      if (row.role === HANDOFF_DRAFTER_ROLE) yield* settle(row, nowMs);
    }
  }).pipe(
    Effect.provideContext(services),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("loom.handoff-drafter.pass-failed", { cause: Cause.pretty(cause) }),
    ),
    Effect.withSpan("loom.handoff-drafter.pass"),
  );
  const worker = yield* makeCoalescingWorker(pass);

  return {
    start: forkParked(
      Effect.gen(function* () {
        // The tick's first beat is the startup reconciliation.
        yield* Effect.forkScoped(
          worker.enqueue().pipe(Effect.repeat(Schedule.spaced(RECONCILIATION_INTERVAL))),
        );
        yield* orchestrator.streamDomainEvents.pipe(
          Stream.filter(
            (event) =>
              event.type === "thread.handoff-recorded" ||
              (event.type === "run.updated" && TERMINAL_RUN.has(event.payload.status)),
          ),
          Stream.runForEach(() => worker.enqueue()),
          Effect.catchCause((cause) =>
            Effect.logWarning("loom.handoff-drafter.stream-stopped", { cause }),
          ),
        );
      }),
    ),
    runPass: worker.enqueue().pipe(Effect.andThen(worker.drain)),
  } satisfies HandoffDrafterReactorShape;
});

/** The reactor service (not started); tests drive `runPass`. */
export const HandoffDrafterReactorServiceLive = Layer.effect(HandoffDrafterReactor, make);

/** The reactor, started post-activation: the production layer. */
export const HandoffDrafterReactorLive = Layer.effectDiscard(
  Effect.flatMap(HandoffDrafterReactor, (reactor) => reactor.start),
).pipe(Layer.provide(HandoffDrafterReactorServiceLive));
