/**
 * ProviderAdapter - Provider-specific runtime adapter contract.
 *
 * Defines the provider-native session/protocol operations that `ProviderService`
 * routes to after resolving the target provider. Implementations should focus
 * on provider behavior only and avoid cross-provider orchestration concerns.
 *
 * @module ProviderAdapter
 */
import type {
  ApprovalRequestId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderUserInputAnswers,
  ProviderRuntimeEvent,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ThreadId,
  ProviderTurnStartResult,
  TurnId,
  UserInputResolvedOutcome,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

export type ProviderSessionModelSwitchMode = "in-session" | "unsupported";

/**
 * How a driver's resume state is held, which decides what the recovery gate
 * must find before it may restart a stopped session.
 *
 * - `resume-cursor`: the driver can only resume from an opaque cursor handed
 *   back by the provider, so recovery without a persisted cursor is impossible
 *   and must fail loudly.
 * - `session-file`: the driver's own on-disk session is the source of truth for
 *   a resume (pi's deterministic per-thread `.jsonl`), so a start with no
 *   cursor genuinely continues the same conversation. The gate asks the driver
 *   whether that state exists via `canResumeThread`.
 */
export type ProviderResumeStateKind = "resume-cursor" | "session-file";

/**
 * The outcome of delivering an already-settled question to a provider.
 *
 * `deliveredContent: false` means the callback was released but the outcome's
 * content (today: a `superseded` message) could not be conveyed through that
 * provider's protocol, so the caller must deliver it as a new turn instead.
 */
export interface UserInputDeliveryResult {
  readonly deliveredContent: boolean;
}

/** Content-bearing delivery: the model received the outcome in-callback. */
export const userInputContentDelivered: UserInputDeliveryResult = { deliveredContent: true };

/** The callback was released, but its content must be re-delivered as a turn. */
export const userInputContentUndelivered: UserInputDeliveryResult = { deliveredContent: false };

export interface ProviderAdapterCapabilities {
  /**
   * Declares whether changing the model on an existing session is supported.
   */
  readonly sessionModelSwitch: ProviderSessionModelSwitchMode;
  /**
   * Does `stopSession` cause a `session.exited` runtime event to be emitted for
   * the stopped session?
   *
   * Required (not optional) so adding an adapter forces an explicit answer: a
   * wrong value silently breaks workspace-hold accounting in one of two ways, and
   * neither is visible without a targeted test.
   *
   * `ProviderService` releases a launch's workspace hold when the launch ends, and
   * uses this to know whether an exit event is still owed for it:
   * - `true` — the exit arrives asynchronously after `stopSession` returns, so the
   *   stopped launch is recorded as still owing one. Without that, a stop followed
   *   by a restart lets the straggler release the NEW launch's hold and expose a
   *   running process to worktree removal.
   * - `false` — no exit is coming, so nothing is recorded. Recording one anyway
   *   leaves a debt that is later spent absorbing a genuine exit, leaking the hold
   *   permanently and making the worktree unreapable.
   *
   * These two cases are provably indistinguishable at exit time (the runtime event
   * carries no launch identity), which is why the answer has to be declared here
   * rather than inferred at runtime.
   */
  readonly emitsExitOnStop: boolean;

  /**
   * Where this driver's resume state lives. Omitted means `resume-cursor` —
   * the conservative default, so a driver that never opts in keeps failing
   * recovery when no cursor is persisted rather than starting an amnesiac
   * session that silently loses the conversation.
   */
  readonly resumeState?: ProviderResumeStateKind;
}

export interface ProviderThreadTurnSnapshot {
  readonly id: TurnId;
  readonly items: ReadonlyArray<unknown>;
}

export interface ProviderThreadSnapshot {
  readonly threadId: ThreadId;
  readonly turns: ReadonlyArray<ProviderThreadTurnSnapshot>;
}

export interface ProviderAdapterShape<TError> {
  /**
   * Provider kind implemented by this adapter.
   */
  readonly provider: ProviderDriverKind;
  readonly capabilities: ProviderAdapterCapabilities;

  /**
   * Start a provider-backed session.
   */
  readonly startSession: (
    input: ProviderSessionStartInput,
  ) => Effect.Effect<ProviderSession, TError>;

  /**
   * Send a turn to an active provider session.
   */
  readonly sendTurn: (
    input: ProviderSendTurnInput,
  ) => Effect.Effect<ProviderTurnStartResult, TError>;

  /**
   * Interrupt an active turn.
   */
  readonly interruptTurn: (threadId: ThreadId, turnId?: TurnId) => Effect.Effect<void, TError>;

  /**
   * Respond to an interactive approval request.
   */
  readonly respondToRequest: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, TError>;

  /**
   * Hand an already-settled user-input outcome to a waiting callback.
   *
   * The durable settlement has already happened server-side, so this is DELIVERY
   * ONLY: an adapter here must never emit its own `user-input.resolved` (that
   * would put a second, contradictory terminal outcome on one request — ingestion
   * drops such echoes, but an adapter should not produce them), and a failure
   * here can never leave the question open.
   *
   * `settlement` names the terminal outcome so the blocked callback returns what
   * actually happened rather than always reading as an answer. Handling it is
   * mandatory, not optional: delivering `{}` as if it were an answer is how a
   * dismissal reaches the model as "the user chose nothing", and OpenCode can
   * stay blocked when an empty form is rejected.
   *
   * The result reports whether the outcome's CONTENT reached the model. It is
   * false when an adapter's protocol cannot carry the content — in practice a
   * `superseded` message on the five ACP/SDK adapters, whose question callbacks
   * model only accepted/cancelled. The caller then converts the settlement into
   * exactly one new turn, so the human's message is never silently dropped.
   */
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
    settlement?: {
      readonly outcome: UserInputResolvedOutcome;
      readonly message?: string;
    },
  ) => Effect.Effect<UserInputDeliveryResult, TError>;

  /**
   * Stop one provider session.
   */
  readonly stopSession: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /**
   * List currently active provider sessions for this adapter.
   */
  readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;

  /**
   * Check whether this adapter owns an active session id.
   */
  readonly hasSession: (threadId: ThreadId) => Effect.Effect<boolean>;

  /**
   * loom: added for the fork's per-event ingestion path (see
   * `ProviderServiceShape.getSession`).
   *
   * Read one active session by thread id, if this adapter owns it.
   *
   * Thread-addressed counterpart to `listSessions` for hot paths (per-event
   * ingestion, per-turn-start) that need a single thread: implementations must
   * resolve it directly rather than materialising every session, so cost does
   * not grow with the number of live sessions.
   */
  readonly getSession: (threadId: ThreadId) => Effect.Effect<ProviderSession | undefined, TError>;

  /**
   * Whether a thread with no live session can still be resumed from state this
   * driver owns outside the persisted resume cursor — for pi, its deterministic
   * on-disk session file. Only meaningful for `resumeState: "session-file"`
   * drivers; the recovery gate consults it instead of demanding a cursor.
   *
   * A true answer must mean the ensuing `startSession` will really CONTINUE that
   * state, not merely that something plausible exists: a driver whose provider
   * silently starts a fresh session when it rejects the state must answer false,
   * so the refusal stays loud instead of resuming into an empty conversation.
   *
   * `cwd` is the cwd recovery will launch with, offered because resume state MAY
   * be scoped to it. Whether it narrows anything is the driver's business: pi
   * ignores it, because its resume names the session file by absolute path and
   * pins the working directory, so no cwd can make a resumable thread
   * unresumable.
   */
  readonly canResumeThread?: (input: {
    readonly threadId: ThreadId;
    readonly cwd?: string | undefined;
  }) => Effect.Effect<boolean>;

  /**
   * Read a provider thread snapshot.
   */
  readonly readThread: (threadId: ThreadId) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Roll back a provider thread by N turns.
   */
  readonly rollbackThread: (
    threadId: ThreadId,
    numTurns: number,
  ) => Effect.Effect<ProviderThreadSnapshot, TError>;

  /**
   * Stop all sessions owned by this adapter.
   */
  readonly stopAll: () => Effect.Effect<void, TError>;

  /**
   * Canonical runtime event stream emitted by this adapter.
   */
  readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
}
