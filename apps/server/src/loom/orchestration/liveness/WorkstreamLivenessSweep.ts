/**
 * The workstream liveness sweep on V2 (Phase 3 plan "Liveness"; P3-8–P3-10).
 * A periodic pass over every active Loom sub-thread that classifies it from the
 * V2 shell, the in-memory heartbeat and its in-flight tool:
 *
 * - **dead** (State A) — the latest run `failed` with a provider failure class
 *   (`usage_limit` excluded: upstream's limit recovery parks and resumes it) for
 *   `failureCap` consecutive sweeps → `thread.attention.raise error`.
 * - **waiting** (State B) — a pending approval-kind runtime request: exempt.
 * - **stalled** (State C) — a running run, no in-flight tool, heartbeat frozen
 *   past `staleActivityWindowMs` → ONE steered stall nudge per frozen episode,
 *   then `error` if still frozen after `stallNudgeGraceMs`. When upstream's
 *   steer conversion would not take the nudge, a queued run would wait behind
 *   the frozen turn, so the sweep escalates at once instead.
 * - **spinning** (State D, `ENABLE_STATE_D`) — heartbeat advancing, the run's
 *   tool work product flat for `noProgressWindowMs` → a `spinning` advisory on
 *   the parent's next FYI digest (not an attention raise).
 * - **slow tool** — a tool in flight past its deferral → a `slow-tool` advisory.
 *
 * The parent learns of every `error` raise through the dispatcher's attention
 * rail. Nothing is persisted: the per-thread ladders live in this service and
 * restart from scratch, floored at sweep start. The classification and ladder
 * functions are V1's (`WorkstreamLivenessSweep.ts`), unchanged in logic.
 *
 * @module loom/orchestration/liveness/WorkstreamLivenessSweep
 */
import {
  CommandId,
  type LoomThreadWorkstream,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";

import { CommandReceiptStoreV2 } from "../../../orchestration-v2/CommandReceiptStore.ts";
import {
  isNativeMaintenanceCommand,
  OrchestratorV2,
} from "../../../orchestration-v2/Orchestrator.ts";
import { ProviderSessionManagerV2 } from "../../../orchestration-v2/ProviderSessionManager.ts";
import { forkParked } from "../../../serverActivation.ts";
import { LoomStoreV2 } from "../../projection/LoomStore.ts";
import { dispatchServerCommand, type ThreadServerCommand } from "../redrive.ts";
import { controlMessage, stallNudgeCommandId } from "../dispatcher/controlMessage.ts";
import { renderSlowToolDigestLine } from "../dispatcher/digest.ts";
import {
  declaredEstimateMs,
  slowToolDeferralMs,
  slowToolNoticeIndex,
  WORKSTREAM_CONTROL_PLANE_MARKER,
} from "../dispatcher/wakes.ts";
import { WorkstreamDispatcher } from "../dispatcher/WorkstreamDispatcher.ts";
import { LoomHeartbeat, LoomHeartbeatLive } from "./heartbeat.ts";
import {
  type InFlightTool,
  inFlightTool,
  isToolItem,
  TOOL_ITEM_TYPES,
  type ToolTurnItem,
} from "./inFlightTool.ts";
import { readStallContext, renderStallContext, type StallContext } from "./stallContext.ts";

/**
 * State D ("possibly spinning") kill switch. State D is the highest
 * false-positive risk, so flipping this to `false` short-circuits the whole
 * branch with no other edit; everything tagged "State D" is deletable as one unit.
 */
const ENABLE_STATE_D = true;

/**
 * Liveness thresholds (V1's, without the starting-run pair). Generous on purpose:
 * - `sweepIntervalMs` 60 s — responsive without hammering the projection.
 * - `startupGraceMs` 2 min — gates the stall detector so a slow first tool
 *   call is never a stall.
 * - `staleActivityWindowMs` 10 min — a running run whose heartbeat has been
 *   frozen this long is a mid-turn stall.
 * - `failureCap` 3 — consecutive sweeps in a failed state before `error`.
 * - `stallNudgeGraceMs` 2 min — how long a nudged episode may stay frozen
 *   before escalating (a steer is folded in between model rounds).
 * - `noProgressWindowMs` 10 min — State D: how long the work product must stay
 *   flat while the heartbeat advances.
 * - `progressInputSampleSize` 16 — State D: how many recent tool calls feed the
 *   fingerprint (larger is stricter and safer).
 */
export interface LivenessSweepThresholds {
  readonly sweepIntervalMs: number;
  readonly startupGraceMs: number;
  readonly staleActivityWindowMs: number;
  readonly failureCap: number;
  readonly stallNudgeGraceMs: number;
  readonly noProgressWindowMs: number;
  readonly progressInputSampleSize: number;
}

export const DEFAULT_LIVENESS_THRESHOLDS: LivenessSweepThresholds = {
  sweepIntervalMs: 60_000,
  startupGraceMs: 120_000,
  staleActivityWindowMs: 600_000,
  failureCap: 3,
  stallNudgeGraceMs: 120_000,
  noProgressWindowMs: 600_000,
  progressInputSampleSize: 16,
};

export type LivenessVerdictKind = "dead" | "stalled";

export interface LivenessVerdict {
  readonly kind: LivenessVerdictKind;
  readonly reason: string;
  /**
   * Stalled only: the effective "last activity" ms the stall was measured
   * against — the stall-episode key. Same value across sweeps = still frozen
   * since the nudge (→ escalate); a new value = progress (→ re-arm).
   */
  readonly effectiveActivityMs?: number;
}

/**
 * Pending runtime-request kinds that pause a thread on purpose (State B). There
 * is no kind named `approval`; `user_input` is a question and is NOT exempt — a
 * questioning thread can still die or wedge.
 */
export const WAITING_REQUEST_KINDS: ReadonlySet<string> = new Set([
  "command",
  "file-read",
  "file-change",
  "mcp-elicitation",
  "permission",
  "dynamic_tool_call",
  "auth_refresh",
]);

const msOf = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.toEpochMillis(value);

/**
 * A failed observation: the latest run failed with a provider failure class
 * other than `usage_limit` (3c's park-and-resume owns that class).
 */
export const isFailedSession = (
  shell: Pick<OrchestrationV2ThreadShell, "status" | "lastErrorClass">,
): boolean =>
  shell.status === "failed" &&
  shell.lastErrorClass != null &&
  shell.lastErrorClass !== "usage_limit";

/**
 * A successful submit is the strongest liveness proof: when the thread's last
 * recorded outcome is at or after its latest run ended, a stale failure is
 * superseded and must not out-vote it. Pure and timestamp-keyed (V1 2026-07-08
 * incident: a reviewer recovered from a provider error and submitted, yet was
 * marked dead). It also exempts a party parked waiting-in-gate post-submit.
 */
export const submitSupersedesFailure = (
  row: Pick<LoomThreadWorkstream, "lastOutcome">,
  shell: Pick<OrchestrationV2ThreadShell, "latestRunCompletedAt" | "updatedAt">,
): boolean =>
  row.lastOutcome !== null &&
  Date.parse(row.lastOutcome.at) >=
    DateTime.toEpochMillis(shell.latestRunCompletedAt ?? shell.updatedAt);

export interface LivenessClassifyInput {
  readonly shell: Pick<
    OrchestrationV2ThreadShell,
    "pendingRuntimeRequest" | "activityRunStatus" | "activityRunStartedAt"
  >;
  /** The in-memory heartbeat (ms), floored at process start. */
  readonly heartbeatMs: number;
  /** A tool call is running: a quiet-but-running tool is never a stall (the slow-tool advisory owns it). */
  readonly hasInFlightTool: boolean;
  readonly failureCount: number;
  /**
   * When this sweep started. A thread cannot have stalled while no server was
   * watching, so the stall clock never reaches back past boot.
   */
  readonly sweepStartedAtMs: number;
  readonly now: number;
  readonly thresholds: LivenessSweepThresholds;
}

/**
 * Pure liveness classification for one active sub-thread: the verdict to act
 * on, or `null` (healthy / waiting / within grace).
 */
export const classifyLiveness = (input: LivenessClassifyInput): LivenessVerdict | null => {
  const { shell, heartbeatMs, hasInFlightTool, failureCount, sweepStartedAtMs, now, thresholds } =
    input;

  // State B — waiting on an approval: intentionally paused, never a fault.
  if (
    shell.pendingRuntimeRequest !== null &&
    WAITING_REQUEST_KINDS.has(shell.pendingRuntimeRequest.kind)
  )
    return null;

  // State A — dead (circuit breaker): a failed state sustained past the cap.
  if (failureCount >= thresholds.failureCap) {
    return {
      kind: "dead",
      reason: `Session repeatedly failed (${failureCount} consecutive sweeps with a failed latest run); circuit breaker tripped.`,
    };
  }

  // State C — stall: a running run whose heartbeat froze past the window, after
  // the startup grace, and never while a tool call is in flight.
  if (shell.activityRunStatus === "running" && !hasInFlightTool) {
    const startedAtMs = msOf(shell.activityRunStartedAt);
    const runAgeMs = startedAtMs === null ? 0 : now - startedAtMs;
    if (runAgeMs < thresholds.startupGraceMs) return null;
    const lastActivityMs = Math.max(heartbeatMs, startedAtMs ?? 0, sweepStartedAtMs);
    const sinceActivityMs = now - lastActivityMs;
    if (sinceActivityMs > thresholds.staleActivityWindowMs) {
      return {
        kind: "stalled",
        reason: `Mid-turn stall: no runtime activity for ${Math.round(sinceActivityMs / 1000)}s during a running turn.`,
        effectiveActivityMs: lastActivityMs,
      };
    }
  }

  return null;
};

export type StallAction = "nudge" | "escalate" | "wait";

/**
 * Pure stall ladder. `nudge` on the first sweep of an episode; `escalate` when
 * the same episode is still frozen after the nudge grace, OR when there is no
 * open turn the nudge can steer into (under V2: upstream's steer conversion
 * would not take it, so a queued run would wait behind the frozen turn); `wait`
 * while a nudged episode is within its grace. A new `episodeMs` re-arms.
 */
export const decideStallAction = (input: {
  readonly priorEpisodeMs: number | null;
  readonly episodeMs: number;
  /** A running turn the nudge would steer into. */
  readonly hasOpenTurn: boolean;
  /** ms since this episode was nudged; null when it never was. */
  readonly msSinceNudge: number | null;
  readonly nudgeGraceMs: number;
}): StallAction =>
  input.priorEpisodeMs === input.episodeMs
    ? input.msSinceNudge !== null && input.msSinceNudge < input.nudgeGraceMs
      ? "wait"
      : "escalate"
    : input.hasOpenTurn
      ? "nudge"
      : "escalate";

// ─── State D — possibly spinning (progress, not repetition) ──────────────────

/** cyrb53 — a cheap deterministic string hash; collisions are irrelevant for change detection. */
const hashSource = (source: string): string => {
  let h1 = 0xdeadbeef ^ source.length;
  let h2 = 0x41c6ce57 ^ source.length;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};

/**
 * State D's work-product fingerprint. The within-turn tool-call CONTENT is the
 * signal that grows with distinct edits (checkpoints only land at turn end);
 * hashing the content, not a display string, is load-bearing. V2 has no
 * within-turn checkpoint source, so the sweep passes `checkpointSource: null`.
 */
export const computeProgressFingerprint = (signal: {
  readonly recentInputsSource: string | null;
  readonly checkpointSource: string | null;
}): string =>
  hashSource(`${signal.checkpointSource ?? ""}\u0000${signal.recentInputsSource ?? ""}`);

/** A completed tool call's content for the fingerprint: what it ran or wrote. */
export const toolInputSource = (item: ToolTurnItem): string =>
  item.type === "command_execution"
    ? `command:${item.input}`
    : item.type === "file_change"
      ? `file:${item.fileName}:${item.diffStr ?? item.newStr ?? ""}`
      : `tool:${item.toolName ?? ""}:${JSON.stringify(item.input)}`;

/** Per-thread State-D bookkeeping: the last fingerprint, since when it is flat, and whether this episode was advised. */
export interface ProgressLoopState {
  readonly fingerprint: string;
  readonly flatSinceMs: number;
  readonly advised: boolean;
}

/**
 * Pure State-D decision: re-arm on a changed fingerprint (or first sight);
 * advise exactly once when it stayed flat for `noProgressWindowMs`.
 */
export const decideProgressLoop = (input: {
  readonly prior: ProgressLoopState | null;
  readonly fingerprint: string;
  readonly now: number;
  readonly noProgressWindowMs: number;
}): { readonly next: ProgressLoopState; readonly advise: boolean } => {
  const { prior, fingerprint, now, noProgressWindowMs } = input;
  if (prior === null || prior.fingerprint !== fingerprint) {
    return { next: { fingerprint, flatSinceMs: now, advised: false }, advise: false };
  }
  if (!prior.advised && now - prior.flatSinceMs >= noProgressWindowMs) {
    return { next: { ...prior, advised: true }, advise: true };
  }
  return { next: prior, advise: false };
};

/** The informed recovery nudge steered into a stalled child's running turn. */
export const buildStallNudgeMessage = (
  verdict: LivenessVerdict,
  context: StallContext | null,
): string =>
  [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    `Your current turn appears to have stalled (${verdict.reason}). This is an automated recovery nudge, not a message from the user.`,
    "",
    "What we found in this run:",
    "",
    renderStallContext(context),
    "",
    "Continue from where you left off: address the issue above and proceed, or — if you are genuinely blocked — stop and explain what you need (`mcp__t3-code__workstream_request_attention` with `needs_guidance`).",
  ].join("\n");

/** The `error` raise on a dead child, one per failed run. */
export const livenessDeadCommandId = (childId: ThreadId, runId: RunId) =>
  `server:workstream-liveness:dead:${childId}:${runId}`;
/** The `error` raise on a stalled child, one per frozen episode. */
export const livenessStallCommandId = (childId: ThreadId, episodeMs: number) =>
  `server:workstream-liveness:stall:${childId}:${episodeMs}`;

/** Logs an error or defect instead of failing (interruption still propagates). */
const logFailure =
  (label: string, fields: Record<string, unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.asVoid,
      Effect.catch((error) => Effect.logWarning(label, { ...fields, error })),
      Effect.catchDefect((defect) => Effect.logWarning(label, { ...fields, defect })),
    );

export interface WorkstreamLivenessSweepShape {
  /** Starts the sweep on its own `sweepIntervalMs` tick, after server activation. */
  readonly start: Effect.Effect<void, never, Scope.Scope>;
  /** One sweep over every active Loom sub-thread; never fails (tests drive it directly). */
  readonly sweep: Effect.Effect<void>;
}

export class WorkstreamLivenessSweep extends Context.Service<
  WorkstreamLivenessSweep,
  WorkstreamLivenessSweepShape
>()("t3/loom/orchestration/liveness/WorkstreamLivenessSweep") {}

const make = (thresholds: LivenessSweepThresholds) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const loomStore = yield* LoomStoreV2;
    const sessions = yield* ProviderSessionManagerV2;
    const dispatcher = yield* WorkstreamDispatcher;
    const heartbeat = yield* LoomHeartbeat;
    const services = yield* Effect.context<CommandReceiptStoreV2 | OrchestratorV2>();
    const sweepStartedAtMs = DateTime.toEpochMillis(yield* DateTime.now);

    // Per-thread ladders; plain maps are safe because the sweep runs serially.
    /** Consecutive failed observations (State A's circuit-breaker counter). */
    const failureCounts = new Map<ThreadId, number>();
    /** The nudged stall episode and when (State C). */
    const stallNudges = new Map<
      ThreadId,
      { readonly episodeMs: number; readonly nudgedAtMs: number }
    >();
    /** State D's fingerprint episode. */
    const progressLoop = new Map<ThreadId, ProgressLoopState>();
    /** The last slow-tool ladder step advised per in-flight call. */
    const slowTools = new Map<ThreadId, { readonly itemId: string; readonly index: number }>();

    /** Dispatches under the receipt discipline; true when the command landed (now or before). */
    const send = (label: string, command: ThreadServerCommand) =>
      dispatchServerCommand(command).pipe(
        Effect.tap((outcome) =>
          outcome.status === "accepted"
            ? Effect.logInfo(label, { threadId: command.threadId, commandId: command.commandId })
            : Effect.void,
        ),
        // Settled: landed now or earlier, or dead (rejected and receipted — V1's `settled`, so
        // the ladder escalates after the grace instead of retrying a dead id forever). Only a
        // deferral is retried.
        Effect.map((outcome) => outcome.status !== "deferred"),
      );

    const raiseError = (label: string, threadId: ThreadId, id: string) =>
      Effect.flatMap(DateTime.now, (now) =>
        send(label, {
          type: "thread.attention.raise",
          commandId: CommandId.make(id),
          threadId,
          createdAt: DateTime.formatIso(now),
          reason: "error",
        }),
      );

    /**
     * Upstream's steer-conversion predicate for a queued Loom control message
     * (`Orchestrator.ts` dispatchMessage): a running run with a running provider
     * turn on its active attempt, a live session that supports active steering
     * without cancelling tools, and not a native maintenance command (`/compact`).
     */
    const isSteerable = Effect.fn("loom.liveness.isSteerable")(function* (threadId: ThreadId) {
      const { runs, providerThreads, providerTurns } = yield* orchestrator.getThreadRecords(
        threadId,
        ["runs", "providerThreads", "providerTurns"],
      );
      const active = runs.find((run) => run.status === "running");
      if (active === undefined) return false;
      const providerSessionId = providerThreads.find(
        (row) => row.id === active.providerThreadId,
      )?.providerSessionId;
      const turnRunning = providerTurns.some(
        (turn) => turn.runAttemptId === active.activeAttemptId && turn.status === "running",
      );
      if (!turnRunning || providerSessionId == null) return false;
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"], {
        messageIds: [active.userMessageId],
      });
      if (messages.some(isNativeMaintenanceCommand)) return false;
      const session = yield* sessions
        .get(providerSessionId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      return (
        Option.isSome(session) &&
        session.value.providerSession.capabilities.turns.supportsActiveSteering &&
        session.value.providerSession.capabilities.turns.activeSteeringInterruptsTools !== true
      );
    });

    // State A: `error` on the child, one per failed run; the attention rail wakes the parent.
    const markDead = (
      row: LoomThreadWorkstream,
      shell: OrchestrationV2ThreadShell,
      reason: string,
    ) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("workstream.liveness.dead", { threadId: row.threadId, reason });
        yield* raiseError(
          "workstream.liveness.dead-raised",
          row.threadId,
          livenessDeadCommandId(row.threadId, shell.latestRunId!),
        );
        failureCounts.delete(row.threadId);
      });

    // The slow-tool advisory: once per ladder step of one in-flight call.
    const adviseSlowTool = Effect.fn("loom.liveness.adviseSlowTool")(function* (
      row: LoomThreadWorkstream,
      tool: InFlightTool,
      now: number,
    ) {
      const estimateMs = declaredEstimateMs({
        commandText: tool.commandText,
        timeoutSeconds: null,
      });
      const inFlightMs = now - tool.startedAtMs;
      const index = slowToolNoticeIndex(inFlightMs, slowToolDeferralMs(estimateMs));
      const prior = slowTools.get(row.threadId);
      if (index < 0 || (prior?.itemId === tool.itemId && prior.index >= index)) return;
      slowTools.set(row.threadId, { itemId: tool.itemId, index });
      const line = renderSlowToolDigestLine({
        id: row.threadId,
        role: row.role,
        toolName: tool.toolName,
        inFlightMs,
        quietMs: now - heartbeat.lastHeartbeatMs(row.threadId),
        estimateMs: estimateMs ?? undefined,
      });
      yield* dispatcher.advise({
        parentId: row.parentThreadId!,
        item: {
          kind: "slow-tool",
          threadId: row.threadId,
          ...(row.role === null ? {} : { role: row.role }),
          title: "Still executing",
          status: "slow-tool",
          excerpt: line.replace(/^-\s*/, ""),
        },
        episodeKey: `slow-tool:${row.threadId}:${tool.itemId}:${index}`,
        episodeStartedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
      });
    });

    // State D: busy (running, past the startup grace, heartbeat fresh, no tool in flight).
    const judgeProgress = Effect.fn("loom.liveness.judgeProgress")(function* (
      row: LoomThreadWorkstream,
      shell: OrchestrationV2ThreadShell,
      now: number,
    ) {
      const startedAtMs = msOf(shell.activityRunStartedAt);
      const busy =
        ENABLE_STATE_D &&
        shell.activityRunStatus === "running" &&
        shell.activeRunId !== null &&
        startedAtMs !== null &&
        now - startedAtMs >= thresholds.startupGraceMs;
      if (!busy) {
        progressLoop.delete(row.threadId);
        return;
      }
      const { turnItems } = yield* orchestrator.getThreadRecords(row.threadId, ["turnItems"], {
        turnItemRunId: shell.activeRunId!,
        turnItemTypes: TOOL_ITEM_TYPES,
        turnItemStatuses: ["completed", "failed"],
      });
      const recentInputsSource = turnItems
        .filter(isToolItem)
        .toSorted((left, right) => left.ordinal - right.ordinal)
        .slice(-thresholds.progressInputSampleSize)
        .map(toolInputSource)
        .join("\u0001");
      const decision = decideProgressLoop({
        prior: progressLoop.get(row.threadId) ?? null,
        fingerprint: computeProgressFingerprint({ recentInputsSource, checkpointSource: null }),
        now,
        noProgressWindowMs: thresholds.noProgressWindowMs,
      });
      progressLoop.set(row.threadId, decision.next);
      if (!decision.advise) return;
      const busyMinutes = Math.round((now - decision.next.flatSinceMs) / 60_000);
      yield* dispatcher.advise({
        parentId: row.parentThreadId!,
        item: {
          kind: "spinning",
          threadId: row.threadId,
          ...(row.role === null ? {} : { role: row.role }),
          title: "No visible progress",
          status: "spinning",
          excerpt: `🌀 ${row.role ?? "sub-thread"} \`${row.threadId}\` possibly spinning — busy ~${busyMinutes} min (heartbeat advancing) but its work product has not changed: no new tool inputs or edits over the window. Informational, not a fault; it is still running.`,
        },
        episodeKey: `spinning:${row.threadId}:${decision.next.flatSinceMs}`,
        episodeStartedAt: DateTime.formatIso(DateTime.makeUnsafe(decision.next.flatSinceMs)),
      });
    });

    const judge = Effect.fn("loom.liveness.judge")(function* (
      row: LoomThreadWorkstream,
      shell: OrchestrationV2ThreadShell,
      now: number,
    ) {
      const id = row.threadId;
      const failureObserved = !submitSupersedesFailure(row, shell) && isFailedSession(shell);
      const failureCount = failureObserved ? (failureCounts.get(id) ?? 0) + 1 : 0;
      if (failureObserved) failureCounts.set(id, failureCount);
      else failureCounts.delete(id);

      // A flagged thread is never nudged or advised again, but it can still die.
      if (row.attention.length > 0) {
        stallNudges.delete(id);
        progressLoop.delete(id);
        slowTools.delete(id);
        if (failureCount >= thresholds.failureCap && !row.attention.includes("error"))
          yield* markDead(row, shell, `${failureCount} consecutive failed sweeps (flagged)`);
        return;
      }

      const tool = shell.activityRunStatus === "running" ? yield* inFlightTool(id) : null;
      const verdict = classifyLiveness({
        shell,
        heartbeatMs: heartbeat.lastHeartbeatMs(id),
        hasInFlightTool: tool !== null,
        failureCount,
        sweepStartedAtMs,
        now,
        thresholds,
      });

      if (verdict === null) {
        stallNudges.delete(id);
        if (tool !== null) {
          // One long call reads as flat by construction: the slow-tool advisory owns it, never State D.
          progressLoop.delete(id);
          return yield* adviseSlowTool(row, tool, now);
        }
        slowTools.delete(id);
        return yield* judgeProgress(row, shell, now);
      }
      progressLoop.delete(id);
      slowTools.delete(id);

      if (verdict.kind === "dead") {
        stallNudges.delete(id);
        return yield* markDead(row, shell, verdict.reason);
      }

      // State C: the stall ladder.
      const episodeMs = verdict.effectiveActivityMs!;
      const prior = stallNudges.get(id);
      const action = decideStallAction({
        priorEpisodeMs: prior?.episodeMs ?? null,
        episodeMs,
        // Only a fresh episode asks whether the nudge would steer.
        hasOpenTurn: prior?.episodeMs === episodeMs || (yield* isSteerable(id)),
        msSinceNudge: prior === undefined ? null : now - prior.nudgedAtMs,
        nudgeGraceMs: thresholds.stallNudgeGraceMs,
      });
      if (action === "wait") return;
      if (action === "escalate") {
        yield* Effect.logWarning("workstream.liveness.stall-escalate", {
          threadId: id,
          reason: verdict.reason,
          nudged: prior !== undefined,
        });
        stallNudges.delete(id);
        return yield* raiseError(
          "workstream.liveness.stall-raised",
          id,
          livenessStallCommandId(id, episodeMs),
        );
      }
      const context = yield* readStallContext(id, shell.activeRunId!);
      const nudged = yield* send(
        "workstream.liveness.stall-nudge",
        controlMessage({
          threadId: id,
          id: stallNudgeCommandId(id, episodeMs),
          tier: "steered",
          origin: "control_notice",
          text: buildStallNudgeMessage(verdict, context),
          payload: {
            kind: "notice",
            notice: "stall-nudge",
            heading: "Your turn appears to have stalled.",
            items: [
              {
                threadId: id,
                ...(row.role === null ? {} : { role: row.role }),
                title: "Stall nudge",
                status: "stalled",
                excerpt: verdict.reason,
              },
            ],
          },
        }),
      );
      // A settled nudge (landed, or dead) starts the grace; a deferred one is retried next sweep.
      if (nudged) stallNudges.set(id, { episodeMs, nudgedAtMs: now });
    });

    const sweep = Effect.gen(function* () {
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      const rows = yield* loomStore.listActiveWorkstreams();
      const shells = new Map(
        (yield* orchestrator.getShellSnapshot()).threads.map((shell) => [shell.id, shell]),
      );
      const judged = new Set<ThreadId>();
      for (const row of rows) {
        const shell = shells.get(row.threadId);
        // Sub-threads only, never a finished one, and only once a run exists (promotion owns the rest).
        if (row.parentThreadId === null || row.outcome !== null || shell?.latestRunId == null)
          continue;
        judged.add(row.threadId);
        yield* judge(row, shell, now).pipe(
          logFailure("workstream.liveness.thread-failed", { threadId: row.threadId }),
        );
      }
      for (const ladder of [failureCounts, stallNudges, progressLoop, slowTools])
        for (const id of ladder.keys()) if (!judged.has(id)) ladder.delete(id);
    }).pipe(logFailure("workstream.liveness.sweep-failed", {}), Effect.provideContext(services));

    return {
      start: forkParked(
        Effect.gen(function* () {
          yield* Effect.logInfo("workstream.liveness.started", { ...thresholds, ENABLE_STATE_D });
          yield* sweep.pipe(
            Effect.repeat(Schedule.spaced(Duration.millis(thresholds.sweepIntervalMs))),
          );
        }),
      ),
      sweep,
    } satisfies WorkstreamLivenessSweepShape;
  });

/** The sweep service (not started) and its heartbeat; tests drive `sweep`. Needs a `WorkstreamDispatcher`. */
export const makeWorkstreamLivenessSweepLive = (
  thresholds: LivenessSweepThresholds = DEFAULT_LIVENESS_THRESHOLDS,
) =>
  Layer.effect(WorkstreamLivenessSweep, make(thresholds)).pipe(
    Layer.provideMerge(LoomHeartbeatLive),
  );

/** The sweep, started post-activation: the production layer. */
export const WorkstreamLivenessSweepLive = Layer.effectDiscard(
  Effect.flatMap(WorkstreamLivenessSweep, (sweep) => sweep.start),
).pipe(Layer.provide(makeWorkstreamLivenessSweepLive()));
