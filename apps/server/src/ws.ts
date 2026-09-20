import {
  sameUsageLimitCommandCoverage,
  withUsageLimitsCommands,
} from "@t3tools/shared/usageLimits";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthReviewWriteScope,
  AuthRelayWriteScope,
  AuthTerminalOperateScope,
  AuthAccessReadScope,
  AuthAccessStreamError,
  type AuthAccessStreamEvent,
  type AuthEnvironmentScope,
  AuthSessionId,
  ClientConnectionMethod,
  ClientDeviceType,
  ClientOs,
  ClientSurface,
  ClientWebDeployment,
  CommandId,
  DEFAULT_THREAD_TITLE,
  type DiscoveredLocalServerList,
  GoalId,
  EventId,
  type EditorId,
  type FileManagerRevealKind,
  type OrchestrationClientOrigin,
  type OrchestrationCommand,
  type GitActionProgressEvent,
  type GitManagerServiceError,
  MessageId,
  ModelSelection,
  OrchestrationDispatchCommandError,
  type OrchestrationEvent,
  type OrchestrationShellStreamEvent,
  type OrchestrationThreadShell,
  type OrchestrationThreadStreamItem,
  type OrchestrationShellStreamItem,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetSnapshotError,
  OrchestrationGetThreadActivitiesError,
  OrchestrationGetThreadLifecycleError,
  OrchestrationSearchThreadsError,
  OrchestrationGetTurnDiffError,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  type ProjectEntriesFailure,
  type ProjectFileFailure,
  type ProjectFileOperation,
  ProjectListAbsoluteDirectoryError,
  ProjectListEntriesError,
  ProjectReadAbsoluteFileError,
  ProjectReadFileError,
  ProjectSearchContentsError,
  ProjectSearchEntriesError,
  ProjectStatPathsError,
  ProjectWriteFileError,
  ProviderUploadFeedbackError,
  ProviderSetupError,
  RelayClientInstallFailedError,
  type RelayClientInstallProgressEvent,
  ServerSelfUpdateError,
  type ServerSelfUpdateProgressEvent,
  type ServerLifecycleStreamEvent,
  type FilesystemBrowseFailure,
  FilesystemBrowseError,
  AssetWorkspaceContextNotFoundError,
  AssetWorkspaceContextResolutionError,
  RpcClientId,
  EnvironmentAuthorizationError,
  type ServerProvider,
  ThreadId,
  type TerminalAttachStreamEvent,
  type TerminalError,
  type TerminalEvent,
  type TerminalMetadataStreamEvent,
  type PullRequestRef,
  WS_METHODS,
  WsRpcGroup,
  WORKTREE_SETUP_ACTIVITY_KIND,
  worktreeSetupActivityId,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import { HttpRouter, HttpServerRequest, HttpServerRespondable } from "effect/unstable/http";
import { RpcSerialization, RpcServer } from "effect/unstable/rpc";

import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "./config.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import {
  projectActivityEvent,
  projectThreadDetailSnapshot,
} from "./orchestration/ActivityPayloadProjection.ts";
import { makeThreadLiveEventCoalescer } from "./orchestration/ThreadLiveEventCoalescer.ts";
import { makeLiveStreamBudget, type RetainedLiveItem } from "./orchestration/LiveStreamBudget.ts";
import {
  cleanupFailedUploadedAttachments,
  normalizeDispatchCommand,
} from "./orchestration/Normalizer.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "./orchestration/Services/ThreadDeletionReactor.ts";
import {
  makeBriefNeededOutwardAttention,
  type BriefNeededOutwardAttention,
} from "./orchestration/briefNeededOutwardAttention.ts";
import type { ProjectionRepositoryError } from "./persistence/Errors.ts";
import * as UsageBreakdownQuery from "./orchestration/Services/UsageBreakdownQuery.ts";
import * as ReasoningStreamBus from "./orchestration/Services/ReasoningStreamBus.ts";
import { makeLoomWsHandlers } from "./loom/wsMethods.ts"; // loom:
import {
  observeRpcEffect as instrumentRpcEffect,
  observeRpcStream as instrumentRpcStream,
  observeRpcStreamEffect as instrumentRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as AccountUsageRegistry from "./provider/Services/AccountUsageRegistry.ts";
import {
  type ExhaustionMark,
  ProviderHealthRegistry,
} from "./provider/Services/ProviderHealthRegistry.ts";
import type { UsageLimitSourceSnapshot } from "@t3tools/contracts";
import { overlayProviderExhaustion } from "./provider/providerExhaustionOverlay.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import { ProviderAuthService } from "./provider/Services/ProviderAuthService.ts";
import { ProviderInstanceRegistry } from "./provider/Services/ProviderInstanceRegistry.ts";
import { makeProviderInstallation } from "./provider/providerInstallation.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { withTerminalOutputWindow } from "./terminal/OutputProtocol.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as DeviceService from "./device/DeviceService.ts";
import { remoteSshDeviceHosts } from "./device/localSshDeviceHost.ts";
import * as PreviewManager from "./preview/Manager.ts";
import { issueAssetUrl } from "./assets/AssetAccess.ts";
import { deletePendingAttachment, issueAttachmentUploadUrl } from "./assets/AttachmentUpload.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import { readWorkflowScript } from "./orchestration/workflowScriptQuery.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import { linkCreatedPullRequest } from "./git/linkCreatedPullRequest.ts";
import * as ReviewService from "./review/ReviewService.ts";
import { WorktreeProvisioner } from "./project/WorktreeProvisioner.ts";
import { WorkspaceLease } from "./workspace/WorkspaceOccupancyLease.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as AgentSessionScanner from "./project/AgentSessionScanner.ts";
import { importRecentAgentThreads } from "./project/AgentSessionImporter.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import { requiredScopeForRpcMethod } from "./auth/RpcAuthorization.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as WorkstreamWorktreeStatus from "./orchestration/WorkstreamWorktreeStatus.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as UsageLimitSources from "./usage/UsageLimitSources.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import { listLinkedPullRequestThreads } from "./pullRequest/linkedThreads.ts";
import { pullRequestSyncKey } from "./pullRequest/pullRequestSyncKey.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as PullRequestSyncReactor from "./orchestration/PullRequestSyncReactor.ts";
import * as SourceControlDiscovery from "./sourceControl/SourceControlDiscovery.ts";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as AzureDevOpsCli from "./sourceControl/AzureDevOpsCli.ts";
import * as BitbucketApi from "./sourceControl/BitbucketApi.ts";
import * as GitHubCli from "./sourceControl/GitHubCli.ts";
import * as GitLabCli from "./sourceControl/GitLabCli.ts";
import * as ForgejoCli from "./sourceControl/ForgejoCli.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./auth/http.ts";
import {
  buildHandoffDraftTurnStart,
  capturedDrafterSelectionCandidate,
} from "./loom/handoffDraft.ts"; // loom: `/handoff` fork-drafter
import { buildRetroDraftTurnStart } from "./loom/retroDraft.ts"; // loom: `/retro` fork-reviewer
import { readLaunchIdentity } from "./orchestration/workstreamLaunchIdentity.ts"; // loom:
import { isThreadIdle } from "./orchestration/threadIdle.ts"; // loom:
import * as RelayClient from "@t3tools/shared/relayClient";
const isOrchestrationDispatchCommandError = Schema.is(OrchestrationDispatchCommandError);
// loom: `/handoff` fork-drafter (plan D4) — validate a source's captured
// launch-identity selection before seeding the drafter with it.
const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);

// loom: cap catch-up replay on the shell subscription's afterSequence path.
// Beyond this many events a fresh snapshot is strictly cheaper than an event
// tail (≥5 projection queries per event + a full thread-shell payload repeated
// per touched thread, vs each aggregate sent once) and closes the silent-drop
// window that lives in the per-event lookup. 500 == one event-store read page
// (READ_PAGE_SIZE), so a permitted replay is always a single page; it also
// covers the common resume cases the resume path exists for (tab refocus, brief
// blips, short sleep). A large overnight gap — the incident habitat — snapshots.
const SHELL_CATCHUP_MAX_EVENTS = 500;

// loom: cap catch-up replay on the thread subscription's afterSequence path.
// Unlike the shell cap this counts ONE thread's detail events (the per-stream
// read makes that the natural unit), so it is far more generous in practice: the
// incident that motivated this work needed 148. A thread exceeding it is a
// long-running one where a single snapshot beats a long event tail. Semantics:
// replay up to and including 500 detail events; snapshot only when a 501st
// exists. See plans/2026-07-28-thread-catchup-silent-truncation.md.
const THREAD_CATCHUP_MAX_EVENTS = 500;

// loom: batch the thread subscription's live leg into multi-value RPC frames.
// One turn emits ~50 thread detail events a few milliseconds apart, and one
// frame each spends ~50 WebSocket envelopes (plus their per-frame overhead) on
// data that fits in a dozen. Re-homed from upstream's pull-5 burst coalescing,
// which applies exactly this `groupedWithin` shape on its shell leg
// (SHELL_COALESCE_*). The thread leg only *batches*: unlike the shell leg it
// must never collapse two events into one, because the client applies every
// activity item, so each group is re-emitted whole and in order as one chunk.
// The window bounds the worst-case added latency for an activity item to reach
// the UI (imperceptible next to a turn) and is what makes the batching
// deterministic rather than a function of how fast the server happens to be.
const THREAD_COALESCE_WINDOW = Duration.millis(50);
const THREAD_COALESCE_MAX_CHUNK = 512;
const coalesceThreadStream = <E, R>(
  stream: Stream.Stream<OrchestrationThreadStreamItem, E, R>,
): Stream.Stream<OrchestrationThreadStreamItem, E, R> =>
  stream.pipe(
    Stream.groupedWithin(THREAD_COALESCE_MAX_CHUNK, THREAD_COALESCE_WINDOW),
    Stream.flatMap((items) => Stream.fromIterable(items)),
  );

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
const CONFIG_DISCOVERY_TIMEOUT = Duration.seconds(5);

const resolveDiscoveryForConfig = <A, E, R>(
  discovery: Effect.Effect<A, E, R>,
  onTimeout: () => A,
) =>
  discovery.pipe(
    Effect.timeoutOption(CONFIG_DISCOVERY_TIMEOUT),
    Effect.map(Option.getOrElse(onTimeout)),
  );

export const resolveAvailableEditorsForConfig = <A, E, R>(
  discovery: Effect.Effect<ReadonlyArray<A>, E, R>,
) => resolveDiscoveryForConfig(discovery, () => []);

export const resolveFileManagerRevealKindForConfig = <E, R>(
  discovery: Effect.Effect<FileManagerRevealKind | undefined, E, R>,
) => resolveDiscoveryForConfig(discovery, () => undefined);

function unexpectedCompatibilityError(error: never): never {
  throw new Error(`Unhandled compatibility error: ${String(error)}`);
}

/** Preserve the setup runner's broader pre-refactor message normalization. */
function legacySetupFailureDescription(cause: unknown): string {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "message" in cause &&
    typeof cause.message === "string"
  ) {
    return cause.message;
  }
  return String(cause);
}

function projectEntriesFailureContext(error: WorkspaceEntries.WorkspaceEntriesError): {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
} {
  switch (error._tag) {
    case "WorkspaceRootNotExistsError":
      return {
        failure: "workspace_root_not_found",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootCreateFailedError":
      return {
        failure: "workspace_root_create_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceRootStatFailedError":
      return {
        failure: "workspace_root_stat_failed",
        normalizedCwd: error.normalizedWorkspaceRoot,
        detail: error.phase,
      };
    case "WorkspaceRootNotDirectoryError":
      return {
        failure: "workspace_root_not_directory",
        normalizedCwd: error.normalizedWorkspaceRoot,
      };
    case "WorkspaceEntriesReadDirectoryError":
      return {
        failure: "directory_list_failed",
        ...(error.cwd !== undefined ? { normalizedCwd: error.cwd } : {}),
        detail: error.message,
      };
    case "WorkspaceSearchIndexCreateFailed":
      return {
        failure: "search_index_create_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    case "WorkspaceSearchIndexScanTimedOut":
      return {
        failure: "search_index_scan_timed_out",
        normalizedCwd: error.cwd,
        timeout: error.timeout,
      };
    case "WorkspaceSearchIndexSearchFailed":
      return {
        failure: "search_index_search_failed",
        normalizedCwd: error.cwd,
        detail: error.reason,
      };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function filesystemBrowseFailureContext(error: WorkspaceEntries.WorkspaceEntriesBrowseError): {
  readonly failure: FilesystemBrowseFailure;
  readonly parentPath?: string;
  readonly platform?: string;
} {
  switch (error._tag) {
    case "WorkspaceEntriesWindowsPathUnsupportedError":
      return { failure: "windows_path_unsupported", platform: error.platform };
    case "WorkspaceEntriesCurrentProjectRequiredError":
      return { failure: "current_project_required" };
    case "WorkspaceEntriesReadDirectoryError":
      return { failure: "read_directory_failed", parentPath: error.parentPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectFileFailureContext(
  error:
    | WorkspaceFileSystem.WorkspaceFileSystemError
    | WorkspacePaths.WorkspacePathOutsideRootError,
): {
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
} {
  switch (error._tag) {
    case "WorkspacePathOutsideRootError":
      return { failure: "workspace_path_outside_root" };
    case "WorkspaceFileSystemOperationError":
      return {
        failure: "operation_failed",
        resolvedPath: error.resolvedPath,
        operation: error.operation,
        operationPath: error.operationPath,
      };
    case "WorkspaceFilePathEscapeError":
      return {
        failure: "resolved_path_outside_root",
        resolvedPath: error.resolvedPath,
        resolvedWorkspaceRoot: error.resolvedWorkspaceRoot,
      };
    case "WorkspacePathNotFileError":
      return { failure: "path_not_file", resolvedPath: error.resolvedPath };
    case "WorkspaceBinaryFileError":
      return { failure: "binary_file", resolvedPath: error.resolvedPath };
    default:
      return unexpectedCompatibilityError(error);
  }
}

function projectSetupScriptCompatibilityDetail(
  error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError,
): string {
  switch (error._tag) {
    case "ProjectSetupScriptOperationError":
      return legacySetupFailureDescription(error.cause);
    case "ProjectSetupScriptProjectNotFoundError":
      return "Project was not found for setup script execution.";
    default:
      return unexpectedCompatibilityError(error);
  }
}

// loom: adds thread.message-reasoning / thread.consult-recorded / thread.fanin-set
// (fork event types) to the upstream thread-detail event set.
export function isThreadDetailEvent(event: OrchestrationEvent): event is Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.message-sent"
      | "thread.message-reasoning"
      | "thread.proposed-plan-upserted"
      | "thread.activity-appended"
      | "thread.consult-recorded"
      | "thread.turn-diff-completed"
      | "thread.reverted"
      | "thread.session-set"
      | "thread.fanin-set";
  }
> {
  return (
    event.type === "thread.message-sent" ||
    event.type === "thread.message-reasoning" ||
    event.type === "thread.proposed-plan-upserted" ||
    event.type === "thread.activity-appended" ||
    event.type === "thread.consult-recorded" ||
    event.type === "thread.turn-diff-completed" ||
    event.type === "thread.reverted" ||
    event.type === "thread.session-set" ||
    // Fan-in settlement (merging → merged/conflicted) so an open thread's detail
    // updates live rather than only on the next shell-snapshot resync.
    event.type === "thread.fanin-set"
  );
}

const PROVIDER_STATUS_DEBOUNCE_MS = 200;

// When a resuming client's cursor is more than this many events behind the
// current head, skip the per-event catch-up replay and send a fresh shell
// snapshot instead. Replaying each intervening event costs a shell refetch;
// past this gap a single O(active-threads) snapshot is cheaper and bounded.
// Matches the event store's default page size (DEFAULT_READ_FROM_SEQUENCE_LIMIT).
const SHELL_RESUME_MAX_GAP = 1_000;

// Thread replay counts only this thread's rows. Busy or pruned unrelated
// streams must not force a full thread snapshot.
const THREAD_RESUME_MAX_EVENTS = 1_000;
// Row count alone does not bound replay memory: a few events with large tool
// payloads can decode to gigabytes. Before replaying, sum the serialized
// payload bytes of the range in SQL and reset with a snapshot past this budget.
const ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES = 8 * 1024 * 1024;

function toAuthAccessStreamEvent(
  change: PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}

const isClientSurface = Schema.is(ClientSurface);
const isClientConnectionMethod = Schema.is(ClientConnectionMethod);
const isClientDeviceType = Schema.is(ClientDeviceType);
const isClientOs = Schema.is(ClientOs);
const isClientWebDeployment = Schema.is(ClientWebDeployment);
const MAX_CLIENT_APP_VERSION_LENGTH = 64;
const MAX_CLIENT_BROWSER_LENGTH = 64;
const MAX_CLIENT_DEVICE_MODEL_LENGTH = 80;

// Optional client identity announced on the /ws upgrade URL next to wsTicket.
// Lenient by design: absent or malformed values degrade to {} so a connection
// never fails over attribution metadata.
function readClientConnectionOrigin(
  request: HttpServerRequest.HttpServerRequest,
): OrchestrationClientOrigin {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return {};
  }
  const surface = url.value.searchParams.get("clientSurface");
  const appVersion = url.value.searchParams.get("clientAppVersion")?.trim() ?? "";
  return {
    ...(isClientSurface(surface) ? { surface } : {}),
    ...(appVersion !== "" && appVersion.length <= MAX_CLIENT_APP_VERSION_LENGTH
      ? { appVersion }
      : {}),
  };
}

// Client telemetry stays in this socket's RPC layer. It must not become a
// server-global "current client" because several client types can connect at once.
function readClientAnalyticsProps(request: HttpServerRequest.HttpServerRequest) {
  const url = HttpServerRequest.toURL(request);
  if (Option.isNone(url)) {
    return {};
  }

  const surface = url.value.searchParams.get("clientSurface");
  const appVersion = url.value.searchParams.get("clientAppVersion")?.trim() ?? "";
  const deviceType = url.value.searchParams.get("clientDeviceType");
  const os = url.value.searchParams.get("clientOs");
  const webDeployment = url.value.searchParams.get("clientWebDeployment");
  const browser = url.value.searchParams.get("clientBrowser")?.trim() ?? "";
  const connectionMethod = url.value.searchParams.get("connectionMethod");
  const rawOsMajorVersion = url.value.searchParams.get("clientOsMajorVersion") ?? "";
  const osMajorVersion = Number(rawOsMajorVersion);
  const deviceModel = url.value.searchParams.get("clientDeviceModel")?.trim() ?? "";
  const isMobile = surface === "mobile";
  const hasOsMajorVersion =
    isMobile && rawOsMajorVersion !== "" && Number.isInteger(osMajorVersion) && osMajorVersion > 0;
  const hasDeviceModel =
    isMobile && deviceModel !== "" && deviceModel.length <= MAX_CLIENT_DEVICE_MODEL_LENGTH;

  return {
    ...(isClientSurface(surface) ? { surface } : {}),
    ...(appVersion !== "" && appVersion.length <= MAX_CLIENT_APP_VERSION_LENGTH
      ? { appVersion, clientAppVersion: appVersion }
      : {}),
    ...(isClientOs(os)
      ? {
          clientOs: os,
          ...(isMobile && (os === "iOS" || os === "Android") ? { os } : {}),
        }
      : {}),
    ...(isClientDeviceType(deviceType) ? { clientDeviceType: deviceType } : {}),
    ...(surface === "web" && isClientWebDeployment(webDeployment) ? { webDeployment } : {}),
    ...(surface === "web" && browser !== "" && browser.length <= MAX_CLIENT_BROWSER_LENGTH
      ? { clientBrowser: browser }
      : {}),
    ...(hasOsMajorVersion ? { osMajorVersion, clientOsMajorVersion: osMajorVersion } : {}),
    ...(hasDeviceModel ? { deviceModel, clientDeviceModel: deviceModel } : {}),
    ...(isClientConnectionMethod(connectionMethod) ? { connectionMethod } : {}),
  };
}

const makeWsRpcLayer = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  clientOrigin: OrchestrationClientOrigin,
  clientAnalyticsProps: Readonly<Record<string, unknown>>,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
) =>
  WsRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const crypto = yield* Crypto.Crypto;
      const sql = yield* SqlClient.SqlClient;
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const usageBreakdownQuery = yield* UsageBreakdownQuery.UsageBreakdownQuery;
      const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
      const reasoningStreamBus = yield* ReasoningStreamBus.ReasoningStreamBus;
      /** A reference's host-level link key; the project's own host where the ref names none. */
      const resolvePullRequestSyncKey = (reference: PullRequestRef) =>
        reference.host !== undefined && reference.repository.includes("/")
          ? Effect.succeed(pullRequestSyncKey(reference))
          : projectionSnapshotQuery.getProjectShellById(reference.projectId).pipe(
              Effect.map((project) =>
                pullRequestSyncKey(reference, Option.getOrUndefined(project)?.repositoryIdentity),
              ),
              Effect.orElseSucceed(() => null),
            );
      const threadDeletionReactor = yield* ThreadDeletionReactor;
      const analytics = yield* AnalyticsService.AnalyticsService;
      // Every command dispatched on this connection carries the connecting
      // client's origin, including server-generated bootstrap sub-commands:
      // the client's request caused them.
      const hasClientOrigin =
        clientOrigin.surface !== undefined || clientOrigin.appVersion !== undefined;
      const dispatchFromClient: OrchestrationEngine.OrchestrationEngineShape["dispatch"] = (
        command,
      ) =>
        orchestrationEngine.dispatch(
          command,
          hasClientOrigin ? { origin: clientOrigin } : undefined,
        );
      const recordClientCommandAnalytics = (command: OrchestrationCommand) => {
        switch (command.type) {
          case "thread.create":
            return analytics.record("client.thread.started", clientAnalyticsProps);
          case "thread.turn.start":
            return command.bootstrap?.createThread
              ? Effect.andThen(
                  analytics.record("client.thread.started", clientAnalyticsProps),
                  analytics.record("client.turn.requested", clientAnalyticsProps),
                )
              : analytics.record("client.turn.requested", clientAnalyticsProps);
          default:
            return Effect.void;
        }
      };
      const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
      const keybindings = yield* Keybindings.Keybindings;
      const environmentTheme = yield* EnvironmentTheme.EnvironmentThemeService;
      const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
      const externalLauncher = yield* ExternalLauncher.ExternalLauncher;
      const remoteOpenTargets = yield* RemoteOpenTargets.RemoteOpenTargets;
      const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
      const review = yield* ReviewService.ReviewService;
      const vcsProvisioning = yield* VcsProvisioningService.VcsProvisioningService;
      const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
      const terminalManager = yield* TerminalManager.TerminalManager;
      const previewManager = yield* PreviewManager.PreviewManager;
      const deviceService = yield* DeviceService.DeviceService;
      const deviceHostContext =
        yield* Effect.context<Effect.Services<ReturnType<typeof remoteSshDeviceHosts>>>();
      const portDiscovery = yield* PortScanner.PortDiscovery;
      const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
      const accountUsageRegistry = yield* AccountUsageRegistry.AccountUsageRegistry;
      const providerHealthRegistry = yield* ProviderHealthRegistry;
      const providerService = yield* ProviderService.ProviderService;
      const providerSessionDirectory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
      const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
      const providerAuth = yield* ProviderAuthService;
      const providerInstances = yield* ProviderInstanceRegistry;
      const providerInstallation = yield* makeProviderInstallation();
      const serverUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
      const config = yield* ServerConfig.ServerConfig;
      const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
      const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;
      const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
      const worktreeProvisioner = yield* WorktreeProvisioner;
      const workspaceLease = yield* WorkspaceLease;
      const canReplayPersistedRange = Effect.fnUntraced(function* (
        afterSequence: number,
        headSequence: number,
        maxGap: number,
      ) {
        const replayGap = headSequence - afterSequence;
        if (replayGap < 0 || replayGap > maxGap) {
          return false;
        }
        const stats = yield* projectionSnapshotQuery
          .getEventReplayStats({
            fromSequenceExclusive: afterSequence,
            toSequenceInclusive: headSequence,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestrationGetSnapshotError({
                  message: "Failed to measure orchestration replay range",
                  cause,
                }),
            ),
          );
        if (stats.payloadBytes > ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES) {
          yield* Effect.logDebug("orchestration replay replaced by snapshot", {
            afterSequence,
            headSequence,
            replayGap,
            eventCount: stats.eventCount,
            payloadBytes: stats.payloadBytes,
            payloadBudgetBytes: ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES,
          });
          return false;
        }
        return true;
      });
      const projectSetupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const worktreeSetupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
      const projectCloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
      const repositoryIdentityResolver =
        yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
      // Clone hooks run on the tracker's fiber, outside any RPC, so the
      // normalizer's services are captured here rather than inherited.
      const normalizerContext = yield* Effect.context<
        | FileSystem.FileSystem
        | Path.Path
        | ServerConfig.ServerConfig
        | WorkspacePaths.WorkspacePaths
      >();
      const agentSessionScanner = yield* AgentSessionScanner.AgentSessionScanner;
      const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
      const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
      const rpcClientIds = yield* Ref.make(new Set<RpcClientId>());
      yield* Effect.addFinalizer(() =>
        Ref.get(rpcClientIds).pipe(
          Effect.flatMap((clientIds) =>
            Effect.forEach(
              clientIds,
              (clientId) => backgroundPolicy.removeRpcClient(currentSessionId, clientId),
              {
                discard: true,
              },
            ),
          ),
          Effect.ignore,
        ),
      );
      const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const sourceControlDiscovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const automaticGitFetchInterval = serverSettings.getSettings.pipe(
        Effect.map(
          (settings) => resolveServerBackgroundActivitySettings(settings).automaticGitFetchInterval,
        ),
        Effect.catch((cause) =>
          Effect.logWarning("Failed to read automatic Git fetch interval setting", {
            detail: cause.message,
          }).pipe(Effect.as(DEFAULT_AUTOMATIC_GIT_FETCH_INTERVAL)),
        ),
      );
      const sourceControlRepositories =
        yield* SourceControlRepositoryService.SourceControlRepositoryService;
      const pullRequests = yield* PullRequestService.PullRequestService;
      const withPullRequestViewer = pullRequests.withRoutingCredential;
      const pullRequestSync = yield* PullRequestSyncReactor.PullRequestSyncReactor;
      const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;
      const sessions = yield* SessionStore.SessionStore;
      const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;
      const workstreamWorktreeStatus = yield* WorkstreamWorktreeStatus.WorkstreamWorktreeStatus;
      const hostResources = yield* HostResources.HostResources;
      const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;
      const resourceTelemetry = yield* ResourceTelemetry.ResourceTelemetry;
      const usage = yield* UsageService.UsageService;
      const relayClient = yield* RelayClient.RelayClient;
      const authorizationError = (requiredScope: AuthEnvironmentScope) =>
        new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${requiredScope}.`,
          requiredScope,
        });
      const authorizeEffect = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? effect
          : Effect.fail(authorizationError(requiredScope));
      const authorizeStream = <A, E, R>(
        requiredScope: AuthEnvironmentScope,
        stream: Stream.Stream<A, E, R>,
      ): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
        currentSession.scopes.includes(requiredScope)
          ? stream
          : Stream.fail(authorizationError(requiredScope));
      const observeRpcEffect = <A, E, R>(
        method: string,
        effect: Effect.Effect<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcEffect(
          method,
          authorizeEffect(requiredScopeForRpcMethod(method), effect),
          traceAttributes,
        );
      const observeRpcStream = <A, E, R>(
        method: string,
        stream: Stream.Stream<A, E, R>,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStream(
          method,
          authorizeStream(requiredScopeForRpcMethod(method), stream),
          traceAttributes,
        );
      const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
        method: string,
        effect: Effect.Effect<
          Stream.Stream<A, StreamError, StreamContext>,
          EffectError,
          EffectContext
        >,
        traceAttributes?: Readonly<Record<string, unknown>>,
      ) =>
        instrumentRpcStreamEffect(
          method,
          authorizeEffect(requiredScopeForRpcMethod(method), effect),
          traceAttributes,
        );
      const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
        isOrchestrationDispatchCommandError(cause)
          ? cause
          : new OrchestrationDispatchCommandError({
              message: cause instanceof Error ? cause.message : fallbackMessage,
              cause,
            });
      const randomUUID = crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) =>
          toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
        ),
      );
      const serverEventId = randomUUID.pipe(Effect.map(EventId.make));
      const serverCommandId = (tag: string) =>
        randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

      const loadAuthAccessSnapshot = () =>
        Effect.all({
          pairingLinks: serverAuth.listPairingLinks(),
          clientSessions: serverAuth.listClientSessions(currentSessionId),
        }).pipe(
          Effect.mapError(
            (error) =>
              new AuthAccessStreamError({
                message: error.message,
              }),
          ),
        );

      const appendSetupScriptActivity = (input: {
        readonly threadId: ThreadId;
        readonly kind: "setup-script.requested" | "setup-script.started" | "setup-script.failed";
        readonly summary: string;
        readonly createdAt: string;
        readonly payload: Record<string, unknown>;
        readonly tone: "info" | "error";
      }) =>
        Effect.all({
          commandId: serverCommandId("setup-script-activity"),
          activityId: serverEventId,
        }).pipe(
          Effect.flatMap(({ commandId, activityId }) =>
            dispatchFromClient({
              type: "thread.activity.append",
              commandId,
              threadId: input.threadId,
              activity: {
                id: activityId,
                tone: input.tone,
                kind: input.kind,
                summary: input.summary,
                payload: input.payload,
                turnId: null,
                createdAt: input.createdAt,
              },
              createdAt: input.createdAt,
            }),
          ),
        );

      // The worktree setup's durable record: one activity per thread, upserted
      // by a fixed id when the setup starts and again when it settles. Live
      // progress keeps streaming from the tracker; this is what a reload or
      // another client reads. Best effort: the thread may already be gone
      // after a failed bootstrap.
      const recordWorktreeSetup = (snapshot: WorktreeSetupSnapshot) =>
        serverCommandId("worktree-setup-activity").pipe(
          Effect.flatMap((commandId) =>
            dispatchFromClient({
              type: "thread.activity.append",
              commandId,
              threadId: snapshot.threadId,
              activity: {
                id: EventId.make(worktreeSetupActivityId(snapshot.threadId)),
                tone:
                  snapshot.phase === "failed" ||
                  snapshot.stages.some((stage) => stage.status === "failed")
                    ? "error"
                    : "info",
                kind: WORKTREE_SETUP_ACTIVITY_KIND,
                summary:
                  snapshot.phase === "running"
                    ? "Setting up worktree"
                    : snapshot.phase === "done"
                      ? "Worktree ready"
                      : snapshot.phase === "cancelled"
                        ? "Worktree setup cancelled"
                        : "Worktree setup failed",
                payload: snapshot,
                turnId: null,
                createdAt: snapshot.startedAt,
              },
              createdAt: snapshot.endedAt ?? snapshot.startedAt,
            }),
          ),
          Effect.ignoreCause({ log: true }),
        );

      const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
        const error = Cause.squash(cause);
        return isOrchestrationDispatchCommandError(error)
          ? error
          : new OrchestrationDispatchCommandError({
              message:
                error instanceof Error ? error.message : "Failed to bootstrap thread turn start.",
              cause,
            });
      };

      const enrichProjectEvent = (
        event: OrchestrationEvent,
      ): Effect.Effect<OrchestrationEvent, never, never> => {
        switch (event.type) {
          case "project.created":
            return repositoryIdentityResolver.resolve(event.payload.workspaceRoot).pipe(
              Effect.map((repositoryIdentity) => ({
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              })),
            );
          case "project.meta-updated":
            return Effect.gen(function* () {
              const workspaceRoot =
                event.payload.workspaceRoot ??
                Option.match(
                  yield* projectionSnapshotQuery.getProjectShellById(event.payload.projectId),
                  {
                    onNone: () => null,
                    onSome: (project) => project.workspaceRoot,
                  },
                ) ??
                null;
              if (workspaceRoot === null) {
                return event;
              }

              const repositoryIdentity = yield* repositoryIdentityResolver.resolve(workspaceRoot);
              return {
                ...event,
                payload: {
                  ...event.payload,
                  repositoryIdentity,
                },
              } satisfies OrchestrationEvent;
            }).pipe(Effect.orElseSucceed(() => event));
          default:
            return Effect.succeed(event);
        }
      };

      const enrichOrchestrationEvents = (events: ReadonlyArray<OrchestrationEvent>) =>
        Effect.forEach(events, enrichProjectEvent, { concurrency: 4 });

      // loom: silent-drop fix. Diverges deliberately from upstream #2968
      // ("Refactor recoverable Effect fallbacks to orElseSucceed") and from
      // upstream's later `retryShellProjectionRead`, both of which turn a failed
      // projection lookup into a dropped stream item — a *failed* lookup then
      // becomes indistinguishable from a genuinely-absent row, and the client's
      // cache stays wedged past the gap with no way to notice. A future upstream
      // sync must NOT re-collapse the two: the error channel
      // (ProjectionRepositoryError) means "lookup failed, state unknown" and must
      // stay loud so the client self-heals via a fresh snapshot; a *successful*
      // Option.none means "row genuinely absent" and is what the upsert-or-remove
      // helpers below turn into a removal. The bounded retry absorbs a transient
      // SQLite contention blip (~75ms across 3 attempts) without tearing down
      // every connected subscription.
      const shellLookupRetry = Schedule.max([
        Schedule.exponential("25 millis"),
        Schedule.recurs(2),
      ]);

      // Shell updates refetch the aggregate. Message and tool bodies are not needed.
      const toShellEvent = ({
        type,
        aggregateKind,
        aggregateId,
        sequence,
      }: OrchestrationEvent) => ({
        type,
        aggregateKind,
        aggregateId,
        sequence,
      });
      type ShellEvent = ReturnType<typeof toShellEvent>;

      type ShellLiveInput =
        | { readonly kind: "event"; readonly event: ShellEvent }
        | { readonly kind: "synchronized" };

      // The refetch runs with bounded concurrency (order-preserving).
      const SHELL_REFETCH_CONCURRENCY = 8;
      // Small time/size window over which to coalesce shell events. The window
      // bounds the worst-case added latency for a brand-new thread to appear in
      // the sidebar (imperceptible), while collapsing high-frequency streaming
      // traffic so it can't serialize the shell stream behind per-event DB reads.
      const SHELL_COALESCE_WINDOW = Duration.millis(50);
      const SHELL_COALESCE_MAX_CHUNK = 512;

      // The shell-event mapper and its coalescers are built PER SUBSCRIPTION
      // because the derived brief-needed tracker memoises what that client was
      // last told (liveness plan §3.3); sharing one tracker would let whichever
      // subscriber refreshed first absorb a transition and leave the others stale.
      const makeShellStreamEventMapper = (briefNeededAttention: BriefNeededOutwardAttention) => {
        const projectUpsertOrRemove = (projectId: ProjectId, sequence: number) =>
          projectionSnapshotQuery.getProjectShellById(projectId).pipe(
            Effect.retry(shellLookupRetry), // loom: fail loud, don't swallow
            Effect.map((project) =>
              Option.some<OrchestrationShellStreamEvent>(
                Option.match(project, {
                  onNone: () => ({ kind: "project-removed" as const, sequence, projectId }),
                  onSome: (nextProject) => ({
                    kind: "project-upserted" as const,
                    sequence,
                    project: nextProject,
                  }),
                }),
              ),
            ),
          );

        // Refetch a thread's shell and emit an upsert if it is still active, or a
        // `thread-removed` if the projection has no active row for it. Emitting a
        // removal on a successful `none` (rather than dropping the event) is what
        // keeps coalescing correct: when a burst collapses a
        // `thread.deleted`/`archived` into a later refetchable event for the same
        // thread, the refetch returns `none` for the now-inactive row and this
        // still tells the sidebar to drop it. A `thread-removed` the client does
        // not have is a harmless no-op. The projection commits in the same
        // transaction before the event publishes, so a `none` reliably means the
        // thread is deleted or archived, not not-yet-persisted — which is exactly
        // why a lookup *failure* must stay in the error channel above.
        //
        // The upsert carries the looked-up thread PLUS any other shell whose
        // graph-derived attention this event changed. Both must ride the SAME
        // event: the client's reducer drops a second event sharing a sequence it
        // has already applied.
        const threadUpsertOrRemove = (threadId: ThreadId, sequence: number) =>
          projectionSnapshotQuery.getThreadShellById(threadId).pipe(
            Effect.retry(shellLookupRetry), // loom: fail loud, don't swallow
            Effect.flatMap(
              Option.match({
                onNone: () =>
                  Effect.succeed(
                    Option.some<OrchestrationShellStreamEvent>({
                      kind: "thread-removed" as const,
                      sequence,
                      threadId,
                    }),
                  ),
                onSome: (thread: OrchestrationThreadShell) =>
                  briefNeededAttention
                    .decorateUpsert(thread)
                    .pipe(
                      Effect.map((threads) =>
                        Option.some<OrchestrationShellStreamEvent>({
                          kind: "thread-upserted" as const,
                          sequence,
                          threads,
                        }),
                      ),
                    ),
              }),
            ),
          );

        // loom: goal aggregate → goal-upserted/goal-removed shell-stream events.
        const goalUpsertOrRemove = (goalId: GoalId, sequence: number) =>
          projectionSnapshotQuery.getGoalShellById(goalId).pipe(
            Effect.retry(shellLookupRetry), // loom: fail loud, don't swallow
            Effect.map((goal) =>
              Option.some<OrchestrationShellStreamEvent>(
                Option.match(goal, {
                  onNone: () => ({ kind: "goal-removed" as const, sequence, goalId }),
                  onSome: (nextGoal) => ({
                    kind: "goal-upserted" as const,
                    sequence,
                    goal: nextGoal,
                  }),
                }),
              ),
            ),
          );

        const toShellStreamEvent = (
          event: ShellEvent,
        ): Effect.Effect<
          Option.Option<OrchestrationShellStreamEvent>,
          ProjectionRepositoryError,
          never
        > => {
          switch (event.type) {
            case "project.created":
            case "project.meta-updated":
              return projectUpsertOrRemove(ProjectId.make(event.aggregateId), event.sequence);
            case "project.deleted":
              return Effect.succeed(
                Option.some({
                  kind: "project-removed" as const,
                  sequence: event.sequence,
                  projectId: ProjectId.make(event.aggregateId),
                }),
              );
            case "thread.deleted":
            case "thread.archived":
              return Effect.succeed(
                Option.some({
                  kind: "thread-removed" as const,
                  sequence: event.sequence,
                  threadId: ThreadId.make(event.aggregateId),
                }),
              );
            case "thread.unarchived":
              return threadUpsertOrRemove(ThreadId.make(event.aggregateId), event.sequence);
            default:
              if (event.aggregateKind === "goal") {
                return goalUpsertOrRemove(GoalId.make(event.aggregateId), event.sequence);
              }
              if (event.aggregateKind !== "thread") {
                return Effect.succeed(Option.none());
              }
              return threadUpsertOrRemove(ThreadId.make(event.aggregateId), event.sequence);
          }
        };

        // Turn a batch of domain events into shell stream items, coalescing by
        // aggregate first. `toShellStreamEvent` re-reads the *current* projected
        // shell for an aggregate, so within a batch only the latest event per
        // aggregate matters: a burst of streaming `thread.message-sent` deltas for
        // one thread collapses into a single shell refetch, and an unrelated
        // `thread.created` in the same batch is never stuck behind those DB reads.
        //
        // Input events arrive in ascending sequence; we keep the last (highest
        // sequence) event per aggregate, then re-sort ascending before emitting so
        // the client — which applies shell items strictly by increasing sequence
        // and drops any `sequence <= snapshotSequence` — never skips a coalesced
        // item.
        const coalesceShellEvents = (
          events: ReadonlyArray<ShellEvent>,
        ): Effect.Effect<
          ReadonlyArray<OrchestrationShellStreamEvent>,
          ProjectionRepositoryError,
          never
        > =>
          Effect.gen(function* () {
            if (events.length === 0) {
              return [];
            }
            // loom: a departing child can clear its parent's DERIVED brief-needed
            // flag, but a removal carries no shell to decorate — mark the memo
            // stale so the next upsert republishes whoever changed. Checked over
            // the WHOLE batch, not just the survivors: coalescing can drop a
            // removal behind a later event for the same aggregate.
            if (
              events.some(
                (event) => event.type === "thread.deleted" || event.type === "thread.archived",
              )
            ) {
              yield* briefNeededAttention.invalidate;
            }
            const latestByAggregate = new Map<string, ShellEvent>();
            for (const event of events) {
              latestByAggregate.set(`${event.aggregateKind}:${event.aggregateId}`, event);
            }
            const survivors = Array.from(latestByAggregate.values()).sort(
              (left, right) => left.sequence - right.sequence,
            );
            const shellEvents = yield* Effect.forEach(survivors, toShellStreamEvent, {
              concurrency: SHELL_REFETCH_CONCURRENCY,
            });
            return shellEvents.flatMap((option) => (Option.isSome(option) ? [option.value] : []));
          });

        const coalesceShellStream = <E, R>(stream: Stream.Stream<OrchestrationEvent, E, R>) =>
          stream.pipe(
            Stream.map(toShellEvent),
            Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
            Stream.mapEffect(coalesceShellEvents),
            Stream.flatMap((items) => Stream.fromIterable(items)),
          );

        // A completion marker is queued alongside live event metadata so it cannot
        // overtake an event still waiting in the coalescing window. Split each
        // batch at markers and coalesce only the event segments on either side.
        const coalesceShellLiveInputs = (
          inputs: ReadonlyArray<ShellLiveInput>,
        ): Effect.Effect<
          ReadonlyArray<OrchestrationShellStreamItem>,
          ProjectionRepositoryError,
          never
        > =>
          Effect.gen(function* () {
            const output: Array<OrchestrationShellStreamItem> = [];
            let pendingEvents: Array<ShellEvent> = [];

            for (const input of inputs) {
              if (input.kind === "event") {
                pendingEvents.push(input.event);
                continue;
              }

              output.push(...(yield* coalesceShellEvents(pendingEvents)));
              pendingEvents = [];
              output.push({ kind: "synchronized" });
            }

            output.push(...(yield* coalesceShellEvents(pendingEvents)));
            return output;
          });

        return { coalesceShellStream, coalesceShellLiveInputs };
      };

      const dispatchBootstrapTurnStart = (
        command: Extract<OrchestrationCommand, { type: "thread.turn.start" }>,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> =>
        Effect.gen(function* () {
          const bootstrap = command.bootstrap;
          const { bootstrap: _bootstrap, ...finalTurnStartCommand } = command;
          let createdThread = false;
          let targetProjectId = bootstrap?.createThread?.projectId;
          let targetProjectCwd = bootstrap?.prepareWorktree?.projectCwd;
          let targetWorktreePath = bootstrap?.createThread?.worktreePath ?? null;
          // The setup script's terminal, once started. Cancel closes only this
          // one so terminals the user opened meanwhile survive.
          let setupTerminalId: string | null = null;

          // Set once the checkout starts; see the session.set below.
          let preparingSessionSet = false;
          const markPreparingSessionFailed = (detail: string) =>
            Effect.gen(function* () {
              const failedAt = yield* nowIso;
              yield* dispatchFromClient({
                type: "thread.session.set",
                commandId: yield* serverCommandId("bootstrap-thread-preparing-failed"),
                threadId,
                session: {
                  threadId,
                  status: "error",
                  providerName: null,
                  providerInstanceId:
                    bootstrap?.createThread?.modelSelection.instanceId ??
                    command.modelSelection?.instanceId,
                  runtimeMode: command.runtimeMode,
                  activeTurnId: null,
                  lastError: detail.trim().length > 0 ? detail : "Worktree setup failed.",
                  queuedMessages: { steering: [], followUp: [] },
                  updatedAt: failedAt,
                },
                createdAt: failedAt,
              });
            });
          const cleanupCreatedThread = () =>
            createdThread
              ? serverCommandId("bootstrap-thread-delete").pipe(
                  Effect.flatMap((commandId) =>
                    dispatchFromClient({
                      type: "thread.delete",
                      commandId,
                      threadId: command.threadId,
                    }),
                  ),
                  Effect.as(true),
                )
              : Effect.succeed(false);

          const recordSetupScriptLaunchFailure = (input: {
            readonly error: ProjectSetupScriptRunner.ProjectSetupScriptRunnerError;
            readonly requestedAt: string;
            readonly worktreePath: string;
          }) => {
            const detail = projectSetupScriptCompatibilityDetail(input.error);
            return appendSetupScriptActivity({
              threadId: command.threadId,
              kind: "setup-script.failed",
              summary: "Setup script failed to start",
              createdAt: input.requestedAt,
              payload: {
                detail,
                worktreePath: input.worktreePath,
              },
              tone: "error",
            }).pipe(
              Effect.ignoreCause({ log: false }),
              Effect.flatMap(() =>
                Effect.logWarning("bootstrap turn start failed to launch setup script", {
                  threadId: command.threadId,
                  worktreePath: input.worktreePath,
                  detail,
                }),
              ),
            );
          };

          const recordSetupScriptStarted = (input: {
            readonly requestedAt: string;
            readonly worktreePath: string;
            readonly scriptId: string;
            readonly scriptName: string;
            readonly terminalId: string;
          }) =>
            Effect.gen(function* () {
              const startedAt = yield* nowIso;
              const payload = {
                scriptId: input.scriptId,
                scriptName: input.scriptName,
                terminalId: input.terminalId,
                worktreePath: input.worktreePath,
              };
              yield* Effect.all([
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.requested",
                  summary: "Starting setup script",
                  createdAt: input.requestedAt,
                  payload,
                  tone: "info",
                }),
                appendSetupScriptActivity({
                  threadId: command.threadId,
                  kind: "setup-script.started",
                  summary: "Setup script started",
                  createdAt: startedAt,
                  payload,
                  tone: "info",
                }),
              ]).pipe(
                Effect.asVoid,
                Effect.catch((error) =>
                  Effect.logWarning(
                    "bootstrap turn start launched setup script but failed to record setup activity",
                    {
                      threadId: command.threadId,
                      worktreePath: input.worktreePath,
                      scriptId: input.scriptId,
                      terminalId: input.terminalId,
                      detail: error.message,
                    },
                  ),
                ),
              );
            });

          const tracked = bootstrap?.prepareWorktree !== undefined;
          const threadId = command.threadId;
          const track = (effect: Effect.Effect<void>) => (tracked ? effect : Effect.void);

          // Starts the setup script. For tracked bootstraps it returns the
          // effect that waits for the script to exit and records the outcome
          // on the card; whether the agent stage waits on it depends on the
          // script's `async` flag. Returns null when nothing is left to await.
          // Untracked callers keep the old fire-and-forget behavior.
          const runSetupProgram = () =>
            Effect.gen(function* () {
              if (!bootstrap?.runSetupScript || !targetWorktreePath) {
                yield* track(worktreeSetupTracker.stageStatus(threadId, "setup-script", "skipped"));
                return null;
              }
              const worktreePath = targetWorktreePath;
              const requestedAt = yield* nowIso;
              yield* track(worktreeSetupTracker.stageStatus(threadId, "setup-script", "running"));
              const setupResult = yield* projectSetupScriptRunner
                .runForThread({
                  threadId,
                  ...(targetProjectId ? { projectId: targetProjectId } : {}),
                  ...(targetProjectCwd ? { projectCwd: targetProjectCwd } : {}),
                  worktreePath,
                  ...(tracked
                    ? {
                        observeCompletion: {
                          onOutputLine: (line) =>
                            worktreeSetupTracker.appendTail(threadId, "setup-script", line),
                        },
                      }
                    : {}),
                })
                .pipe(
                  Effect.matchEffect({
                    onFailure: (error) =>
                      recordSetupScriptLaunchFailure({
                        error,
                        requestedAt,
                        worktreePath,
                      }).pipe(
                        Effect.andThen(
                          track(
                            worktreeSetupTracker.stageStatus(
                              threadId,
                              "setup-script",
                              "failed",
                              "failed to start",
                            ),
                          ),
                        ),
                        Effect.as(null),
                      ),
                    onSuccess: (setupResult) => {
                      if (setupResult.status !== "started") {
                        return track(
                          worktreeSetupTracker.stageStatus(
                            threadId,
                            "setup-script",
                            "skipped",
                            "no setup script",
                          ),
                        ).pipe(Effect.as(null));
                      }
                      setupTerminalId = setupResult.terminalId;
                      return recordSetupScriptStarted({
                        requestedAt,
                        worktreePath,
                        scriptId: setupResult.scriptId,
                        scriptName: setupResult.scriptName,
                        terminalId: setupResult.terminalId,
                      }).pipe(
                        Effect.andThen(
                          track(
                            worktreeSetupTracker.update(threadId, (snapshot) => ({
                              ...snapshot,
                              setupScript: {
                                name: setupResult.scriptName,
                                command: setupResult.scriptCommand,
                                terminalId: setupResult.terminalId,
                              },
                            })),
                          ),
                        ),
                        Effect.as(setupResult),
                      );
                    },
                  }),
                );
              if (!tracked || !setupResult?.completion) {
                return null;
              }
              // The setup script is best effort, like the untracked path: a
              // failed install must not throw away the worktree the user just
              // waited for. The card keeps the failed stage and its terminal.
              // Forked right away so the terminal listener behind `completion`
              // is always consumed, even when the turn dispatch fails before
              // anyone would otherwise wait on it. The tracker update is a
              // no-op once the snapshot has been dropped.
              const completionFiber = yield* setupResult.completion.pipe(
                Effect.flatMap((completion) => {
                  if (completion.exitCode === 0) {
                    return worktreeSetupTracker.stageStatus(threadId, "setup-script", "done");
                  }
                  const detail =
                    completion.exitCode === null
                      ? "terminal closed before the script finished"
                      : `exit ${completion.exitCode}`;
                  return worktreeSetupTracker.stageStatus(
                    threadId,
                    "setup-script",
                    "failed",
                    detail,
                  );
                }),
                Effect.forkDetach,
              );
              if (!setupResult.async) {
                yield* Fiber.join(completionFiber);
                return null;
              }
              return completionFiber;
            });

          const bootstrapProgram = Effect.gen(function* () {
            const prepareWorktree = bootstrap?.prepareWorktree;
            let shouldPrepareWorktree = prepareWorktree
              ? yield* gitWorkflow.isRepository(prepareWorktree.projectCwd)
              : false;
            let worktreeBaseRef = prepareWorktree?.baseBranch ?? null;

            if (prepareWorktree && shouldPrepareWorktree) {
              // "Start from origin" is a stored default; repos without the
              // requested remote branch fall back to the local base branch.
              const startFromOrigin =
                prepareWorktree.startFromOrigin === true &&
                (yield* gitWorkflow.remoteExists({
                  cwd: prepareWorktree.projectCwd,
                  remoteName: "origin",
                }));
              if (startFromOrigin) {
                yield* track(worktreeSetupTracker.stageStatus(threadId, "fetch", "running"));
                yield* gitWorkflow.fetchRemote({
                  cwd: prepareWorktree.projectCwd,
                  remoteName: "origin",
                  refName: prepareWorktree.baseBranch,
                });
                const remoteBaseExists = yield* gitWorkflow.remoteBranchExists({
                  cwd: prepareWorktree.projectCwd,
                  refName: prepareWorktree.baseBranch,
                  remoteName: "origin",
                });
                if (remoteBaseExists) {
                  const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
                    cwd: prepareWorktree.projectCwd,
                    refName: prepareWorktree.baseBranch,
                    fallbackRemoteName: "origin",
                  });
                  worktreeBaseRef = resolvedRemoteBase.commitSha;
                  yield* track(
                    worktreeSetupTracker.stageStatus(
                      threadId,
                      "fetch",
                      "done",
                      `origin/${prepareWorktree.baseBranch} at ${resolvedRemoteBase.commitSha.slice(0, 7)}`,
                    ),
                  );
                } else {
                  yield* track(
                    worktreeSetupTracker.stageStatus(
                      threadId,
                      "fetch",
                      "warning",
                      `origin/${prepareWorktree.baseBranch} not found, using local branch`,
                    ),
                  );
                }
              } else {
                yield* track(worktreeSetupTracker.stageStatus(threadId, "fetch", "skipped"));
              }

              const resolvedWorktreeBaseRef = worktreeBaseRef ?? prepareWorktree.baseBranch;
              shouldPrepareWorktree = yield* gitWorkflow.hasCommit({
                cwd: prepareWorktree.projectCwd,
                refName: resolvedWorktreeBaseRef,
              });
              worktreeBaseRef = resolvedWorktreeBaseRef;
              yield* track(
                worktreeSetupTracker.update(threadId, (snapshot) => ({
                  ...snapshot,
                  baseRef: resolvedWorktreeBaseRef,
                })),
              );
            }

            if (prepareWorktree && !shouldPrepareWorktree) {
              if (prepareWorktree.requireWorktree) {
                return yield* new OrchestrationDispatchCommandError({
                  message:
                    "A separate worktree requires a Git repository and a base branch with a commit.",
                });
              }
              // Not a git repo, or the base has no commit: the thread runs in
              // the project checkout instead. The card says so and moves on.
              yield* track(
                worktreeSetupTracker.update(threadId, (snapshot) => ({
                  ...snapshot,
                  stages: snapshot.stages.map((stage) =>
                    stage.id === "fetch" || stage.id === "checkout" || stage.id === "submodules"
                      ? { ...stage, status: "skipped", detail: "using project checkout" }
                      : stage,
                  ),
                })),
              );
            }

            if (bootstrap?.createThread) {
              const created = yield* dispatchFromClient({
                type: "thread.create",
                commandId: yield* serverCommandId("bootstrap-thread-create"),
                threadId: command.threadId,
                projectId: bootstrap.createThread.projectId,
                // loom: fork workstream fields carried through bootstrap thread.create
                goalId: bootstrap.createThread.goalId ?? null,
                parentThreadId: bootstrap.createThread.parentThreadId ?? null,
                role: bootstrap.createThread.role ?? null,
                purpose: bootstrap.createThread.purpose ?? null,
                brief: bootstrap.createThread.brief ?? null,
                // Thread fork (MVP): the UI's fork affordance seeds this so the
                // first send forks the source's pi session at the child's first
                // launch.
                forkFromThreadId: bootstrap.createThread.forkFromThreadId ?? null,
                title: bootstrap.createThread.title,
                // loom: §4 trust boundary. The bootstrap create title is the
                // client's truncated FIRST MESSAGE (a seed), never a human-typed
                // curated title — so stamp it `seed` here rather than letting the
                // decider conservatively infer `curated` from a non-placeholder
                // title. This keeps the real local-draft first-send path
                // automation-malleable so the reactor can upgrade it to the LLM
                // `derived` title. A blank-context "New thread" stays `default`.
                //
                // loom: `/handoff` fork-drafter (plan D4) — a server-injected
                // bootstrap may supply an explicit CURATED provenance (the
                // drafter title is curated, not a first-message seed) so the
                // auto-title reactor never renames a drafter. Honour it when
                // present; otherwise keep the seed/default inference.
                titleProvenance:
                  bootstrap.createThread.titleProvenance ??
                  (bootstrap.createThread.title.trim() === DEFAULT_THREAD_TITLE
                    ? "default"
                    : "seed"),
                modelSelection: bootstrap.createThread.modelSelection,
                runtimeMode: bootstrap.createThread.runtimeMode,
                interactionMode: bootstrap.createThread.interactionMode,
                branch: bootstrap.createThread.branch,
                worktreePath: bootstrap.createThread.worktreePath,
                createdAt: bootstrap.createThread.createdAt,
              });
              // The successful create is a fence in the engine command queue:
              // every delete for the prior incarnation committed before it.
              // Drain through that event before setup or turn start can own
              // terminals and provider sessions under the reused thread id.
              createdThread = true;
              yield* threadDeletionReactor.drainThrough(created.sequence);
              // Persist the send now rather than with the turn: the thread is
              // real from here on, so any client (or a reload) sees the message
              // while the worktree is still being prepared. The turn start
              // later references this id instead of re-sending the text.
              yield* dispatchFromClient({
                type: "thread.message.user.append",
                commandId: yield* serverCommandId("bootstrap-thread-message"),
                threadId: command.threadId,
                message: {
                  messageId: command.message.messageId,
                  text: command.message.text,
                  attachments: command.message.attachments,
                  ...(command.message.context !== undefined
                    ? { context: command.message.context }
                    : {}),
                },
                createdAt: command.createdAt,
              });
              if (tracked) {
                const running = yield* worktreeSetupTracker.get(threadId);
                if (running) yield* recordWorktreeSetup(running);
              }
            }

            if (prepareWorktree && shouldPrepareWorktree && worktreeBaseRef) {
              if (bootstrap?.createThread && createdThread) {
                // The checkout and setup script can run for minutes before the
                // turn starts, and the created thread carries no message or
                // turn until then. Project a starting session now so every
                // client lists the thread as working and a reopened thread
                // knows to follow the setup stream. A failed or cancelled setup
                // deletes the thread, so nothing lingers.
                const preparingAt = yield* nowIso;
                yield* dispatchFromClient({
                  type: "thread.session.set",
                  commandId: yield* serverCommandId("bootstrap-thread-preparing"),
                  threadId,
                  session: {
                    threadId,
                    status: "starting",
                    providerName: null,
                    providerInstanceId: bootstrap.createThread.modelSelection.instanceId,
                    runtimeMode: command.runtimeMode,
                    activeTurnId: null,
                    lastError: null,
                    queuedMessages: { steering: [], followUp: [] },
                    updatedAt: preparingAt,
                  },
                  createdAt: preparingAt,
                });
                preparingSessionSet = true;
              }
              yield* worktreeSetupTracker.stageStatus(threadId, "checkout", "running");
              let checkoutTotal: number | null = null;
              const worktree = yield* gitWorkflow.createWorktree(
                {
                  cwd: prepareWorktree.projectCwd,
                  refName: worktreeBaseRef,
                  newRefName: prepareWorktree.branch,
                  baseRefName: prepareWorktree.baseBranch,
                  path: null,
                },
                {
                  progress: {
                    // Git has registered the directory at this point, so a
                    // cancel during the submodule step can still remove it.
                    onWorktreeClaimed: (path) =>
                      Effect.sync(() => {
                        targetWorktreePath = path;
                      }),
                    onCheckoutProgress: ({ percent, completed, total }) => {
                      checkoutTotal = total;
                      return worktreeSetupTracker.stage(threadId, "checkout", {
                        percent,
                        detail: `${completed.toLocaleString("en-US")} / ${total.toLocaleString("en-US")} files`,
                      });
                    },
                    onSubmodulesStarted: () =>
                      worktreeSetupTracker
                        .stageStatus(
                          threadId,
                          "checkout",
                          "done",
                          checkoutTotal === null
                            ? null
                            : `${checkoutTotal.toLocaleString("en-US")} files`,
                        )
                        .pipe(
                          Effect.andThen(
                            worktreeSetupTracker.stageStatus(threadId, "submodules", "running"),
                          ),
                        ),
                    onSubmoduleLine: (line) => {
                      const submodulePath = /Submodule path '([^']+)'/.exec(line)?.[1];
                      return submodulePath === undefined
                        ? Effect.void
                        : worktreeSetupTracker.stage(threadId, "submodules", {
                            detail: submodulePath,
                          });
                    },
                    onSubmodulesFinished: ({ ok, detail }) =>
                      worktreeSetupTracker.stageStatus(
                        threadId,
                        "submodules",
                        ok ? "done" : "warning",
                        ok ? undefined : (detail ?? "submodule checkout failed"),
                      ),
                  },
                },
              );
              const checkoutEndedAt = yield* nowIso;
              yield* worktreeSetupTracker.update(threadId, (snapshot) => ({
                ...snapshot,
                worktreePath: worktree.worktree.path,
                stages: snapshot.stages.map((stage) => {
                  if (stage.id === "checkout" && stage.status === "running") {
                    return {
                      ...stage,
                      status: "done",
                      percent: 100,
                      endedAt: checkoutEndedAt,
                      detail:
                        checkoutTotal === null
                          ? stage.detail
                          : `${checkoutTotal.toLocaleString("en-US")} files`,
                    };
                  }
                  if (stage.id === "submodules" && stage.status === "pending") {
                    return { ...stage, status: "skipped", detail: "none" };
                  }
                  return stage;
                }),
              }));
              targetWorktreePath = worktree.worktree.path;
              yield* dispatchFromClient({
                type: "thread.meta.update",
                commandId: yield* serverCommandId("bootstrap-thread-meta-update"),
                threadId,
                branch: worktree.worktree.refName,
                worktreePath: targetWorktreePath,
              });
            }

            const pendingSetupScript = yield* runSetupProgram();

            yield* track(worktreeSetupTracker.stageStatus(threadId, "agent", "running"));
            // Past this point a cancel would roll back a thread whose turn has
            // started. Drop the cancel handle and make the handoff atomic.
            yield* track(worktreeSetupTracker.markUncancellable(threadId));
            const started = yield* Effect.uninterruptible(
              dispatchFromClient(finalTurnStartCommand),
            );
            yield* track(worktreeSetupTracker.stageStatus(threadId, "agent", "done"));
            // An async setup script outlives the handoff: the snapshot stays
            // running so the client keeps its row next to the agent's work,
            // and settles when the script exits. The turn already started, so
            // the wait cannot fail the dispatch.
            const settle = tracked
              ? worktreeSetupTracker
                  .finish(threadId, "done")
                  .pipe(
                    Effect.flatMap((snapshot) =>
                      snapshot ? recordWorktreeSetup(snapshot) : Effect.void,
                    ),
                  )
              : Effect.void;
            if (pendingSetupScript) {
              yield* Fiber.join(pendingSetupScript).pipe(
                Effect.ignoreCause({ log: true }),
                Effect.andThen(settle),
                Effect.forkDetach,
              );
            } else {
              yield* settle;
            }
            return started;
          });

          const cleanupAndFail = (
            cause: Cause.Cause<unknown>,
            dispatchError: OrchestrationDispatchCommandError,
          ) =>
            Effect.uninterruptible(cleanupCreatedThread()).pipe(
              Effect.matchCauseEffect({
                onFailure: (cleanupCause) =>
                  Effect.logWarning("bootstrap thread cleanup failed", {
                    threadId,
                    detail: Cause.pretty(cleanupCause),
                  }).pipe(
                    // The thread outlived its setup. Its preparing session
                    // must not read as working forever, so record the failure
                    // on it instead.
                    Effect.andThen(
                      preparingSessionSet
                        ? markPreparingSessionFailed(dispatchError.message).pipe(
                            Effect.ignoreCause({ log: true }),
                          )
                        : Effect.void,
                    ),
                    Effect.flatMap(() => Effect.fail(dispatchError)),
                  ),
                onSuccess: (threadDeleted) =>
                  Effect.fail(
                    threadDeleted ||
                      (bootstrap?.createThread &&
                        bootstrap.prepareWorktree?.requireWorktree === true &&
                        !createdThread)
                      ? new OrchestrationDispatchCommandError({
                          message: dispatchError.message,
                          ...(dispatchError.cause !== undefined
                            ? { cause: dispatchError.cause }
                            : {}),
                          bootstrapThreadDisposition: threadDeleted ? "deleted" : "not-created",
                        })
                      : dispatchError,
                  ),
              }),
            );

          const settledBootstrapProgram = bootstrapProgram.pipe(
            Effect.interruptible,
            Effect.catchCause((cause) => {
              const dispatchError = toBootstrapDispatchCommandCauseError(cause);
              if (Cause.hasInterruptsOnly(cause)) {
                // A user cancel interrupts the forked bootstrap fiber. The
                // created thread is rolled back like any other failure so the
                // draft returns to the composer. The setup terminal is closed
                // first so a still-running script cannot hold files open in
                // the worktree while git removes it. Closing kills the
                // process asynchronously, so the removal retries briefly.
                const closeSetupTerminal = setupTerminalId
                  ? terminalManager.close({
                      threadId,
                      terminalId: setupTerminalId,
                      deleteHistory: true,
                    })
                  : Effect.void;
                const removeCreatedWorktree =
                  tracked && targetWorktreePath && bootstrap?.prepareWorktree
                    ? closeSetupTerminal.pipe(
                        Effect.ignoreCause({ log: true }),
                        Effect.andThen(
                          gitWorkflow
                            .removeWorktree({
                              cwd: bootstrap.prepareWorktree.projectCwd,
                              path: targetWorktreePath,
                              force: true,
                            })
                            .pipe(
                              Effect.retry({ times: 4, schedule: Schedule.spaced("500 millis") }),
                            ),
                        ),
                        Effect.ignoreCause({ log: true }),
                        Effect.uninterruptible,
                      )
                    : Effect.void;
                return track(
                  worktreeSetupTracker
                    .finish(threadId, "cancelled")
                    .pipe(
                      Effect.flatMap((snapshot) =>
                        snapshot ? recordWorktreeSetup(snapshot) : Effect.void,
                      ),
                    ),
                ).pipe(
                  Effect.andThen(removeCreatedWorktree),
                  Effect.andThen(
                    tracked
                      ? cleanupAndFail(
                          cause,
                          new OrchestrationDispatchCommandError({
                            message: "Worktree setup cancelled.",
                          }),
                        )
                      : Effect.fail(dispatchError),
                  ),
                );
              }
              return track(
                worktreeSetupTracker
                  .finish(threadId, "failed", dispatchError.message)
                  .pipe(
                    Effect.flatMap((snapshot) =>
                      snapshot ? recordWorktreeSetup(snapshot) : Effect.void,
                    ),
                  ),
              ).pipe(Effect.andThen(cleanupAndFail(cause, dispatchError)));
            }),
            // Cancellation must finish recording and rollback after the bootstrap is interrupted.
            Effect.uninterruptible,
          );

          // The bootstrap outlives the connection that asked for it: a reload
          // or a dropped socket must not abandon a half-made worktree, and
          // the thread it created is already visible to every client. The
          // RPC only waits on the detached fiber; a user cancel interrupts it
          // through the tracker.
          const runBootstrap = tracked
            ? Effect.gen(function* () {
                // Fork and register as one step: a detached fiber keeps going
                // if the caller is interrupted, so it must never exist without
                // the tracker entry that cancel and the stage updates key on.
                const fiber = yield* Effect.uninterruptible(
                  Effect.gen(function* () {
                    const fiber = yield* Effect.forkDetach(settledBootstrapProgram);
                    yield* worktreeSetupTracker.begin({
                      threadId,
                      branch: bootstrap?.prepareWorktree?.branch ?? null,
                      baseRef: bootstrap?.prepareWorktree?.baseBranch ?? null,
                      stages: ["fetch", "checkout", "submodules", "setup-script", "agent"],
                      fiber,
                    });
                    return fiber;
                  }),
                );
                return yield* Fiber.join(fiber);
              })
            : settledBootstrapProgram;

          return yield* runBootstrap;
        });

      const dispatchNormalizedCommand = (
        normalizedCommand: OrchestrationCommand,
      ): Effect.Effect<{ readonly sequence: number }, OrchestrationDispatchCommandError> => {
        const dispatchEffect =
          normalizedCommand.type === "thread.turn.start" && normalizedCommand.bootstrap
            ? dispatchBootstrapTurnStart(normalizedCommand)
            : dispatchFromClient(normalizedCommand).pipe(
                Effect.tap(({ sequence }) =>
                  // Returning from thread.create is the handoff point at which
                  // clients may start resources for the new incarnation. Use
                  // its event sequence as the exact deletion-cleanup fence.
                  normalizedCommand.type === "thread.create"
                    ? threadDeletionReactor.drainThrough(sequence)
                    : Effect.void,
                ),
                Effect.mapError((cause) =>
                  toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
                ),
              );

        return startup
          .enqueueCommand(dispatchEffect)
          .pipe(
            Effect.mapError((cause) =>
              toDispatchCommandError(cause, "Failed to dispatch orchestration command"),
            ),
          );
      };

      // Only clients that answer /usage-limits themselves see it in the catalogs;
      // an older client would send the injected command to the provider.
      const loadServerConfig = (options: { readonly usageLimitsCommand: boolean }) =>
        Effect.gen(function* () {
          const keybindingsConfig = yield* keybindings.loadConfigState;
          // loom: overlay live exhaustion marks onto provider snapshots.
          const currentProviders = overlayProviderExhaustion(
            yield* providerRegistry.getProviders,
            yield* providerHealthRegistry.snapshot,
            yield* Clock.currentTimeMillis,
          );
          const providers = options.usageLimitsCommand
            ? withUsageLimitsCommands(currentProviders, yield* usageLimitSources.current)
            : currentProviders;
          const settings = ServerSettings.redactServerSettingsForClient(
            yield* serverSettings.getSettings,
          );
          const environment = yield* serverEnvironment.getDescriptor;
          const auth = yield* serverAuth.getDescriptor();
          const availableEditors: ReadonlyArray<EditorId> = yield* resolveAvailableEditorsForConfig(
            externalLauncher.resolveAvailableEditors(),
          );
          const fileManagerRevealKind = availableEditors.includes("file-manager")
            ? yield* resolveFileManagerRevealKindForConfig(
                externalLauncher.resolveFileManagerRevealKind(),
              )
            : undefined;

          return {
            environment,
            auth,
            cwd: config.cwd,
            keybindingsConfigPath: config.keybindingsConfigPath,
            keybindings: keybindingsConfig.keybindings,
            issues: keybindingsConfig.issues,
            providers,
            availableEditors,
            // Same discovery-with-timeout treatment as editors: a slow probe
            // must not stall server.getConfig, so it degrades to no targets.
            remoteOpenTargets: yield* resolveAvailableEditorsForConfig(
              remoteOpenTargets.resolveTargets(),
            ),
            // loom: client-launched editors (Zed remote) need the ssh host.
            remoteEditorSshHost: Option.getOrNull(yield* ExternalLauncher.readRemoteEditorSshHost),
            observability: {
              logsDirectoryPath: config.logsDir,
              localTracingEnabled: true,
              ...(config.otlpTracesUrl !== undefined
                ? { otlpTracesUrl: config.otlpTracesUrl }
                : {}),
              otlpTracesEnabled: config.otlpTracesUrl !== undefined,
              ...(config.otlpMetricsUrl !== undefined
                ? { otlpMetricsUrl: config.otlpMetricsUrl }
                : {}),
              otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
              ...(config.otlpLogsUrl !== undefined ? { otlpLogsUrl: config.otlpLogsUrl } : {}),
              otlpLogsEnabled: config.otlpLogsUrl !== undefined,
            },
            settings,
            // loom: now honoured. Loom previously advertised `false` because its
            // shell leg mapped the (fallible) projection lookup on the CONSUMING
            // stream and never forked into a value-only buffer, so it had nowhere
            // to offer the marker without an ordering hazard. Upstream's scope-bound
            // live buffer + coalescer (adopted in this pull) queues the marker in
            // the SAME buffer as live events, which is exactly the ordering the
            // thread path already relied on — and loom's fail-loud mapper rides on
            // top of it. See plans/2026-07-28-thread-catchup-silent-truncation.md.
            shellResumeCompletionMarker: true,
            ...(fileManagerRevealKind === undefined
              ? {}
              : {
                  shellRevealInFileManager: true,
                  shellRevealInFileManagerKind: fileManagerRevealKind,
                }),
            threadResumeCompletionMarker: true,
            threadSnapshotPagination: true,
            reasoningMessages: true,
          };
        });

      const refreshGitStatus = (cwd: string) =>
        vcsStatusBroadcaster
          .refreshStatus(cwd)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach, Effect.asVoid);

      return WsRpcGroup.of({
        // loom: fork ws handlers (heartbeat keepalive, usage breakdown, workstream
        // worktree read/remove) — factory in loom/wsMethods.ts, fed the locals above.
        ...makeLoomWsHandlers({ observeRpcEffect, usageBreakdownQuery, workstreamWorktreeStatus }),
        [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.dispatchCommand,
            Effect.gen(function* () {
              yield* ProjectCloneTracker.rejectCommandsDuringClone(projectCloneTracker, command);
              const normalizedCommand = yield* normalizeDispatchCommand(command);
              // Archive and settle both mean "done with this thread", so a
              // live provider session must not keep running background work
              // (PR monitors, dev servers, subagent fleets) after either
              // lands. The decider rejects settling a starting/running
              // session, so for settle this only ever stops an idle one; a
              // stopped session-set does not count as activity, so the stop
              // cannot un-settle the thread it follows.
              //
              // loom: thread.archive cascades over the live subtree in the
              // decider, so its teardown sweeps the same set — a workstream
              // child with a running session would otherwise keep burning
              // after its root is archived. Settle deliberately does NOT
              // cascade: an abandoned graph must stay settleable while its
              // children run (docs/upstream-sync/23-sidebar-v2-rehome.md §J).
              // The sweep set is read with a narrow lineage query, NOT
              // getShellSnapshot(): that snapshot hydrates every active thread
              // and shells out to `git` per workspace root to resolve
              // repository identities (hundreds of ms, sometimes >1s) — an
              // enormous price on the click-to-ack path just to learn a
              // handful of thread ids.
              const parkingCommand =
                normalizedCommand.type === "thread.archive" ||
                normalizedCommand.type === "thread.settle"
                  ? normalizedCommand
                  : undefined;
              // Best-effort on purpose: the user's archive/settle must not
              // fail because this cleanup read blipped, so a failed read
              // logs and skips the stop instead of propagating.
              const threadsToStopAfterParking = !parkingCommand
                ? []
                : parkingCommand.type === "thread.archive"
                  ? yield* projectionSnapshotQuery
                      .getLiveSubtreeSessionLiveness(parkingCommand.threadId)
                      .pipe(
                        Effect.orElseSucceed(() => [
                          { threadId: parkingCommand.threadId, hasLiveSession: false },
                        ]),
                      )
                  : yield* projectionSnapshotQuery.getThreadShellById(parkingCommand.threadId).pipe(
                      Effect.map(
                        Option.match({
                          onNone: () => [],
                          onSome: (thread) => [
                            {
                              threadId: parkingCommand.threadId,
                              hasLiveSession:
                                thread.session !== null && thread.session.status !== "stopped",
                            },
                          ],
                        }),
                      ),
                      Effect.catchCause((cause) =>
                        Effect.logWarning(
                          "failed to read thread session state before session-stop check",
                          { threadId: parkingCommand.threadId, cause },
                        ).pipe(Effect.as([])),
                      ),
                    );
              const result = yield* dispatchNormalizedCommand(normalizedCommand).pipe(
                Effect.tapError(() => cleanupFailedUploadedAttachments(command, normalizedCommand)),
              );
              yield* recordClientCommandAnalytics(normalizedCommand);
              yield* ProjectCloneTracker.discardCloneForDeletedProject(
                projectCloneTracker,
                normalizedCommand,
              );
              // Teardown runs detached: the archive is already committed and
              // the shell-stream `thread-removed` event has been published, so
              // the row is gone from the client's sidebar the moment we ack.
              // Stopping provider sessions and closing PTYs is slow, serial
              // best-effort cleanup whose result the caller never inspects —
              // holding the ack behind it made the button feel dead.
              if (parkingCommand && threadsToStopAfterParking.length > 0) {
                const parkingKind = parkingCommand.type === "thread.archive" ? "archive" : "settle";
                yield* Effect.forEach(
                  threadsToStopAfterParking,
                  ({ threadId, hasLiveSession }) =>
                    Effect.gen(function* () {
                      if (hasLiveSession) {
                        yield* Effect.gen(function* () {
                          const stopCommand = yield* normalizeDispatchCommand({
                            type: "thread.session.stop",
                            commandId: CommandId.make(
                              `session-stop-for-${parkingKind}:${parkingCommand.commandId}:${threadId}`,
                            ),
                            threadId,
                            createdAt: yield* nowIso,
                            // A settled thread can be re-engaged before this
                            // stop is decided; the decider then drops the stop
                            // instead of killing the new session. Archive stops
                            // stay unconditional: turn starts on archived
                            // threads are rejected, so there is no new session
                            // to protect.
                            ...(parkingKind === "settle" ? { onlyIfSettled: true } : {}),
                          });

                          yield* dispatchNormalizedCommand(stopCommand);
                        }).pipe(
                          Effect.catchCause((cause) =>
                            Effect.logWarning(
                              `failed to stop provider session during ${parkingKind}`,
                              { threadId, cause: Cause.pretty(cause) },
                            ),
                          ),
                        );
                      }

                      // Terminals are user-opened panes, not thread background
                      // work: archive removes the thread from view so they
                      // close with it, but a settled thread stays reachable and
                      // may be un-settled, so its terminals stay up.
                      if (parkingKind === "archive") {
                        yield* terminalManager.close({ threadId }).pipe(
                          Effect.catch((error) =>
                            Effect.logWarning("failed to close thread terminals after archive", {
                              threadId,
                              error: error.message,
                            }),
                          ),
                        );
                      }
                    }),
                  { discard: true },
                ).pipe(Effect.forkDetach);
              }
              return result;
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationDispatchCommandError(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to dispatch orchestration command",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        // loom: `/handoff` fork-drafter (plan D2/D4). Human composer intercept
        // → fork the source into a throwaway `handoff-drafter` ROOT and inject
        // the drafter kickoff as its first turn via the existing bootstrap
        // turn-start path. The source transcript is never touched. Validation
        // mirrors the fork guard: pi-only source, source idle (the composer
        // disables the command while running; this is the backstop),
        // non-empty explanation (schema-enforced).
        [WS_METHODS.serverHandoffDraft]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverHandoffDraft,
            Effect.gen(function* () {
              const failValidation = (message: string) =>
                new OrchestrationDispatchCommandError({ message });

              const source = yield* projectionSnapshotQuery.getThreadDetailById(
                input.sourceThreadId,
              );
              if (Option.isNone(source)) {
                return yield* failValidation("The source thread for this handoff was not found.");
              }
              const sourceThread = source.value;

              // Pi-only: only the pi driver honours `forkFromThreadId`
              // (`pi --fork`). Mirror ThreadForkHttp's guard rather than
              // promising context that another driver would silently drop.
              if (sourceThread.session?.providerName !== "pi") {
                return yield* failValidation(
                  "Only pi-backed threads can be handed off (the drafter relies on pi's native session fork).",
                );
              }

              // Source-idle: forking a mid-turn jsonl would capture an unclosed
              // tool call. The composer disables /handoff while the source is
              // running; this rejects the residual race with a clear error.
              const pendingTurnStartThreadIds =
                yield* projectionSnapshotQuery.getPendingTurnStartThreadIds();
              if (
                !isThreadIdle(sourceThread, pendingTurnStartThreadIds) ||
                (sourceThread.latestTurn !== null && sourceThread.latestTurn.state === "running")
              ) {
                return yield* failValidation(
                  "This thread is mid-turn; wait for it to finish before handing off (forking a live session would corrupt its context).",
                );
              }

              // Model policy (plan D4): prefer the source's captured
              // launch-identity selection (what actually consumed the cacheable
              // prefix). Degraded fallback (deliberate, and unlike the
              // dispatcher's DEFER): a missing/model-less/undecodable capture
              // falls back to the projected `sourceThread.modelSelection` — a
              // valid selection the source already launched with (exactly what
              // `thread_fork` ships). This is a one-shot HUMAN action, so
              // deferring (as the dispatcher's promotion loop does) would mean
              // rejecting the handoff, worse UX than a correct-but-not-cache-
              // optimal model. `ModelSelection` decode proves shape/branding but
              // NOT that the instance is still configured; a genuinely dead
              // instance surfaces downstream as `thread.turn-start-failed` → the
              // settlement reactor raises needs_guidance (D6 leg 2), never a
              // silent success.
              const candidate = capturedDrafterSelectionCandidate(
                readLaunchIdentity(config.workstreamLaunchIdentityDir, sourceThread.id),
              );
              const selection =
                candidate === undefined
                  ? sourceThread.modelSelection
                  : yield* decodeModelSelection(candidate).pipe(
                      Effect.orElseSucceed(() => sourceThread.modelSelection),
                    );

              const drafterThreadId = ThreadId.make(yield* crypto.randomUUIDv4);
              const command = buildHandoffDraftTurnStart({
                source: sourceThread,
                explanation: input.explanation,
                drafterThreadId,
                modelSelection: selection,
                commandId: CommandId.make(`server:handoff-draft:${yield* crypto.randomUUIDv4}`),
                messageId: MessageId.make(yield* crypto.randomUUIDv4),
                now: yield* nowIso,
              });

              yield* dispatchNormalizedCommand(command);
              return { drafterThreadId };
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationDispatchCommandError(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to start the handoff drafter",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        // loom: `/retro` fork-reviewer. Human composer intercept → fork the
        // source into a VISIBLE `retro-reviewer` ROOT and inject the retro
        // kickoff as its first turn. Same intake shape as `/handoff` above
        // (pi-only source, source idle, message never lands on the source);
        // model policy inherits the source's projected selection (a retro is a
        // fresh cold review, so launch-identity cache parity buys nothing).
        [WS_METHODS.serverRetroDraft]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRetroDraft,
            Effect.gen(function* () {
              const failValidation = (message: string) =>
                new OrchestrationDispatchCommandError({ message });

              const source = yield* projectionSnapshotQuery.getThreadDetailById(
                input.sourceThreadId,
              );
              if (Option.isNone(source)) {
                return yield* failValidation("The source thread for this retro was not found.");
              }
              const sourceThread = source.value;

              // Pi-only: only the pi driver honours `forkFromThreadId`
              // (`pi --fork`). Mirror ThreadForkHttp's guard rather than
              // promising context that another driver would silently drop.
              if (sourceThread.session?.providerName !== "pi") {
                return yield* failValidation(
                  "Only pi-backed threads can be reviewed (the retro relies on pi's native session fork).",
                );
              }

              // Source-idle: forking a mid-turn jsonl would capture an unclosed
              // tool call. The composer disables /retro while the source is
              // running; this rejects the residual race with a clear error.
              const pendingTurnStartThreadIds =
                yield* projectionSnapshotQuery.getPendingTurnStartThreadIds();
              if (
                !isThreadIdle(sourceThread, pendingTurnStartThreadIds) ||
                (sourceThread.latestTurn !== null && sourceThread.latestTurn.state === "running")
              ) {
                return yield* failValidation(
                  "This thread is mid-turn; wait for it to finish before running a retro (forking a live session would corrupt its context).",
                );
              }

              // The reviewer is seeded from the source's projected selection.
              // The fork only carries context on the pi driver, so refuse a
              // projected selection that resolves to a non-pi instance (a
              // reroute drift) rather than silently launching without history.
              const selectedProvider = (yield* providerRegistry.getProviders).find(
                (provider) => provider.instanceId === sourceThread.modelSelection.instanceId,
              );
              if (selectedProvider !== undefined && selectedProvider.driver !== "pi") {
                return yield* failValidation(
                  "This thread's current model selection is not pi-backed; a retro fork would launch without the thread's history. Switch the thread back to a pi model first.",
                );
              }

              const reviewerThreadId = ThreadId.make(yield* crypto.randomUUIDv4);
              const command = buildRetroDraftTurnStart({
                source: sourceThread,
                focus: input.focus,
                reviewerThreadId,
                modelSelection: sourceThread.modelSelection,
                commandId: CommandId.make(`server:retro-draft:${yield* crypto.randomUUIDv4}`),
                messageId: MessageId.make(yield* crypto.randomUUIDv4),
                now: yield* nowIso,
              });

              yield* dispatchNormalizedCommand(command);
              return { reviewerThreadId };
            }).pipe(
              Effect.mapError((cause) =>
                isOrchestrationDispatchCommandError(cause)
                  ? cause
                  : new OrchestrationDispatchCommandError({
                      message: "Failed to start the retro reviewer",
                      cause,
                    }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getWorkflowScript]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getWorkflowScript,
            readWorkflowScript({ scriptPath: input.scriptPath }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getTurnDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getTurnDiff,
            checkpointDiffQuery.getTurnDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetTurnDiffError({
                    message: "Failed to load turn diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getThreadActivities]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getThreadActivities,
            projectionSnapshotQuery.getThreadActivitiesPage(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetThreadActivitiesError({
                    message: "Failed to load thread activities page",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getThreadLifecycle]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getThreadLifecycle,
            projectionSnapshotQuery.getThreadLifecycle(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetThreadLifecycleError({
                    message: "Failed to load thread lifecycle",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getFullThreadDiff,
            checkpointDiffQuery.getFullThreadDiff(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetFullThreadDiffError({
                    message: "Failed to load full thread diff",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.searchThreads]: (input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.searchThreads,
            projectionSnapshotQuery.searchThreads(input).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestrationSearchThreadsError({
                    message: "Failed to search threads",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeShell]: (input) =>
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeShell,
            Effect.gen(function* () {
              // Derived brief-needed parent attention (liveness plan §3.3) is
              // applied HERE, at the outward boundary — never inside the shell
              // queries, which the dispatcher and sweep read as control-plane
              // state. One tracker per subscription; see the module doc.
              const briefNeededAttention =
                yield* makeBriefNeededOutwardAttention(projectionSnapshotQuery);
              const { coalesceShellStream, coalesceShellLiveInputs } =
                makeShellStreamEventMapper(briefNeededAttention);
              // Coalesce the live shell stream per aggregate over a small window
              // so bursts of high-frequency events (streaming message deltas,
              // activity appends) collapse into a single shell refetch and never
              // serialize a brand-new thread's `thread.created` behind hundreds
              // of per-event DB reads. See coalesceShellStream.
              // Attach live delivery into a scope-bound buffer BEFORE loading any
              // snapshot or draining catch-up, otherwise an event published while
              // the snapshot query is in flight is lost (it is past the snapshot's
              // sequence but the live subscription is not attached yet). Every
              // path below emits from this same buffered live tail. Overlapping
              // events are deduped by sequence on the client.
              const liveBudget = yield* makeLiveStreamBudget();
              const liveBuffer = yield* Queue.unbounded<
                RetainedLiveItem<ShellLiveInput>,
                OrchestrationGetSnapshotError
              >();
              let liveBufferClosed = false;
              const closeLiveBuffer = (error?: OrchestrationGetSnapshotError) =>
                Effect.gen(function* () {
                  if (liveBufferClosed) {
                    return;
                  }
                  liveBufferClosed = true;
                  liveBudget.release(yield* Queue.clear(liveBuffer).pipe(Effect.orDie));
                  if (error) {
                    yield* Queue.fail(liveBuffer, error);
                  }
                  yield* Queue.shutdown(liveBuffer);
                });
              yield* Effect.addFinalizer(() => closeLiveBuffer());
              yield* liveBudget.failed.pipe(
                Effect.catchTags({ OrchestrationGetSnapshotError: closeLiveBuffer }),
                Effect.forkScoped,
              );
              // loom: EAGER attach via `subscribeDomainEvents` (a fork-added engine
              // facility) rather than upstream's lazy `streamDomainEvents`. The
              // scope-bound buffer only closes the connect-gap if the PubSub
              // subscription already exists when the snapshot read runs; a forked
              // `streamDomainEvents` subscribes whenever its fibre first pulls,
              // which is not ordered against this generator.
              const liveDomainEvents = yield* orchestrationEngine.subscribeDomainEvents;
              yield* Effect.forkScoped(
                liveDomainEvents.pipe(
                  Stream.map(toShellEvent),
                  Stream.runForEach((event) =>
                    liveBudget.retain({ kind: "event" as const, event }, event).pipe(
                      Effect.flatMap((item) => Queue.offer(liveBuffer, item)),
                      Effect.uninterruptible,
                    ),
                  ),
                  // Stop the PubSub consumer even if RPC delivery is waiting
                  // for an ACK and never pulls the failed buffer again.
                  Effect.raceFirst(liveBudget.failed),
                  Effect.catchTags({ OrchestrationGetSnapshotError: () => Effect.void }),
                ),
              );
              // loom: fail loud, don't swallow. The coalescer's projection refetch
              // is fallible (ProjectionRepositoryError, already retried); surfacing
              // it here fails the subscription so the client self-heals with a
              // fresh snapshot, instead of dropping a shell update and leaving the
              // sidebar permanently stale.
              const coalesceRetainedInputs = (
                items: ReadonlyArray<RetainedLiveItem<ShellLiveInput>>,
              ) =>
                coalesceShellLiveInputs(items.map((item) => item.value)).pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to project live orchestration shell event",
                        cause,
                      }),
                  ),
                  Effect.flatMap((output) => liveBudget.replace(items, output)),
                );
              const bufferedLiveStream = Stream.fromQueue(liveBuffer).pipe(
                Stream.groupedWithin(SHELL_COALESCE_MAX_CHUNK, SHELL_COALESCE_WINDOW),
                Stream.mapEffect(coalesceRetainedInputs),
                Stream.flatMap((items) => Stream.fromIterable(items)),
              );

              const loadSnapshot = projectionSnapshotQuery.getShellSnapshot().pipe(
                Effect.flatMap(briefNeededAttention.decorateSnapshot),
                Effect.tapError((cause) =>
                  Effect.logError("orchestration shell snapshot load failed", { cause }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestrationGetSnapshotError({
                      message: "Failed to load orchestration shell snapshot",
                      cause,
                    }),
                ),
              );

              // Offer the completion marker into the same queue as live events.
              // Anything buffered while snapshot/replay work was in flight is
              // therefore delivered before the client is told it is synchronized.
              const synchronizedThenLive = liveBudget.deliver(
                input.requestCompletionMarker === true
                  ? Stream.concat(
                      Stream.fromEffect(
                        liveBudget.retain({ kind: "synchronized" as const }).pipe(
                          Effect.flatMap((item) => Queue.offer(liveBuffer, item)),
                          Effect.uninterruptible,
                          Effect.andThen(Queue.takeAll(liveBuffer)),
                          Effect.flatMap(coalesceRetainedInputs),
                        ),
                      ).pipe(Stream.flatMap((items) => Stream.fromIterable(items))),
                      bufferedLiveStream,
                    )
                  : bufferedLiveStream,
              );

              // When the client already holds a shell snapshot (cached, or loaded
              // over HTTP) it passes that snapshot's sequence, and we resume by
              // replaying shell events after it instead of re-sending the whole
              // projects/threads list over the socket. Overlapping events are
              // deduped by sequence on the client.
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const replayGap = headSequence - afterSequence;
                // Gap too large: replaying every intervening event (each a shell
                // refetch) is far more expensive than a single O(active-threads)
                // snapshot. A cursor ahead of this engine's authoritative state
                // is also invalid (a restored DB backup or a projection reset
                // would otherwise leave the client confidently stale with phantom
                // threads), so reset it with a snapshot. Send the snapshot
                // followed by the buffered live tail, exactly as the
                // no-afterSequence path does.
                if (
                  !(yield* canReplayPersistedRange(
                    afterSequence,
                    headSequence,
                    SHELL_RESUME_MAX_GAP,
                  ))
                ) {
                  return Stream.concat(
                    Stream.make({ kind: "snapshot" as const, snapshot: yield* loadSnapshot }),
                    synchronizedThenLive,
                  );
                }
                const catchUpStream = coalesceShellStream(
                  // Replay only through the head captured above. Newer events
                  // are already covered by the live subscription, so this bound
                  // cannot chase a moving event-store head or grow the live
                  // buffer indefinitely while waiting for an empty page.
                  orchestrationEngine.readEvents(afterSequence, replayGap),
                ).pipe(
                  Stream.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: "Failed to replay orchestration shell events",
                        cause,
                      }),
                  ),
                );
                return Stream.concat(catchUpStream, synchronizedThenLive);
              }

              return Stream.concat(
                Stream.make({ kind: "snapshot" as const, snapshot: yield* loadSnapshot }),
                synchronizedThenLive,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot]: (_input) =>
          observeRpcEffect(
            ORCHESTRATION_WS_METHODS.getArchivedShellSnapshot,
            projectionSnapshotQuery.getArchivedShellSnapshot().pipe(
              Effect.tapError((cause) =>
                Effect.logError("orchestration archived shell snapshot load failed", { cause }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestrationGetSnapshotError({
                    message: "Failed to load archived orchestration shell snapshot",
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "orchestration" },
          ),
        [ORCHESTRATION_WS_METHODS.subscribeThread]: (input) =>
          // loom: connect-gap-aware thread subscription on upstream's HTTP-snapshot
          // + afterSequence resume flow (#3719, #4079). Both the durable domain
          // events AND the transient reasoning bus are pre-buffered into upstream's
          // single connect-gap queue before the snapshot/catch-up, so mid-fetch
          // items drain onto the snapshot instead of being lost.
          observeRpcStreamEffect(
            ORCHESTRATION_WS_METHODS.subscribeThread,
            Effect.gen(function* () {
              const isThisThreadDetailEvent = (event: OrchestrationEvent) =>
                event.aggregateKind === "thread" &&
                event.aggregateId === input.threadId &&
                isThreadDetailEvent(event);

              // loom: EAGER attach (`subscribeDomainEvents`), matching the shell
              // path. The lazy `streamDomainEvents` value only subscribed when the
              // forked fibre first pulled, leaving a silent connect-gap for events
              // committed between the snapshot/cursor read below and that first
              // pull. The gap-free-seam reasoning further down DEPENDS on the
              // subscription existing before the cursor is sampled.
              // See plans/2026-07-28-thread-catchup-silent-truncation.md.
              const rawThreadLive = yield* orchestrationEngine.subscribeDomainEvents;
              const liveStream = rawThreadLive.pipe(
                Stream.filter(isThisThreadDetailEvent),
                Stream.map((event) => ({
                  kind: "event" as const,
                  event: projectActivityEvent(event, input.reasoningMessages === true),
                })),
              );

              // loom: transient ephemeral reasoning chunks for this thread. These
              // never touch the event store; they drive live "Thinking… ⟷ Thought
              // for Xs" display. Acquire the bus subscription HERE — before the
              // snapshot fetch / catch-up replay below — so any chunks published
              // during that window buffer in the subscription queue
              // (ReasoningStreamBus.subscribe is scoped for exactly this). The
              // durable `thread.message-reasoning` event in liveStream is
              // authoritative (REPLACE full text) on finalization; these deltas
              // only drive the live "Thinking…" display.
              const reasoningSubscription = yield* reasoningStreamBus.subscribe;
              const reasoningStream = Stream.fromSubscription(reasoningSubscription).pipe(
                Stream.filter((payload) => payload.threadId === input.threadId),
                Stream.map((payload) => ({
                  kind: "reasoning-delta" as const,
                  payload,
                })),
              );

              // Attach live delivery before reading either replay or snapshot state.
              // Otherwise an event published while the snapshot is loading is lost.
              const liveBuffer = yield* makeThreadLiveEventCoalescer();
              yield* Effect.forkScoped(
                liveStream.pipe(
                  Stream.runForEachArray(liveBuffer.offerAll),
                  Effect.raceFirst(liveBuffer.failed),
                  Effect.catchTags({ OrchestrationGetSnapshotError: () => Effect.void }),
                ),
                { startImmediately: true },
              );
              // loom: the transient reasoning stream is forked into this SAME
              // buffer, so reasoning deltas ride the connect-gap queue (one
              // pre-subscribed buffer that drains AFTER the snapshot element — the
              // client applies the snapshot as a whole-thread replace, so buffered
              // deltas land on top of it) rather than a separate late merge.
              yield* Effect.forkScoped(
                reasoningStream.pipe(
                  Stream.runForEachArray(liveBuffer.offerAll),
                  Effect.raceFirst(liveBuffer.failed),
                  Effect.catchTags({ OrchestrationGetSnapshotError: () => Effect.void }),
                ),
                { startImmediately: true },
              );
              const bufferedLiveStream = liveBuffer.stream;
              let replayOnMissingSnapshot: typeof bufferedLiveStream | undefined;

              // When the client already loaded the snapshot over HTTP it passes
              // that snapshot's sequence, and we resume the live subscription by
              // replaying persisted events after it instead of re-sending the
              // (potentially multi-KB) snapshot frame over the socket.
              //
              // The live PubSub subscription must be attached *before* draining
              // the catch-up replay, otherwise events published during the replay
              // window are dropped (they are past the persisted tail the replay
              // read, but the live stream is not yet subscribed). So fork the
              // live stream into a buffer bound to this stream's scope, then emit
              // catch-up followed by the buffered/ongoing live events. Overlapping
              // events are deduped by sequence on the client.
              //
              // Measure only this thread's rows — the read is bounded by events
              // RETURNED for this thread, never by events scanned globally, which
              // is what let a busy server silently deliver nothing on resume.
              // Global sequence gaps can contain unrelated or pruned streams. Keep
              // an explicit upper bound so events after the captured head stay in
              // the live tail. A cursor ahead of the head (restored DB backup,
              // projection reset) cannot be replayed at all and takes the snapshot
              // path. See plans/2026-07-28-thread-catchup-silent-truncation.md.
              if (input.afterSequence !== undefined) {
                const afterSequence = input.afterSequence;
                const headSequence = yield* orchestrationEngine.latestSequence;
                const range = {
                  threadId: input.threadId,
                  fromSequenceExclusive: afterSequence,
                  toSequenceInclusive: headSequence,
                };
                const replayStats =
                  afterSequence > headSequence
                    ? null
                    : yield* orchestrationEngine
                        .getThreadReplayStats({
                          ...range,
                          maxEvents: THREAD_RESUME_MAX_EVENTS,
                        })
                        .pipe(
                          Effect.mapError(
                            (cause) =>
                              new OrchestrationGetSnapshotError({
                                message: `Failed to measure thread ${input.threadId} replay range`,
                                cause,
                              }),
                          ),
                        );
                if (
                  replayStats !== null &&
                  replayStats.eventCount <= THREAD_RESUME_MAX_EVENTS &&
                  replayStats.payloadBytes <= ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES
                ) {
                  const catchUpStream = orchestrationEngine
                    .readThreadEvents({ ...range, limit: THREAD_RESUME_MAX_EVENTS })
                    .pipe(
                      Stream.filter(isThisThreadDetailEvent),
                      Stream.map((event) => ({
                        kind: "event" as const,
                        event: projectActivityEvent(event, input.reasoningMessages === true),
                      })),
                      Stream.mapError(
                        (cause) =>
                          new OrchestrationGetSnapshotError({
                            message: `Failed to replay thread ${input.threadId} events`,
                            cause,
                          }),
                      ),
                    );
                  // loom: the marker is OFFERED INTO THE SAME QUEUE as the live
                  // events, never concatenated ahead of the stream — a
                  // concatenated marker would overtake events already buffered
                  // during the snapshot/catch-up window and tell the client
                  // "synchronised" before it had applied them.
                  const afterCatchUp =
                    input.requestCompletionMarker === true
                      ? Stream.unwrap(
                          liveBuffer
                            .offer({ kind: "synchronized" as const })
                            .pipe(Effect.as(bufferedLiveStream)),
                        )
                      : bufferedLiveStream;
                  const replay = Stream.concat(catchUpStream, afterCatchUp);
                  if (!replayStats.hasCreateEvent) {
                    return replay;
                  }
                  replayOnMissingSnapshot = replay;
                }
                // A recreated thread needs a fresh snapshot if it still exists.
                // Oversized replays and invalid cursors also use the snapshot path.
              }

              const snapshot = yield* projectionSnapshotQuery
                .getThreadDetailSnapshot(
                  input.threadId,
                  // Windowing the fallback snapshot is opt-in per subscription:
                  // clients that don't send turnLimit (including all
                  // pre-pagination clients) get the full thread, since they
                  // have no way to load older pages.
                  input.turnLimit === undefined ? undefined : { turnLimit: input.turnLimit },
                )
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new OrchestrationGetSnapshotError({
                        message: `Failed to load thread ${input.threadId}`,
                        cause,
                      }),
                  ),
                );

              if (Option.isNone(snapshot)) {
                // The recreated thread can already be deleted. Preserve the
                // bounded replay and shell removal instead of retrying a
                // snapshot that cannot exist. Oversized ranges still fail.
                if (replayOnMissingSnapshot !== undefined) {
                  return replayOnMissingSnapshot;
                }
                return yield* new OrchestrationGetSnapshotError({
                  message: `Thread ${input.threadId} was not found`,
                  cause: input.threadId,
                });
              }

              const afterSnapshot =
                input.requestCompletionMarker === true
                  ? Stream.unwrap(
                      liveBuffer
                        .offer({ kind: "synchronized" as const })
                        .pipe(Effect.as(bufferedLiveStream)),
                    )
                  : bufferedLiveStream;
              return Stream.concat(
                Stream.make({
                  kind: "snapshot" as const,
                  snapshot: projectThreadDetailSnapshot(
                    snapshot.value,
                    input.reasoningMessages === true,
                  ),
                }),
                afterSnapshot,
              );
            }),
            { "rpc.aggregate": "orchestration" },
          ),
        [WS_METHODS.serverProbe]: (_input) =>
          observeRpcEffect(WS_METHODS.serverProbe, Effect.succeed({}), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetConfig]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetConfig,
            loadServerConfig({ usageLimitsCommand: false }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverRefreshProviders]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverRefreshProviders,
            Effect.gen(function* () {
              // An untargeted refresh is "re-read everything's status", which
              // includes quota from configured usage-limit sources. Awaited,
              // not forked: the RPC scope closes on return and would
              // interrupt a fork before the hub answered.
              if (input.instanceId === undefined) {
                yield* usageLimitSources.refresh;
              }
              let providers = yield* input.cwd !== undefined && input.instanceId !== undefined
                ? providerRegistry.refreshWorkspaceSnapshot({
                    instanceId: input.instanceId,
                    cwd: input.cwd,
                  })
                : input.instanceId !== undefined
                  ? providerRegistry.refreshInstance(input.instanceId)
                  : providerRegistry.refresh();
              if (input.refreshModels) {
                const instances = yield* providerInstances.listInstances;
                for (const instance of instances) {
                  if (
                    !instance.refreshModels ||
                    (input.instanceId !== undefined && input.instanceId !== instance.instanceId) ||
                    !providers.some(
                      (provider) =>
                        provider.instanceId === instance.instanceId &&
                        provider.enabled &&
                        provider.installed,
                    )
                  )
                    continue;
                  yield* instance.refreshModels().pipe(
                    Effect.mapError(
                      (error) =>
                        new ProviderSetupError({
                          instanceId: instance.instanceId,
                          operation: "refresh-models",
                          detail: error.detail,
                        }),
                    ),
                  );
                  providers = yield* providerRegistry.refreshInstance(instance.instanceId);
                }
              }
              return { providers };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.providerUploadFeedback]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerUploadFeedback,
            providerService.uploadFeedback(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderUploadFeedbackError({
                    threadId: input.threadId,
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.serverUpdateProvider]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateProvider,
            providerMaintenanceRunner.updateProvider(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.providerConsumeResetCredit]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerConsumeResetCredit,
            Effect.gen(function* () {
              if ("sourceId" in input) return yield* usageLimitSources.consumeResetCredit(input);
              const instance = yield* providerInstances.getInstance(input.instanceId);
              // A disabled instance must not spend anything on its account.
              if (instance === undefined || !instance.enabled) {
                return yield* new ProviderSetupError({
                  instanceId: input.instanceId,
                  operation: "consume-reset-credit",
                  detail: instance ? "This provider is disabled." : "Provider instance not found.",
                });
              }
              if (instance.consumeResetCredit === undefined) {
                return yield* new ProviderSetupError({
                  instanceId: input.instanceId,
                  operation: "consume-reset-credit",
                  detail: "This provider does not bank reset credits.",
                });
              }
              const outcome = yield* instance.consumeResetCredit().pipe(
                Effect.mapError(
                  (error) =>
                    new ProviderSetupError({
                      instanceId: input.instanceId,
                      operation: "consume-reset-credit",
                      detail: error.detail,
                      cause: error,
                    }),
                ),
              );
              return { outcome };
            }),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerAuthStart]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthStart,
            providerAuth.start(input, currentSessionId),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerAuthComplete]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthComplete,
            providerAuth.complete(input, currentSessionId),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerAuthCancel]: (input) =>
          observeRpcEffect(
            WS_METHODS.providerAuthCancel,
            providerAuth.cancel(input, currentSessionId),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerAuthLogout]: (input) =>
          observeRpcEffect(WS_METHODS.providerAuthLogout, providerAuth.logout(input), {
            "rpc.aggregate": "provider",
          }),
        [WS_METHODS.providerAuthSubscribe]: (input) =>
          observeRpcStream(
            WS_METHODS.providerAuthSubscribe,
            providerAuth.subscribe(input, currentSessionId),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerInstallStart]: (input) =>
          observeRpcEffect(WS_METHODS.providerInstallStart, providerInstallation.start(input), {
            "rpc.aggregate": "provider",
          }),
        [WS_METHODS.providerInstallCancel]: (input) =>
          observeRpcEffect(WS_METHODS.providerInstallCancel, providerInstallation.cancel(input), {
            "rpc.aggregate": "provider",
          }),
        [WS_METHODS.providerInstallSubscribe]: (input) =>
          observeRpcStream(
            WS_METHODS.providerInstallSubscribe,
            providerInstallation.subscribe(input),
            { "rpc.aggregate": "provider" },
          ),
        [WS_METHODS.providerInstallRemove]: (input) =>
          observeRpcEffect(WS_METHODS.providerInstallRemove, providerInstallation.remove(input), {
            "rpc.aggregate": "provider",
          }),
        [WS_METHODS.serverUpdateServer]: (input) =>
          observeRpcEffect(WS_METHODS.serverUpdateServer, serverUpdate.update(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverUpdateServerWithProgress]: (input) =>
          observeRpcStream(
            WS_METHODS.serverUpdateServerWithProgress,
            Stream.callback<ServerSelfUpdateProgressEvent, ServerSelfUpdateError>((queue) =>
              serverUpdate
                .update(input, (stage) =>
                  Queue.offer(queue, {
                    type: "progress",
                    stage,
                  }).pipe(Effect.asVoid),
                )
                .pipe(
                  Effect.flatMap((result) =>
                    Queue.offer(queue, {
                      type: "complete",
                      result,
                    }),
                  ),
                  Effect.catchTags({
                    ServerSelfUpdateError: (error) => Queue.fail(queue, error),
                  }),
                  Effect.andThen(Queue.end(queue)),
                  Effect.forkScoped,
                ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverCommitDesktopUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverCommitDesktopUpdate,
            serverUpdate.commitDesktopUpdate(input.requestId),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverUpsertKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverUpsertKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverRemoveKeybinding]: (rule) =>
          observeRpcEffect(
            WS_METHODS.serverRemoveKeybinding,
            Effect.gen(function* () {
              const keybindingsConfig = yield* keybindings.removeKeybindingRule(rule);
              return { keybindings: keybindingsConfig, issues: [] };
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetSettings]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetSettings,
            serverSettings.getSettings.pipe(
              Effect.map(ServerSettings.redactServerSettingsForClient),
            ),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
          observeRpcEffect(
            WS_METHODS.serverUpdateSettings,
            Effect.gen(function* () {
              const deviceHosts = patch.deviceHosts
                ? yield* remoteSshDeviceHosts(patch.deviceHosts).pipe(
                    Effect.provide(deviceHostContext),
                  )
                : undefined;
              const settings = yield* serverSettings.updateSettings({
                ...patch,
                ...(deviceHosts ? { deviceHosts } : {}),
              });
              return ServerSettings.redactServerSettingsForClient(settings);
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverDiscoverSourceControl,
            sourceControlDiscovery.discover,
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetTraceDiagnostics]: (_input) =>
          observeRpcEffect(
            WS_METHODS.serverGetTraceDiagnostics,
            TraceDiagnostics.readTraceDiagnostics({
              traceFilePath: config.serverTracePath,
              maxFiles: config.traceMaxFiles,
            }),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetProcessDiagnostics]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetProcessDiagnostics, processDiagnostics.read, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetHostResources]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetHostResources, hostResources.read, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverGetProcessResourceHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetProcessResourceHistory,
            processResourceMonitor.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetResourceTelemetryHistory]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverGetResourceTelemetryHistory,
            resourceTelemetry.readHistory(input),
            {
              "rpc.aggregate": "server",
            },
          ),
        [WS_METHODS.serverGetUsageSummary]: (input) =>
          observeRpcEffect(WS_METHODS.serverGetUsageSummary, usage.readSummary(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRefreshUsageRates]: (_input) =>
          observeRpcEffect(WS_METHODS.serverRefreshUsageRates, usage.refreshRates, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverRetryResourceTelemetry]: (_input) =>
          observeRpcEffect(WS_METHODS.serverRetryResourceTelemetry, resourceTelemetry.retry, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverSignalProcess]: (input) =>
          observeRpcEffect(WS_METHODS.serverSignalProcess, processDiagnostics.signal(input), {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.serverReportClientActivity]: (input, metadata) =>
          Ref.update(rpcClientIds, (clientIds) => {
            const next = new Set(clientIds);
            next.add(RpcClientId.make(metadata.client.id));
            return next;
          }).pipe(
            Effect.andThen(
              observeRpcEffect(
                WS_METHODS.serverReportClientActivity,
                backgroundPolicy.reportClientActivity(
                  currentSessionId,
                  RpcClientId.make(metadata.client.id),
                  input,
                ),
                { "rpc.aggregate": "server" },
              ),
            ),
          ),
        [WS_METHODS.serverReportHostPowerState]: (input) =>
          observeRpcEffect(
            WS_METHODS.serverReportHostPowerState,
            backgroundPolicy.reportHostPowerState(input),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.serverGetBackgroundPolicy]: (_input) =>
          observeRpcEffect(WS_METHODS.serverGetBackgroundPolicy, backgroundPolicy.snapshot, {
            "rpc.aggregate": "server",
          }),
        [WS_METHODS.cloudGetRelayClientStatus]: (_input) =>
          observeRpcEffect(WS_METHODS.cloudGetRelayClientStatus, relayClient.resolve, {
            "rpc.aggregate": "cloud",
          }),
        [WS_METHODS.cloudInstallRelayClient]: (_input) =>
          observeRpcStream(
            WS_METHODS.cloudInstallRelayClient,
            Stream.callback<RelayClientInstallProgressEvent, RelayClientInstallFailedError>(
              (queue) =>
                relayClient
                  .installWithProgress((event) => Queue.offer(queue, event).pipe(Effect.asVoid))
                  .pipe(
                    Effect.flatMap((status) =>
                      Queue.offer(queue, {
                        type: "complete",
                        status,
                      }),
                    ),
                    Effect.catchTag("RelayClientInstallError", (error) =>
                      Queue.fail(
                        queue,
                        new RelayClientInstallFailedError({
                          reason: error.reason,
                          message: error.message,
                        }),
                      ),
                    ),
                    Effect.andThen(Queue.end(queue)),
                    Effect.forkScoped,
                  ),
            ),
            { "rpc.aggregate": "cloud" },
          ),
        [WS_METHODS.pullRequestsList]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsList, pullRequests.list(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsListStats]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsListStats, pullRequests.listStats(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsRoutingIdentity]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsRoutingIdentity,
            pullRequests.routingIdentity(input),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsRouting]: (input) =>
          observeRpcEffect(WS_METHODS.pullRequestsRouting, pullRequests.routing(input), {
            "rpc.aggregate": "pull-requests",
          }),
        [WS_METHODS.pullRequestsSummary]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSummary,
            withPullRequestViewer(input, pullRequests.summary(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsStack]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsStack,
            withPullRequestViewer(input, pullRequests.stack(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsLinkedThreads]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsLinkedThreads,
            resolvePullRequestSyncKey(input).pipe(
              Effect.flatMap((key) =>
                key === null
                  ? Effect.succeed({ threads: [] })
                  : listLinkedPullRequestThreads(key).pipe(
                      Effect.provideService(SqlClient.SqlClient, sql),
                    ),
              ),
            ),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsDetail]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsDetail,
            withPullRequestViewer(input, pullRequests.detail(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsPreview]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsPreview,
            withPullRequestViewer(input, pullRequests.preview(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsActivity]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsActivity,
            withPullRequestViewer(input, pullRequests.activity(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsThreadComments]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsThreadComments,
            withPullRequestViewer(input, pullRequests.threadComments(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsDiffFileContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsDiffFileContents,
            withPullRequestViewer(input, pullRequests.diffFileContents(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsFilesViewed]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsFilesViewed,
            withPullRequestViewer(input, pullRequests.filesViewed(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetFilesViewed]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSetFilesViewed,
            withPullRequestViewer(input, pullRequests.setFilesViewed(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsRunAction]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsRunAction,
            withPullRequestViewer(input, pullRequests.runAction(input)).pipe(
              Effect.tap(() =>
                resolvePullRequestSyncKey(input).pipe(
                  Effect.flatMap((key) =>
                    key === null ? Effect.void : pullRequestSync.requestSync(key),
                  ),
                ),
              ),
            ),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsUpdate]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsUpdate,
            withPullRequestViewer(input, pullRequests.update(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsComment]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsComment,
            withPullRequestViewer(input, pullRequests.comment(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsUpdateComment]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsUpdateComment,
            withPullRequestViewer(input, pullRequests.updateComment(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsSubmitReview]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSubmitReview,
            withPullRequestViewer(input, pullRequests.submitReview(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsReplyToThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsReplyToThread,
            withPullRequestViewer(input, pullRequests.replyToThread(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetThreadResolution]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSetThreadResolution,
            withPullRequestViewer(input, pullRequests.setThreadResolution(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetReaction]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSetReaction,
            withPullRequestViewer(input, pullRequests.setReaction(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.pullRequestsInvalidate]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsInvalidate,
            pullRequests.invalidate(input, { notifyReaders: true }).pipe(
              // A reader asking for fresh host state also wants the thread badges it feeds to
              // catch up, including a merged link the sweep would otherwise never revisit.
              Effect.andThen(
                input.reference === undefined || input.filesViewedOnly === true
                  ? Effect.void
                  : resolvePullRequestSyncKey(input.reference).pipe(
                      Effect.flatMap((key) =>
                        key === null ? Effect.void : pullRequestSync.requestSync(key),
                      ),
                    ),
              ),
            ),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSubscribeRefreshes]: () =>
          observeRpcStream(
            WS_METHODS.pullRequestsSubscribeRefreshes,
            pullRequests.subscribeRefreshes,
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsReviewerCandidates]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsReviewerCandidates,
            withPullRequestViewer(input, pullRequests.reviewerCandidates(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsRequestReviewers]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsRequestReviewers,
            withPullRequestViewer(input, pullRequests.requestReviewers(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsLabelCandidates]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsLabelCandidates,
            withPullRequestViewer(input, pullRequests.labelCandidates(input)),
            { "rpc.aggregate": "pull-requests" },
          ),
        [WS_METHODS.pullRequestsSetLabels]: (input) =>
          observeRpcEffect(
            WS_METHODS.pullRequestsSetLabels,
            withPullRequestViewer(input, pullRequests.setLabels(input)),
            {
              "rpc.aggregate": "pull-requests",
            },
          ),
        [WS_METHODS.sourceControlLookupRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlLookupRepository,
            sourceControlRepositories.lookupRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.sourceControlCloneRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlCloneRepository,
            sourceControlRepositories.cloneRepository(input),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.projectCloneStart]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectCloneStart,
            projectCloneTracker.start(input, {
              createProject: (project) =>
                Effect.gen(function* () {
                  const normalizedCommand = yield* normalizeDispatchCommand({
                    type: "project.create",
                    commandId: yield* serverCommandId("project-clone-create"),
                    projectId: project.projectId,
                    title: project.title,
                    workspaceRoot: project.workspaceRoot,
                    createWorkspaceRootIfMissing: true,
                    createdAt: project.createdAt,
                  });
                  yield* dispatchNormalizedCommand(normalizedCommand);
                  yield* recordClientCommandAnalytics(normalizedCommand);
                }).pipe(Effect.provideContext(normalizerContext)),
              onCloned: (project) =>
                // The project was created against an empty directory, so its
                // cached identity is "not a repository" until this refresh.
                // Re-emitting the project shell carries the new identity to
                // every client without a round trip.
                repositoryIdentityResolver.resolve(project.workspaceRoot, { refresh: true }).pipe(
                  Effect.andThen(
                    Effect.gen(function* () {
                      const command = yield* normalizeDispatchCommand({
                        type: "project.meta.update",
                        commandId: yield* serverCommandId("project-clone-done"),
                        projectId: project.projectId,
                      });
                      yield* dispatchNormalizedCommand(command);
                    }),
                  ),
                  Effect.andThen(refreshGitStatus(project.workspaceRoot)),
                  Effect.ignoreCause({ log: true }),
                  Effect.provideContext(normalizerContext),
                ),
            }),
            { "rpc.aggregate": "source-control" },
          ),
        [WS_METHODS.projectCloneCancel]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectCloneCancel,
            projectCloneTracker
              .cancel(input.projectId)
              .pipe(Effect.map((applied) => ({ applied }))),
            { "rpc.aggregate": "source-control" },
          ),
        [WS_METHODS.projectCloneRetry]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectCloneRetry,
            projectCloneTracker.retry(input.projectId).pipe(Effect.map((applied) => ({ applied }))),
            { "rpc.aggregate": "source-control" },
          ),
        [WS_METHODS.subscribeProjectClones]: () =>
          observeRpcStream(WS_METHODS.subscribeProjectClones, projectCloneTracker.stream, {
            "rpc.aggregate": "source-control",
          }),
        [WS_METHODS.sourceControlPublishRepository]: (input) =>
          observeRpcEffect(
            WS_METHODS.sourceControlPublishRepository,
            sourceControlRepositories
              .publishRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            {
              "rpc.aggregate": "source-control",
            },
          ),
        [WS_METHODS.projectsSearchEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchEntries,
            workspaceEntries.search(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchEntriesError({
                    cwd: input.cwd,
                    queryLength: input.query.length,
                    limit: input.limit,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsSearchContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsSearchContents,
            workspaceEntries.searchContents(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectSearchContentsError({
                    cwd: input.cwd,
                    queryLength: input.query.length,
                    limit: input.limit,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsListEntries]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsListEntries,
            workspaceEntries.list(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectListEntriesError({
                    ...input,
                    ...projectEntriesFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadFile,
            workspaceFileSystem.readFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectReadFileError({
                    ...input,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsReadAbsoluteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsReadAbsoluteFile,
            workspaceFileSystem.readAbsoluteFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectReadAbsoluteFileError({
                    absolutePath: input.absolutePath,
                    failure: cause.failure,
                    ...(cause.resolvedPath !== undefined
                      ? { resolvedPath: cause.resolvedPath }
                      : {}),
                    ...(cause.operation !== undefined ? { operation: cause.operation } : {}),
                    ...(cause.operationPath !== undefined
                      ? { operationPath: cause.operationPath }
                      : {}),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsListAbsoluteDirectory]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsListAbsoluteDirectory,
            workspaceFileSystem.listAbsoluteDirectory(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectListAbsoluteDirectoryError({
                    absolutePath: input.absolutePath,
                    failure: cause.failure,
                    ...(cause.resolvedPath !== undefined
                      ? { resolvedPath: cause.resolvedPath }
                      : {}),
                    ...(cause.operation !== undefined ? { operation: cause.operation } : {}),
                    ...(cause.operationPath !== undefined
                      ? { operationPath: cause.operationPath }
                      : {}),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsStatPaths]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsStatPaths,
            workspaceFileSystem
              .statPaths(input)
              .pipe(Effect.mapError((cause) => new ProjectStatPathsError({ cause }))),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.projectsWriteFile]: (input) =>
          observeRpcEffect(
            WS_METHODS.projectsWriteFile,
            workspaceFileSystem.writeFile(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ProjectWriteFileError({
                    cwd: input.cwd,
                    relativePath: input.relativePath,
                    ...projectFileFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.shellOpenInEditor]: (input) =>
          observeRpcEffect(WS_METHODS.shellOpenInEditor, externalLauncher.launchEditor(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.filesystemBrowse]: (input) =>
          observeRpcEffect(
            WS_METHODS.filesystemBrowse,
            workspaceEntries.browse(input).pipe(
              Effect.mapError(
                (cause) =>
                  new FilesystemBrowseError({
                    ...input,
                    ...filesystemBrowseFailureContext(cause),
                    cause,
                  }),
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.attachmentsCreateUploadUrl]: (input) =>
          observeRpcEffect(WS_METHODS.attachmentsCreateUploadUrl, issueAttachmentUploadUrl(input), {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.attachmentsDelete]: (input) =>
          observeRpcEffect(
            WS_METHODS.attachmentsDelete,
            deletePendingAttachment(input.attachmentId),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.agentSessionsScan]: () =>
          observeRpcEffect(WS_METHODS.agentSessionsScan, agentSessionScanner.scan, {
            "rpc.aggregate": "workspace",
          }),
        [WS_METHODS.agentSessionsImport]: (input) =>
          observeRpcEffect(
            WS_METHODS.agentSessionsImport,
            importRecentAgentThreads(input).pipe(
              Effect.provideService(AgentSessionScanner.AgentSessionScanner, agentSessionScanner),
              Effect.provideService(
                OrchestrationEngine.OrchestrationEngineService,
                orchestrationEngine,
              ),
              Effect.provideService(
                ProjectionSnapshotQuery.ProjectionSnapshotQuery,
                projectionSnapshotQuery,
              ),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(
                ProviderSessionDirectory.ProviderSessionDirectory,
                providerSessionDirectory,
              ),
            ),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.assetsCreateUrl]: (input) =>
          observeRpcEffect(
            WS_METHODS.assetsCreateUrl,
            Effect.gen(function* () {
              const path = yield* Path.Path;
              // An absolute media path can be linked from a thread on another environment.
              if (
                input.resource._tag === "attachment" ||
                input.resource._tag === "native-app-icon" ||
                // GitHub media names the repository it authenticates through itself.
                input.resource._tag === "github-media" ||
                (input.resource._tag === "media-file" && path.isAbsolute(input.resource.path))
              ) {
                return yield* issueAssetUrl({ resource: input.resource });
              }
              if (input.resource._tag === "draft-workspace-file") {
                // A project draft names its workspace directly; there is no
                // thread to resolve one from.
                return yield* issueAssetUrl({
                  resource: input.resource,
                  workspaceRoot: input.resource.cwd,
                });
              }
              if (input.resource._tag === "project-favicon") {
                const project = yield* projectionSnapshotQuery
                  .getActiveProjectByWorkspaceRoot(input.resource.cwd)
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new AssetWorkspaceContextResolutionError({
                          resource: input.resource,
                          cause,
                        }),
                    ),
                  );
                if (Option.isNone(project)) {
                  return yield* new AssetWorkspaceContextNotFoundError({
                    resource: input.resource,
                  });
                }
                return yield* issueAssetUrl({
                  resource: input.resource,
                  ...(project.value.faviconPath
                    ? { projectFaviconPath: project.value.faviconPath }
                    : {}),
                });
              }
              const thread = yield* projectionSnapshotQuery
                .getThreadShellById(input.resource.threadId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(thread)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              const project = yield* projectionSnapshotQuery
                .getProjectShellById(thread.value.projectId)
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new AssetWorkspaceContextResolutionError({
                        resource: input.resource,
                        cause,
                      }),
                  ),
                );
              if (Option.isNone(project)) {
                return yield* new AssetWorkspaceContextNotFoundError({
                  resource: input.resource,
                });
              }
              return yield* issueAssetUrl({
                resource: input.resource,
                workspaceRoot: thread.value.worktreePath ?? project.value.workspaceRoot,
              });
            }),
            { "rpc.aggregate": "workspace" },
          ),
        [WS_METHODS.subscribeVcsStatus]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeVcsStatus,
            vcsStatusBroadcaster.streamStatus(input, {
              automaticRemoteRefreshInterval: automaticGitFetchInterval,
            }),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.subscribeWorktreeSetup]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeWorktreeSetup,
            worktreeSetupTracker.stream(input.threadId),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.worktreeSetupCancel]: (input) =>
          observeRpcEffect(
            WS_METHODS.worktreeSetupCancel,
            worktreeSetupTracker
              .cancel(input.threadId)
              .pipe(Effect.map((cancelled) => ({ cancelled }))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsRefreshStatus]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRefreshStatus,
            vcsStatusBroadcaster.refreshStatus(input.cwd),
            {
              "rpc.aggregate": "vcs",
            },
          ),
        [WS_METHODS.vcsPull]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsPull,
            gitWorkflow.pullCurrentBranch(input.cwd).pipe(
              Effect.matchCauseEffect({
                onFailure: (cause) => Effect.failCause(cause),
                onSuccess: (result) =>
                  refreshGitStatus(input.cwd).pipe(Effect.ignore({ log: true }), Effect.as(result)),
              }),
            ),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.gitRunStackedAction]: (input) =>
          observeRpcStream(
            WS_METHODS.gitRunStackedAction,
            Stream.callback<GitActionProgressEvent, GitManagerServiceError>((queue) =>
              gitWorkflow
                .runStackedAction(input, {
                  actionId: input.actionId,
                  progressReporter: {
                    publish: (event) => Queue.offer(queue, event).pipe(Effect.asVoid),
                  },
                })
                .pipe(
                  Effect.matchCauseEffect({
                    onFailure: (cause) => Queue.failCause(queue, cause),
                    onSuccess: (result) =>
                      (input.threadId === undefined
                        ? Effect.void
                        : linkCreatedPullRequest({
                            threadId: input.threadId,
                            result,
                            commandId: serverCommandId("pr-created-link"),
                          }).pipe(
                            Effect.provideService(
                              OrchestrationEngine.OrchestrationEngineService,
                              orchestrationEngine,
                            ),
                            Effect.provideService(
                              ProjectionSnapshotQuery.ProjectionSnapshotQuery,
                              projectionSnapshotQuery,
                            ),
                          )
                      ).pipe(
                        Effect.andThen(refreshGitStatus(input.cwd)),
                        Effect.andThen(Queue.end(queue).pipe(Effect.asVoid)),
                      ),
                  }),
                ),
            ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.gitResolvePullRequest]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitResolvePullRequest,
            gitWorkflow.resolvePullRequest(input),
            {
              "rpc.aggregate": "git",
            },
          ),
        [WS_METHODS.gitPreparePullRequestThread]: (input) =>
          observeRpcEffect(
            WS_METHODS.gitPreparePullRequestThread,
            gitWorkflow
              .preparePullRequestThread(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "git" },
          ),
        [WS_METHODS.vcsListRefs]: (input) =>
          observeRpcEffect(WS_METHODS.vcsListRefs, gitWorkflow.listRefs(input), {
            "rpc.aggregate": "vcs",
          }),
        [WS_METHODS.vcsCreateWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateWorktree,
            gitWorkflow.createWorktree(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        // Gated on the workspace lease like every other remover (post-completion
        // engagement plan §7). This is the client-driven path — thread delete
        // calls it with `force: true` — so it can target a server-managed
        // worktree that a live provider process is sitting in. An occupied
        // worktree is left alone rather than deleted under the process; the
        // deferred-removal sweep collects it once the process exits.
        [WS_METHODS.vcsRemoveWorktree]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsRemoveWorktree,
            workspaceLease
              .withExclusive(
                input.path,
                gitWorkflow
                  .removeWorktree(input)
                  .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
              )
              .pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () =>
                      Effect.logInfo("vcsRemoveWorktree skipped: workspace is occupied", {
                        path: input.path,
                      }),
                    onSome: () => Effect.void,
                  }),
                ),
              ),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsCreateRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsCreateRef,
            gitWorkflow.createRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsSwitchRef]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsSwitchRef,
            gitWorkflow.switchRef(input).pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.vcsInit]: (input) =>
          observeRpcEffect(
            WS_METHODS.vcsInit,
            vcsProvisioning
              .initRepository(input)
              .pipe(Effect.tap(() => refreshGitStatus(input.cwd))),
            { "rpc.aggregate": "vcs" },
          ),
        [WS_METHODS.reviewGetDiffPreview]: (input) =>
          observeRpcEffect(WS_METHODS.reviewGetDiffPreview, review.getDiffPreview(input), {
            "rpc.aggregate": "review",
          }),
        [WS_METHODS.reviewGetDiffFileContents]: (input) =>
          observeRpcEffect(
            WS_METHODS.reviewGetDiffFileContents,
            review.getDiffFileContents(input),
            { "rpc.aggregate": "review" },
          ),
        [WS_METHODS.terminalOpen]: (input) =>
          observeRpcEffect(WS_METHODS.terminalOpen, terminalManager.open(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalAttach]: (input) =>
          observeRpcStream(
            WS_METHODS.terminalAttach,
            Stream.callback<TerminalAttachStreamEvent, TerminalError>((queue) =>
              Effect.acquireRelease(
                terminalManager.attachStream(input, (event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.terminalWrite]: (input) =>
          observeRpcEffect(WS_METHODS.terminalWrite, terminalManager.write(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalResize]: (input) =>
          observeRpcEffect(WS_METHODS.terminalResize, terminalManager.resize(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClear]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClear, terminalManager.clear(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalRestart]: (input) =>
          observeRpcEffect(WS_METHODS.terminalRestart, terminalManager.restart(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.terminalClose]: (input) =>
          observeRpcEffect(WS_METHODS.terminalClose, terminalManager.close(input), {
            "rpc.aggregate": "terminal",
          }),
        [WS_METHODS.subscribeTerminalEvents]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalEvents,
            Stream.callback<TerminalEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribe((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.subscribeTerminalMetadata]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeTerminalMetadata,
            Stream.callback<TerminalMetadataStreamEvent>((queue) =>
              Effect.acquireRelease(
                terminalManager.subscribeMetadata((event) => Queue.offer(queue, event)),
                (unsubscribe) => Effect.sync(unsubscribe),
              ),
            ),
            { "rpc.aggregate": "terminal" },
          ),
        [WS_METHODS.previewOpen]: (input) =>
          observeRpcEffect(WS_METHODS.previewOpen, previewManager.open(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewNavigate]: (input) =>
          observeRpcEffect(WS_METHODS.previewNavigate, previewManager.navigate(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewResize]: (input) =>
          observeRpcEffect(WS_METHODS.previewResize, previewManager.resize(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewRefresh]: (input) =>
          observeRpcEffect(WS_METHODS.previewRefresh, previewManager.refresh(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewClose]: (input) =>
          observeRpcEffect(WS_METHODS.previewClose, previewManager.close(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewList]: (input) =>
          observeRpcEffect(WS_METHODS.previewList, previewManager.list(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewReportStatus]: (input) =>
          observeRpcEffect(WS_METHODS.previewReportStatus, previewManager.reportStatus(input), {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.previewAutomationConnect]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.previewAutomationConnect,
            previewAutomationBroker.connect(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationRespond]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationRespond,
            previewAutomationBroker.respond(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.previewAutomationFocusHost]: (input) =>
          observeRpcEffect(
            WS_METHODS.previewAutomationFocusHost,
            previewAutomationBroker.focusHost(input),
            { "rpc.aggregate": "preview-automation" },
          ),
        [WS_METHODS.subscribePreviewEvents]: (_input) =>
          observeRpcStream(WS_METHODS.subscribePreviewEvents, previewManager.events, {
            "rpc.aggregate": "preview",
          }),
        [WS_METHODS.deviceConfigure]: (input) =>
          observeRpcEffect(WS_METHODS.deviceConfigure, deviceService.configure(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceTestHost]: (input) =>
          observeRpcEffect(WS_METHODS.deviceTestHost, deviceService.testHost(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceList]: (_input) =>
          observeRpcEffect(WS_METHODS.deviceList, deviceService.list, {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceOpen]: (input) =>
          observeRpcEffect(WS_METHODS.deviceOpen, deviceService.open(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceClose]: (input) =>
          observeRpcEffect(WS_METHODS.deviceClose, deviceService.close(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceShutdown]: (input) =>
          observeRpcEffect(WS_METHODS.deviceShutdown, deviceService.shutdown(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceDetail]: (input) =>
          observeRpcEffect(WS_METHODS.deviceDetail, deviceService.detail(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.deviceAction]: (input) =>
          observeRpcEffect(WS_METHODS.deviceAction, deviceService.action(input), {
            "rpc.aggregate": "device",
          }),
        [WS_METHODS.subscribeDeviceState]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeDeviceState,
            DeviceService.stateStream(deviceService),
            { "rpc.aggregate": "device" },
          ),
        [WS_METHODS.subscribeDiscoveredLocalServers]: (input) =>
          observeRpcStream(
            WS_METHODS.subscribeDiscoveredLocalServers,
            Stream.callback<DiscoveredLocalServerList>((queue) =>
              Effect.gen(function* () {
                const configuredUrls = input.configuredUrls ?? [];
                yield* portDiscovery.retain;
                const initial = yield* portDiscovery.scan(configuredUrls);
                const initialScannedAt = DateTime.formatIso(yield* DateTime.now);
                yield* Queue.offer(queue, {
                  servers: initial,
                  scannedAt: initialScannedAt,
                  configuredUrlProbing: true,
                });
                yield* portDiscovery.subscribe(
                  { configuredUrls, initialSnapshot: initial },
                  (servers) =>
                    Effect.gen(function* () {
                      const scannedAt = DateTime.formatIso(yield* DateTime.now);
                      yield* Queue.offer(queue, {
                        servers,
                        scannedAt,
                        configuredUrlProbing: true,
                      });
                    }),
                );
              }),
            ),
            { "rpc.aggregate": "preview" },
          ),
        [WS_METHODS.subscribeServerConfig]: (input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerConfig,
            Effect.gen(function* () {
              const usageLimitsCommand = input.usageLimitsCommand === true;
              const config = yield* loadServerConfig({ usageLimitsCommand });
              const keybindingsUpdates = keybindings.streamChanges.pipe(
                Stream.map((event) => ({
                  version: 1 as const,
                  type: "keybindingsUpdated" as const,
                  payload: {
                    keybindings: event.keybindings,
                    issues: event.issues,
                  },
                })),
              );
              // loom: fold the provider snapshots with live exhaustion marks so an
              // account-wide limit (or a manual pause) surfaces on the provider
              // card (§8.2). Upstream's usage-limit sources are a third input
              // folded the same way. Seeded from the current values so a change on
              // any one input re-derives from the last known value of the others.
              type ProviderStatusInput = {
                readonly providers?: ReadonlyArray<ServerProvider>;
                readonly marks?: ReadonlyArray<ExhaustionMark>;
                readonly sources?: ReadonlyArray<UsageLimitSourceSnapshot>;
              };
              const providerStatuses = Stream.merge(
                Stream.merge(
                  providerRegistry.streamChanges.pipe(
                    Stream.map((providers): ProviderStatusInput => ({ providers })),
                  ),
                  providerHealthRegistry.streamChanges.pipe(
                    Stream.map((marks): ProviderStatusInput => ({ marks })),
                  ),
                ),
                usageLimitSources.streamChanges.pipe(
                  // Quota updates already have their own stream. Republish the model
                  // catalog only when the set of providers offered the command changes.
                  Stream.changesWith(
                    usageLimitsCommand ? sameUsageLimitCommandCoverage : () => true,
                  ),
                  Stream.map((sources): ProviderStatusInput => ({ sources })),
                ),
              ).pipe(
                Stream.scan(
                  {
                    providers: yield* providerRegistry.getProviders,
                    marks: yield* providerHealthRegistry.snapshot,
                    sources: yield* usageLimitSources.current,
                  },
                  (state, event) => ({
                    providers: event.providers ?? state.providers,
                    marks: event.marks ?? state.marks,
                    sources: event.sources ?? state.sources,
                  }),
                ),
                Stream.drop(1),
                Stream.mapEffect((state) =>
                  Effect.map(Clock.currentTimeMillis, (now) =>
                    overlayProviderExhaustion(
                      usageLimitsCommand
                        ? withUsageLimitsCommands(state.providers, state.sources)
                        : state.providers,
                      state.marks,
                      now,
                    ),
                  ),
                ),
                // Every input replays its current value, so the first update normally
                // repeats the snapshot the client already holds. Compare against that
                // snapshot rather than dropping blindly: a refresh that landed between
                // the snapshot and the subscription still goes out.
                (updates) => Stream.concat(Stream.make(config.providers), updates),
                Stream.changesWith(
                  (previous, next) => JSON.stringify(previous) === JSON.stringify(next),
                ),
                Stream.drop(1),
                Stream.map((providers) => ({
                  version: 1 as const,
                  type: "providerStatuses" as const,
                  payload: { providers },
                })),
                Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
              );
              // The only source of published themes: the stream emits the
              // current set before any change, so the snapshot carrying it too
              // would just send every client the same array twice per connect.
              // Gated on the subscriber's capability flag because an
              // already-shipped client decodes this stream against the old
              // event union and its whole config subscription dies on an
              // unknown member.
              const environmentThemeUpdates =
                input.environmentThemes === true
                  ? environmentTheme.streamChanges.pipe(
                      Stream.map((themes) => ({
                        version: 1 as const,
                        type: "environmentThemesUpdated" as const,
                        payload: { themes },
                      })),
                    )
                  : Stream.empty;
              // Same gate as themes: an older client dies on an unknown event.
              const usageLimitSourceUpdates =
                input.usageLimitSources === true
                  ? usageLimitSources.streamChanges.pipe(
                      Stream.map((sources) => ({
                        version: 1 as const,
                        type: "usageLimitSourcesUpdated" as const,
                        payload: { sources },
                      })),
                    )
                  : Stream.empty;
              const settingsUpdates = serverSettings.streamChanges.pipe(
                Stream.map((settings) => ServerSettings.redactServerSettingsForClient(settings)),
                Stream.map((settings) => ({
                  version: 1 as const,
                  type: "settingsUpdated" as const,
                  payload: { settings },
                })),
              );
              // loom: account-usage change stream added to the config subscription.
              const accountUsageUpdates = accountUsageRegistry.streamChanges.pipe(
                Stream.map((usage) => ({
                  version: 1 as const,
                  type: "accountUsage" as const,
                  payload: { usage },
                })),
              );

              const liveUpdates = Stream.merge(
                keybindingsUpdates,
                Stream.merge(
                  providerStatuses,
                  Stream.merge(
                    settingsUpdates,
                    Stream.merge(
                      accountUsageUpdates,
                      Stream.merge(environmentThemeUpdates, usageLimitSourceUpdates),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.concat(
                  Stream.make({ version: 1 as const, type: "snapshot" as const, config }),
                  // loom: initial usage so a fresh subscriber sees the latest known
                  // limits without waiting for the next provider event.
                  Stream.make({
                    version: 1 as const,
                    type: "accountUsage" as const,
                    payload: { usage: yield* accountUsageRegistry.snapshot },
                  }),
                ),
                liveUpdates,
              );
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeServerLifecycle]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeServerLifecycle,
            Effect.gen(function* () {
              const liveBuffer = yield* Queue.unbounded<ServerLifecycleStreamEvent>();
              yield* Effect.forkScoped(
                lifecycleEvents.stream.pipe(
                  Stream.runForEach((event) => Queue.offer(liveBuffer, event)),
                ),
                { startImmediately: true },
              );
              const snapshot = yield* lifecycleEvents.snapshot;
              const snapshotEvents = Array.from(snapshot.events).toSorted(
                (left, right) => left.sequence - right.sequence,
              );
              const liveEvents = Stream.fromQueue(liveBuffer).pipe(
                Stream.filter((event) => event.sequence > snapshot.sequence),
              );
              return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
            }),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeAuthAccess]: (_input) =>
          observeRpcStreamEffect(
            WS_METHODS.subscribeAuthAccess,
            Effect.gen(function* () {
              const initialSnapshot = yield* loadAuthAccessSnapshot();
              const revisionRef = yield* Ref.make(1);
              const accessChanges: Stream.Stream<
                PairingGrantStore.BootstrapCredentialChange | SessionStore.SessionCredentialChange
              > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

              const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
                Stream.mapEffect((change) =>
                  Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                    Effect.map((revision) =>
                      toAuthAccessStreamEvent(change, revision, currentSessionId),
                    ),
                  ),
                ),
              );

              return Stream.concat(
                Stream.make({
                  version: 1 as const,
                  revision: 1,
                  type: "snapshot" as const,
                  payload: initialSnapshot,
                }),
                liveEvents,
              );
            }),
            { "rpc.aggregate": "auth" },
          ),
        [WS_METHODS.subscribeBackgroundPolicy]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeBackgroundPolicy,
            Stream.unwrap(
              Effect.map(backgroundPolicy.subscribe, ({ latest, changes }) =>
                Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
        [WS_METHODS.subscribeResourceTelemetry]: (_input) =>
          observeRpcStream(
            WS_METHODS.subscribeResourceTelemetry,
            Stream.unwrap(
              Effect.map(resourceTelemetry.subscribe, ({ latest, changes }) =>
                Stream.concat(Stream.make(latest), changes),
              ),
            ),
            { "rpc.aggregate": "server" },
          ),
      });
    }),
  );

export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const previewAutomationBroker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const baseServerSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
    const config = yield* ServerConfig.ServerConfig;
    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
    const serverSelfUpdate = yield* ServerSelfUpdate.withRunningThreadContinuation({
      mode: config.mode,
      selfUpdate: baseServerSelfUpdate,
      prepare: startup.markRunningProviderSessionsForContinuation.pipe(
        Effect.mapError(
          (cause) =>
            new ServerSelfUpdateError({
              reason: "Could not prepare running threads to continue after the update.",
              cause,
            }),
        ),
      ),
      clear: (threadIds) =>
        startup.clearProviderSessionContinuationMarkers(threadIds).pipe(
          Effect.mapError(
            (cause) =>
              new ServerSelfUpdateError({
                reason: "Could not clear thread continuation markers after the update failed.",
                cause,
              }),
          ),
        ),
    });
    const pullRequests = yield* PullRequestService.PullRequestService;
    const sql = yield* SqlClient.SqlClient;
    return HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
        const sessions = yield* SessionStore.SessionStore;
        const analytics = yield* AnalyticsService.AnalyticsService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
          Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
            failEnvironmentAuthInvalid(
              EnvironmentAuth.serverAuthCredentialReason(error),
              EnvironmentAuth.serverAuthDpopFailureReason(error),
            ),
          ),
          Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
            failEnvironmentInternal("internal_error", error),
          ),
        );
        const clientOrigin = readClientConnectionOrigin(request);
        const clientAnalyticsProps = readClientAnalyticsProps(request);
        yield* sessions.recordClientConnection(session.sessionId, clientOrigin);
        yield* analytics.record("client.connected", clientAnalyticsProps);
        const rpcWebSocketHttpEffect = yield* Effect.gen(function* () {
          const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
          yield* RpcServer.make(WsRpcGroup, { disableTracing: true }).pipe(
            Effect.provideService(RpcServer.Protocol, withTerminalOutputWindow(protocol)),
            Effect.forkScoped,
          );
          // @effect-diagnostics-next-line returnEffectInGen:off
          return httpEffect;
        }).pipe(
          Effect.provide(
            makeWsRpcLayer(
              session,
              clientOrigin,
              clientAnalyticsProps,
              previewAutomationBroker,
            ).pipe(
              Layer.provideMerge(RpcSerialization.layerJson),
              Layer.provide(Layer.succeed(SqlClient.SqlClient, sql)),
              Layer.provide(AgentSessionScanner.layer),
              Layer.provide(ProviderMaintenanceRunner.layer),
              Layer.provide(Layer.succeed(ServerSelfUpdate.ServerSelfUpdate, serverSelfUpdate)),
              // One server-lifetime service means clients share the same PR caches, and a WS
              // mutation invalidates the HTTP diff cache that every client reads from.
              Layer.provide(Layer.succeed(PullRequestService.PullRequestService, pullRequests)),
              Layer.provide(
                SourceControlDiscovery.layer.pipe(
                  Layer.provide(
                    SourceControlProviderRegistry.layer.pipe(
                      Layer.provide(
                        Layer.mergeAll(
                          AzureDevOpsCli.layer,
                          BitbucketApi.layer,
                          GitHubCli.layer,
                          GitLabCli.layer,
                          ForgejoCli.layer,
                        ),
                      ),
                      Layer.provideMerge(GitVcsDriver.layer),
                      Layer.provide(
                        VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer)),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
        return yield* Effect.acquireUseRelease(
          sessions.markConnected(session.sessionId),
          () => rpcWebSocketHttpEffect,
          () => sessions.markDisconnected(session.sessionId),
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
          EnvironmentInternalError: HttpServerRespondable.toResponse,
        }),
      ),
    );
  }),
);
