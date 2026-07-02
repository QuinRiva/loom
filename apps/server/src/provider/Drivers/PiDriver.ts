// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics runEffectInsideEffect:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";

import {
  EventId,
  PI_DEFAULT_MODEL,
  PI_THINKING_LEVEL_OPTIONS,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
  type ChatAttachment,
  type ModelCapabilities,
  type PiThinkingLevel,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ServerProvider,
  type ServerProviderModel,
  type ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { withLocalNodeModulesBin } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  goalTaskAddUrlFromMcpEndpoint,
  goalTaskListUrlFromMcpEndpoint,
  goalTaskDeleteUrlFromMcpEndpoint,
  goalTaskUpdateUrlFromMcpEndpoint,
  goalUpdateUrlFromMcpEndpoint,
} from "../../mcp/GoalTaskHttp.ts";
import { goalHandoffUrlFromMcpEndpoint } from "../../mcp/GoalHandoffHttp.ts";
import {
  setThreadTitleUrlFromMcpEndpoint,
  workstreamAttentionUrlFromMcpEndpoint,
  workstreamConsultThreadUrlFromMcpEndpoint,
  workstreamDependenciesUrlFromMcpEndpoint,
  workstreamLaneUrlFromMcpEndpoint,
  workstreamListUrlFromMcpEndpoint,
  workstreamReleaseUrlFromMcpEndpoint,
  workstreamReportUrlFromMcpEndpoint,
  workstreamSpawnUrlFromMcpEndpoint,
  workstreamStopUrlFromMcpEndpoint,
} from "../../mcp/WorkstreamSpawnHttp.ts";
import type {
  BranchNameGenerationInput,
  ThreadTitleGenerationInput,
  TextGenerationShape,
} from "../../textGeneration/TextGeneration.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  ProviderDriverError,
} from "../Errors.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  createPiRpcProcess,
  type PiRpcProcess,
  type PiRpcStdoutEvent,
  type PiRpcStdoutMessage,
} from "../Layers/Pi/RpcProcess.ts";
import { generatePiStructured } from "../Layers/Pi/OneShotCompletion.ts";
import { ensurePiWorkstreamSpawnExtension } from "./Pi/WorkstreamSpawnExtension.ts";
import { ensurePiGoalTaskExtension } from "./Pi/GoalTaskExtension.ts";
import { piSessionIdForThread } from "../Layers/Pi/Cli.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");
const decodePiSettings = Schema.decodeSync(PiSettings);
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(2);
const PI_MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "@earendil-works/pi-coding-agent",
});
const PI_WORK_MODEL_SYSTEM_PROMPT =
  "You operate inside T3 Code's work model: Goals → Tasks → Workstream. This is how every thread here is organised, whatever its role.\n\nA GOAL is a single durable objective that outlives any one session and spans many — the north star for all work under it. Orient to it; if work drifts from the goal, refocus or update it. A goal is decomposed into a TASK TREE: the living, shared record of what is done and what remains — for the agents working it and for the human who glances at it to re-orient. It is kept current as work progresses.\n\nWork happens in a WORKSTREAM: a tree of durable threads. You are one thread in it, and your role overlay says how you act within it. A ROOT thread ORCHESTRATES — it plans, delegates, and reviews rather than doing the work by hand. A CHILD thread EXECUTES a single self-contained brief and hands a result back. A child is a real, persistent thread a human can open and talk to, not a throwaway: spawning one is deliberate, and a child starts fresh — it inherits none of the parent's conversation, only the brief it is given. Work flows down as briefs and back up as reports. The workstream is a DAG of threads: dependencies are its edges, so dependent work waits while independent branches run in parallel — and the graph is not fixed; it is expected to be amended and replanned as understanding improves.\n\nGetting information from another thread, cheapest first: a thread's REPORT is its curated hand-back — read that first. The workstream GRAPH lets you see every thread and find any of them without searching (`workstream_list`). To resolve an ambiguity, CONSULT the thread that holds the context. The full thread history can be accessed via the Pi session jsonl file if necessary.\n\nA few principles keep this coherent:\n- Your assignment is your task. For a child that is its spawn brief; at the root it is the user's direction. An inherited goal is background - align to it, but where it and your assignment differ, follow the assignment.\n- Work at your level. If you orchestrate, delegate substantial work to children rather than absorbing it inline. If you execute a brief, do the work directly.\n- Status describes the plan; runtime is the truth. A thread's status is where it sits in the workflow; whether its agent is actually working is a separate, system-tracked fact. Lean on the system's signals for a child's state rather than inferring from a single quiet look — and if a signal looks wrong for what you can plainly see, verify rather than act blindly.\n- System notices are not the human. Automated workstream notices (a child finished, needs attention, recovered) are control-plane signals for you to act on, not messages from the user.\n- Setup may still be running. Worktree environment setup can run in the background after you start, so before any command that needs the project environment (installs, builds, tests, typecheck, dev servers) check the setup breadcrumb — `cat \"$(git rev-parse --git-dir)/t3code-setup-state.json\"`: `ready` proceed; `pending` do reading/editing/planning first and re-check (poll, don't run installs yourself); `failed` inspect its `detail` and the setup terminal output, then fix or report the setup failure rather than blindly rerunning installs; file absent means no setup script was configured — assume the repo is in its normal provided state.";

const PI_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "thinkingLevel",
      label: "Thinking",
      type: "select",
      currentValue: "medium",
      options: PI_THINKING_LEVEL_OPTIONS.map((level) =>
        level === "medium"
          ? { id: level, label: "Medium", isDefault: true }
          : {
              id: level,
              label: level === "xhigh" ? "Extra High" : level[0]!.toUpperCase() + level.slice(1),
            },
      ),
    },
  ],
});

export type PiDriverEnv = ServerConfig;

interface ActivePiSession {
  session: ProviderSession;
  process: PiRpcProcess;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  unsubscribe: () => void;
  activeTurnId: TurnId | undefined;
  // Turn id `turn.started` was last emitted for. pi re-emits `agent_start` per
  // auto-retry attempt and per T3-level retry re-prompt within the SAME T3
  // turn; a duplicate `turn.started` would re-run downstream turn-start logic.
  turnStartedFor: TurnId | undefined;
  // T3-level slow-tier retry state for the open turn (see T3_RETRY_DELAYS_MS).
  // `originalModel` is set once the backend fallback engages so the model can
  // be restored when the turn settles; `timer` is the pending re-dispatch.
  retry:
    | {
        attempt: number;
        timer: ReturnType<typeof setTimeout> | undefined;
        originalModel: string | undefined;
      }
    | undefined;
  currentAssistantMessageId: string | undefined;
  // pi delivers tool input only on `tool_execution_start`/`update.args` and the
  // bare result on `tool_execution_end` — so we stash the args by toolCallId on
  // start/update and merge them back into the `item.completed` payload on end.
  // Without this the loop signature (and timeline) sees only result-less generic
  // tokens and collapses every same-type call to one (false "stuck loop").
  toolArgs: Map<string, Record<string, unknown>>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function detailFromCause(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

function titleFromText(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 80) : "Untitled session";
}

function branchFromText(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "pi-session";
}

function appendSystemPrompts(...prompts: ReadonlyArray<string | undefined>): string | undefined {
  const combined = prompts.filter((prompt) => prompt && prompt.trim().length > 0).join("\n\n");
  return combined.length > 0 ? combined : undefined;
}

function withInstanceIdentity(input: {
  readonly instanceId: ProviderInstance["instanceId"];
  readonly displayName: string | undefined;
  readonly accentColor: string | undefined;
  readonly continuationGroupKey: string;
}) {
  return (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });
}

/**
 * Curated "top / recommended" shortlist surfaced first in the model picker —
 * the latest model per provider. The default (`PI_DEFAULT_MODEL`, Opus 4.8 on
 * Vertex) leads. GPT-5.5 is deliberately the `openai-codex` provider id, not
 * the plain `openai` one. The remaining catalogue (fetched live via
 * `get_available_models`, see {@link enrichPiSnapshot}) follows in pi's own order.
 */
const CURATED_PI_MODELS: ReadonlyArray<{ readonly slug: string; readonly name: string }> = [
  { slug: PI_DEFAULT_MODEL, name: "Claude Opus 4.8 (Vertex)" },
  { slug: "openai-codex/gpt-5.5", name: "GPT-5.5" },
  { slug: "google-vertex/gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview (Vertex)" },
];
const curatedRank = (slug: string): number => {
  const index = CURATED_PI_MODELS.findIndex((model) => model.slug === slug);
  return index === -1 ? CURATED_PI_MODELS.length : index;
};

interface PiAvailableModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly contextWindow: number;
}

function piCustomModels(settings: PiSettings): ReadonlyArray<ServerProviderModel> {
  return settings.customModels.map((slug) => ({
    slug,
    name: slug,
    isCustom: true,
    capabilities: PI_CAPABILITIES,
  }));
}

/** Synchronous snapshot shown before the live catalogue arrives. */
function piModels(settings: PiSettings): ReadonlyArray<ServerProviderModel> {
  return [
    ...CURATED_PI_MODELS.map((model) => ({
      slug: model.slug,
      name: model.name,
      isCustom: false,
      capabilities: PI_CAPABILITIES,
    })),
    ...piCustomModels(settings),
  ];
}

/** Full pi catalogue, curated shortlist first, then pi's own order, then custom. */
function piCatalogModels(
  available: ReadonlyArray<PiAvailableModel>,
  settings: PiSettings,
): ReadonlyArray<ServerProviderModel> {
  const builtIn = available
    .map((model) => ({
      slug: `${model.provider}/${model.id}`,
      name: model.name,
      isCustom: false as const,
      capabilities: PI_CAPABILITIES,
    }))
    .sort((a, b) => curatedRank(a.slug) - curatedRank(b.slug));
  return [...builtIn, ...piCustomModels(settings)];
}

/**
 * Replace the snapshot's placeholder model list with pi's live catalogue by
 * running a throwaway `pi --mode rpc` process and asking `get_available_models`.
 * Failures (pi not installed, not authed, RPC error) are logged and ignored so
 * the picker falls back to the curated shortlist.
 */
function enrichPiSnapshot(input: {
  readonly settings: PiSettings;
  readonly serverConfig: ServerConfig["Service"];
  readonly snapshot: ServerProvider;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  // Shared slug -> context-window map filled from the live catalogue so the
  // adapter can resolve `maxTokens` synchronously without its own RPC.
  readonly modelContextWindows: Map<string, number>;
}): Effect.Effect<void> {
  if (!input.settings.enabled) return Effect.void;
  return Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const response = yield* Effect.acquireUseRelease(
      Effect.promise(() =>
        createPiRpcProcess({
          binaryPath: input.settings.binaryPath,
          platform,
          cwd: input.serverConfig.cwd,
          // Prepend the worktree's node_modules/.bin so pi resolves that
          // worktree's workspace binaries before the server's inherited PATH.
          env: withLocalNodeModulesBin(process.env, input.serverConfig.cwd, platform),
        }),
      ),
      (proc) =>
        Effect.promise(() =>
          proc.request<{ readonly models: ReadonlyArray<PiAvailableModel> }>({
            type: "get_available_models",
          }),
        ),
      (proc) => Effect.promise(() => proc.stop()),
    );
    const models = response.data?.models ?? [];
    // Only replace the window map on a non-empty catalogue: a successful-but-empty
    // refresh must not wipe known windows (which would blank the meter % until the
    // next good refresh, up to one refresh interval later).
    if (models.length > 0) {
      input.modelContextWindows.clear();
      for (const model of models) {
        input.modelContextWindows.set(`${model.provider}/${model.id}`, model.contextWindow);
      }
    }
    yield* input.publishSnapshot({
      ...input.snapshot,
      models: piCatalogModels(models, input.settings),
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Pi model catalog enrichment failed", { cause: Cause.pretty(cause) }),
    ),
  );
}

function makePiProvider(settings: PiSettings, checkedAt: string): ServerProviderDraft {
  return buildServerProvider({
    presentation: { displayName: "Pi", showInteractionModeToggle: true },
    enabled: settings.enabled,
    checkedAt,
    models: piModels(settings),
    probe: {
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "unknown" },
      message:
        "Pi RPC provider uses `pi --mode rpc`; run `pi` and log in if a session fails to start.",
    },
  });
}

function eventBase(input: {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly turnId?: TurnId;
  readonly itemId?: string;
  readonly requestId?: string;
  readonly raw?: ProviderRuntimeEvent["raw"];
}): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  return {
    eventId: EventId.make(`pi-event-${NodeCrypto.randomUUID()}`),
    provider: DRIVER_KIND,
    providerInstanceId: input.instanceId,
    threadId: input.threadId,
    createdAt: new Date().toISOString(),
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
    ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
    ...(input.raw ? { raw: input.raw } : {}),
  };
}

function rawPiMessage(message: PiRpcStdoutMessage): NonNullable<ProviderRuntimeEvent["raw"]> {
  return {
    source: message.type === "response" ? "pi.rpc.response" : "pi.rpc.event",
    ...(message.type === "response" ? { method: message.command } : { messageType: message.type }),
    payload: message,
  };
}

function toolItemType(
  toolName: string,
):
  | "command_execution"
  | "file_change"
  | "mcp_tool_call"
  | "collab_agent_tool_call"
  | "web_search"
  | "image_view"
  | "dynamic_tool_call" {
  const normalized = toolName.toLowerCase();
  if (normalized.includes("agent") || normalized.includes("task")) return "collab_agent_tool_call";
  if (normalized.includes("bash") || normalized.includes("command") || normalized.includes("shell"))
    return "command_execution";
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch")
  )
    return "file_change";
  if (normalized.includes("mcp")) return "mcp_tool_call";
  if (normalized.includes("web")) return "web_search";
  if (normalized.includes("image")) return "image_view";
  return "dynamic_tool_call";
}

type PiToolExecutionMessage = Extract<
  PiRpcStdoutEvent,
  { readonly type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
>;

function asArgsRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Re-attach the tool input to the result under `rawInput` (pi's `item.completed`
 * carries only the bare result). `deriveToolActivityPresentation` already recovers
 * the command/path/query from `data.rawInput`, so this single merge makes bash
 * (command), edit (path) and read/grep/find (path/pattern) each yield a
 * discriminating loop signature again.
 */
function mergeRawInput(result: unknown, args: Record<string, unknown> | undefined): unknown {
  if (!args) return result;
  const record = asArgsRecord(result);
  return record ? { ...record, rawInput: args } : { result, rawInput: args };
}

/**
 * Build the `item.{started,updated,completed}` payload for a pi tool lifecycle
 * message, correlating the start/update args (stashed in `toolArgs` by
 * toolCallId) into the completion payload. Pure aside from the stash map it
 * threads through, so it is unit-testable end-to-end.
 */
export function piToolItemPayload(
  message: PiToolExecutionMessage,
  toolArgs: Map<string, Record<string, unknown>>,
): {
  itemType: ReturnType<typeof toolItemType>;
  status: "inProgress" | "completed" | "failed";
  title: string;
  data?: unknown;
} {
  const itemType = toolItemType(message.toolName);
  if (message.type === "tool_execution_end") {
    const stashed = toolArgs.get(message.toolCallId);
    toolArgs.delete(message.toolCallId);
    return {
      itemType,
      status: message.isError ? "failed" : "completed",
      title: message.toolName,
      data: mergeRawInput(message.result, stashed),
    };
  }
  const args = asArgsRecord(message.args);
  if (args) toolArgs.set(message.toolCallId, args);
  return {
    itemType,
    status: "inProgress",
    title: message.toolName,
    data:
      message.type === "tool_execution_update"
        ? (message.partialResult ?? message.args)
        : message.args,
  };
}

function resolvePiModel(model: string): { provider: string; modelId: string } | undefined {
  const slash = model.indexOf("/");
  return slash > 0 && slash < model.length - 1
    ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }
    : undefined;
}

// ── T3-level provider-error retry + backend fallback ───────────────────────
// pi already auto-retries transient provider errors on a fast schedule
// (~2s/4s/8s). Overload episodes often last minutes, so when pi's retries
// exhaust we run a second, slower tier ON TOP: re-dispatch the turn on the
// current backend per T3_RETRY_DELAYS_MS, then switch to the SAME model on
// another backend (Anthropic-direct ↔ Vertex are distinct capacity pools) for
// a brief allowance, then give up into the normal failed-turn path. The
// fallback is per-turn only: the next sendTurn re-issues `set_model` from the
// thread's stored selection.

/** Slow-tier retry schedule on the turn's current backend. */
export const T3_RETRY_DELAYS_MS: ReadonlyArray<number> = [15_000, 30_000, 45_000, 60_000, 90_000];
/** Brief allowance on the fallback backend before giving up. */
export const T3_FALLBACK_RETRY_DELAYS_MS: ReadonlyArray<number> = [15_000, 60_000];

/**
 * Transient (retry-worthy) provider errors — capacity/plumbing, not user
 * fault. Mirrors the spirit of pi's own retryable-error regex: 529 overloaded,
 * 429 rate limits, 5xx, and network-shaped failures. Auth/validation errors
 * deliberately do NOT match and fail immediately.
 */
export const PI_TRANSIENT_PROVIDER_ERROR_RE =
  /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?(error|refused|reset|lost)|socket hang up|fetch failed|terminated|stream ended before|timed?.?out|timeout/i;

/** Preferred capacity-pool partner per provider namespace (checked first; the
 * generic same-model-other-provider scan is the fallback). Both directions of
 * the Anthropic-direct ↔ Vertex pair are known-good, authenticated pools. */
const PI_BACKEND_PARTNERS: Record<string, string> = {
  anthropic: "google-vertex-claude",
  "google-vertex-claude": "anthropic",
};

/**
 * Derive the same-model-different-backend fallback slug from pi's live
 * catalogue: prefer the known partner pool, else the first other provider
 * hosting the identical modelId. Undefined when no equivalent exists.
 */
export function piBackendFallbackModel(
  currentModel: string | undefined,
  availableModels: Iterable<string>,
): string | undefined {
  const current = currentModel === undefined ? undefined : resolvePiModel(currentModel);
  if (!current) return undefined;
  const slugs = [...availableModels];
  const partner = PI_BACKEND_PARTNERS[current.provider];
  if (partner !== undefined && slugs.includes(`${partner}/${current.modelId}`))
    return `${partner}/${current.modelId}`;
  return slugs.find((slug) => {
    const parsed = resolvePiModel(slug);
    return (
      parsed !== undefined &&
      parsed.modelId === current.modelId &&
      parsed.provider !== current.provider
    );
  });
}

/**
 * Outcome of a finished pi agent run: the last assistant message's
 * `stopReason`/`errorMessage` from the `agent_end` messages array.
 */
export function piRunOutcome(messages: ReadonlyArray<Record<string, unknown>> | undefined): {
  stopReason: string | undefined;
  errorMessage: string | undefined;
} {
  for (let i = (messages?.length ?? 0) - 1; i >= 0; i -= 1) {
    const message = messages![i]!;
    if (message.role === "assistant") {
      return {
        stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
        errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
      };
    }
  }
  return { stopReason: undefined, errorMessage: undefined };
}

/** In-band control-plane framing for the retry re-prompt (the errored run left
 * pi idle; a fresh prompt is the only way to resume it). */
export const buildPiRetryPrompt = (errorMessage: string): string =>
  [
    "[T3 Code control plane — automated retry after a provider error; not a message from the user]",
    "",
    `Your previous response failed with a transient provider error (${errorMessage}); none of it was delivered.`,
    "Continue the task from where you left off.",
  ].join("\n");

/**
 * Translate pi's per-message `Usage` into the generic context-window snapshot
 * the orchestration layer ingests. `usedTokens` mirrors pi's own
 * `calculateContextTokens` (prefer `totalTokens`, else sum all buckets) so the
 * ring matches pi's native percentage and its auto-compaction trigger.
 * `inputTokens` is the prompt side only (`input + cacheRead + cacheWrite`);
 * `output` is the newly generated text. pi has no thread-cumulative figure, so
 * `totalProcessedTokens` is left unset.
 */
function normalizePiTokenUsage(
  usage: unknown,
  maxTokens: number | undefined,
): ThreadTokenUsageSnapshot | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const record = usage as Record<string, unknown>;
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const cacheRead = num(record.cacheRead);
  const output = num(record.output);
  const promptTokens = num(record.input) + cacheRead + num(record.cacheWrite);
  const usedTokens = num(record.totalTokens) || promptTokens + output;
  if (usedTokens <= 0) return undefined;
  // pi attaches its own authoritative dollar figure as `usage.cost.total` (a
  // per-message delta). Surface it verbatim — we never price tokens ourselves.
  const cost = record.cost;
  const costTotal =
    cost && typeof cost === "object" ? num((cost as Record<string, unknown>).total) : 0;
  return {
    usedTokens,
    inputTokens: promptTokens,
    cachedInputTokens: cacheRead,
    outputTokens: output,
    lastUsedTokens: usedTokens,
    lastInputTokens: promptTokens,
    lastCachedInputTokens: cacheRead,
    lastOutputTokens: output,
    ...(costTotal > 0 ? { costUsd: costTotal } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  };
}

function imageAttachments(
  attachmentsDir: string,
  attachments: ReadonlyArray<ChatAttachment> | undefined,
) {
  return (attachments ?? []).flatMap((attachment) => {
    const path = resolveAttachmentPath({ attachmentsDir, attachment });
    return path && NodeFS.existsSync(path)
      ? [
          {
            type: "image" as const,
            data: NodeFS.readFileSync(path).toString("base64"),
            mimeType: attachment.mimeType,
          },
        ]
      : [];
  });
}

function makePiAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: PiSettings;
  readonly serverConfig: ServerConfig["Service"];
  readonly events: Queue.Queue<ProviderRuntimeEvent>;
  // Shared slug -> context-window map populated by `enrichPiSnapshot` from pi's
  // live catalogue; read synchronously here to set token-usage `maxTokens`.
  readonly modelContextWindows: Map<string, number>;
}): ProviderAdapterShape<
  | ProviderAdapterProcessError
  | ProviderAdapterRequestError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterValidationError
> {
  const sessions = new Map<ThreadId, ActivePiSession>();
  const emit = (event: ProviderRuntimeEvent) =>
    Queue.offer(input.events, event).pipe(Effect.asVoid);
  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<ActivePiSession, ProviderAdapterSessionNotFoundError> => {
    const session = sessions.get(threadId);
    if (session) return Effect.succeed(session);
    return Effect.fail(
      new ProviderAdapterSessionNotFoundError({ provider: DRIVER_KIND, threadId }),
    );
  };
  const updateSession = (session: ActivePiSession, patch: Partial<ProviderSession>) => {
    session.session = { ...session.session, ...patch, updatedAt: new Date().toISOString() };
    return session.session;
  };

  // Event base for synthetic (non-pi-message) emissions: retry warnings, the
  // reroute notice, and turn settlement from a timer callback.
  const sessionBase = (session: ActivePiSession, raw?: ProviderRuntimeEvent["raw"]) =>
    eventBase({
      instanceId: input.instanceId,
      threadId: session.session.threadId,
      ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
      raw: raw ?? { source: "pi.rpc.synthetic", payload: {} },
    });

  // Clear any pending T3 retry and, if the backend fallback engaged, restore
  // the turn's original model (per-turn fallback: subsequent turns must run on
  // the thread's selected model — sendTurn re-issues set_model anyway; this is
  // belt-and-braces for non-orchestrated sends). Best-effort: a failed restore
  // is ignored because the next sendTurn sets the model authoritatively.
  const settleRetry = (session: ActivePiSession): Effect.Effect<void> => {
    const retry = session.retry;
    session.retry = undefined;
    if (!retry) return Effect.void;
    if (retry.timer !== undefined) clearTimeout(retry.timer);
    if (retry.originalModel === undefined || retry.originalModel === session.session.model)
      return Effect.void;
    const model = resolvePiModel(retry.originalModel);
    updateSession(session, { model: retry.originalModel });
    return model
      ? Effect.promise(() =>
          session.process.request({
            type: "set_model",
            provider: model.provider,
            modelId: model.modelId,
          }),
        ).pipe(Effect.ignore)
      : Effect.void;
  };

  // Settle the open turn as completed/interrupted (events are built while the
  // turn id is still set, then the id is cleared).
  const completeTurn = (
    session: ActivePiSession,
    state: "completed" | "interrupted",
    raw?: ProviderRuntimeEvent["raw"],
  ): Effect.Effect<void> => {
    const done = emit({ ...sessionBase(session, raw), type: "turn.completed", payload: { state } });
    session.activeTurnId = undefined;
    updateSession(session, { status: "ready", activeTurnId: undefined });
    return settleRetry(session).pipe(Effect.andThen(done));
  };

  // Terminal failure path (mirrors ClaudeAdapter): a runtime.error with class
  // provider_error plus turn.completed failed — ingestion turns these into
  // session status "error" + lastError, the UI banner, and the workstream
  // error wake.
  const failTurn = (
    session: ActivePiSession,
    errorMessage: string,
    raw?: ProviderRuntimeEvent["raw"],
  ): Effect.Effect<void> => {
    const events = emit({
      ...sessionBase(session, raw),
      type: "runtime.error",
      payload: { message: errorMessage, class: "provider_error" },
    }).pipe(
      Effect.andThen(
        emit({
          ...sessionBase(session, raw),
          type: "turn.completed",
          payload: { state: "failed", errorMessage },
        }),
      ),
    );
    session.activeTurnId = undefined;
    updateSession(session, { status: "error", activeTurnId: undefined });
    return settleRetry(session).pipe(Effect.andThen(events));
  };

  // Timer callback body: re-dispatch the failed turn (optionally after the
  // backend switch). Guards make a stale timer a no-op: the session was
  // replaced/stopped, the turn was interrupted, or a newer schedule superseded
  // this one. Any dispatch failure lands in the terminal failure path.
  const dispatchTurnRetry = (
    session: ActivePiSession,
    attempt: number,
    switchToModel: string | undefined,
    errorMessage: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (
        sessions.get(session.session.threadId) !== session ||
        session.activeTurnId === undefined ||
        session.retry?.attempt !== attempt
      )
        return;
      // Timer has fired: drop the handle so interruptTurn takes the abort path
      // for the now in-flight prompt instead of settling a "pending" retry.
      session.retry = { ...session.retry, timer: undefined };
      if (switchToModel !== undefined) {
        const model = resolvePiModel(switchToModel);
        const fromModel = session.session.model ?? "unknown";
        if (model) {
          yield* Effect.tryPromise({
            try: () =>
              session.process.request({
                type: "set_model",
                provider: model.provider,
                modelId: model.modelId,
              }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: DRIVER_KIND,
                method: "set_model",
                detail: detailFromCause(cause, "Failed to switch Pi fallback model."),
                cause,
              }),
          });
          updateSession(session, { model: switchToModel });
          yield* emit({
            ...sessionBase(session),
            type: "model.rerouted",
            payload: {
              fromModel,
              toModel: switchToModel,
              reason: `Provider errors persisted through ${T3_RETRY_DELAYS_MS.length} retries; retrying this turn on the same model via another backend.`,
            },
          });
        }
      }
      yield* Effect.tryPromise({
        try: () =>
          session.process.request({ type: "prompt", message: buildPiRetryPrompt(errorMessage) }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: DRIVER_KIND,
            method: "prompt",
            detail: detailFromCause(cause, "Failed to dispatch Pi retry prompt."),
            cause,
          }),
      });
    }).pipe(
      Effect.catch((error) =>
        failTurn(session, `${errorMessage} (automatic retry failed: ${error.detail})`),
      ),
    );

  // Schedule the next slow-tier retry for a transient provider failure.
  // Returns undefined when the ladder is exhausted (or no fallback backend
  // exists), which sends the caller to the terminal failure path.
  const scheduleTurnRetry = (
    session: ActivePiSession,
    errorMessage: string,
  ): Effect.Effect<void> | undefined => {
    const attempt = (session.retry?.attempt ?? 0) + 1;
    const primary = T3_RETRY_DELAYS_MS.length;
    let delayMs: number;
    let switchToModel: string | undefined;
    if (attempt <= primary) {
      delayMs = T3_RETRY_DELAYS_MS[attempt - 1]!;
    } else {
      const fallbackIndex = attempt - primary - 1;
      if (fallbackIndex >= T3_FALLBACK_RETRY_DELAYS_MS.length) return undefined;
      delayMs = T3_FALLBACK_RETRY_DELAYS_MS[fallbackIndex]!;
      if (fallbackIndex === 0) {
        switchToModel = piBackendFallbackModel(
          session.session.model,
          input.modelContextWindows.keys(),
        );
        if (switchToModel === undefined) return undefined;
      }
    }
    const timer = setTimeout(() => {
      void Effect.runPromise(
        dispatchTurnRetry(session, attempt, switchToModel, errorMessage),
      ).catch(() => undefined);
    }, delayMs);
    session.retry = {
      attempt,
      timer,
      originalModel:
        session.retry?.originalModel ?? (switchToModel ? session.session.model : undefined),
    };
    return emit({
      ...sessionBase(session),
      type: "runtime.warning",
      payload: {
        message: `Provider error — automatic retry ${attempt} in ${Math.round(delayMs / 1000)}s${switchToModel ? ` on fallback backend ${switchToModel}` : ""}: ${errorMessage}`,
      },
    });
  };

  const handleMessage = (session: ActivePiSession, message: PiRpcStdoutMessage) => {
    const raw = rawPiMessage(message);
    const base = (extra?: { turnId?: TurnId; itemId?: string; requestId?: string }) =>
      eventBase({
        instanceId: input.instanceId,
        threadId: session.session.threadId,
        ...(session.activeTurnId ? { turnId: session.activeTurnId } : {}),
        ...extra,
        raw,
      });

    switch (message.type) {
      // A pi "agent run" (agent_start -> agent_end) is one T3 turn. pi emits
      // many internal turn_start/turn_end pairs per run (one per model round /
      // tool batch) while it stays streaming the whole time, so the T3 turn must
      // span the entire run: activeTurnId (set by sendTurn) is kept until
      // agent_end so a mid-run send is detected as a steer (see sendTurn).
      case "agent_start":
        updateSession(session, { status: "running", activeTurnId: session.activeTurnId });
        // pi re-emits agent_start per auto-retry attempt and per T3-level retry
        // re-prompt; emit turn.started once per T3 turn.
        if (!session.activeTurnId || session.turnStartedFor === session.activeTurnId)
          return Effect.void;
        session.turnStartedFor = session.activeTurnId;
        return emit({
          ...base(),
          type: "turn.started",
          payload: session.session.model ? { model: session.session.model } : {},
        });
      // pi-internal sub-turn boundary, not a T3 turn boundary: ignore it so we
      // don't re-emit turn.started each round (which would re-run plan
      // acceptance). The T3 turn already started at agent_start.
      case "turn_start":
        return Effect.void;
      case "message_start":
        session.currentAssistantMessageId = `assistant-${NodeCrypto.randomUUID()}`;
        return Effect.void;
      case "message_update": {
        const assistantEvent = message.assistantMessageEvent;
        const itemId = session.currentAssistantMessageId;
        if (!assistantEvent || !itemId) return Effect.void;
        if (
          assistantEvent.type === "text_delta" &&
          typeof assistantEvent.delta === "string" &&
          assistantEvent.delta
        ) {
          return emit({
            ...base({ itemId }),
            type: "content.delta",
            payload: {
              streamKind: "assistant_text",
              delta: assistantEvent.delta,
              ...(typeof assistantEvent.contentIndex === "number"
                ? { contentIndex: assistantEvent.contentIndex }
                : {}),
            },
          });
        }
        if (
          assistantEvent.type === "thinking_delta" &&
          typeof assistantEvent.delta === "string" &&
          assistantEvent.delta
        ) {
          return emit({
            ...base({ itemId }),
            type: "content.delta",
            payload: {
              streamKind: "reasoning_text",
              delta: assistantEvent.delta,
              ...(typeof assistantEvent.contentIndex === "number"
                ? { contentIndex: assistantEvent.contentIndex }
                : {}),
            },
          });
        }
        return Effect.void;
      }
      case "message_end": {
        if (message.message.role !== "assistant") return Effect.void;
        const itemId = session.currentAssistantMessageId ?? `assistant-${NodeCrypto.randomUUID()}`;
        const usage = normalizePiTokenUsage(
          message.message.usage,
          session.session.model ? input.modelContextWindows.get(session.session.model) : undefined,
        );
        return emit({
          ...base({ itemId }),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            data: message.message,
          },
        }).pipe(
          Effect.andThen(
            usage
              ? emit({ ...base(), type: "thread.token-usage.updated", payload: { usage } })
              : Effect.void,
          ),
          Effect.tap(() => Effect.sync(() => (session.currentAssistantMessageId = undefined))),
        );
      }
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end": {
        const eventType =
          message.type === "tool_execution_start"
            ? "item.started"
            : message.type === "tool_execution_end"
              ? "item.completed"
              : "item.updated";
        return emit({
          ...base({ itemId: message.toolCallId }),
          type: eventType,
          payload: piToolItemPayload(message, session.toolArgs),
        });
      }
      case "extension_ui_request": {
        // Only select/confirm/input/editor expect a response; notify/setStatus/setWidget/
        // setTitle/set_editor_text are display-only (pi emits several on startup). Ignore the latter.
        if (
          message.method !== "select" &&
          message.method !== "confirm" &&
          message.method !== "input" &&
          message.method !== "editor"
        )
          return Effect.void;
        return emit({
          ...base({ requestId: message.id }),
          type: "user-input.requested",
          payload: {
            questions: [
              {
                id: message.id,
                header: message.title ?? "Pi request",
                question: message.message ?? message.title ?? "Pi requested input",
                options: (message.options ?? ["OK"]).map((option) => ({
                  label: option,
                  description: option,
                })),
              },
            ],
          },
        });
      }
      case "queue_update":
        return emit({
          ...base(),
          type: "thread.queue.updated",
          payload: { steering: message.steering ?? [], followUp: message.followUp ?? [] },
        });
      // pi-internal sub-turn end: must NOT end the T3 turn or clear
      // activeTurnId (that would blind mid-run steer detection). Per-message
      // completion is emitted separately by message_end.
      case "turn_end":
        return Effect.void;
      // End of the pi agent run = end of the T3 turn — unless pi's auto-retry
      // (willRetry) or the T3-level slow retry tier keeps the turn open.
      case "agent_end": {
        // Turn boundary: drop any tool-arg stashes whose `tool_execution_end`
        // never arrived (aborted/interrupted/never-completing tool). All of a
        // turn's tool calls resolve within the run and toolCallIds are unique,
        // so clearing the whole map here can never mis-merge a later call — pure
        // memory hygiene. Cleared on ALL return paths (abort can take any).
        session.toolArgs.clear();
        // pi will retry internally: the run (and the T3 turn) is not over.
        // auto_retry_start surfaces the wait as a runtime.warning.
        if (message.willRetry === true) return Effect.void;
        if (session.activeTurnId === undefined) {
          updateSession(session, { status: "ready", activeTurnId: undefined });
          return Effect.void;
        }
        const outcome = piRunOutcome(message.messages);
        if (outcome.stopReason === "error") {
          const errorMessage = outcome.errorMessage ?? "Pi turn failed.";
          if (PI_TRANSIENT_PROVIDER_ERROR_RE.test(errorMessage)) {
            const retry = scheduleTurnRetry(session, errorMessage);
            if (retry) return retry; // turn stays open through the retry window
          }
          return failTurn(session, errorMessage, raw);
        }
        return completeTurn(
          session,
          outcome.stopReason === "aborted" ? "interrupted" : "completed",
          raw,
        );
      }
      // pi's retry ladder ended. Success and exhaustion are both reported via
      // agent_end; the ONE case only this event reports is a retry cancelled
      // mid-sleep (abort during pi's backoff wait): that run already ended with
      // an agent_end willRetry:true and no further agent_end will come, so
      // settle the open turn as interrupted here. A pending T3-level retry
      // timer means this event is instead the tail of the exhaustion path —
      // leave the turn open for the scheduled re-dispatch.
      case "auto_retry_end":
        if (
          !message.success &&
          session.activeTurnId !== undefined &&
          session.retry?.timer === undefined
        )
          return completeTurn(session, "interrupted");
        return Effect.void;
      // pi's built-in fast retry tier: surface each wait live in the timeline.
      case "auto_retry_start":
        return emit({
          ...base(),
          type: "runtime.warning",
          payload: {
            message: `Provider error — retry ${message.attempt}/${message.maxAttempts} in ${Math.round(message.delayMs / 1000)}s: ${message.errorMessage}`,
          },
        });
      default:
        return Effect.void;
    }
  };

  return {
    provider: DRIVER_KIND,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (startInput) =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        return yield* Effect.tryPromise({
          try: () => {
            const mcpSession = McpProviderSession.readMcpProviderSession(startInput.threadId);
            const appendSystemPrompt = appendSystemPrompts(
              mcpSession ? PI_WORK_MODEL_SYSTEM_PROMPT : undefined,
              startInput.appendSystemPrompt,
            );
            const piCwd = startInput.cwd ?? input.serverConfig.cwd;
            return createPiRpcProcess({
              binaryPath: input.settings.binaryPath,
              platform,
              cwd: piCwd,
              // Deterministic per-thread session id so pi create-or-resumes the
              // SAME session file across server restarts / reconnects, instead
              // of silently spawning a fresh, amnesiac session each time.
              sessionId: piSessionIdForThread(startInput.threadId),
              ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
              ...(startInput.skills && startInput.skills.length > 0
                ? { skills: startInput.skills }
                : {}),
              ...(startInput.tools && startInput.tools.length > 0
                ? { tools: startInput.tools }
                : {}),
              ...(mcpSession
                ? {
                    extensions: [
                      ensurePiWorkstreamSpawnExtension(input.serverConfig.stateDir),
                      ensurePiGoalTaskExtension(input.serverConfig.stateDir),
                    ],
                  }
                : {}),
              // Prepend the session worktree's node_modules/.bin so pi resolves
              // that worktree's workspace binaries before the server's inherited
              // PATH, while preserving the T3_WORKSTREAM_* additions.
              env: withLocalNodeModulesBin(
                mcpSession
                  ? {
                      ...process.env,
                      T3_WORKSTREAM_SPAWN_URL: workstreamSpawnUrlFromMcpEndpoint(
                        mcpSession.endpoint,
                      ),
                      T3_WORKSTREAM_LANE_URL: workstreamLaneUrlFromMcpEndpoint(mcpSession.endpoint),
                      T3_WORKSTREAM_ATTENTION_URL: workstreamAttentionUrlFromMcpEndpoint(
                        mcpSession.endpoint,
                      ),
                      T3_WORKSTREAM_RELEASE_URL: workstreamReleaseUrlFromMcpEndpoint(
                        mcpSession.endpoint,
                      ),
                      T3_WORKSTREAM_STOP_URL: workstreamStopUrlFromMcpEndpoint(mcpSession.endpoint),
                      T3_WORKSTREAM_DEPENDENCIES_URL: workstreamDependenciesUrlFromMcpEndpoint(
                        mcpSession.endpoint,
                      ),
                      T3_WORKSTREAM_REPORT_URL: workstreamReportUrlFromMcpEndpoint(
                        mcpSession.endpoint,
                      ),
                      T3_WORKSTREAM_LIST_URL: workstreamListUrlFromMcpEndpoint(mcpSession.endpoint),
                      T3_WORKSTREAM_CONSULT_THREAD_URL: workstreamConsultThreadUrlFromMcpEndpoint(
                        mcpSession.endpoint,
                      ),
                      T3_SET_THREAD_TITLE_URL: setThreadTitleUrlFromMcpEndpoint(
                        mcpSession.endpoint,
                      ),
                      T3_GOAL_TASK_LIST_URL: goalTaskListUrlFromMcpEndpoint(mcpSession.endpoint),
                      T3_GOAL_TASK_ADD_URL: goalTaskAddUrlFromMcpEndpoint(mcpSession.endpoint),
                      T3_GOAL_TASK_UPDATE_URL: goalTaskUpdateUrlFromMcpEndpoint(
                        mcpSession.endpoint,
                      ),
                      T3_GOAL_TASK_DELETE_URL: goalTaskDeleteUrlFromMcpEndpoint(
                        mcpSession.endpoint,
                      ),
                      T3_GOAL_UPDATE_URL: goalUpdateUrlFromMcpEndpoint(mcpSession.endpoint),
                      T3_GOAL_HANDOFF_URL: goalHandoffUrlFromMcpEndpoint(mcpSession.endpoint),
                      T3_WORKSTREAM_AUTHORIZATION: mcpSession.authorizationHeader,
                    }
                  : process.env,
                piCwd,
                platform,
              ),
            });
          },
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: DRIVER_KIND,
              threadId: startInput.threadId,
              detail: detailFromCause(cause, "Failed to start Pi RPC process."),
              cause,
            }),
        });
      }).pipe(
        Effect.flatMap((process) =>
          Effect.gen(function* () {
            const createdAt = yield* nowIso;
            const session: ProviderSession = {
              provider: DRIVER_KIND,
              providerInstanceId: input.instanceId,
              status: "ready",
              runtimeMode: startInput.runtimeMode,
              cwd: startInput.cwd ?? input.serverConfig.cwd,
              ...(startInput.modelSelection ? { model: startInput.modelSelection.model } : {}),
              threadId: startInput.threadId,
              createdAt,
              updatedAt: createdAt,
            };
            const active: ActivePiSession = {
              session,
              process,
              turns: [],
              unsubscribe: () => undefined,
              activeTurnId: undefined,
              turnStartedFor: undefined,
              retry: undefined,
              currentAssistantMessageId: undefined,
              toolArgs: new Map(),
            };
            active.unsubscribe = process.subscribe(
              (message) =>
                void Effect.runPromise(handleMessage(active, message)).catch(() => undefined),
            );
            process.child.once("exit", () => {
              if (active.retry?.timer !== undefined) clearTimeout(active.retry.timer);
              sessions.delete(startInput.threadId);
              void Effect.runPromise(
                emit({
                  ...eventBase({
                    instanceId: input.instanceId,
                    threadId: startInput.threadId,
                    raw: { source: "pi.rpc.synthetic", payload: { stderr: process.stderrTail() } },
                  }),
                  type: "session.exited",
                  payload: {
                    reason: process.stderrTail() || "Pi RPC process exited.",
                    recoverable: false,
                    exitKind: "error",
                  },
                }),
              ).catch(() => undefined);
            });
            sessions.set(startInput.threadId, active);
            yield* emit({
              ...eventBase({
                instanceId: input.instanceId,
                threadId: startInput.threadId,
                raw: { source: "pi.rpc.synthetic", payload: {} },
              }),
              type: "session.started",
              payload: { message: "Pi session started" },
            });
            yield* emit({
              ...eventBase({
                instanceId: input.instanceId,
                threadId: startInput.threadId,
                raw: { source: "pi.rpc.synthetic", payload: {} },
              }),
              type: "thread.started",
              payload: {},
            });
            return session;
          }),
        ),
      ),
    sendTurn: (turnInput) =>
      requireSession(turnInput.threadId).pipe(
        Effect.flatMap((session) =>
          Effect.gen(function* () {
            const text = turnInput.input?.trim() ?? "";
            const images = imageAttachments(
              input.serverConfig.attachmentsDir,
              turnInput.attachments,
            );
            if (!text && images.length === 0) {
              return yield* new ProviderAdapterValidationError({
                provider: DRIVER_KIND,
                operation: "sendTurn",
                issue: "Pi turns require text input or at least one image attachment.",
              });
            }
            // A pending retry timer means we're in a T3 backoff window: the T3
            // turn is open but pi is idle between attempts. Settle the retry
            // (clears the timer so its dispatchTurnRetry can't double-prompt, and
            // restores the pre-fallback model) and send this message as a fresh
            // prompt on the still-open turn rather than a steer (pi isn't
            // mid-run). An explicit modelSelection below still overrides.
            const inBackoff =
              session.retry?.timer !== undefined && session.activeTurnId !== undefined;
            if (inBackoff) yield* settleRetry(session);
            if (turnInput.modelSelection) {
              const model = resolvePiModel(turnInput.modelSelection.model);
              if (model)
                yield* Effect.tryPromise({
                  try: () =>
                    session.process.request({
                      type: "set_model",
                      provider: model.provider,
                      modelId: model.modelId,
                    }),
                  catch: (cause) =>
                    new ProviderAdapterRequestError({
                      provider: DRIVER_KIND,
                      method: "set_model",
                      detail: detailFromCause(cause, "Failed to set Pi model."),
                      cause,
                    }),
                });
              const thinkingLevel = getModelSelectionStringOptionValue(
                turnInput.modelSelection,
                "thinkingLevel",
              ) as PiThinkingLevel | undefined;
              if (thinkingLevel)
                yield* Effect.tryPromise({
                  try: () =>
                    session.process.request({ type: "set_thinking_level", level: thinkingLevel }),
                  catch: (cause) =>
                    new ProviderAdapterRequestError({
                      provider: DRIVER_KIND,
                      method: "set_thinking_level",
                      detail: detailFromCause(cause, "Failed to set Pi thinking level."),
                      cause,
                    }),
                });
              updateSession(session, { model: turnInput.modelSelection.model });
            }
            // A send while a turn is already running is a steer: pi folds the
            // message into the live agent loop and continues the SAME turn, so
            // we keep the existing turn id and don't re-emit lifecycle state
            // (mirrors ClaudeAdapter). Pi requires an explicit streamingBehavior
            // mid-turn or it rejects the prompt. Future: let the user choose
            // steer vs followUp per message (design doc Decision 3).
            const activeTurnId = session.activeTurnId;
            const turnId = activeTurnId ?? TurnId.make(`pi-turn-${NodeCrypto.randomUUID()}`);
            if (activeTurnId === undefined) {
              session.activeTurnId = turnId;
              session.turns.push({ id: turnId, items: [] });
              updateSession(session, { status: "running", activeTurnId: turnId });
            }
            yield* Effect.tryPromise({
              try: () =>
                session.process.request({
                  type: "prompt",
                  message: text,
                  ...(images.length > 0 ? { images } : {}),
                  ...(activeTurnId !== undefined && !inBackoff
                    ? { streamingBehavior: "steer" as const }
                    : {}),
                }),
              catch: (cause) =>
                new ProviderAdapterRequestError({
                  provider: DRIVER_KIND,
                  method: "prompt",
                  detail: detailFromCause(cause, "Failed to send Pi prompt."),
                  cause,
                }),
            });
            return { threadId: turnInput.threadId, turnId } satisfies ProviderTurnStartResult;
          }),
        ),
      ),
    interruptTurn: (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((session) =>
          // A pending T3-level retry means pi is idle between attempts: an
          // abort would be a no-op that never emits agent_end, so settle the
          // open turn as interrupted right here (cancels the timer too).
          session.retry?.timer !== undefined && session.activeTurnId !== undefined
            ? completeTurn(session, "interrupted")
            : Effect.tryPromise({
                try: () => session.process.write({ type: "abort" }),
                catch: (cause) =>
                  new ProviderAdapterRequestError({
                    provider: DRIVER_KIND,
                    method: "abort",
                    detail: detailFromCause(cause, "Failed to interrupt Pi turn."),
                    cause,
                  }),
              }),
        ),
      ),
    respondToRequest: () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: DRIVER_KIND,
          operation: "respondToRequest",
          issue: "Pi approval requests are not exposed separately in v1.",
        }),
      ),
    respondToUserInput: (threadId, requestId, answers) =>
      requireSession(threadId).pipe(
        Effect.flatMap((session) =>
          Effect.tryPromise({
            try: () =>
              session.process.write({
                type: "extension_ui_response",
                id: requestId,
                value: JSON.stringify(answers),
              }),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: DRIVER_KIND,
                method: "extension_ui_response",
                detail: detailFromCause(cause, "Failed to respond to Pi input."),
                cause,
              }),
          }),
        ),
      ),
    stopSession: (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((session) =>
          Effect.promise(() => session.process.stop()).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (session.retry?.timer !== undefined) clearTimeout(session.retry.timer);
                sessions.delete(threadId);
              }),
            ),
          ),
        ),
      ),
    listSessions: () => Effect.sync(() => [...sessions.values()].map((session) => session.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) =>
      requireSession(threadId).pipe(
        Effect.map((session) => ({
          threadId,
          turns: session.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
        })),
      ),
    rollbackThread: (threadId) =>
      requireSession(threadId).pipe(Effect.map((session) => ({ threadId, turns: session.turns }))),
    stopAll: () =>
      Effect.forEach(
        [...sessions.values()],
        (session) => Effect.promise(() => session.process.stop()),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.tap(() => Effect.sync(() => sessions.clear()))),
    streamEvents: Stream.fromQueue(input.events),
  };
}

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Pi", supportsMultipleInstances: true },
  configSchema: PiSettings,
  defaultConfig: () => decodePiSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const serverConfig = yield* ServerConfig;
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
      // Slug -> context-window (tokens), populated by `enrichPiSnapshot` from pi's
      // live catalogue (fetched once at provider boot) and read synchronously by
      // the adapter so token-usage snapshots carry `maxTokens` with no per-session
      // RPC and no first-message race.
      const modelContextWindows = new Map<string, number>();
      const adapter = makePiAdapter({
        instanceId,
        settings: effectiveConfig,
        serverConfig,
        events,
        modelContextWindows,
      });
      yield* Effect.addFinalizer(() =>
        adapter.stopAll().pipe(Effect.ignore, Effect.andThen(Queue.shutdown(events))),
      );
      const platform = yield* HostProcessPlatform;
      const deterministicTitle = (message: string) =>
        Effect.succeed({ title: titleFromText(message) });
      // Real one-shot pi completion so the default `pi` text-generation instance
      // produces genuine structured output (titles/goals). The legacy per-op
      // stubs stay deterministic; only `generateStructured` is wired for real.
      const generateStructured: TextGenerationShape["generateStructured"] = (genInput) =>
        generatePiStructured({
          binaryPath: effectiveConfig.binaryPath,
          platform,
          env: process.env,
          cwd: serverConfig.cwd,
          prompt: genInput.prompt,
          outputSchema: genInput.outputSchema,
          modelSelection: genInput.modelSelection,
        });
      const textGeneration: TextGenerationShape = {
        generateCommitMessage: () => Effect.succeed({ subject: "Update from pi", body: "" }),
        generatePrContent: () => Effect.succeed({ title: "Update from pi", body: "" }),
        generateBranchName: (textInput: BranchNameGenerationInput) =>
          Effect.succeed({ branch: branchFromText(textInput.message) }),
        generateThreadTitle: (textInput: ThreadTitleGenerationInput) =>
          deterministicTitle(textInput.message),
        generateStructured,
      };
      const snapshot = yield* makeManagedServerProvider<PiSettings>({
        maintenanceCapabilities: PI_MAINTENANCE_CAPABILITIES,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          nowIso.pipe(
            Effect.map((checkedAt) => stampIdentity(makePiProvider(settings, checkedAt))),
          ),
        checkProvider: nowIso.pipe(
          Effect.map((checkedAt) => stampIdentity(makePiProvider(effectiveConfig, checkedAt))),
        ),
        enrichSnapshot: ({ snapshot: currentSnapshot, publishSnapshot }) =>
          enrichPiSnapshot({
            settings: effectiveConfig,
            serverConfig,
            snapshot: currentSnapshot,
            publishSnapshot,
            modelContextWindows,
          }),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: cause instanceof Error ? cause.message : String(cause),
              cause,
            }),
        ),
      );
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
