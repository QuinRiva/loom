/**
 * loom: stuckLaunchRecovery — the single recovery for a session wedged in
 * `starting` with no live provider turn. Fork-owned in full (no upstream file
 * defines or consumes it); it lives beside its two fork-owned call sites
 * (`loom/startup.ts`, `Layers/WorkstreamLivenessSweep.ts`) rather than inside
 * either, because BOTH call it and the shared predicate/CAS contract is exactly
 * what must not drift between boot-time and runtime recovery.
 *
 * ## The wedge
 *
 * `ProviderCommandReactor` writes `session.status = "starting"` the moment a
 * turn-start is accepted but before the runtime reports `turn.started`
 * (`activeTurnId` is still null in that window). Normally the runtime's
 * `turn.started` ingestion flips it to `running`. When that ingestion never
 * lands — an event-queue backlog discarded by a restart is the observed cause —
 * the pair (`starting`, `activeTurnId: null`) becomes permanent and had ZERO
 * recovery coverage:
 *
 * - the UI shows "Connecting" forever (`derivePhase` maps `starting → connecting`);
 * - `selectThreadsToDispatch` requires `session === null`, so a never-launched
 *   child is never re-dispatched;
 * - `classifyLiveness`'s stall detector only judged sessions with an OPEN turn
 *   (`activeTurnId !== null`), so the sweep could not see it either;
 * - a gated reviewer wedged this way sits `plan_lane = in_progress` (set eagerly
 *   at kickoff) and its review gate can never resolve, stranding the parent.
 *
 * ## The recovery, and why it is a resume rather than a re-dispatch
 *
 * Two steps per wedged thread:
 *
 *   1. ONE compare-and-swap transaction (`thread.stuck-launch.recover`) that
 *      clears the stale pending turn-start row (otherwise the thread never reads
 *      idle and step 2 defers forever) AND installs a `ready`/idle session — but
 *      only if the thread is still in the exact session state the caller judged.
 *      This alone unwedges the UI and makes the thread promptable again.
 *   2. resume with ONE `requireIdle` turn-start whose text depends on whether the
 *      kickoff was ever delivered to the provider (the D8 marker): an undelivered
 *      kickoff is RE-COMPOSED and re-delivered verbatim, a delivered one gets a
 *      neutral "your launch was interrupted, continue" control notice.
 *
 * Step 3 is deliberately a resume and NOT a dispatcher re-dispatch. Making the
 * dispatcher treat a `starting` session as un-started would need the session
 * nulled and `latestUserMessageAt` un-recorded — neither is expressible in the
 * event model — and it is precisely the path that risks the double-launch the
 * recovery must never cause. Re-delivering the composed kickoff through the
 * ordinary turn-start path is equivalent in effect (the child receives the exact
 * prompt the dispatcher would have sent) and strictly safer.
 *
 * ## The eager `in_progress` plan lane is left alone, on purpose
 *
 * A dispatcher kickoff sets `in_progress` atomically with the turn-start, so a
 * child wedged mid-launch sits `in_progress` having never run — and a gated
 * reviewer in that state makes its review gate permanently unresolvable. The fix
 * is to give that lane a way FORWARD (step 3's resume), not to walk the lane
 * backwards: demoting to `ready` would hand the child to
 * `selectThreadsToDispatch` while it still holds a session and a recorded user
 * message, so the dispatcher would either skip it anyway (its gates require
 * `session === null`) or, if those gates were also loosened, launch a second turn
 * alongside this one. `in_progress` with a live resumed turn is the honest state:
 * the lane says what is true and the gate resolves the moment the child submits.
 *
 * ## Why a double launch is impossible
 *
 * The load-bearing guard is the **compare-and-swap**, not `requireIdle`. Both
 * callers judge the wedge from a snapshot plus a provider-liveness sample, and
 * both are already stale when the write arrives; `requireIdle` alone cannot save
 * us there, because an UNCONDITIONAL reset would itself manufacture exactly the
 * idleness that gate tests for (clear the pending row, overwrite `starting` with
 * `ready`, and the gate waves the second launch through). So:
 *
 * - Step 1 is conditional on TWO tokens, and it needs both. `expectedSessionUpdatedAt`
 *   catches anything that rewrites the session row (notably the `starting` restamp
 *   `ProviderCommandReactor` makes once a launch progresses). But a genuine
 *   `thread.turn.start` writes NO session event in its own transaction — it emits
 *   `thread.message-sent` + `thread.turn-start-requested`, and the session restamp
 *   arrives later, asynchronously. In that window a session-only CAS would wrongly
 *   succeed, clear the NEW pending row, and reset to `ready`. So the repair also
 *   pins `expectedLatestUserMessageAt`, which `thread.message-sent` bumps
 *   synchronously in that same transaction: any accepted turn-start moves at least
 *   one token, and the repair is refused wholesale. The decider re-asserts the
 *   wedge shape too, so this can never degrade into a general "force this session
 *   to ready" primitive.
 * - Because the CAS covers the pending-clear and the reset in ONE transaction,
 *   there is no window where the pending row is gone but the session is not yet
 *   reset (or vice versa) for another producer to misread.
 * - The resume is only dispatched when the CAS was actually applied, and is still
 *   `requireIdle: true` — now as genuine defence in depth, re-validated against
 *   just-committed state at the serialized boundary.
 * - {@link isStuckLaunch} requires an authoritative "no live provider launch"
 *   verdict, which callers must compute fail-CLOSED (unknown ⇒ live).
 * - Runtime callers additionally hold off for a generous grace window
 *   ({@link DEFAULT_STUCK_LAUNCH_GRACE_MS}), so a slow-but-real launch is never
 *   judged.
 * - Every command id is episode-keyed (`session.updatedAt`), so a retry inside
 *   one episode is receipt-deduped while a genuinely fresh wedge re-arms.
 *
 * @module stuckLaunchRecovery
 */
import {
  CommandId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { isKickoffDelivered } from "./workstreamLaunchIdentity.ts";
import { readWorkstreamBriefAt } from "./workstreamBrief.ts";
import { workstreamChildPrompt } from "./workstreamChildPrompt.ts";

/**
 * How long a session may sit `starting` with no live provider launch before a
 * RUNTIME caller (the liveness sweep) treats it as wedged. Deliberately generous
 * — the asymmetry is the whole point: missing a wedge for another sweep cycle
 * costs a minute, resetting a session that is genuinely mid-launch would kill
 * live work. 15 minutes comfortably exceeds any real launch (worktree
 * provisioning, provider spawn, MCP handshake, first prompt acceptance), all of
 * which register a provider session or an active binding long before then.
 *
 * The BOOT caller passes 0 instead: at startup nothing can be mid-launch (no
 * command has been accepted yet and provider processes die with the server), so
 * a `starting` row is necessarily leftover from the previous process.
 */
export const DEFAULT_STUCK_LAUNCH_GRACE_MS = 900_000;

/**
 * The wedge's episode key: the ms timestamp of the `session-set` that wrote
 * `starting`. Stable while the thread stays wedged (nothing else advances it),
 * and it necessarily changes the moment a recovery reset lands — which is what
 * makes it a sound dedup key for both the command ids and the sweep's
 * recover-then-escalate ladder.
 */
export const stuckLaunchEpisodeMs = (session: Pick<OrchestrationSession, "updatedAt">): number => {
  const ms = Date.parse(session.updatedAt);
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * Is this session wedged mid-launch? `hasLiveProviderLaunch` is the
 * authoritative liveness input and MUST be computed fail-closed by the caller
 * (any doubt ⇒ `true`), because it is the only thing standing between this
 * predicate and a reset of live work.
 *
 * `graceMs: 0` means "no grace window" outright, not "elapsed must be ≥ 0": the
 * boot caller has no age question to ask (nothing can be mid-launch at startup)
 * and must stay immune to a future-dated `updatedAt` from clock skew.
 */
export const isStuckLaunch = (input: {
  readonly session: Pick<OrchestrationSession, "status" | "activeTurnId" | "updatedAt">;
  readonly hasLiveProviderLaunch: boolean;
  readonly now: number;
  readonly graceMs: number;
}): boolean =>
  input.session.status === "starting" &&
  input.session.activeTurnId === null &&
  !input.hasLiveProviderLaunch &&
  (input.graceMs <= 0 || input.now - stuckLaunchEpisodeMs(input.session) >= input.graceMs);

/**
 * May a reconciled thread be RESUMED (as opposed to reset only)? Shared by the
 * interrupted-turn path in `loom/startup.ts` and by the stuck-launch recovery
 * here so the two can never drift:
 *
 * - a thread parked on a human (pending approval / user input) or already flagged
 *   for attention must not be resumed — a turn-start clears the flag and the
 *   human-facing wait, and a human is already the way forward;
 * - archived / soft-deleted / cancelled threads must not be revived — hidden or
 *   explicitly abandoned work stays abandoned. `done` IS resumable (an
 *   interrupted follow-up turn is legitimate).
 */
export const isRecoveryResumable = (input: {
  readonly attentionCount: number;
  readonly parkedOnHuman: boolean;
  readonly archived: boolean;
  readonly deleted: boolean;
  readonly cancelled: boolean;
}): boolean =>
  input.attentionCount === 0 &&
  !input.parkedOnHuman &&
  !input.archived &&
  !input.deleted &&
  !input.cancelled;

const CONTROL_PLANE_MARKER = "[T3 Workstream control plane — automated notice, not from the user]";

/**
 * The resume text for a recovered wedge. `composedKickoff` is non-null ONLY when
 * the thread's kickoff was never delivered to the provider, in which case the
 * generic "continue where you left off" would be silent corruption — nothing was
 * left off — so the composed kickoff is re-delivered verbatim instead. Mirrors
 * the D8 contract in `ExhaustionResumeSweep`.
 */
export const buildStuckLaunchResumeMessage = (composedKickoff: string | null): string =>
  composedKickoff === null
    ? [
        CONTROL_PLANE_MARKER,
        "",
        "Your session was left mid-launch: the turn was requested and your work may have started, but the runtime never confirmed the turn, so the session was stuck. It has been reset and this is an automated recovery turn, not a message from the user.",
        "",
        "Resume from where you left off and finish the work. If you had already completed it, proceed to your normal completion step (e.g. workstream_submit).",
      ].join("\n")
    : [
        CONTROL_PLANE_MARKER,
        "",
        "Your session was stuck mid-launch and your kickoff brief was never delivered, so nothing has been started yet. This is an automated recovery turn, not a message from the user. Start now from the brief below:",
        "",
        composedKickoff,
      ].join("\n");

/** The thread fields the recovery needs; both the shell and the read-model thread satisfy it. */
export type StuckLaunchThread = Pick<
  OrchestrationThreadShell,
  "id" | "title" | "role" | "kickoffBriefPath" | "runtimeMode" | "interactionMode"
>;

/**
 * The second CAS witness: the thread's latest USER-message timestamp as the
 * caller observed it (null when it has none). Passed explicitly rather than read
 * off the thread because the two callers hold different shapes — the sweep has
 * the shell's `latestUserMessageAt` projection, while boot has the read-model
 * thread's `messages` array — and {@link latestUserMessageAtOf} derives it from
 * the latter. The decider recomputes it the same way from committed state.
 */
export const latestUserMessageAtOf = (thread: {
  readonly messages?: ReadonlyArray<{ readonly role: string; readonly createdAt: string }>;
}): string | null =>
  (thread.messages ?? []).reduce<string | null>(
    (latest, message) =>
      message.role !== "user"
        ? latest
        : latest === null || Date.parse(message.createdAt) > Date.parse(latest)
          ? message.createdAt
          : latest,
    null,
  );

/**
 * Providers whose driver actually writes the D8 kickoff-delivered marker, and for
 * which marker ABSENCE is therefore real evidence that the kickoff never reached
 * the agent.
 *
 * Only the pi driver writes it (`PiDriver` at its prompt-accepted boundary). For
 * every other driver the marker is absent ALWAYS — delivered or not — so treating
 * absence as proof of non-delivery there would re-send the full brief to a
 * Claude/Codex/OpenCode/Cursor/Grok child that had already accepted it and
 * possibly finished the work.
 *
 * The asymmetry decides the default: re-delivering a brief to a thread that
 * already acted on it can duplicate real work (edits, commits, submits) and needs
 * a human to untangle, whereas sending the neutral continue notice to a thread
 * that never got its brief is merely unhelpful — the agent says it has nothing to
 * go on and the parent re-prompts. So replay requires POSITIVE capability
 * evidence, and every provider that cannot furnish it fails safe to "continue".
 */
const KICKOFF_MARKER_PROVIDERS: ReadonlySet<string> = new Set(["pi"]);

/**
 * Is marker absence trustworthy evidence of non-delivery for this session's
 * provider? `providerName` is nullable on the session record; unknown counts as
 * not-trustworthy (fail safe).
 */
export const kickoffDeliveryEvidenceAvailable = (providerName: string | null): boolean =>
  providerName !== null && KICKOFF_MARKER_PROVIDERS.has(providerName);

/**
 * Compose the resume text for a wedged thread: re-deliver the kickoff only when
 * the thread still carries the role + on-disk brief needed to recompose it AND
 * its provider can actually attest delivery AND that attestation says the kickoff
 * never landed. Otherwise the neutral continue notice.
 *
 * A DELIVERED kickoff always takes the continue path — that is what stops a
 * delivered-then-wedged brief from being re-prepended to a transcript that
 * already has it. A provider that cannot attest at all is treated the same way,
 * per {@link KICKOFF_MARKER_PROVIDERS}.
 */
export const resolveStuckLaunchResumeText = Effect.fn("stuckLaunchRecovery.resolveResumeText")(
  function* (input: {
    readonly thread: StuckLaunchThread;
    readonly launchIdentityDir: string;
    /** `session.providerName` — decides whether marker absence means anything. */
    readonly providerName: string | null;
  }) {
    const { thread, launchIdentityDir, providerName } = input;
    const { role, kickoffBriefPath } = thread;
    if (
      role === null ||
      kickoffBriefPath === null ||
      !kickoffDeliveryEvidenceAvailable(providerName) ||
      isKickoffDelivered(launchIdentityDir, thread.id)
    ) {
      return buildStuckLaunchResumeMessage(null);
    }
    const brief = Option.getOrUndefined(yield* readWorkstreamBriefAt(kickoffBriefPath));
    return buildStuckLaunchResumeMessage(
      brief === undefined ? null : workstreamChildPrompt({ role, brief }),
    );
  },
);

/**
 * Recover ONE wedged thread: clear its stale pending turn-start (when the caller
 * says one exists), reset the session to `ready`/idle, and — when `resume` — send
 * a single `requireIdle` turn-start carrying {@link resolveStuckLaunchResumeText}.
 *
 * `scope` namespaces the command ids so the boot pass and the runtime sweep can
 * never cross-dedup: the sweep passes a constant (episode-keyed dedup within one
 * wedge), boot passes a per-boot random id so an attempt lost to a crash is
 * retried on the next boot instead of being permanently receipt-deduped.
 *
 * Returns `{ repaired, resumed }`: `repaired` is false when the compare-and-swap
 * lost (the thread left the state we judged — the safe outcome, nothing was
 * written), and `resumed` says whether a recovery turn was actually launched.
 * Resume failures/deferrals are swallowed and logged: the reset is the
 * load-bearing half and must never be undone by a failed resume, and the caller
 * keeps reconciling its other threads.
 */
export const recoverStuckLaunch = Effect.fn("stuckLaunchRecovery.recover")(function* (input: {
  readonly thread: StuckLaunchThread;
  readonly session: OrchestrationSession;
  /**
   * The second CAS witness as the caller observed it (see
   * {@link latestUserMessageAtOf}). Load-bearing: without it a turn-start that has
   * been accepted but not yet restamped into the session slips through.
   */
  readonly latestUserMessageAt: string | null;
  /** Clear a stale pending turn-start row. Skip it when the caller already did. */
  readonly clearPendingTurnStart: boolean;
  readonly resume: boolean;
  readonly launchIdentityDir: string;
  readonly scope: string;
}) {
  const { thread, session, resume, launchIdentityDir, scope } = input;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const episodeMs = stuckLaunchEpisodeMs(session);
  const idFor = (kind: string) =>
    CommandId.make(`server:stuck-launch-${kind}:${scope}:${thread.id}:${episodeMs}`);

  // 1+2. The repair, as ONE compare-and-swap transaction: clear the stale pending
  //      turn-start (it would otherwise keep the thread permanently non-idle and
  //      strand the resume) and install the reconciled `ready` session, but ONLY
  //      if the thread is still in the exact session state we judged. The decider
  //      rejects the whole thing on any mismatch, so a real turn-start that landed
  //      since our snapshot cannot be erased by us. This is the load-bearing
  //      double-launch guard: `requireIdle` on step 3 is NOT sufficient on its own,
  //      because an unconditional reset would itself manufacture the idleness that
  //      gate checks for.
  const repaired = yield* engine
    .dispatch({
      type: "thread.stuck-launch.recover",
      commandId: idFor("recover"),
      threadId: thread.id,
      expectedSessionUpdatedAt: session.updatedAt,
      expectedLatestUserMessageAt: input.latestUserMessageAt,
      session: {
        ...session,
        status: "ready",
        activeTurnId: null,
        lastError: null,
        queuedMessages: { steering: [], followUp: [] },
        updatedAt: now,
      },
      ...(input.clearPendingTurnStart ? { clearPendingTurnStart: true } : {}),
      detail: "Reconciled a stale pending turn-start on a session wedged in `starting`.",
      createdAt: now,
    } satisfies OrchestrationCommand)
    .pipe(
      Effect.as(true),
      // A rejected CAS is the SAFE outcome, not an error: the thread moved on
      // (most likely it genuinely came alive), so there is nothing to repair.
      Effect.catchCause((cause) =>
        Effect.logInfo("stuck-launch repair skipped: state moved since it was judged", {
          threadId: thread.id,
          expectedSessionUpdatedAt: session.updatedAt,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );

  // The CAS lost, so we never touched the thread and MUST NOT launch into it.
  if (!repaired) return { repaired: false, resumed: false };
  if (!resume) return { repaired: true, resumed: false };

  // 3. The single launch, reached ONLY because the CAS above was applied — i.e.
  //    the thread was provably still wedged at the serialized command boundary.
  //    `requireIdle` is kept as defence in depth (a deferral leaves no receipt, so
  //    the id stays redeliverable), but the CAS is what makes it sound.
  const text = yield* resolveStuckLaunchResumeText({
    thread,
    launchIdentityDir,
    providerName: session.providerName,
  });
  const resumed = yield* engine
    .dispatch({
      type: "thread.turn.start",
      commandId: idFor("resume"),
      threadId: thread.id,
      message: {
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        role: "user",
        origin: "control_notice",
        text,
        attachments: [],
      },
      titleSeed: thread.title,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      requireIdle: true,
      createdAt: now,
    } satisfies OrchestrationCommand)
    .pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logDebug("stuck-launch resume deferred or failed", {
          threadId: thread.id,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as(false)),
      ),
    );
  return { repaired: true, resumed };
});
