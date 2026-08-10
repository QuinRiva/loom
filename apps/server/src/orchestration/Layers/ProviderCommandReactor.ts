import {
  type ChatAttachment,
  CommandId,
  EventId,
  GoalId,
  DEFAULT_THREAD_TITLE, // loom: §4 title provenance guard
  canReplaceTitle, // loom: §4 title provenance guard
  titleProvenanceRank, // loom: §4 title provenance guard
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationGoal,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  MessageId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
  DEFAULT_USER_INPUT_RESOLVED_OUTCOME,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import { renderUserInputOutcomeAsTurnOpener } from "@t3tools/shared/userInputOutcome";
import { openUserInputRequestIds } from "@t3tools/shared/openRequests";
import { dispatchUserInputResolutions } from "../userInputSettlement.ts";
import { slugify } from "@t3tools/shared/String";
import { gateLoopTargetOf } from "@t3tools/shared/workstreamGraph";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveMergeAuthority, shipPolicyPromptBlock } from "@t3tools/shared/shipPolicy";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { buildThreadInterpretationPrompt } from "../../textGeneration/TextGenerationPrompts.ts";
import { sanitizeThreadTitle } from "../../textGeneration/TextGenerationUtils.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
// loom: in-flight launch claims — the stuck-launch recovery guard.
import { ProviderLaunchClaims } from "../../provider/Services/ProviderLaunchClaims.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { renderGoalTaskTree } from "../goalTaskRender.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { shouldRefuseForkLaunch } from "../threadIdle.ts";
import { HANDOFF_DRAFTER_ROLE } from "../../loom/handoffDraft.ts"; // loom: `/handoff` fork-drafter
import { RETRO_REVIEWER_OVERLAY_PROMPT, RETRO_REVIEWER_ROLE } from "../../loom/retroDraft.ts"; // loom: `/retro` fork-reviewer
import { piSessionIdForThread, resolveSessionFilePath } from "../../provider/piSessionFiles.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { listRoleOverlays, loadRoleOverlay } from "../roleOverlay.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import {
  WorktreeProvisioner,
  isProvisionedChildBranch,
} from "../../project/WorktreeProvisioner.ts";
import { workstreamChildPrompt } from "../workstreamChildPrompt.ts";
import { readWorkstreamBriefAt } from "../workstreamBrief.ts";
const isProviderAdapterRequestError = Schema.is(ProviderAdapterRequestError);
const isProviderDriverKind = Schema.is(ProviderDriverKind);

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";

// The relocation clause, appended to the composed system prompt when the
// thread's workspace has moved since the session originally ran. Derived from
// durable state: a recorded `finalCommitSha` proves the child was disposed by
// fan-in/cancel and its original checkout removed, so the tree it now sees is
// the parent's current state, and absolute paths it remembers are historical.
// It instructs CARE, not incapacity — the thread resumes with its full launch.
export const relocationClause = (input: {
  readonly finalCommitSha: string;
  readonly cwd: string;
}): string =>
  `Your work here previously happened in a working directory that no longer exists; you are now in \`${input.cwd}\` (the parent's current tree, or the project workspace). Your merged work is commit \`${input.finalCommitSha}\`. The files you see now are that tree's CURRENT state, which has moved on since you finished. Any absolute paths you remember are historical — re-verify before editing. Exact historical file contents live in git at that commit.`;

// The identity clause: WHO this thread is, in-band. A launched pi session
// otherwise knows neither its thread id (the id every workstream tool takes,
// the id the human sees) nor where its own transcript lives — while the
// work-model prompt tells it the history "can be accessed via the Pi session
// jsonl file". Deliberately derived only from a thread's one STABLE fact (its
// id) so the composed prompt is byte-identical across the thread's own
// relaunches: the session file is named by CONVENTION (`*_<threadId>.jsonl`,
// per `piSessionIdForThread`) plus the runtime `PI_SESSION_FILE` env, never by
// a resolved absolute path — which does not exist yet at a first launch and
// would churn the cacheable prefix.
//
// It deliberately does NOT name the workspace cwd, for two compounding reasons.
// pi already appends the REAL `Current working directory: <cwd>` as the final
// line of its base prompt, built from the process cwd at launch — always true,
// never replayed. And this clause IS replayed: a `forkFrom` child's first launch
// replays the source's captured argv verbatim (`resolveForkLaunchArgs`), so any
// cwd named here would be the SOURCE's. Isolation defaults by role (writers
// isolated, readers shared) and a fork inherits its source's role, so a fork of
// a writer sits in its OWN worktree by default — and would have been told, with
// an imperative, that its edits land in someone else's tree. Naming the cwd here
// contradicts pi's own true line in exactly the case that writes code. The id is
// replayed too, but a stale id is inert (every workstream tool resolves the
// calling thread from its credential, never from the model's belief).
//
// It also never names a sessions ROOT. `~/.pi/agent/sessions` is only pi's
// default: the store moves with `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`,
// the `sessionDir` setting, or `PI_CODING_AGENT_DIR`, and PiDriver pins none of
// them (it passes the server env through). Asserting the default would inject a
// false path on any deployment that configures the store, and an agent trusting
// it would read an unrelated session or none. `$PI_SESSION_FILE` is set by pi's
// own bash tool for every command it runs, so that one truthful fact locates
// this thread's own history without naming a root.
//
// It says nothing about where ANOTHER thread's jsonl lives, because there is no
// short true answer: pi scopes session files by project slug (`--<cwd>--`, see
// `piProjectSessionDir`), so an isolated sibling in its own worktree sits in a
// DIFFERENT directory, as does this thread's own history after a relocation.
// Cross-thread history is reached by the paths that always work — the sibling's
// report and `consult_thread` — not by a directory guess.
export const threadIdentityClause = (input: { readonly threadId: ThreadId }): string =>
  `You are thread \`${input.threadId}\` in this workstream: the id every workstream tool takes, the id the human sees, and the id you quote when reporting. Your own conversation history is the pi session jsonl at \`$PI_SESSION_FILE\` (set in every shell command you run), a file named \`*_${piSessionIdForThread(input.threadId)}.jsonl\`. To reach ANOTHER thread's history, use its report or \`consult_thread\`; its jsonl is not necessarily in the same directory as yours.`;

/**
 * Turn-start re-provision guard (plan §8 item 4 — the defect B fix): re-provision
 * an isolated child ONLY when it has NOT provably run (no session file) AND its
 * branch still points at the parent (never provisioned). A thread whose session
 * file exists has run — fan-in repoints its branch to the parent's, so the
 * branch-name predicate alone can no longer distinguish "never provisioned" from
 * "provisioned, fanned in, worktree reaped"; session-file existence resolves it.
 * Re-provisioning a thread that has run is the bug that cut a fresh worktree and
 * re-delivered the kickoff brief to a completed child.
 */
export const shouldReprovisionIsolatedChild = (input: {
  readonly sessionFileExists: boolean;
  readonly isolation: string;
  readonly branch: string | null;
  readonly threadId: ThreadId;
}): boolean =>
  !input.sessionFileExists &&
  input.isolation === "isolated" &&
  !isProvisionedChildBranch(input.branch, input.threadId);

const activeGoalContextInstruction = (
  goal: OrchestrationGoal,
  opts?: { readonly asChildBackground?: boolean },
) => {
  const tasks =
    goal.tasks.length === 0 ? "(no tasks yet)" : renderGoalTaskTree(goal.tasks).trimEnd();
  if (opts?.asChildBackground) {
    return [
      `Background context — your parent orchestrator is working toward this overall goal \`${goal.id}\` (${goal.slug}): ${goal.title}`,
      goal.description.trim().length > 0
        ? `\nParent's objective (background only, NOT your task): ${goal.description.trim()}`
        : "",
      `\n\nParent's current task tree (the orchestrator owns it, but you may mark your own task done and add discovered work):\n${tasks}`,
    ].join("");
  }
  return [
    `Active goal \`${goal.id}\` (${goal.slug}): ${goal.title}`,
    goal.description.trim().length > 0 ? `\nObjective: ${goal.description.trim()}` : "",
    `\n\nCurrent tasks:\n${tasks}`,
    `\n\nKeep this task tree current as the work evolves — it is how the human re-orients at a glance. This snapshot is delivered once and is not refreshed — read the current tree on demand with \`goal_task_list\` (it mutates nothing), and mutate it with the goal/task tools, which act on THIS thread's goal (you never pass a goal id): \`goal_task_add\` (optionally under a parent task), \`goal_task_update\` (rename, mark done/reopen, reorder), \`goal_task_delete\`, and \`goal_update\` (title/description/slug).`,
  ].join("");
};

export function providerErrorLabel(value: string | undefined): string {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : "unknown";
}

export function providerErrorLabelFromInstanceHint(input: {
  readonly instanceId?: string | undefined;
  readonly modelSelectionInstanceId?: string | undefined;
  readonly sessionProvider?: string | undefined;
}): string {
  return providerErrorLabel(
    input.instanceId ?? input.modelSelectionInstanceId ?? input.sessionProvider,
  );
}

function findProviderAdapterRequestError(
  cause: Cause.Cause<ProviderServiceError>,
): ProviderAdapterRequestError | undefined {
  const failReason = cause.reasons.find(Cause.isFailReason);
  return isProviderAdapterRequestError(failReason?.error) ? failReason.error : undefined;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function stalePendingRequestDetail(requestKind: "approval", requestId: string): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  // loom: stuck-launch recovery guard (see `processTurnStartRequested`).
  const launchClaims = yield* ProviderLaunchClaims;
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
  const worktreeProvisioner = yield* WorktreeProvisioner;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();
  // Per-thread guard so a turn-2 interpretation cannot start (and double-create
  // a goal) while a turn-1 interpretation fork for the same thread is still
  // outstanding. `requireUniqueGoalSlug` rejects collisions but offers no
  // protection against two distinct goal UUIDs minted for one thread.
  const inFlightInterpretations = new Set<string>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    const providerError = isProviderAdapterRequestError(failReason?.error)
      ? failReason.error
      : undefined;
    if (providerError) {
      return providerError.detail;
    }
    return Cause.pretty(cause);
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session ?? {
          threadId: input.threadId,
          providerName: null,
          providerInstanceId: thread.modelSelection.instanceId,
          runtimeMode: thread.runtimeMode,
        }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: input.detail,
        queuedMessages: { steering: [], followUp: [] },
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Fix A: durably clear the pending turn-start projection row when a turn-start
  // fails before `turn.started`. Dispatched on EVERY turn-start failure — both
  // when a session exists (reset to ready above) and when none does (no
  // session-set is emitted at all) — because in both cases no
  // `thread.session-set running` will ever arrive to clear the row, and a
  // lingering pending turn-start keeps the parent permanently non-idle, which
  // strands a deferred dispatcher wake.
  //
  // The command id is DETERMINISTIC, derived from the failing turn-start's
  // identity (`turnStartKey` — the same key that dedups the turn-start itself).
  // This makes the clear idempotent and safely retryable: a transient dispatch
  // failure is retried, and because the id is fixed every attempt re-drives the
  // same command without a duplicate effect, so the pending row is never left
  // orphaned by a single failed (random-id) dispatch.
  const clearPendingTurnStartForFailedTurn = (input: {
    readonly threadId: ThreadId;
    readonly turnStartKey: string;
    readonly detail: string;
    readonly createdAt: string;
  }) =>
    orchestrationEngine
      .dispatch({
        type: "thread.turn-start.fail",
        commandId: CommandId.make(`server:turn-start-fail:${input.turnStartKey}`),
        threadId: input.threadId,
        detail: input.detail,
        createdAt: input.createdAt,
      })
      .pipe(Effect.retry(Schedule.exponential(Duration.millis(100)).pipe(Schedule.take(3))));

  const resolveProject = Effect.fnUntraced(function* (projectId: ProjectId) {
    return yield* projectionSnapshotQuery
      .getProjectShellById(projectId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const resolveThread = Effect.fnUntraced(function* (threadId: ThreadId) {
    return yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
  });

  const rejectStartedThreadModelChangeIfRequired = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly currentModelSelection: ModelSelection;
    readonly requestedModelSelection: ModelSelection | undefined;
  }) {
    const requestedModelSelection = input.requestedModelSelection;
    if (
      requestedModelSelection === undefined ||
      (input.currentModelSelection.instanceId === requestedModelSelection.instanceId &&
        input.currentModelSelection.model === requestedModelSelection.model)
    ) {
      return;
    }
    const providers = yield* providerRegistry.getProviders;
    const requiresNewThread =
      providers.find((snapshot) => snapshot.instanceId === input.currentModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true ||
      providers.find((snapshot) => snapshot.instanceId === requestedModelSelection.instanceId)
        ?.requiresNewThreadForModelChange === true;
    if (!requiresNewThread) {
      return;
    }
    return yield* new ProviderAdapterRequestError({
      provider: providerErrorLabelFromInstanceHint({
        instanceId: String(requestedModelSelection.instanceId),
        modelSelectionInstanceId: String(input.currentModelSelection.instanceId),
      }),
      method: "thread.turn.start",
      detail: `Thread '${input.threadId}' cannot switch models after the conversation has started. Start a new thread to use '${requestedModelSelection.model}'.`,
    });
  });

  // Standing goal-context instruction, delivered once per session by appending
  // to the pi system prompt at session spawn (never prepended per turn).
  // Auto-goals own goal creation now; a goal-less thread gets no injected
  // instruction (the old GOALLESS_CONTEXT_INSTRUCTION told the coding agent to
  // mint its own goal, which conflicts with the side-channel auto-create flow).
  const buildGoalSystemPrompt = Effect.fn("buildGoalSystemPrompt")(function* (thread: {
    readonly projectId: ProjectId;
    readonly goalId: string | null;
    readonly parentThreadId: ThreadId | null;
  }) {
    if (!thread.goalId) return undefined;
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const goal = readModel.goals.find(
      (entry) => entry.id === thread.goalId && entry.deletedAt === null,
    );
    return goal
      ? activeGoalContextInstruction(goal, { asChildBackground: thread.parentThreadId !== null })
      : undefined;
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly pendingTurnStart?: boolean;
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const activeSession = yield* providerService.getSession(threadId);
    const activeThreadSession =
      thread.session !== null && thread.session.status !== "stopped" && activeSession
        ? thread.session
        : null;
    if (
      activeThreadSession !== null &&
      activeSession !== undefined &&
      (activeThreadSession.providerInstanceId === undefined ||
        activeSession.providerInstanceId === undefined)
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(activeThreadSession.providerName ?? undefined),
        method: "thread.turn.start",
        detail: `Thread '${threadId}' has an active provider session without a provider instance id.`,
      });
    }
    const currentInstanceId =
      activeThreadSession !== null &&
      activeSession !== undefined &&
      activeSession.providerInstanceId !== undefined
        ? activeSession.providerInstanceId
        : thread.modelSelection.instanceId;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const desiredInstanceId = desiredModelSelection.instanceId;
    const currentInfo = yield* providerService.getInstanceInfo(currentInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(currentInstanceId),
              modelSelectionInstanceId: String(thread.modelSelection.instanceId),
              sessionProvider: thread.session?.providerName ?? undefined,
            }),
            method: "thread.turn.start",
            detail: `Thread '${threadId}' references unknown provider instance '${currentInstanceId}'. The instance is not configured in this build.`,
          }),
      ),
    );
    const desiredInfo = yield* providerService.getInstanceInfo(desiredInstanceId).pipe(
      Effect.mapError(
        () =>
          new ProviderAdapterRequestError({
            provider: providerErrorLabelFromInstanceHint({
              instanceId: String(desiredModelSelection.instanceId),
            }),
            method: "thread.turn.start",
            detail: `Requested provider instance '${desiredInstanceId}' is not configured in this build.`,
          }),
      ),
    );
    const desiredDriverKind = desiredInfo.driverKind;
    if (!isProviderDriverKind(desiredDriverKind)) {
      return yield* new ProviderAdapterRequestError({
        provider: providerErrorLabel(String(desiredDriverKind)),
        method: "thread.turn.start",
        detail: `Requested provider instance '${desiredInstanceId}' uses unknown provider driver '${desiredDriverKind}'. The driver is not installed in this build.`,
      });
    }
    const preferredProvider: ProviderDriverKind = desiredDriverKind;
    // Thread fork (MVP) — the load-bearing first-fork-launch idle gate. The fork
    // is applied at THIS launch when the child carries a fork source and its own
    // session file does not exist yet (the fork-once condition the driver also
    // checks). Since `pi --fork` reads the SOURCE session file, refuse to start
    // if the source is mid-turn — forking a jsonl with an unclosed tool call
    // would corrupt the forked history. This is the ONLY idle gate for forks
    // (fork creation is deliberately un-gated: the tool is called by the source
    // mid-turn). Decision extracted to `shouldRefuseForkLaunch` for unit tests.
    if (thread.forkFromThreadId !== null) {
      const pendingTurnStartThreadIds =
        yield* projectionSnapshotQuery.getPendingTurnStartThreadIds();
      const source = Option.getOrUndefined(
        yield* projectionSnapshotQuery.getThreadDetailById(thread.forkFromThreadId),
      );
      const childSessionFileExists =
        resolveSessionFilePath(piSessionIdForThread(threadId)) !== undefined;
      // loom: forkFrom (D2 deterministic refusal) — at the fork's FIRST launch,
      // an unresolvable source (archived or deleted after spawn-time validation;
      // getThreadDetailById returns only ACTIVE threads) must be refused, not
      // permitted. `shouldRefuseForkLaunch` deliberately permits an unknown
      // source (it gates idleness, not existence), and a stale on-disk
      // sidecar/session for the archived source would otherwise let the fork
      // launch from a source no longer owned/visible. Refuse loudly here.
      if (!childSessionFileExists && source === undefined) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Cannot fork thread '${thread.forkFromThreadId}': the source thread is no longer active (archived or deleted after this fork was created). Re-spawn the fork from a live source.`,
        });
      }
      if (
        shouldRefuseForkLaunch({
          forkFromThreadId: thread.forkFromThreadId,
          childSessionFileExists,
          source,
          pendingTurnStartThreadIds,
        })
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          // loom: forkFrom (D7 backstop) — the dispatch gate normally defers a
          // fork until its source is idle; this fires only on the residual race
          // (the source started a NEW turn between the dispatcher check and this
          // launch). It surfaces loudly as thread.turn-start-failed + error
          // attention. The repair is made brief-safe by D8: once the source is
          // idle, `workstream_prompt` on this child re-delivers the composed
          // kickoff (the lens brief is never lost).
          detail: `Cannot fork thread '${thread.forkFromThreadId}' while it is mid-turn — the fork copies its live session and would capture an unclosed tool call. Once that thread's current turn finishes, send this child a workstream_prompt to (re)deliver its kickoff brief and launch the fork.`,
        });
      }
    }
    if (options?.pendingTurnStart === true && thread.session?.status !== "running") {
      yield* setThreadSession({
        threadId,
        session: {
          threadId,
          status: "starting",
          providerName: activeSession?.provider ?? preferredProvider,
          providerInstanceId: activeSession?.providerInstanceId ?? desiredInstanceId,
          runtimeMode: desiredRuntimeMode,
          activeTurnId: null,
          lastError: null,
          queuedMessages: { steering: [], followUp: [] },
          updatedAt: createdAt,
        },
        createdAt,
      });
    }
    if (thread.session !== null) {
      yield* rejectStartedThreadModelChangeIfRequired({
        threadId,
        currentModelSelection:
          activeSession?.model !== undefined
            ? {
                ...thread.modelSelection,
                instanceId: currentInstanceId,
                model: activeSession.model,
              }
            : thread.modelSelection,
        requestedModelSelection,
      });
    }
    if (
      thread.session !== null &&
      requestedModelSelection !== undefined &&
      requestedModelSelection.instanceId !== currentInstanceId
    ) {
      if (currentInfo.driverKind !== desiredInfo.driverKind) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' is bound to driver '${currentInfo.driverKind}' and cannot switch to '${desiredInfo.driverKind}'.`,
        });
      }
      if (
        currentInfo.continuationIdentity.continuationKey !==
        desiredInfo.continuationIdentity.continuationKey
      ) {
        return yield* new ProviderAdapterRequestError({
          provider: preferredProvider,
          method: "thread.turn.start",
          detail: `Thread '${threadId}' cannot switch from instance '${currentInstanceId}' to '${desiredInstanceId}' because their provider resume state is incompatible.`,
        });
      }
    }
    const project = yield* resolveProject(thread.projectId);
    // Canonical workspace cwd: the thread's worktree if provisioned, else the
    // project workspaceRoot. The existence-check fallback for a DANGLING worktree
    // (relocated/reaped) lives at the launch boundary (PiDriver), NOT here — the
    // reactor's cwd drives cwd-change restart detection, which must compare the
    // recorded worktree path, not an existence-substituted one.
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: project ? [project] : [],
    });

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderDriverKind;
    }) =>
      Effect.gen(function* () {
        const goalSystemPrompt = yield* buildGoalSystemPrompt(thread);
        // Compose the role overlay ahead of the goal context. The driver
        // prepends PI_WORK_MODEL_SYSTEM_PROMPT, so the effective reading order is
        // work-model → role overlay → goal context. NOTE: if a non-workstream pi
        // mode is ever added, the `orchestrator` overlay must not ship without
        // the workstream tools behind it.
        const roleProjectRoot = effectiveCwd ?? process.cwd();
        // loom: `/retro` fork-reviewer — its policy is SERVER-OWNED, never the
        // reviewed project's. The generic path reads `roles/<role>.md` from the
        // fork's inherited worktree, which belongs to the project under review;
        // resolving there would silently drop the retro policy for any project
        // (or older worktree) without the file — leaving only the base work-
        // model prompt, whose worktree-write rule forbids the reviewer's one
        // deliverable (~/loom-retro/). One server-owned overlay for all
        // projects instead.
        const roleOverlay =
          thread.role === RETRO_REVIEWER_ROLE
            ? // No tools restriction, so its effective surface keeps
              // workstream_spawn — the catalogue must match what it can call.
              { prompt: RETRO_REVIEWER_OVERLAY_PROMPT, delegation: true }
            : loadRoleOverlay({ role: thread.role, projectRoot: roleProjectRoot });
        // The defined-roles catalogue: only threads whose EFFECTIVE surface
        // includes workstream_spawn (no overlay at all, no tool restriction, or
        // `toolsets:` naming delegation). A leaf that enables delegation
        // mid-session gets the catalogue pointer from the enable_toolset result
        // instead — roles/ is listable on demand.
        const roleCatalogue =
          roleOverlay === undefined || roleOverlay.delegation
            ? listRoleOverlays({ projectRoot: roleProjectRoot })
            : [];
        const rolesBlock =
          roleCatalogue.length > 0
            ? [
                "Available roles for spawning children (defined in roles/). A free-text role may still be used when none fits:",
                ...roleCatalogue.map((role) => `- ${role.name}: ${role.summary}`),
              ].join("\n")
            : undefined;
        // The project's merge contract, resolved from `.t3code/ship.json` for the
        // thread's worktree (human-merge default; a project opts into agent-merge).
        // Injected into every thread so the merge boundary is explicit in-band
        // rather than inherited implicitly from a brief chain (see PE-2111).
        const shipPolicyBlock = shipPolicyPromptBlock(resolveMergeAuthority(roleProjectRoot));
        // Situational awareness for a RELOCATED thread: a fanned-in (or
        // cancelled-and-reaped) child's transcript remembers absolute paths in a
        // checkout that no longer exists. `finalCommitSha` is stamped only by
        // fan-in/cancel disposal (`WorkstreamFanInReactor`), and only on children
        // — so it is the genuine relocation signal and never fires for a root or
        // for a thread still sitting in its own worktree.
        const relocationBlock =
          thread.finalCommitSha != null
            ? relocationClause({ finalCommitSha: thread.finalCommitSha, cwd: roleProjectRoot })
            : undefined;
        const appendSystemPrompt = [
          threadIdentityClause({ threadId }),
          roleOverlay?.prompt,
          shipPolicyBlock,
          rolesBlock,
          goalSystemPrompt,
          relocationBlock,
        ]
          .filter((part): part is string => !!part && part.trim().length > 0)
          .join("\n\n");
        return yield* providerService.startSession(threadId, {
          threadId,
          ...(preferredProvider ? { provider: preferredProvider } : {}),
          providerInstanceId: desiredInstanceId,
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          modelSelection: desiredModelSelection,
          ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          ...(appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {}),
          ...(roleOverlay?.skills ? { skills: roleOverlay.skills } : {}),
          ...(roleOverlay?.tools ? { tools: roleOverlay.tools } : {}),
          // Thread fork (MVP): carry the fork source so the driver forks the
          // source's pi session at this child's first launch (fork-once — the
          // driver no-ops it once the child's own session file exists).
          ...(thread.forkFromThreadId ? { forkFromThreadId: thread.forkFromThreadId } : {}),
          // loom: `/retro` fork-reviewer — a retro fork DIVERGES in role from
          // its source, so its first launch composes its OWN identity (role
          // overlay + work model) instead of replaying the source argv. The
          // source's system prompt carries the source role's policy (e.g. the
          // worktree-write contract) which the reviewer's overlay must be able
          // to scope differently; verbatim replay would also drop the
          // reviewer's own role overlay entirely.
          ...(thread.forkFromThreadId && thread.role === RETRO_REVIEWER_ROLE
            ? { forkIdentity: "compose" as const }
            : {}),
          runtimeMode: desiredRuntimeMode,
        });
      });

    const bindSessionToThread = (session: ProviderSession) =>
      Effect.gen(function* () {
        if (session.providerInstanceId === undefined) {
          return yield* new ProviderAdapterRequestError({
            provider: providerErrorLabel(session.provider),
            method: "thread.turn.start",
            detail: `Provider session '${session.threadId}' started without a provider instance id.`,
          });
        }
        yield* setThreadSession({
          threadId,
          session: {
            threadId,
            status:
              options?.pendingTurnStart === true && session.status === "ready"
                ? "starting"
                : mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
            ...(session.lastErrorClass !== undefined
              ? { lastErrorClass: session.lastErrorClass }
              : {}),
            queuedMessages: { steering: [], followUp: [] },
            updatedAt: session.updatedAt,
          },
          createdAt,
        });
      });

    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const cwdChanged = effectiveCwd !== activeSession?.cwd;
      const sessionModelSwitch = (yield* providerService.getCapabilities(desiredInstanceId))
        .sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const instanceChanged =
        requestedModelSelection !== undefined &&
        activeSession?.providerInstanceId !== requestedModelSelection.instanceId;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "unsupported";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        preferredProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !cwdChanged &&
        !instanceChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return existingSessionThreadId;
      }

      // A cwd-change restart driven by the workspaceRoot FALLBACK (worktreePath
      // null) while the running session lives in some other checkout is the
      // visible symptom of a lost worktree binding — make it loud.
      if (cwdChanged && thread.worktreePath === null && activeSession?.cwd !== undefined) {
        yield* Effect.logWarning(
          "provider command reactor cwd restart falls back to project workspaceRoot; the previous session ran elsewhere — possible lost worktree binding",
          {
            threadId,
            previousCwd: activeSession.cwd,
            fallbackCwd: effectiveCwd,
          },
        );
      }
      const resumeCursor = shouldRestartForModelChange
        ? undefined
        : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider: activeSession?.provider,
        currentInstanceId,
        desiredInstanceId,
        desiredProvider: desiredModelSelection.instanceId,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        previousCwd: activeSession?.cwd,
        desiredCwd: effectiveCwd,
        cwdChanged,
        modelChanged,
        instanceChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
        cwd: restartedSession.cwd,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const buildSendTurnRequestForThread = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return yield* Effect.die(
        new Error(`Thread '${input.threadId}' was not found in read model.`),
      );
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      pendingTurnStart: true,
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService.getSession(input.threadId);
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : activeSession.providerInstanceId === undefined
          ? yield* new ProviderAdapterRequestError({
              provider: providerErrorLabel(activeSession.provider),
              method: "thread.turn.start",
              detail: `Active provider session '${activeSession.threadId}' is missing a provider instance id.`,
            })
          : (yield* providerService.getCapabilities(activeSession.providerInstanceId))
              .sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    // A turn without an explicit override must still run the thread's stored
    // selection: in-session-switch drivers get it as the turn's modelSelection
    // (control-plane turns — kick-offs, prompts, wakes, gate rework — carry no
    // explicit pick, and drivers like pi would otherwise keep whatever model
    // the session happened to start on), while no-switch drivers pin the turn
    // to the active session's model.
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : requestedModelSelection;

    return {
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    };
  });

  // Rename the temporary `t3code/<hash>` worktree branch to a slug derived from
  // the generated thread title, so branch and title stay consistent. Guards:
  // temp-branch-only (never touch a user-named branch), collision-safe via
  // renameBranch, no-ops when the slug already matches, and SHARED-WORKTREE-safe
  // (never rename a branch this thread only inherited — see below). Internally
  // failure-isolated so a git failure leaves the temp branch intact and never
  // aborts the surrounding interpretation (e.g. emergent-goal creation). The
  // worktree DIRECTORY is intentionally left as the hash dir.
  const renameWorktreeBranchToTitle = Effect.fn("renameWorktreeBranchToTitle")(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly title: string;
  }) {
    if (!input.branch || !input.worktreePath || !isTemporaryWorktreeBranch(input.branch)) {
      return;
    }
    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    // Shared-worktree guard: a thread_fork / goal_continue thread INHERITS a live
    // thread's worktree + branch rather than provisioning its own. Its title is
    // still (re)derived, which used to fire this rename and move the branch out
    // from under the source thread (and any children sharing that worktree),
    // stranding their recorded branch. Only rename a branch this thread solely
    // owns: bail if any OTHER live thread shares this worktree path.
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const sharesWorktree = readModel.threads.some(
      (other) =>
        other.id !== input.threadId && other.deletedAt === null && other.worktreePath === cwd,
    );
    if (sharesWorktree) return;
    const targetBranch = buildGeneratedWorktreeBranchName(input.title);
    if (targetBranch === oldBranch) return;

    yield* Effect.gen(function* () {
      const renamed = yield* gitWorkflow.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* vcsStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          targetBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  // Side-channel interpretation of what the thread is trying to achieve, distilled
  // into a thread title + emergent goal in one cheap model call. Forked and
  // failure-logged by callers so a text-gen outage degrades to the seed title and
  // never blocks a turn. The title is applied once (turn 1); the goal is created
  // when the model is confident (turn 1) or unconditionally on the best guess
  // (turn 2). Re-resolves the thread after the (slow) call and bails if a goal
  // appeared meanwhile, so it is safe to retry across turns.
  const interpretThreadIntent = Effect.fn("interpretThreadIntent")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly titleSeed?: string;
    readonly applyTitle: boolean;
    readonly forceCreateGoal: boolean;
    readonly createdAt: string;
  }) {
    const attachments = input.attachments ?? [];
    const { textGenerationModelSelection: modelSelection } =
      yield* serverSettingsService.getSettings;
    const { prompt, outputSchema } = buildThreadInterpretationPrompt({
      message: input.messageText,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    const interpretation = yield* textGeneration.generateStructured({
      prompt,
      outputSchema,
      modelSelection,
    });

    const thread = yield* resolveThread(input.threadId);
    // Bail only if the thread vanished during generation. NOTE: unlike the
    // original guard, we do NOT bail when a goal already exists — a goal-attached
    // root (new thread under an existing goal) still needs its `derived` title
    // applied so ambient retitling can reach `derived` and stop (§4 finding 3).
    // The goal-creation half below is what the goalId guard gates, not titling.
    if (!thread) return;

    if (input.applyTitle) {
      const title = sanitizeThreadTitle(interpretation.title);
      // loom: §4 the LLM interpretation is a `derived` write — it may replace a
      // default/seed title but never a curated one (the decider enforces this
      // too; checking here also avoids a pointless branch rename).
      if (title.length > 0 && canReplaceTitle(thread.titleProvenance, "derived")) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title,
          titleProvenance: "derived",
        });
        // Keep the git branch consistent with the generated title: rename the
        // temporary worktree branch off the same title in one model call.
        yield* renameWorktreeBranchToTitle({
          threadId: input.threadId,
          branch: thread.branch,
          worktreePath: thread.worktreePath,
          title,
        });
      }
    }

    // Goal creation is gated separately: a thread that already has a goal never
    // gets a second one (its title was still applied above).
    if (thread.goalId) return;
    if (!input.forceCreateGoal && interpretation.confidence !== "high") {
      return;
    }

    const goalTitle = interpretation.goal.title.trim();
    if (goalTitle.length === 0) return;
    const goalDescription = interpretation.goal.description.trim();

    // Resolve a unique slug before dispatch: the DB `UNIQUE (project_id, slug)`
    // constraint (and `requireUniqueGoalSlug`) reserves slugs of deleted goals
    // too, so collide against every goal in the project regardless of state.
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const existingSlugs = new Set(
      readModel.goals
        .filter((goal) => goal.projectId === thread.projectId)
        .map((goal) => goal.slug),
    );
    const baseSlug = slugify(goalTitle);
    let slug = baseSlug;
    for (let suffix = 2; existingSlugs.has(slug); suffix += 1) {
      slug = `${baseSlug}-${suffix}`;
    }

    const goalId = GoalId.make(yield* crypto.randomUUIDv4);
    yield* orchestrationEngine.dispatch({
      type: "goal.create",
      commandId: yield* serverCommandId("goal-auto-create"),
      goalId,
      projectId: thread.projectId,
      slug,
      title: goalTitle,
      // loom: §4 an emergent goal is a `derived` title (LLM interpretation).
      titleProvenance: "derived",
      ...(goalDescription.length > 0 ? { description: goalDescription } : {}),
      createdAt: input.createdAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.meta.update",
      commandId: yield* serverCommandId("thread-goal-attach"),
      threadId: input.threadId,
      goalId,
    });
  });

  // Acquire the per-thread interpretation lock, run interpretation forked +
  // failure-logged, and release the lock when the fork settles. Returns without
  // doing anything if a fork for this thread is already outstanding.
  const startThreadInterpretation = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly titleSeed?: string;
    readonly applyTitle: boolean;
    readonly forceCreateGoal: boolean;
    readonly createdAt: string;
  }) {
    const key = String(input.threadId);
    if (inFlightInterpretations.has(key)) return;
    inFlightInterpretations.add(key);
    yield* interpretThreadIntent(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to interpret thread intent", {
          threadId: input.threadId,
          cause: Cause.pretty(cause),
        }),
      ),
      Effect.ensuring(Effect.sync(() => inFlightInterpretations.delete(key))),
      Effect.forkScoped,
    );
  });

  // loom: stuck-launch recovery guard. This span writes `session.starting` and
  // then BLOCKS in `providerService.startSession` (process spawn / pi fork / MCP
  // handshake) without writing anything further — no session event, and no runtime
  // binding until `bindSessionToThread` runs after it resolves. A liveness sweep
  // sampling that quiet window sees a textbook wedge whose CAS tokens both match,
  // and would recover it into a SECOND prompt. An in-memory launch claim held
  // across the whole span is the only evidence that distinguishes "mid-launch" from
  // "wedged", so recovery fails closed while it is held.
  const processTurnStartRequestedInner = Effect.fn("processTurnStartRequestedInner")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    // Worktree-isolation invariant (item 4): a turn must never start against an
    // isolated child whose worktree was never provisioned. A promote-time
    // provisioning failure leaves branch/worktreePath pointing at the PARENT, so
    // without this the turn would run in the parent's worktree and silently
    // defeat isolation. EVERY turn-start funnels through here — the kick-off, an
    // orchestrator `workstream_prompt`, a client-initiated resume, gate
    // traversals, wakes — so this single chokepoint (re)provisions before the
    // turn. The predicate is restart-safe: it reads the child's own durable
    // branch meta, not the in-process failed-provision marker. Idempotent — an
    // already-provisioned child (its own `ws/…` branch) skips it.
    // Post-completion engagement (plan §8 item 4 — the defect B fix): a thread
    // whose pi session file EXISTS has provably run, so it must never be
    // re-provisioned and never treated as a never-started child (no kickoff-brief
    // re-delivery). Fan-in repoints the branch to the parent's, which makes the
    // branch-name predicate below unable to tell "never provisioned" from
    // "provisioned, fanned in, worktree reaped" — it guesses the former and cuts a
    // fresh worktree + re-delivers the brief to a completed thread. Session-file
    // existence is the durable, unambiguous "has provably run" proof. The
    // re-provision path below stays for GENUINELY never-started children (no
    // session file yet) — its legitimate purpose.
    let recoveredNeverStartedChild = false;
    if (
      shouldReprovisionIsolatedChild({
        sessionFileExists: resolveSessionFilePath(piSessionIdForThread(thread.id)) !== undefined,
        isolation: thread.isolation,
        branch: thread.branch,
        threadId: thread.id,
      })
    ) {
      const provisioned = yield* worktreeProvisioner.ensureIsolatedChildProvisioned({
        threadId: thread.id,
        role: thread.role ?? "child",
        projectId: thread.projectId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
      });
      if (!provisioned) {
        // ensureIsolatedChildProvisioned already re-parked (activity +
        // needs_guidance). Clear the pending turn-start row so the idle gate does
        // not treat the child as perpetually busy, and do NOT start the turn.
        yield* clearPendingTurnStartForFailedTurn({
          threadId: event.payload.threadId,
          turnStartKey: key,
          detail:
            "Worktree provisioning failed before the turn could start; the child was re-parked (needs_guidance).",
          createdAt: event.payload.createdAt,
        });
        return;
      }
      // An unprovisioned isolated branch is a durable proof the kick-off turn was
      // never dispatched (the promote path only fires it AFTER provisioning
      // succeeds), so the spawn brief was never delivered. Having just recovered
      // the worktree, this turn IS the kick-off — its message must carry the brief.
      recoveredNeverStartedChild = true;
    }

    // Deliver the never-delivered kick-off brief on the recovery turn. The
    // documented recovery move (`workstream_prompt` a parked child) otherwise
    // starts the child with only the orchestrator's message; here we prepend the
    // exact kick-off content (same `workstreamChildPrompt` composition the promote
    // path uses — one brief-assembly path, no bespoke variant) so the recovered
    // first turn reads as the kick-off plus the orchestrator's extra message. A
    // child whose kick-off already ran keeps `message.text` untouched (its branch
    // is provisioned, so this block never runs) — later prompts never re-deliver.
    // Scaffold plan §1: the kick-off brief now lives on disk (the event store
    // holds only the `kickoffBriefPath` pointer), so read the file content here
    // instead of the event-sourced `brief` string. Falls back to `brief ??
    // purpose` for a legacy brief-less child whose pointer was never attached.
    const kickoffBrief =
      recoveredNeverStartedChild && thread.kickoffBriefPath !== null
        ? Option.getOrNull(yield* readWorkstreamBriefAt(thread.kickoffBriefPath))
        : (thread.brief ?? thread.purpose);
    const effectiveMessageText =
      recoveredNeverStartedChild && thread.role !== null && kickoffBrief !== null
        ? `${workstreamChildPrompt({ role: thread.role, brief: kickoffBrief, gateTargetId: gateLoopTargetOf(thread) })}\n\n${message.text}`
        : message.text;

    const userMessages = thread.messages.filter((entry) => entry.role === "user");
    const isFirstUserMessageTurn = userMessages.length === 1;
    const titleSeed = toNonEmptyProviderInput(event.payload.titleSeed);

    // loom: §1 workstream children NEVER interpret intent: they inherit their
    // goal from the parent (healed by the goal-attach-down cascade if spawned
    // during a goal-less window) and their curated title from the spawn. Running
    // the emergent-goal invariant on a child is exactly what created orphan
    // child-only goals. Only roots interpret.
    //
    // loom: `/handoff` fork-drafter (plan D3/D6) — a handoff-drafter root is
    // ALSO excluded: it is a throwaway fork with a curated title and either the
    // source's goal or (legitimately) none. Emergent-goal interpretation on a
    // goal-less drafter would spend a model call AND attach an orphan goal that
    // survives its own archive (the goal-attach decider requires existence, not
    // active state), violating “only the staged destination remains”.
    //
    // loom: `/retro` fork-reviewer — excluded for the same reason: a curated
    // title and the source's goal (or legitimately none); its transcript is the
    // SOURCE's conversation, so interpretation would name a goal after the
    // reviewed work rather than the review.
    if (
      thread.parentThreadId === null &&
      thread.role !== HANDOFF_DRAFTER_ROLE &&
      thread.role !== RETRO_REVIEWER_ROLE
    ) {
      // §4 apply the client's title SEED immediately through the guarded path so
      // the sidebar shows a real title before the slower LLM interpretation
      // lands — but only while the title is still the "New thread" default and
      // the seed itself carries more than the default.
      if (
        titleProvenanceRank(thread.titleProvenance) === 0 &&
        titleSeed !== undefined &&
        titleSeed !== DEFAULT_THREAD_TITLE
      ) {
        yield* orchestrationEngine
          .dispatch({
            type: "thread.meta.update",
            commandId: yield* serverCommandId("thread-title-seed"),
            threadId: event.payload.threadId,
            title: titleSeed,
            titleProvenance: "seed",
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }

      // Emergent goals ("every session has a goal" invariant): interpret intent
      // while the thread still lacks a goal OR its title is still
      // automation-malleable (default/seed). Turn 1 is confidence-gated (create
      // a goal only when confident); turn 2+ force the best-guess goal. The
      // per-thread in-flight lock dedups overlapping attempts, so this retries
      // across turns rather than stranding a thread goal-less. Once a goal
      // exists AND the title has reached `derived`/`curated`, ambient
      // interpretation stops.
      const needsGoal = !thread.goalId;
      const titleMalleable = canReplaceTitle(thread.titleProvenance, "derived");
      if (needsGoal || titleMalleable) {
        // §4/Bug B: interpret from the OPENING CONTEXT — what the thread is
        // ABOUT — not the message that happened to trigger this turn. On turn 1
        // the triggering message IS the opening message, so it is the input. On
        // turn 2+ the trigger is a mid-conversation instruction ("Merge coder
        // changes") that must be EXCLUDED entirely, or it reproduces the bug of
        // naming the goal after the instruction. We anchor on the first user
        // message (which predates the trigger) and its attachments.
        const openingMessage = userMessages[0];
        const interpretationText = isFirstUserMessageTurn
          ? effectiveMessageText
          : (openingMessage?.text ?? effectiveMessageText);
        const interpretationAttachments = isFirstUserMessageTurn
          ? message.attachments
          : openingMessage?.attachments;
        yield* startThreadInterpretation({
          threadId: event.payload.threadId,
          applyTitle: titleMalleable,
          forceCreateGoal: needsGoal && !isFirstUserMessageTurn,
          createdAt: event.payload.createdAt,
          messageText: interpretationText,
          ...(interpretationAttachments !== undefined
            ? { attachments: interpretationAttachments }
            : {}),
          ...(titleSeed !== undefined ? { titleSeed } : {}),
        });
      }
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }
      const detail = formatFailureDetail(cause);
      return clearPendingTurnStartForFailedTurn({
        threadId: event.payload.threadId,
        turnStartKey: key,
        detail,
        createdAt: event.payload.createdAt,
      }).pipe(
        Effect.flatMap(() =>
          setThreadSessionErrorOnTurnStartFailure({
            threadId: event.payload.threadId,
            detail,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.flatMap(() =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
          }),
        ),
        Effect.asVoid,
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageText: effectiveMessageText,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(Option.none()))),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    yield* providerService
      .sendTurn(sendTurnRequest.value)
      .pipe(Effect.catchCause(recoverTurnStartFailure), Effect.forkScoped);
  });

  /**
   * Settle every question open on a thread from the COMMAND path, before any
   * adapter call — the interrupt/stop half of the settlement guarantee.
   *
   * The runtime cancel paths only fire when the adapter is reachable
   * (`ProviderService.stopSession` calls `adapter.stopSession` solely when
   * `routed.isActive`, and interrupt returns early when no session is bound), so
   * a stop or interrupt against an already-dead provider used to clear nothing —
   * reproducing incident 1's stale shape from a deliberate human action, and
   * leaving the Stop control unable to unwedge the very state it looks like it
   * should fix. Settling here first makes provider cancellation pure
   * delivery/cleanup: if it also emits a resolution, ingestion drops that echo.
   */
  const settleOpenUserInputRequests = Effect.fn("settleOpenUserInputRequests")(function* (input: {
    readonly thread: { readonly id: ThreadId; readonly activities: ReadonlyArray<unknown> };
    readonly createdAt: string;
    readonly tag: string;
  }) {
    const openRequestIds = openUserInputRequestIds(
      input.thread.activities as ReadonlyArray<{
        readonly kind: string;
        readonly payload: unknown;
      }>,
    );
    if (openRequestIds.size === 0) return;
    yield* dispatchUserInputResolutions({
      dispatch: orchestrationEngine.dispatch,
      newId: crypto.randomUUIDv4,
      threadId: input.thread.id,
      resolutions: [...openRequestIds].map((requestId) => ({
        requestId,
        outcome: "cancelled" as const,
      })),
      createdAt: input.createdAt,
      tag: input.tag,
    });
  });

  // loom: the claim wrapper (see the note above `processTurnStartRequestedInner`).
  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    return yield* launchClaims.withClaim(
      event.payload.threadId,
      processTurnStartRequestedInner(event),
    );
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    // Settle BEFORE the liveness check: an interrupt of a thread whose provider is
    // already gone must still end its open questions, or a human pressing Stop on
    // a wedged thread changes nothing.
    yield* settleOpenUserInputRequests({
      thread,
      createdAt: event.payload.createdAt,
      tag: "turn-interrupt",
    });

    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService.interruptTurn({ threadId: event.payload.threadId });
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.approval.respond.failed",
            summary: "Provider approval response failed",
            detail: isUnknownPendingApprovalRequestError(cause)
              ? stalePendingRequestDetail("approval", event.payload.requestId)
              : Cause.pretty(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          }),
        ),
      );
  });

  /**
   * Deliver an ALREADY-SETTLED question outcome (the decider settled it in the
   * same transaction that produced this event — see `userInputSettlementEvents`).
   * Delivery is therefore best-effort by design: nothing here can leave the
   * question open, and a `respond.failed` activity is a delivery diagnostic that
   * clears nothing (no consumer prose-matches it anymore).
   *
   * When there is no live consumer — dead session, restarted server, relaunched
   * process — the outcome is converted into a normal turn instead of being lost:
   * the human's answer opens the next turn, tagged to the request. That is the
   * durable consumer the original plan argued did not exist; it does, it is just
   * the next turn rather than the dead tool call.
   */
  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const outcome = event.payload.outcome ?? DEFAULT_USER_INPUT_RESOLVED_OUTCOME;
      // EXACTLY-ONCE, durably. Both ids are derived from the causative settlement
      // event, not minted fresh per attempt: `event.eventId` is the id of the
      // durable `thread.user-input-response-requested` that triggered this
      // delivery, so a reactor retry, a redelivery, or a replay of that event
      // produces the SAME command id and the engine's command receipt turns the
      // second dispatch into a no-op. A random id would open a duplicate turn and
      // deliver an action-bearing human message twice.
      const fallbackCommandId = CommandId.make(
        `server:user-input-late-delivery:${event.payload.requestId}:${event.eventId}`,
      );
      const fallbackMessageId = MessageId.make(`user-input-late-delivery:${event.eventId}`);
      const deliverAsNextTurn = (detail: string) =>
        Effect.gen(function* () {
          yield* appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.user-input.respond.failed",
            summary: "Provider user input delivery failed; delivered as a new turn instead",
            detail,
            turnId: null,
            createdAt: event.payload.createdAt,
            requestId: event.payload.requestId,
          });
          const messageId = fallbackMessageId;
          yield* orchestrationEngine
            .dispatch({
              type: "thread.turn.start",
              commandId: fallbackCommandId,
              threadId: event.payload.threadId,
              message: {
                messageId,
                role: "user",
                origin: "control_notice",
                text: renderUserInputOutcomeAsTurnOpener({
                  requestId: event.payload.requestId,
                  outcome,
                  answers: event.payload.answers,
                  ...(event.payload.message !== undefined
                    ? { message: event.payload.message }
                    : {}),
                }),
                attachments: [],
              },
              titleSeed: thread.title,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              createdAt: event.payload.createdAt,
            })
            .pipe(Effect.ignoreCause({ log: true }));
        });

      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* deliverAsNextTurn("No active provider session is bound to this thread.");
      }

      const delivery = yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
          outcome,
          ...(event.payload.message !== undefined ? { message: event.payload.message } : {}),
        })
        .pipe(
          Effect.map(Option.some),
          Effect.catchCause((cause) =>
            deliverAsNextTurn(Cause.pretty(cause)).pipe(Effect.as(Option.none())),
          ),
        );

      // The callback was released but could not carry the outcome's CONTENT — in
      // practice a supersede message on a provider whose question protocol models
      // only accepted/cancelled. The human's words must still reach the model, so
      // they open exactly one new turn. This is the ONLY path that produces a
      // turn-start for a supersede: the decider deliberately withholds one, so
      // there is no route by which the same instruction is delivered twice.
      if (Option.isSome(delivery) && !delivery.value.deliveredContent) {
        yield* deliverAsNextTurn(
          `The ${thread.session?.providerName ?? "provider"} question callback cannot carry a '${outcome}' outcome's content; delivering it as a new turn instead.`,
        );
      }
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    // As with interrupt: settle from the command path first, so a stop against an
    // inactive adapter (where `ProviderService` skips `adapter.stopSession`
    // entirely) still ends the thread's open questions.
    yield* settleOpenUserInputRequests({ thread, createdAt: now, tag: "session-stop" });
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        ...(thread.session?.lastErrorClass !== undefined
          ? { lastErrorClass: thread.session.lastErrorClass }
          : {}),
        queuedMessages: { steering: [], followUp: [] },
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
