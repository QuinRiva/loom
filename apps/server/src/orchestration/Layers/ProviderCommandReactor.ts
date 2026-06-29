import {
  type ChatAttachment,
  CommandId,
  EventId,
  GoalId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationGoal,
  type OrchestrationGoalTask,
  ProviderDriverKind,
  type ProjectId,
  type OrchestrationSession,
  ThreadId,
  type ProviderSession,
  type RuntimeMode,
  type TurnId,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import { slugify } from "@t3tools/shared/String";
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

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { buildThreadInterpretationPrompt } from "../../textGeneration/TextGenerationPrompts.ts";
import { sanitizeThreadTitle } from "../../textGeneration/TextGenerationUtils.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { loadRoleOverlay } from "../roleOverlay.ts";
import { VcsStatusBroadcaster } from "../../vcs/VcsStatusBroadcaster.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
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
const DEFAULT_THREAD_TITLE = "New thread";

const renderGoalTasksForPrompt = (
  tasks: ReadonlyArray<OrchestrationGoalTask>,
  depth: number,
): string =>
  tasks
    .map(
      (task) =>
        `${"  ".repeat(depth)}- [${task.done ? "x" : " "}] ${task.text} (${task.id})\n` +
        renderGoalTasksForPrompt(task.children, depth + 1),
    )
    .join("");

const activeGoalContextInstruction = (
  goal: OrchestrationGoal,
  opts?: { readonly asChildBackground?: boolean },
) => {
  const tasks =
    goal.tasks.length === 0 ? "(no tasks yet)" : renderGoalTasksForPrompt(goal.tasks, 0).trimEnd();
  if (opts?.asChildBackground) {
    return [
      `Background context — your parent orchestrator is working toward this overall goal \`${goal.id}\` (${goal.slug}): ${goal.title}`,
      goal.description.trim().length > 0
        ? `\nParent's objective (background only, NOT your task): ${goal.description.trim()}`
        : "",
      `\n\nYour authoritative task is the spawn brief in your first message. This goal is provided only so your work aligns with the wider effort — do not execute it directly or treat its objective as your own assignment. If the brief and this goal appear to conflict, follow the brief.`,
      `\n\nParent's current task tree (for orientation only; you do not manage it):\n${tasks}`,
    ].join("");
  }
  return [
    `Active goal \`${goal.id}\` (${goal.slug}): ${goal.title}`,
    goal.description.trim().length > 0 ? `\nObjective: ${goal.description.trim()}` : "",
    `\n\nCurrent tasks:\n${tasks}`,
    `\n\nKeep the task list current as you work — do NOT edit goal files. Use the CLI:`,
    `\n  t3 goal task add ${goal.id} "<text>" [--parent <task-id>]`,
    `\n  t3 goal task done ${goal.id} <task-id>`,
    `\n  t3 goal task open ${goal.id} <task-id>`,
    `\n  t3 goal task rename ${goal.id} <task-id> "<text>"`,
    `\n  t3 goal task delete ${goal.id} <task-id>`,
    `\n  t3 goal update ${goal.id} [--title <title>] [--description <text>]`,
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

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
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

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = findProviderAdapterRequestError(cause);
  if (error) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending user-input request") ||
      detail.includes("unknown pending user input request") ||
      detail.includes("unknown pending codex user input request")
    );
  }
  const message = Cause.pretty(cause).toLowerCase();
  return (
    message.includes("unknown pending user-input request") ||
    message.includes("unknown pending user input request") ||
    message.includes("unknown pending codex user input request")
  );
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
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
  const providerRegistry = yield* ProviderRegistry;
  const gitWorkflow = yield* GitWorkflowService;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster;
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
    const session = thread?.session;
    if (!session) {
      return;
    }
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...session,
        status: session.status === "stopped" ? "stopped" : "ready",
        activeTurnId: null,
        lastError: input.detail,
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
    },
  ) {
    const thread = yield* resolveThread(threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const requestedModelSelection = options?.modelSelection;
    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const activeSession = yield* resolveActiveSession(threadId);
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
        const roleSystemPrompt = loadRoleOverlay({
          role: thread.role,
          projectRoot: effectiveCwd ?? process.cwd(),
        });
        const appendSystemPrompt = [roleSystemPrompt, goalSystemPrompt]
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
            status: mapProviderSessionStatusToOrchestrationStatus(session.status),
            providerName: session.provider,
            providerInstanceId: session.providerInstanceId,
            runtimeMode: desiredRuntimeMode,
            // Provider turn ids are not orchestration turn ids.
            activeTurnId: null,
            lastError: session.lastError ?? null,
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
    yield* ensureSessionForThread(
      input.threadId,
      input.createdAt,
      input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {},
    );
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
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
    const modelForTurn =
      sessionModelSwitch === "unsupported" && input.modelSelection === undefined
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    return {
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    };
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const { textGenerationModelSelection: modelSelection } =
        yield* serverSettingsService.getSettings;

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

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
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
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
    // Bail if the thread vanished or already gained a goal during generation.
    if (!thread || thread.goalId) return;

    if (input.applyTitle) {
      const title = sanitizeThreadTitle(interpretation.title);
      if (title.length > 0 && canReplaceThreadTitle(thread.title, input.titleSeed)) {
        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: yield* serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title,
        });
      }
    }

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

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
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

    const userMessageCount = thread.messages.filter((entry) => entry.role === "user").length;
    const isFirstUserMessageTurn = userMessageCount === 1;
    const generationInput = {
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
    };

    if (isFirstUserMessageTurn) {
      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);
    }

    // Emergent goals ("every session has a goal" invariant): interpret intent on
    // every user turn while the thread is still goal-less. Turn 1 is
    // confidence-gated (create a goal only when confident); turn 2+ force the
    // best-guess goal regardless of confidence. The per-thread in-flight lock in
    // startThreadInterpretation dedups overlapping attempts, so this retries
    // until a goal exists rather than giving up after a fixed turn (a turn-count
    // gate here would strand a thread goal-less if the turn-1 interpretation was
    // still in flight when turn 2 arrived). Threads spawned under an existing
    // goal already have goalId set and are skipped.
    if (!thread.goalId) {
      yield* startThreadInterpretation({
        threadId: event.payload.threadId,
        applyTitle: isFirstUserMessageTurn,
        forceCreateGoal: !isFirstUserMessageTurn,
        createdAt: event.payload.createdAt,
        ...generationInput,
      });
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
      messageText: message.text,
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

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
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

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : Cause.pretty(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
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
