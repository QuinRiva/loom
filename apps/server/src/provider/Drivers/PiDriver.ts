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
  USAGE_BACKEND_DISPLAY_NAMES,
  type ChatAttachment,
  type ModelCapabilities,
  type ModelSelection,
  type PiThinkingLevel,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type RuntimeErrorClass,
  type ProviderTurnStartResult,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
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

import {
  attachmentRelativePath,
  createAttachmentId,
  resolveAttachmentPath,
} from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { workstreamBaseUrlFromMcpEndpoint } from "../../mcp/toolPaths.ts";
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
import { accountKeyForModelSlug } from "../exhaustionMapping.ts";
import { resolveFailoverTarget } from "../failoverChains.ts";
import {
  ProviderHealthRegistry,
  matches as markMatchesAccount,
  type ProviderHealthRegistryShape,
} from "../Services/ProviderHealthRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { ProviderFailoverSettings } from "@t3tools/contracts";
import { buildServerProvider, type ServerProviderDraft } from "../providerSnapshot.ts";
import {
  userInputContentDelivered,
  userInputContentUndelivered,
  type ProviderAdapterShape,
  type UserInputDeliveryResult,
} from "../Services/ProviderAdapter.ts";
import {
  createPiRpcProcess,
  type PiRpcCommandInfo,
  type PiRpcProcess,
  type PiRpcProcessOptions,
  type PiRpcStdoutEvent,
  type PiRpcStdoutMessage,
} from "../Layers/Pi/RpcProcess.ts";
import { generatePiStructured } from "../Layers/Pi/OneShotCompletion.ts";
import {
  sanitisePiSessionForThread,
  slugRoutesToAnthropic,
  threadSessionHasPoisonedToolIds,
} from "../Layers/Pi/SessionIdSanitiser.ts";
import { ensurePiProviderToolExtension } from "./Pi/providerToolExtension.ts";
import {
  cancelPiAskUserQuestions,
  registerPiAskUserEmitter,
  resolvePiAskUserQuestion,
} from "./Pi/askUserBroker.ts";
import { ensurePiSearchGuardExtension } from "./Pi/searchGuardExtension.ts";
import { piSessionIdForThread, resolveSessionFilePath } from "../piSessionFiles.ts";
// loom: forkFrom launch-identity capture/replay + kickoff-delivered marker (D2/D8).
import {
  deleteLaunchIdentity,
  isKickoffDelivered,
  markKickoffDelivered,
  readLaunchIdentity,
  resolveForkLaunchArgs,
  updateLaunchIdentityApplied,
  writeLaunchIdentity,
} from "../../orchestration/workstreamLaunchIdentity.ts";
// Debugging-only: deterministic path for the effective-prompt debug sidecar.
import { promptDebugSidecarPath } from "../../orchestration/workstreamPromptDebug.ts";
import {
  T3_QUOTA_FAILOVER_DELAY_MS,
  T3_RETRY_DELAYS_MS,
  buildPiRetryPrompt,
  classifyPiProviderError,
  formatResetTime,
  nextRetryStep,
  piRunOutcome,
  resolvePiModel,
} from "./piTurnRetryPolicy.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");
const decodePiSettings = Schema.decodeSync(PiSettings);
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(2);
// `pi --mode rpc` attaches its stdin command reader only after the session has
// fully booted (node cold start, auth, extension/skill loading) and emits no
// readiness signal, so `get_available_models` cannot be answered until boot
// completes. Under host load that can exceed the 30s default request timeout,
// tripping a needless enrichment failure. This is a throwaway, self-healing,
// 2-min-cadence refresh, so we wait out a slow boot (well under the refresh
// interval, which interrupts the fiber anyway) rather than burn the spawn.
const PI_ENRICHMENT_REQUEST_TIMEOUT_MS = 90_000;
const PI_MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "@earendil-works/pi-coding-agent",
});
const PI_WORK_MODEL_SYSTEM_PROMPT =
  "You operate inside T3 Code's work model: Goals → Tasks → Workstream. This is how every thread here is organised, whatever its role.\n\nA GOAL is a single durable objective that outlives any one session and spans many — the north star for all work under it. Orient to it; if work drifts from the goal, refocus or update it. A goal is decomposed into a TASK TREE: the living, shared record of what is done and what remains — for the agents working it and for the human who glances at it to re-orient. It is kept current as work progresses.\n\nWork happens in a WORKSTREAM: a tree of durable threads. You are one thread in it, and your role overlay says how you act within it. A ROOT thread ORCHESTRATES — it plans, delegates, and reviews rather than doing the work by hand. A CHILD thread EXECUTES a single self-contained brief and hands a result back. A child is a real, persistent thread a human can open and talk to, not a throwaway: spawning one is deliberate, and a child starts fresh — it inherits none of the parent's conversation, only the brief it is given. Work flows down as briefs and back up as reports. The workstream is a graph of threads: dependencies are its edges, so dependent work waits while independent branches run in parallel (with bounded review-gate loops as the one deliberate cycle) — and the graph is not fixed; it is expected to be amended and replanned as understanding improves.\n\nGetting information from another thread, cheapest first: a thread's REPORT is its curated hand-back — read that first. The workstream GRAPH lets you see every thread and find any of them without searching (`workstream_list`). To resolve an ambiguity, CONSULT the thread that holds the context. The full thread history can be accessed via the Pi session jsonl file if necessary.\n\nA few principles keep this coherent:\n- Your assignment is your task. For a child that is its spawn brief; at the root it is the user's direction. An inherited goal is background - align to it, but where it and your assignment differ, follow the assignment.\n- Work at your level. If you orchestrate, delegate substantial work to children rather than absorbing it inline, and when new non-trivial work crystallises mid-conversation, pause to lay out or amend the graph before diving in. If you execute a brief, do the work directly.\n- Status describes the plan; runtime is the truth. A thread's status is where it sits in the workflow; whether its agent is actually working is a separate, system-tracked fact. Lean on the system's signals for a child's state rather than inferring from a single quiet look — and if a signal looks wrong for what you can plainly see, verify rather than act blindly.\n- System notices are not the human. Automated workstream notices (a child finished, needs attention, recovered) are control-plane signals for you to act on, not messages from the user.\n- Your worktree is your workspace. Every edit and commit you make lands in your own worktree (your process cwd) and nowhere else — any other checkout of this project (another thread's worktree, the parent's worktree, or the project's base workspace root) is read-only context (reports, evidence), never somewhere to `cd` into and write. This matters doubly if you orchestrate: children's worktrees are cut from YOUR branch, so a file committed anywhere else — however canonical its path looks — is invisible to every child you spawn. If a brief seems to require editing outside your own worktree, that is a brief error: surface it rather than comply.\n- Search your worktree, not the roots above it. Your worktree is small, but the workspace and cockpit roots that contain it are vast (every sibling worktree's node_modules), so an unbounded `find`/`grep` from one of those roots can crawl for many minutes. Never search them unscoped: stay within your worktree, or bound the walk (`-maxdepth`, a named subtree, or a tool like `rg` that skips gitignored trees) rather than let a search wander into other threads' trees. A guard blocks unbounded recursive searches outside your worktree and auto-bounds unbounded search pipelines to 30s — when a file is not where you expected, do not search wider: verify the exact paths your brief gave you first (brief paths are authoritative), then run a focused bounded search, and only as a last resort consult the thread that holds the context (`consult_thread` — expensive).\n- Setup may still be running. Worktree environment setup can run in the background after you start, so before any command that needs the project environment (installs, builds, tests, typecheck, dev servers) check the setup breadcrumb — `cat \"$(git rev-parse --git-dir)/t3code-setup-state.json\"`: `ready` proceed; `pending` do reading/editing/planning first and re-check (poll, don't run installs yourself); `failed` inspect its `detail` and the setup terminal output, then fix or report the setup failure rather than blindly rerunning installs; file absent means no setup script was configured — assume the repo is in its normal provided state.";

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

export type PiDriverEnv = ServerConfig | ProviderHealthRegistry | ServerSettingsService;

/** Failover config used when settings can't be read (rare, cache-backed). */
const DEFAULT_FAILOVER: Pick<ProviderFailoverSettings, "enabled" | "chains"> = {
  enabled: true,
  chains: undefined,
};

/**
 * Outcome of tier-2 effective-model resolution (§5.4). Kept distinct so a
 * dispatch NEVER lands on an exhausted/paused account: "intended" and
 * "fallback" carry a concrete slug to run on; "exhausted" means the intent is
 * exhausted/paused with no healthy target (or failover off) — the turn must
 * fail `quota_exhausted` for the resume sweep, not dispatch.
 */
type EffectiveResolution =
  | { readonly kind: "intended"; readonly slug: string }
  | { readonly kind: "fallback"; readonly slug: string }
  | { readonly kind: "exhausted" };

interface ActivePiSession {
  session: ProviderSession;
  process: PiRpcProcess;
  // Recreate the pi process with this session's exact launch options (same
  // sessionId, so pi re-reads the same on-disk file). Used to relaunch from a
  // freshly sanitised history when a live session crosses into an
  // Anthropic-family model carrying codex-poisoned tool ids in its in-memory
  // history (which we cannot rewrite — pi owns it), so the replay is clean.
  launch: () => Promise<PiRpcProcess>;
  turns: Array<{ id: TurnId; items: Array<unknown> }>;
  unsubscribe: () => void;
  activeTurnId: TurnId | undefined;
  // Turn id `turn.started` was last emitted for. pi re-emits `agent_start` per
  // auto-retry attempt and per T3-level retry re-prompt within the SAME T3
  // turn; a duplicate `turn.started` would re-run downstream turn-start logic.
  turnStartedFor: TurnId | undefined;
  // Last thinking level applied via set_thinking_level (session.model plays the
  // same role for set_model): every turn re-asserts the thread's stored
  // selection, so these let applyModelSelection skip no-op RPCs.
  thinkingLevel: PiThinkingLevel | undefined;
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
  // Tier-2 effective-model tracking (§5.4): the slug this session is currently
  // running on after failover resolution. Distinct from `session.model` (which
  // the tier-1 transient path also mutates); used solely to dedupe
  // `model.rerouted` emission so it fires once per effective-slug change.
  lastEffectiveModel: string | undefined;
  // Window label (e.g. "weekly") and formatted reset time of the exhaustion
  // that last forced a reroute, cached so the "back onto intended" reason can
  // name the window + when it reset (its health mark is already cleared by
  // then). §5.4.
  lastRerouteWindowLabel: string | undefined;
  lastRerouteResetAt: string | undefined;
  // pi delivers tool input only on `tool_execution_start`/`update.args` and the
  // bare result on `tool_execution_end` — so we stash the args by toolCallId on
  // start/update and merge them back into the `item.completed` payload on end.
  // Without this the loop signature (and timeline) sees only result-less generic
  // tokens and collapses every same-type call to one (false "stuck loop").
  toolArgs: Map<string, Record<string, unknown>>;
  // Correlates pi's response id with the native dialog method so Loom can
  // unmap its shared answer record back into pi's method-specific wire shape.
  uiRequests: Map<string, "select" | "confirm" | "input" | "editor">;
  unregisterAskUserEmitter: () => void;
  materializedActivityImages: Map<string, ChatAttachment>;
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
const CURATED_PI_MODELS: ReadonlyArray<{
  readonly slug: string;
  readonly name: string;
  readonly subProvider: string;
}> = [
  // Names mirror what `piCatalogModels` derives from the live catalogue so
  // the placeholder and enriched snapshots agree: pi's own names already
  // carry "(Vertex)" for google-vertex-claude, and "GPT-5.5" collides across
  // the openai/openai-codex backends (hence the "(Codex)" suffix).
  { slug: PI_DEFAULT_MODEL, name: "Claude Opus 4.8 (Vertex)", subProvider: "Vertex" },
  { slug: "openai-codex/gpt-5.5", name: "GPT-5.5 (Codex)", subProvider: "Codex" },
  {
    slug: "google-vertex/gemini-3.1-pro-preview",
    name: "Gemini 3.1 Pro Preview",
    subProvider: "Vertex",
  },
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

/**
 * Backend label for a catalogue model. Bedrock ids carry a region routing
 * prefix (e.g. `au.anthropic.claude-…`) which is surfaced as "Bedrock AU";
 * unknown provider ids fall back to the raw id so the backend is never
 * silently ambiguous. Labels come from the shared USAGE_BACKEND_DISPLAY_NAMES
 * map so the model picker and the /usage dashboard's scope tabs never drift.
 */
export function piBackendLabel(provider: string, modelId: string): string {
  const base = USAGE_BACKEND_DISPLAY_NAMES[provider] ?? provider;
  if (provider !== "bedrock") return base;
  const region = /^([a-z]{2,5})\./.exec(modelId)?.[1];
  return region ? `${base} ${region.toUpperCase()}` : base;
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
      subProvider: model.subProvider,
      isCustom: false,
      capabilities: PI_CAPABILITIES,
    })),
    ...piCustomModels(settings),
  ];
}

/**
 * Full pi catalogue, curated shortlist first, then pi's own order, then
 * custom. Every model carries its backend label as `subProvider` (shown as
 * secondary text in the picker), and models whose display names collide
 * across backends (e.g. "GPT-5.5" on both openai and openai-codex) get the
 * label appended to the name so identical rows stay distinguishable.
 */
export function piCatalogModels(
  available: ReadonlyArray<PiAvailableModel>,
  settings: PiSettings,
): ReadonlyArray<ServerProviderModel> {
  const nameCounts = new Map<string, number>();
  for (const model of available) {
    nameCounts.set(model.name, (nameCounts.get(model.name) ?? 0) + 1);
  }
  const builtIn = available
    .map((model) => {
      const label = piBackendLabel(model.provider, model.id);
      return {
        slug: `${model.provider}/${model.id}`,
        name: (nameCounts.get(model.name) ?? 0) > 1 ? `${model.name} (${label})` : model.name,
        subProvider: label,
        isCustom: false as const,
        capabilities: PI_CAPABILITIES,
      };
    })
    .sort((a, b) => curatedRank(a.slug) - curatedRank(b.slug));
  return [...builtIn, ...piCustomModels(settings)];
}

const PI_SKILL_NAME_PREFIX = "skill:";

/**
 * Split pi's unified `get_commands` list into the snapshot's two surfaces:
 * `source === "skill"` populates the `$` skill palette (with the `skill:`
 * display prefix stripped), while extension/prompt-template commands populate
 * the `/` slash-command menu. Commands without a usable name are dropped so the
 * palette never renders a blank row.
 */
export function piCommandsToSnapshot(commands: ReadonlyArray<PiRpcCommandInfo>): {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
} {
  const slashCommands: Array<ServerProviderSlashCommand> = [];
  const skills: Array<ServerProviderSkill> = [];
  for (const command of commands) {
    const description = command.description?.trim() ? command.description.trim() : undefined;
    if (command.source === "skill") {
      const name = command.name.startsWith(PI_SKILL_NAME_PREFIX)
        ? command.name.slice(PI_SKILL_NAME_PREFIX.length)
        : command.name;
      if (!name.trim()) continue;
      const path = command.sourceInfo?.path?.trim();
      const scope = command.sourceInfo?.scope?.trim();
      skills.push({
        name,
        // `path` is required by the contract; fall back to the skill name so a
        // skill without source metadata still surfaces in the palette.
        path: path && path.length > 0 ? path : name,
        enabled: true,
        ...(description ? { description } : {}),
        ...(scope ? { scope } : {}),
      });
      continue;
    }
    const name = command.name.trim();
    if (!name) continue;
    slashCommands.push({
      name,
      ...(description ? { description } : {}),
    });
  }
  return { slashCommands, skills };
}

/**
 * Replace the snapshot's placeholder model list with pi's live catalogue and
 * populate its slash-command/skill palette by running a throwaway
 * `pi --mode rpc` process and asking `get_available_models` + `get_commands`
 * within the same acquire/use/release. Failures (pi not installed, not authed,
 * RPC error) are logged and ignored so the picker falls back to the curated
 * shortlist and the palette degrades to empty lists.
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
    const enrichment = yield* Effect.acquireUseRelease(
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
        // Batch both discovery requests into the one short-lived process rather
        // than spawning pi twice per refresh.
        Effect.promise(async () => {
          const modelsResponse = await proc.request<{
            readonly models: ReadonlyArray<PiAvailableModel>;
          }>({ type: "get_available_models" }, PI_ENRICHMENT_REQUEST_TIMEOUT_MS);
          // `get_commands` is best-effort: an older pi that doesn't support it
          // must not blank the freshly fetched model catalogue.
          const commandsResponse = await proc
            .request<{ readonly commands: ReadonlyArray<PiRpcCommandInfo> }>(
              { type: "get_commands" },
              PI_ENRICHMENT_REQUEST_TIMEOUT_MS,
            )
            .catch(() => undefined);
          return { modelsResponse, commandsResponse };
        }),
      (proc) => Effect.promise(() => proc.stop()),
    );
    const models = enrichment.modelsResponse.data?.models ?? [];
    const { slashCommands, skills } = piCommandsToSnapshot(
      enrichment.commandsResponse?.data?.commands ?? [],
    );
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
      slashCommands,
      skills,
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

const MAX_ACTIVITY_TEXT_CHARS = 12_000;
const CHILD_MESSAGE_TAIL_COUNT = 2;

function truncateActivityText(value: string): string {
  return value.length > MAX_ACTIVITY_TEXT_CHARS
    ? `${value.slice(0, MAX_ACTIVITY_TEXT_CHARS)}\n… [truncated ${value.length - MAX_ACTIVITY_TEXT_CHARS} chars]`
    : value;
}

function imageMimeFromBase64(value: string): string | null {
  if (value.startsWith("iVBOR")) return "image/png";
  if (value.startsWith("/9j/")) return "image/jpeg";
  if (value.startsWith("R0lGOD")) return "image/gif";
  if (value.startsWith("UklGR")) return "image/webp";
  return null;
}

function materializeInlineActivityImage(input: {
  readonly threadId: ThreadId;
  readonly attachmentsDir: string;
  readonly cache: Map<string, ChatAttachment>;
  readonly value: string;
}): unknown {
  const dataUrlMatch = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(
    input.value,
  );
  const mimeType = dataUrlMatch?.[1] ?? imageMimeFromBase64(input.value.slice(0, 16));
  const base64 = (dataUrlMatch?.[2] ?? input.value).replace(/\s+/g, "");
  if (!mimeType || base64.length < 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return null;

  const hash = NodeCrypto.createHash("sha256").update(base64).digest("hex");
  const cached = input.cache.get(hash);
  if (cached) return { attachment: cached };

  const id = createAttachmentId(input.threadId);
  if (!id) return null;
  const buffer = Buffer.from(base64, "base64");
  const attachment: ChatAttachment = {
    type: "image",
    id,
    name: `activity-image-${id}`,
    mimeType,
    sizeBytes: buffer.byteLength,
  };
  const relativePath = attachmentRelativePath(attachment);
  NodeFS.mkdirSync(input.attachmentsDir, { recursive: true });
  NodeFS.writeFileSync(`${input.attachmentsDir}/${relativePath}`, buffer);
  input.cache.set(hash, attachment);
  return { attachment };
}

function compactChildResult(value: unknown): unknown {
  const result = asArgsRecord(value);
  if (!result) return value;
  const messages = Array.isArray(result.messages) ? result.messages : [];
  const tail = messages.slice(-CHILD_MESSAGE_TAIL_COUNT).flatMap((message) => {
    const record = asArgsRecord(message);
    const text =
      typeof record?.content === "string"
        ? record.content
        : Array.isArray(record?.content) &&
            typeof asArgsRecord(record.content[0])?.text === "string"
          ? String(asArgsRecord(record.content[0])?.text)
          : undefined;
    return text
      ? [
          {
            role: typeof record?.role === "string" ? record.role : undefined,
            text: truncateActivityText(text).slice(0, 1_000),
          },
        ]
      : [];
  });
  return {
    childThreadId: result.childThreadId ?? result.threadId ?? result.id,
    title: result.title ?? result.name,
    status: result.status ?? result.outcome,
    messageCount: messages.length,
    ...(tail.length > 0 ? { tail } : {}),
    transcriptRef:
      result.sessionPath ?? result.sessionFile ?? result.reportPath ?? result.childThreadId,
  };
}

function slimActivityValue(input: {
  readonly threadId: ThreadId;
  readonly attachmentsDir: string;
  readonly cache: Map<string, ChatAttachment>;
  readonly value: unknown;
  readonly key?: string;
}): unknown {
  if (typeof input.value === "string") {
    return (
      materializeInlineActivityImage({ ...input, value: input.value }) ??
      truncateActivityText(input.value)
    );
  }
  if (Array.isArray(input.value)) {
    return input.value.map((entry) =>
      slimActivityValue({
        threadId: input.threadId,
        attachmentsDir: input.attachmentsDir,
        cache: input.cache,
        value: entry,
      }),
    );
  }
  const record = asArgsRecord(input.value);
  if (!record) return input.value;

  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (key === "content" && input.key === "truncation") continue;
    next[key] =
      key === "results" && input.key === "details" && Array.isArray(value)
        ? value.map(compactChildResult)
        : slimActivityValue({ ...input, value, key });
  }
  return next;
}

export function slimPiToolPayloadData(input: {
  readonly threadId: ThreadId;
  readonly attachmentsDir: string;
  readonly cache: Map<string, ChatAttachment>;
  readonly itemType: ReturnType<typeof toolItemType>;
  readonly data: unknown;
}): unknown {
  return slimActivityValue({
    threadId: input.threadId,
    attachmentsDir: input.attachmentsDir,
    cache: input.cache,
    value: input.data,
  });
}

/**
 * Derive the human-readable one-liner for a tool call from its args: the
 * command for shell tools, the search pattern/query, the file path, or the
 * URL. This is what every adapter is expected to put in `payload.detail` —
 * without it the work log shows a bare, inert tool name (e.g. "Bash").
 */
export function piToolDetail(args: Record<string, unknown> | undefined): string | undefined {
  if (!args) return undefined;
  const str = (value: unknown) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed.length > 0 ? trimmed : undefined;
  };
  const command = str(args.command) ?? str(args.cmd);
  if (command) return command.slice(0, 400);
  const path = str(args.path) ?? str(args.filePath) ?? str(args.file);
  const pattern = str(args.pattern) ?? str(args.query);
  if (pattern) return (path ? `${pattern} ${path}` : pattern).slice(0, 400);
  return (path ?? str(args.url) ?? str(args.title))?.slice(0, 400);
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
  detail?: string;
  data?: unknown;
} {
  const itemType = toolItemType(message.toolName);
  if (message.type === "tool_execution_end") {
    const stashed = toolArgs.get(message.toolCallId);
    toolArgs.delete(message.toolCallId);
    const detail = piToolDetail(stashed);
    return {
      itemType,
      status: message.isError ? "failed" : "completed",
      title: message.toolName,
      ...(detail ? { detail } : {}),
      data: mergeRawInput(message.result, stashed),
    };
  }
  const args = asArgsRecord(message.args);
  if (args) toolArgs.set(message.toolCallId, args);
  const detail = piToolDetail(args ?? toolArgs.get(message.toolCallId));
  return {
    itemType,
    status: "inProgress",
    title: message.toolName,
    ...(detail ? { detail } : {}),
    data:
      message.type === "tool_execution_update"
        ? (message.partialResult ?? message.args)
        : message.args,
  };
}

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
  // `cacheWrite` is the total cache-creation bucket; `cacheWrite1h` is a
  // SUBSET of it (Anthropic's 1h-retention split), so it must not be added.
  const cacheWrite = num(record.cacheWrite);
  return {
    usedTokens,
    inputTokens: promptTokens,
    cachedInputTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
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

export function makePiAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: PiSettings;
  readonly serverConfig: ServerConfig["Service"];
  readonly events: Queue.Queue<ProviderRuntimeEvent>;
  // loom: forkFrom — injectable pi process factory (defaults to the real
  // createPiRpcProcess). Lets driver-boundary tests capture the argv/forkFrom a
  // launch produces and drive the stream without spawning a real pi binary.
  readonly createProcess?: (options: PiRpcProcessOptions) => Promise<PiRpcProcess>;
  // Shared slug -> context-window map populated by `enrichPiSnapshot` from pi's
  // live catalogue; read synchronously here to set token-usage `maxTokens`.
  readonly modelContextWindows: Map<string, number>;
  // Exhaustion state: consulted for quota corroboration and written on
  // error-classified quota failures, and read for tier-2 effective routing.
  readonly healthRegistry: ProviderHealthRegistryShape;
  // Reads the current tier-2 failover config (master switch + chain overrides)
  // fresh each dispatch; defaults to enabled-with-built-ins if settings error.
  readonly readFailover: Effect.Effect<Pick<ProviderFailoverSettings, "enabled" | "chains">>;
  // True when THIS instance declares its own `usageSources`. Such an instance
  // meters exhaustion under its instance id, so a custom-provider slug whose
  // namespace has no static account mapping routes to the instance key instead
  // of going untracked. Read fresh so a settings edit needs no restart.
  readonly readInstanceUsesUsageSources: Effect.Effect<boolean>;
}): ProviderAdapterShape<
  | ProviderAdapterProcessError
  | ProviderAdapterRequestError
  | ProviderAdapterSessionNotFoundError
  | ProviderAdapterValidationError
> {
  const sessions = new Map<ThreadId, ActivePiSession>();
  // loom: forkFrom (D2/D8) — durable per-thread launch-identity sidecars +
  // kickoff-delivered markers live under this dir.
  const launchIdentityDir = input.serverConfig.workstreamLaunchIdentityDir;
  const emit = (event: ProviderRuntimeEvent) =>
    Queue.offer(input.events, event).pipe(Effect.asVoid);
  // Same offer, but surfacing whether it actually landed. `Queue.offer` on a
  // shut-down queue succeeds without delivering, so a terminal event emitted
  // during teardown can vanish between the canonical log and the database — the
  // broker's durable fallback keys off this flag.
  const emitDelivered = (event: ProviderRuntimeEvent) => Queue.offer(input.events, event);
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

  const emitUserInputResolved = (
    session: ActivePiSession,
    requestId: string,
    answers: Record<string, unknown>,
    cancelled = false,
  ) =>
    emitDelivered({
      ...sessionBase(session, {
        source: "pi.rpc.synthetic",
        method: cancelled ? "ask_user_question/cancelled" : "user-input/resolved",
        payload: { answers, cancelled },
      }),
      requestId: RuntimeRequestId.make(requestId),
      type: "user-input.resolved",
      payload: { answers, outcome: cancelled ? "cancelled" : "answered" },
    });

  const cancelLegacyUserInputs = (session: ActivePiSession) => {
    const requestIds = [...session.uiRequests.keys()];
    // Claim every request before emitting so a concurrent UI answer cannot
    // also settle the same native dialog.
    session.uiRequests.clear();
    return Effect.forEach(
      requestIds,
      (requestId) => emitUserInputResolved(session, requestId, {}, true),
      { discard: true },
    );
  };

  const cancelPendingUserInputs = (session: ActivePiSession) =>
    Effect.promise(() => cancelPiAskUserQuestions(session.session.threadId)).pipe(
      Effect.andThen(cancelLegacyUserInputs(session)),
    );

  // Clear any pending T3 retry and, if the backend fallback engaged, restore
  // the turn's original model (per-turn fallback: subsequent turns must run on
  // the thread's selected model — sendTurn re-issues set_model anyway; this is
  // belt-and-braces for non-orchestrated sends). Best-effort: a failed restore
  // is ignored — session.model then still names the fallback slug, so the next
  // applyModelSelection won't dedupe-skip the authoritative set_model.
  const settleRetry = (session: ActivePiSession): Effect.Effect<void> => {
    const retry = session.retry;
    session.retry = undefined;
    if (!retry) return Effect.void;
    if (retry.timer !== undefined) clearTimeout(retry.timer);
    const originalModel = retry.originalModel;
    if (originalModel === undefined || originalModel === session.session.model) return Effect.void;
    const model = resolvePiModel(originalModel);
    return model
      ? Effect.promise(() =>
          session.process
            .request({ type: "set_model", provider: model.provider, modelId: model.modelId })
            .then(() => void updateSession(session, { model: originalModel })),
        ).pipe(Effect.ignore)
      : Effect.void;
  };

  // Tier-2 effective routing (§5.4): the thread's stored selection is the
  // *intent* and is never rewritten; each dispatch resolves an *effective* slug
  // — the intent when healthy, a failover target when the intent's account is
  // exhausted and tier-2 is enabled. Pure branch logic lives in
  // `resolveFailoverTarget`; here we just gather the (synchronous) health
  // snapshot + settings and feed it in. Stateless: one decision per dispatch,
  // no ladder.
  // Account key for an intent slug: the static slug-namespace mapping, falling
  // back to this instance's id when the instance declares usageSources (so a
  // pooled `cliproxy/*` slug is tracked under `cliproxy` rather than untracked).
  const accountKeyForIntent = (intentSlug: string): Effect.Effect<string | null> =>
    input.readInstanceUsesUsageSources.pipe(
      Effect.map(
        (usesSources) =>
          accountKeyForModelSlug(intentSlug) ?? (usesSources ? input.instanceId : null),
      ),
    );

  const resolveEffectiveModel = (intentSlug: string): Effect.Effect<EffectiveResolution> =>
    Effect.gen(function* () {
      const accountKey = yield* accountKeyForIntent(intentSlug);
      // API-billed slugs never register exhaustion (no subscription window).
      if (accountKey === null) return { kind: "intended", slug: intentSlug };
      const modelId = resolvePiModel(intentSlug)?.modelId;
      const marks = yield* input.healthRegistry.snapshot;
      const isExhausted = (key: string, id?: string) =>
        marks.some((mark) => markMatchesAccount(mark, key, id));
      if (!isExhausted(accountKey, modelId)) return { kind: "intended", slug: intentSlug };
      // Intent is exhausted/paused. Disabled failover ⇒ fail and wait for reset
      // (§5.4); enabled ⇒ reroute, failing only when no healthy target exists.
      const failover = yield* input.readFailover;
      if (!failover.enabled) return { kind: "exhausted" };
      const target = resolveFailoverTarget({
        slug: intentSlug,
        catalogue: new Set(input.modelContextWindows.keys()),
        isExhausted,
        ...(failover.chains ? { chains: failover.chains } : {}),
      });
      return target === undefined ? { kind: "exhausted" } : { kind: "fallback", slug: target };
    });

  // Describe the intent's active exhaustion for reason/message strings: which
  // window tripped, the model display name, reset time, and whether it is a
  // manual pause (which has no reset).
  const describeExhaustion = (
    intentSlug: string,
  ): Effect.Effect<{
    readonly windowLabel: string | undefined;
    readonly displayName: string | undefined;
    readonly resetsAt: string | undefined;
    readonly paused: boolean;
  }> =>
    Effect.gen(function* () {
      const accountKey = yield* accountKeyForIntent(intentSlug);
      const modelId = resolvePiModel(intentSlug)?.modelId;
      if (accountKey === null)
        return {
          windowLabel: undefined,
          displayName: undefined,
          resetsAt: undefined,
          paused: false,
        };
      const [until, marks] = yield* Effect.all([
        input.healthRegistry.exhaustedUntil(accountKey, modelId),
        input.healthRegistry.snapshot,
      ]);
      const mark = marks.find((m) => markMatchesAccount(m, accountKey, modelId));
      return {
        windowLabel: mark?.windowLabel,
        displayName: mark?.displayName,
        resetsAt: formatResetTime(until),
        paused: mark?.source === "manual",
      };
    });

  // "(Fable, resets 07 Jul 23:00)" / "(manually paused)" qualifier.
  const exhaustionQualifier = (d: {
    readonly displayName: string | undefined;
    readonly resetsAt: string | undefined;
    readonly paused: boolean;
  }): string => {
    const bits = [
      d.displayName,
      d.resetsAt ? `resets ${d.resetsAt}` : d.paused ? "manually paused" : undefined,
    ].filter((bit): bit is string => Boolean(bit));
    return bits.length > 0 ? ` (${bits.join(", ")})` : "";
  };

  // Reason for a reroute ONTO a fallback (§5.4 wording): names the exhausted
  // window + reset time (or pause), and never claims a reset when none is known.
  const rerouteReasonFrom = (
    d: {
      readonly windowLabel: string | undefined;
      readonly displayName: string | undefined;
      readonly resetsAt: string | undefined;
      readonly paused: boolean;
    },
    intentSlug: string,
    effective: string,
  ): string => {
    const limit = d.windowLabel ? `${d.windowLabel} limit` : "usage limit";
    const tail = d.resetsAt ? " until it resets" : d.paused ? " until unpaused" : "";
    return `${intentSlug} ${limit} reached${exhaustionQualifier(d)} — running on ${effective}${tail}.`;
  };

  // Reason for reverting BACK onto the intended model once its window reset,
  // using the window label + reset time cached when we routed onto the fallback
  // (the health mark is gone by now); clears the cache. Avoids reset-shaped
  // wording when no reset time was known (e.g. a manual unpause).
  const restoreReason = (
    session: ActivePiSession,
    intentSlug: string,
    last: string | undefined,
  ): string => {
    const window = session.lastRerouteWindowLabel ? `${session.lastRerouteWindowLabel} ` : "";
    const resetAt = session.lastRerouteResetAt;
    session.lastRerouteWindowLabel = undefined;
    session.lastRerouteResetAt = undefined;
    const wasRouted = last ? ` (was routed to ${last})` : "";
    return resetAt
      ? `${intentSlug} ${window}usage window reset at ${resetAt} — resuming on it${wasRouted}.`
      : `${intentSlug} is available again — resuming on it${wasRouted}.`;
  };

  // Terminal-failure message when the intent is exhausted and no fallback is
  // available — the resume sweep (chunk D) restarts it once the window resets.
  const exhaustedFailureMessage = (intentSlug: string): Effect.Effect<string> =>
    Effect.gen(function* () {
      const d = yield* describeExhaustion(intentSlug);
      const limit = d.windowLabel ? `${d.windowLabel} limit` : "usage limit";
      const tail = d.paused ? " — account is paused" : " — waiting for reset";
      return `${intentSlug} ${limit} reached${exhaustionQualifier(d)}; no healthy fallback available${tail}.`;
    });

  // Emit `model.rerouted` only when the effective slug changes (both directions),
  // deduped via `lastEffectiveModel`. The very first dispatch onto a healthy
  // intent is silent; a first dispatch already on a fallback (exhausted at
  // kick-off) still announces. Never called for the "exhausted" outcome, so no
  // false "available again" fires while the intent is still exhausted.
  const maybeEmitReroute = (
    session: ActivePiSession,
    intentSlug: string,
    effective: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const last = session.lastEffectiveModel;
      session.lastEffectiveModel = effective;
      if (effective === last || (last === undefined && effective === intentSlug)) return;
      if (effective !== intentSlug) {
        const d = yield* describeExhaustion(intentSlug);
        session.lastRerouteWindowLabel = d.windowLabel;
        session.lastRerouteResetAt = d.resetsAt;
        yield* emit({
          ...sessionBase(session),
          type: "model.rerouted",
          payload: {
            fromModel: intentSlug,
            toModel: effective,
            reason: rerouteReasonFrom(d, intentSlug, effective),
          },
        });
      } else {
        yield* emit({
          ...sessionBase(session),
          type: "model.rerouted",
          payload: {
            fromModel: last ?? intentSlug,
            toModel: effective,
            reason: restoreReason(session, intentSlug, last),
          },
        });
      }
    });

  // Tell the live pi process which model/thinking level to run, skipping RPCs
  // whose value already matches what this adapter last applied. Called at
  // session start (pi would otherwise silently run the user's global default)
  // and on every turn that carries a selection. Applies tier-2 effective
  // routing so an exhausted intent runs on its fallback from the first dispatch.
  const applyModelSelection = (
    session: ActivePiSession,
    selection: ModelSelection,
    resolution?: EffectiveResolution,
  ): Effect.Effect<void, ProviderAdapterRequestError> =>
    Effect.gen(function* () {
      const resolved =
        resolution ??
        (resolvePiModel(selection.model)
          ? yield* resolveEffectiveModel(selection.model)
          : ({ kind: "intended", slug: selection.model } as EffectiveResolution));
      // Only configure a model when we have a concrete slug to run on. The
      // "exhausted" outcome must NOT set_model the dead account (sendTurn fails
      // the turn instead); at session start it simply leaves pi unconfigured
      // until the first turn fails.
      if (resolved.kind !== "exhausted") {
        const model = resolvePiModel(resolved.slug);
        if (model && resolved.slug !== session.session.model) {
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
          updateSession(session, { model: resolved.slug });
        }
        if (model) yield* maybeEmitReroute(session, selection.model, resolved.slug);
      }
      const thinkingLevel = getModelSelectionStringOptionValue(selection, "thinkingLevel") as
        | PiThinkingLevel
        | undefined;
      if (thinkingLevel && thinkingLevel !== session.thinkingLevel) {
        yield* Effect.tryPromise({
          try: () => session.process.request({ type: "set_thinking_level", level: thinkingLevel }),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: DRIVER_KIND,
              method: "set_thinking_level",
              detail: detailFromCause(cause, "Failed to set Pi thinking level."),
              cause,
            }),
        });
        session.thinkingLevel = thinkingLevel;
      }
    });

  // loom: D2 — persist the APPLIED selection (model slug + thinking level) that
  // served a turn's final round onto the thread's launch-identity record. A fork
  // replays this as the selection that most recently consumed the shared prefix.
  // BEST-EFFORT: a state-dir write failure must NOT suppress turn completion (a
  // suppressed completion would leave the projection/forks permanently running);
  // it forfeits only future cache identity for a fork of this thread, which is
  // logged and surfaces downstream as a loud fork-launch refusal (missing
  // record).
  // Run a synchronous best-effort disk write, returning the failure message (or
  // undefined on success) WITHOUT throwing into the Effect — the launch-identity
  // sidecar/marker are cache optimisations whose write must never fail a launch,
  // a turn settlement, or a send.
  const trySyncWrite = (run: () => void): string | undefined => {
    try {
      run();
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };

  const persistServedModel = (
    session: ActivePiSession,
    model: string | undefined,
    thinkingLevel: string | undefined,
  ) =>
    Effect.gen(function* () {
      const failure = trySyncWrite(() =>
        updateLaunchIdentityApplied(launchIdentityDir, session.session.threadId, {
          model,
          thinkingLevel,
        }),
      );
      if (failure !== undefined)
        yield* Effect.logWarning("forkFrom: failed to persist launch identity at settlement", {
          threadId: session.session.threadId,
          error: failure,
        });
    });

  // Settle the open turn as completed/interrupted (events are built while the
  // turn id is still set, then the id is cleared).
  const completeTurn = (
    session: ActivePiSession,
    state: "completed" | "interrupted",
    raw?: ProviderRuntimeEvent["raw"],
  ): Effect.Effect<void> => {
    const done = emit({ ...sessionBase(session, raw), type: "turn.completed", payload: { state } });
    // loom: D2 write order — snapshot the applied selection that served this
    // turn's final round BEFORE settleRetry restores the pre-fallback original,
    // advance the launch-identity record, THEN emit turn.completed. The
    // dispatcher's source-idle re-trigger derives from that event, so emitting
    // first would let a fork read a stale (pre-reroute) selection.
    const servedModel = session.session.model;
    const servedThinkingLevel = session.thinkingLevel;
    session.activeTurnId = undefined;
    updateSession(session, { status: "ready", activeTurnId: undefined });
    return cancelPendingUserInputs(session).pipe(
      Effect.andThen(persistServedModel(session, servedModel, servedThinkingLevel)),
      Effect.andThen(settleRetry(session)),
      Effect.andThen(done),
    );
  };

  // Terminal failure path (mirrors ClaudeAdapter): a runtime.error with class
  // provider_error plus turn.completed failed — ingestion turns these into
  // session status "error" + lastError, the UI banner, and the workstream
  // error wake.
  const failTurn = (
    session: ActivePiSession,
    errorMessage: string,
    raw?: ProviderRuntimeEvent["raw"],
    errorClass: RuntimeErrorClass = "provider_error",
  ): Effect.Effect<void> => {
    const events = emit({
      ...sessionBase(session, raw),
      type: "runtime.error",
      payload: { message: errorMessage, class: errorClass },
    }).pipe(
      Effect.andThen(
        emit({
          ...sessionBase(session, raw),
          type: "turn.completed",
          payload: { state: "failed", errorMessage },
        }),
      ),
    );
    // loom: D2 — a source can be lane-`done` via workstream_submit yet have its
    // provider turn settle in error afterwards; apply the same settlement update
    // here so a fork replays the selection that actually last consumed the prefix.
    const servedModel = session.session.model;
    const servedThinkingLevel = session.thinkingLevel;
    session.activeTurnId = undefined;
    updateSession(session, { status: "error", activeTurnId: undefined });
    return cancelPendingUserInputs(session).pipe(
      Effect.andThen(persistServedModel(session, servedModel, servedThinkingLevel)),
      Effect.andThen(settleRetry(session)),
      Effect.andThen(events),
    );
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
    const step = nextRetryStep(
      session.retry?.attempt ?? 0,
      session.session.model,
      input.modelContextWindows.keys(),
    );
    if (step === undefined) return undefined;
    const { attempt, delayMs, switchToModel } = step;
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

  // Reactive tier-2 switch on a quota-classified failure: set the fallback
  // model, announce the reroute, and re-prompt the still-open turn (mirrors
  // `dispatchTurnRetry`'s set_model + control-plane re-prompt). Stateless — a
  // single switch decision; if the fallback also dies quota-wise it re-enters
  // this path, marks the fallback, and the next resolution skips it (chains are
  // finite, so this terminates). A switch/re-prompt failure falls to the
  // terminal quota failure.
  const rerouteAndReprompt = (
    session: ActivePiSession,
    fromSlug: string,
    toSlug: string,
    errorMessage: string,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const model = resolvePiModel(toSlug);
      if (!model) {
        yield* failTurn(session, errorMessage, undefined, "quota_exhausted");
        return;
      }
      // Failing over onto an Anthropic-family model while the live pi history
      // still carries codex-poisoned tool ids in memory would replay them into a
      // fatal 400. Relaunch from sanitised disk first so the reroute lands clean
      // (the turn is between pi runs here, so restarting loses no in-flight run).
      if (
        slugRoutesToAnthropic(toSlug) &&
        threadSessionHasPoisonedToolIds(session.session.threadId)
      )
        yield* relaunchWithSanitisedHistory(session);
      const d = yield* describeExhaustion(fromSlug);
      session.lastRerouteWindowLabel = d.windowLabel;
      session.lastRerouteResetAt = d.resetsAt;
      const reason = rerouteReasonFrom(d, fromSlug, toSlug);
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
            detail: detailFromCause(cause, "Failed to switch Pi failover model."),
            cause,
          }),
      });
      updateSession(session, { model: toSlug });
      session.lastEffectiveModel = toSlug;
      yield* emit({
        ...sessionBase(session),
        type: "model.rerouted",
        payload: { fromModel: fromSlug, toModel: toSlug, reason },
      });
      yield* Effect.sleep(Duration.millis(T3_QUOTA_FAILOVER_DELAY_MS));
      yield* Effect.tryPromise({
        try: () =>
          session.process.request({ type: "prompt", message: buildPiRetryPrompt(errorMessage) }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: DRIVER_KIND,
            method: "prompt",
            detail: detailFromCause(cause, "Failed to dispatch Pi failover prompt."),
            cause,
          }),
      });
    }).pipe(
      Effect.catch((error) =>
        failTurn(
          session,
          `${errorMessage} (failover switch failed: ${error.detail})`,
          undefined,
          "quota_exhausted",
        ),
      ),
    );

  // Classify a failed turn's error and route it (§5.1/§5.3). Quota classification
  // runs BEFORE the transient ladder so a quota error never burns retries against
  // a dead account. Exhausted iff the message is quota-shaped, OR it is transient
  // AND the health registry already marks this slug's account exhausted (a bare
  // 429 during a known-exhausted window is exhaustion, not overload). On
  // exhaustion: record an error-sourced mark and fail with `quota_exhausted`
  // (rerouting is chunk C). Otherwise: existing transient ladder, then
  // `provider_error`.
  const classifyAndHandleError = (
    session: ActivePiSession,
    errorMessage: string,
    raw?: ProviderRuntimeEvent["raw"],
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const slug = session.session.model;
      const accountKey = slug ? yield* accountKeyForIntent(slug) : null;
      const modelId = slug ? resolvePiModel(slug)?.modelId : undefined;
      // A non-retryable client-request error (HTTP 400 invalid_request, e.g. a
      // codex-style tool_use.id Anthropic won't accept) replays identically
      // forever. Fail it now as validation_error — BEFORE quota/transient — so it
      // never enters the retry ladder or gets re-resumed as a quota stall (that
      // was the 400 flood). Recovery is the pre-spawn sanitise on next start.
      const errorClass = classifyPiProviderError(errorMessage);
      if (errorClass === "non_retryable_request") {
        yield* failTurn(session, errorMessage, raw, "validation_error");
        return;
      }
      const quotaByRegex = errorClass === "quota_shaped";
      const quotaByCorroboration =
        errorClass === "transient" &&
        accountKey !== null &&
        (yield* input.healthRegistry.isExhausted(accountKey, modelId));
      if (quotaByRegex || quotaByCorroboration) {
        if (accountKey !== null) {
          yield* input.healthRegistry.markExhausted({
            accountKey,
            modelScope: modelId ?? "*",
            until: null,
            source: "error",
          });
        }
        // With the mark now set, resolve a healthy fallback for the failed slug
        // and switch to it (tier 2 stays out of the transient ladder). No
        // healthy target (or failover disabled) ⇒ terminal quota failure, which
        // the resume sweep (chunk D) picks up at reset.
        const resolution = slug
          ? yield* resolveEffectiveModel(slug)
          : ({ kind: "exhausted" } as EffectiveResolution);
        if (resolution.kind === "fallback" && slug && resolvePiModel(resolution.slug)) {
          yield* rerouteAndReprompt(session, slug, resolution.slug, errorMessage);
          return;
        }
        yield* failTurn(session, errorMessage, raw, "quota_exhausted");
        return;
      }
      if (errorClass === "transient") {
        const retry = scheduleTurnRetry(session, errorMessage);
        if (retry) {
          yield* retry; // turn stays open through the retry window
          return;
        }
      }
      yield* failTurn(session, errorMessage, raw);
    });

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
        const normalized = normalizePiTokenUsage(
          message.message.usage,
          session.session.model ? input.modelContextWindows.get(session.session.model) : undefined,
        );
        // Model attribution for the usage ledger: the message's own `model` is
        // authoritative per message (survives mid-session model switches);
        // `responseModel` is the concrete inference model when pi reports one.
        const str = (value: unknown) =>
          typeof value === "string" && value.trim() ? value : undefined;
        // The session-state fallback holds a T3 slug ("anthropic/claude-x")
        // while pi's message.model is a bare id ("claude-x"); strip the
        // provider prefix so one model can't split into two ledger labels.
        const sessionModel = str(session.session.model);
        const model =
          str(message.message.model) ??
          (sessionModel ? (resolvePiModel(sessionModel)?.modelId ?? sessionModel) : undefined);
        const resolvedModel = str(message.message.responseModel);
        // Real backend provider for usage attribution. pi's per-message
        // `message.model` is a bare id with NO provider prefix, and pi surfaces
        // no per-message backend over RPC — only the session slug
        // (`session.session.model`, e.g. "google-vertex-claude/claude-opus-4-8")
        // carries the vendor. So attribution is the session's selected backend;
        // a subagent/oracle turn that transiently runs a different backend in
        // the same thread is attributed to the session backend (accepted
        // best-effort — no per-message signal exists to do better).
        const providerId = sessionModel ? resolvePiModel(sessionModel)?.provider : undefined;
        const usage = normalized
          ? {
              ...normalized,
              ...(model ? { model } : {}),
              ...(resolvedModel ? { resolvedModel } : {}),
              ...(providerId ? { providerId } : {}),
            }
          : undefined;
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
        const payload = piToolItemPayload(message, session.toolArgs);
        const slimData =
          payload.data === undefined
            ? undefined
            : slimPiToolPayloadData({
                threadId: session.session.threadId,
                attachmentsDir: input.serverConfig.attachmentsDir,
                cache: session.materializedActivityImages,
                itemType: payload.itemType,
                data: payload.data,
              });
        return emit({
          ...base({ itemId: message.toolCallId }),
          type: eventType,
          payload: {
            ...payload,
            ...(slimData !== undefined ? { data: slimData } : {}),
          },
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
        session.uiRequests.set(message.id, message.method);
        const options =
          message.method === "confirm"
            ? ["Yes", "No"]
            : message.method === "select"
              ? (message.options ?? [])
              : [];
        return emit({
          ...base({ requestId: message.id }),
          type: "user-input.requested",
          payload: {
            questions: [
              {
                id: message.id,
                header: message.title ?? "Pi request",
                question: message.message ?? message.title ?? "Pi requested input",
                options: options.map((option) => ({ label: option, description: option })),
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
        const settleInputs = cancelPendingUserInputs(session);
        // A finished run can no longer receive a native dialog response, even
        // when pi will auto-retry within the same T3 turn.
        if (message.willRetry === true) return settleInputs;
        if (session.activeTurnId === undefined) {
          updateSession(session, { status: "ready", activeTurnId: undefined });
          return settleInputs;
        }
        const outcome = piRunOutcome(message.messages);
        if (outcome.stopReason === "error") {
          return settleInputs.pipe(
            Effect.andThen(
              classifyAndHandleError(session, outcome.errorMessage ?? "Pi turn failed.", raw),
            ),
          );
        }
        return settleInputs.pipe(
          Effect.andThen(
            completeTurn(
              session,
              outcome.stopReason === "aborted" ? "interrupted" : "completed",
              raw,
            ),
          ),
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

  // Processes we deliberately swapped out during an in-place relaunch. Their
  // `exit` must NOT tear the session down (a replacement is already live) — only
  // an unplanned crash of the CURRENT process settles the session.
  const replacedProcesses = new WeakSet<PiRpcProcess>();

  // Attach this adapter's stream subscription + crash handler to a pi process.
  // Shared by session start and relaunch so both wire identical semantics.
  const wirePiProcess = (active: ActivePiSession, process: PiRpcProcess): void => {
    active.unsubscribe = process.subscribe(
      (message) => void Effect.runPromise(handleMessage(active, message)).catch(() => undefined),
    );
    process.child.once("exit", () => {
      if (replacedProcesses.has(process)) return;
      if (active.retry?.timer !== undefined) clearTimeout(active.retry.timer);
      sessions.delete(active.session.threadId);
      void (async () => {
        // Cancel BEFORE unregistering so the emitter is still present — but the
        // ordering is no longer load-bearing: the broker persists the resolution
        // through the command path whenever the emit cannot be delivered, so an
        // absent emitter or an already-shut-down queue both still settle.
        await Effect.runPromise(cancelPendingUserInputs(active)).catch(() => undefined);
        active.unregisterAskUserEmitter();
        await Effect.runPromise(
          emit({
            ...eventBase({
              instanceId: input.instanceId,
              threadId: active.session.threadId,
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
      })();
    });
  };

  // Restart the pi process from a freshly sanitised session file. The codex
  // poison lives in pi's IN-MEMORY history too (pi owns it, we can't rewrite
  // it), so an in-session set_model into an Anthropic-family model would replay
  // the poison and hit a fatal 400. Stopping the process first means the disk
  // rewrite never races a live writer; the replacement reads the clean file and
  // resumes identically (disk is the source of truth for a pi resume). Model +
  // thinking level are cleared so the caller's set_model/thinking re-applies on
  // the fresh process. Only safe between turns (no in-flight pi run to lose).
  const relaunchWithSanitisedHistory = (
    session: ActivePiSession,
  ): Effect.Effect<void, ProviderAdapterProcessError> =>
    Effect.gen(function* () {
      const previous = session.process;
      replacedProcesses.add(previous);
      if (session.retry?.timer !== undefined) {
        clearTimeout(session.retry.timer);
        session.retry = { ...session.retry, timer: undefined };
      }
      // D10: the replaced process's exit handler is short-circuited by
      // `replacedProcesses`, so without this an in-flight question survives the
      // relaunch — the tool call that would collect the answer died with the old
      // process, so answering would "succeed" (panel clears, resolved emitted)
      // and go nowhere. Cancel before the swap: apparent success with no
      // delivery is worse than a visible cancellation.
      yield* cancelPendingUserInputs(session);
      yield* Effect.promise(() => previous.stop());
      session.unsubscribe();
      yield* Effect.sync(() => sanitisePiSessionForThread(session.session.threadId));
      const next = yield* Effect.tryPromise({
        try: () => session.launch(),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: DRIVER_KIND,
            threadId: session.session.threadId,
            detail: detailFromCause(cause, "Failed to relaunch Pi RPC process."),
            cause,
          }),
      });
      session.process = next;
      session.currentAssistantMessageId = undefined;
      // Force the caller's set_model/thinking to re-apply on the fresh process:
      // clear the thinking dedupe (a stale model slug already differs from the
      // Anthropic target we're switching to, so set_model won't dedupe-skip).
      session.thinkingLevel = undefined;
      wirePiProcess(session, next);
    });

  return {
    provider: DRIVER_KIND,
    capabilities: { sessionModelSwitch: "in-session" },
    startSession: (startInput) =>
      Effect.gen(function* () {
        const platform = yield* HostProcessPlatform;
        // Pre-spawn defence for the codex→Anthropic tool_use.id bug: before pi
        // reads its session file, rewrite any codex-style joined ids so the
        // replayed history survives Anthropic's `^[a-zA-Z0-9_-]+$` validator.
        // Pre-spawn is the one moment we own the file (no live pi process is
        // writing it). Gated on the EFFECTIVE model being Anthropic-family so a
        // codex resume keeps its joined ids intact; idempotent + a no-op on a
        // clean history. Covers every restart-based resume (server restart,
        // reconnect, and the exhaustion resume sweep once the process exited).
        const intendedSlug = startInput.modelSelection?.model;
        if (intendedSlug && resolvePiModel(intendedSlug)) {
          const resolution = yield* resolveEffectiveModel(intendedSlug);
          const effectiveSlug = resolution.kind === "exhausted" ? intendedSlug : resolution.slug;
          if (slugRoutesToAnthropic(effectiveSlug))
            yield* Effect.sync(() => sanitisePiSessionForThread(startInput.threadId));
        }
        // loom: forkFrom (D2) — a fork child's FIRST launch replays the SOURCE's
        // captured launch identity verbatim (final argv appendSystemPrompt /
        // tools / skills) instead of the reactor-composed values, which are
        // mutable intent and would break prefix-identity caching. Detected by
        // the same fork-once condition the launch closure uses: a fork source is
        // set and the child has no session file yet. A missing record (source
        // predates the feature, was force-`done` without launching, or its
        // session was deleted) is a readable refusal, not a silent divergence.
        const forkFirstLaunch =
          startInput.forkFromThreadId !== undefined &&
          resolveSessionFilePath(piSessionIdForThread(startInput.threadId)) === undefined;
        // loom: forkIdentity "compose" — a role-divergent fork (e.g. a retro
        // reviewer) launches with its OWN reactor-composed identity instead of
        // replaying the source argv: the source's system prompt carries the
        // source ROLE's policy, which a diverging fork must not inherit. The
        // session content is still forked; only the argv identity differs, so
        // no launch-identity record is needed (and the missing-record refusal
        // below does not apply — it guards verbatim replay only).
        const composeForkIdentity = startInput.forkIdentity === "compose";
        const forkRecord =
          forkFirstLaunch && !composeForkIdentity && startInput.forkFromThreadId !== undefined
            ? readLaunchIdentity(launchIdentityDir, startInput.forkFromThreadId)
            : undefined;
        if (forkFirstLaunch && !composeForkIdentity && forkRecord === undefined) {
          return yield* new ProviderAdapterProcessError({
            provider: DRIVER_KIND,
            threadId: startInput.threadId,
            detail:
              `Cannot fork thread '${startInput.forkFromThreadId}': it has no captured launch identity. ` +
              `The source predates the forkFrom feature, was never actually launched, or its session/record is missing. ` +
              `A fork must inherit the source's launched system prompt and model to preserve the shared cacheable prefix.`,
          });
        }
        const launch = (): Promise<PiRpcProcess> => {
          const mcpSession = McpProviderSession.readMcpProviderSession(startInput.threadId);
          const composedAppendSystemPrompt = appendSystemPrompts(
            mcpSession ? PI_WORK_MODEL_SYSTEM_PROMPT : undefined,
            startInput.appendSystemPrompt,
          );
          const piCwd = startInput.cwd ?? input.serverConfig.cwd;
          // Thread fork (MVP), fork-once guard: fork the source session ONLY at
          // the child's first launch — i.e. when the thread carries a fork
          // source AND its own deterministic session file does not exist yet.
          // Native `pi --fork <src>` copies the source jsonl into the child's
          // fresh session id (rewiring embedded ids) and never mutates the
          // source; pi errors if `--session-id` already exists, so once the
          // child's file is on disk every later resume launches normally. This
          // is the single most important correctness detail of forking.
          const forkSource =
            startInput.forkFromThreadId !== undefined &&
            resolveSessionFilePath(piSessionIdForThread(startInput.threadId)) === undefined
              ? (resolveSessionFilePath(piSessionIdForThread(startInput.forkFromThreadId)) ??
                piSessionIdForThread(startInput.forkFromThreadId))
              : undefined;
          // loom: forkFrom (D2) — replay the source's final argv verbatim on the
          // fork's first launch (no re-prepend, no reactor recomposition).
          // `forkRecord` is defined only for the first launch; a later resume
          // recomputes forkSource === undefined and recomposes normally.
          const { appendSystemPrompt, skills, tools } = resolveForkLaunchArgs({
            forkRecord: forkSource !== undefined ? forkRecord : undefined,
            composedAppendSystemPrompt,
            startSkills: startInput.skills,
            startTools: startInput.tools,
          });
          // loom: D2 — capture this launch's identity at the createPiRpcProcess
          // boundary. `appendSystemPrompt` is the FINAL argv bytes (post work-
          // model prepend), so a fork replaying it must not re-prepend. The
          // model is the launch intent; turn settlement advances it to the model
          // that actually served each turn. BEST-EFFORT: a state-dir write
          // failure must NEVER reject an otherwise-good launch (this runs for
          // EVERY pi thread, forks and non-forks alike). A lost record forfeits
          // only a future fork's cache identity, which surfaces as that fork's
          // loud missing-record launch refusal rather than a silent divergence.
          try {
            writeLaunchIdentity(launchIdentityDir, startInput.threadId, {
              providerInstanceId: input.instanceId,
              model: startInput.modelSelection?.model,
              options: startInput.modelSelection?.options?.map((option) => ({
                id: option.id,
                value: option.value,
              })),
              appendSystemPrompt,
              tools: tools && tools.length > 0 ? [...tools] : undefined,
              skills: skills && skills.length > 0 ? [...skills] : undefined,
            });
          } catch {
            // loom: forkFrom (D2) — capture failed for THIS launch. Any record
            // left on disk is from a PRIOR launch and may carry stale argv/model
            // that no longer matches what pi is about to run; invalidate it so a
            // fork reads a MISSING record (loud refusal) rather than silently
            // replaying stale identity. The current launch proceeds regardless
            // (identity capture is a cache optimisation, never a launch gate).
            deleteLaunchIdentity(launchIdentityDir, startInput.threadId);
          }
          return (input.createProcess ?? createPiRpcProcess)({
            binaryPath: input.settings.binaryPath,
            platform,
            cwd: piCwd,
            // Deterministic per-thread session id so pi create-or-resumes the
            // SAME session file across server restarts / reconnects, instead
            // of silently spawning a fresh, amnesiac session each time.
            sessionId: piSessionIdForThread(startInput.threadId),
            ...(forkSource !== undefined ? { forkFrom: forkSource } : {}),
            ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
            ...(skills && skills.length > 0 ? { skills } : {}),
            ...(tools && tools.length > 0 ? { tools } : {}),
            // The search guard loads for EVERY loom-launched pi session; the
            // provider-tool extension only where a workstream MCP session
            // exists (its tools POST to workstream endpoints).
            extensions: [
              ...(mcpSession ? [ensurePiProviderToolExtension(input.serverConfig.stateDir)] : []),
              ensurePiSearchGuardExtension(input.serverConfig.stateDir),
            ],
            // Prepend the session worktree's node_modules/.bin so pi resolves
            // that worktree's workspace binaries before the server's inherited
            // PATH, while preserving the T3_WORKSTREAM_* additions.
            env: withLocalNodeModulesBin(
              mcpSession
                ? {
                    ...process.env,
                    T3_WORKSTREAM_ENDPOINT: workstreamBaseUrlFromMcpEndpoint(mcpSession.endpoint),
                    T3_WORKSTREAM_AUTHORIZATION: mcpSession.authorizationHeader,
                    // Debugging-only: the effective-prompt capture extension
                    // writes the fully assembled prompt to this sidecar on each
                    // agent start (fire-and-forget; a write failure only loses
                    // debug data). Deterministic path, mirrored by the
                    // projection query so the UI can open it.
                    T3_PROMPT_DEBUG_PATH: promptDebugSidecarPath(
                      input.serverConfig.workstreamPromptDebugDir,
                      startInput.threadId,
                    ),
                  }
                : process.env,
              piCwd,
              platform,
            ),
          });
        };
        const piProcess = yield* Effect.tryPromise({
          try: launch,
          catch: (cause) =>
            new ProviderAdapterProcessError({
              provider: DRIVER_KIND,
              threadId: startInput.threadId,
              detail: detailFromCause(cause, "Failed to start Pi RPC process."),
              cause,
            }),
        });
        return { process: piProcess, launch };
      }).pipe(
        Effect.flatMap(({ process, launch }) =>
          Effect.gen(function* () {
            const createdAt = yield* nowIso;
            const session: ProviderSession = {
              provider: DRIVER_KIND,
              providerInstanceId: input.instanceId,
              status: "ready",
              runtimeMode: startInput.runtimeMode,
              cwd: startInput.cwd ?? input.serverConfig.cwd,
              threadId: startInput.threadId,
              createdAt,
              updatedAt: createdAt,
            };
            const active: ActivePiSession = {
              session,
              process,
              launch,
              turns: [],
              unsubscribe: () => undefined,
              activeTurnId: undefined,
              turnStartedFor: undefined,
              thinkingLevel: undefined,
              retry: undefined,
              currentAssistantMessageId: undefined,
              lastEffectiveModel: undefined,
              lastRerouteWindowLabel: undefined,
              lastRerouteResetAt: undefined,
              toolArgs: new Map(),
              uiRequests: new Map(),
              unregisterAskUserEmitter: () => undefined,
              materializedActivityImages: new Map(),
            };
            wirePiProcess(active, process);
            sessions.set(startInput.threadId, active);
            active.unregisterAskUserEmitter = registerPiAskUserEmitter(
              startInput.threadId,
              async (event) => {
                if (event.type === "requested") {
                  return await Effect.runPromise(
                    emitDelivered({
                      ...sessionBase(active),
                      requestId: RuntimeRequestId.make(event.requestId),
                      type: "user-input.requested",
                      payload: { questions: event.questions },
                    }),
                  );
                }
                return await Effect.runPromise(
                  emitUserInputResolved(
                    active,
                    event.requestId,
                    event.answers as Record<string, unknown>,
                    event.cancelled,
                  ),
                );
              },
            );
            // Pin the session to its assigned model from birth — pi otherwise
            // runs whatever defaultModel is in the user's global pi settings.
            // On failure the process is stopped, which routes cleanup through
            // the normal exit handler.
            if (startInput.modelSelection)
              yield* applyModelSelection(active, startInput.modelSelection).pipe(
                Effect.tapError(() => Effect.promise(() => process.stop()).pipe(Effect.ignore)),
              );
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
            return active.session;
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
              // Resolve tier-2 routing once; an "exhausted" outcome (intent
              // exhausted/paused with no healthy target, or failover off) must
              // fail the turn quota_exhausted WITHOUT dispatching to the dead
              // account — the resume sweep (chunk D) restarts it at reset. Only
              // for a FRESH turn: a steer (turn already running) can't retarget
              // mid-run, so it continues on the live model and fails naturally.
              const resolution = resolvePiModel(turnInput.modelSelection.model)
                ? yield* resolveEffectiveModel(turnInput.modelSelection.model)
                : ({
                    kind: "intended",
                    slug: turnInput.modelSelection.model,
                  } as EffectiveResolution);
              if (resolution.kind === "exhausted" && session.activeTurnId === undefined) {
                const failedTurnId = TurnId.make(`pi-turn-${NodeCrypto.randomUUID()}`);
                session.activeTurnId = failedTurnId;
                session.turns.push({ id: failedTurnId, items: [] });
                updateSession(session, { status: "running", activeTurnId: failedTurnId });
                // Emit turn.started (pi never runs here, so its agent_start
                // won't) so the projection creates the turn row + clears the
                // pending turn-start; failTurn then settles it as failed.
                session.turnStartedFor = failedTurnId;
                yield* emit({
                  ...sessionBase(session),
                  type: "turn.started",
                  payload: { model: turnInput.modelSelection.model },
                });
                yield* failTurn(
                  session,
                  yield* exhaustedFailureMessage(turnInput.modelSelection.model),
                  undefined,
                  "quota_exhausted",
                );
                return {
                  threadId: turnInput.threadId,
                  turnId: failedTurnId,
                } satisfies ProviderTurnStartResult;
              }
              // Crossing a live session INTO an Anthropic-family model while its
              // on-disk history still carries codex-poisoned tool ids: the poison
              // is also in pi's in-memory replay (which we can't rewrite), so an
              // in-session switch would 400. Relaunch from sanitised disk first.
              // Fresh-turn only (a mid-run steer can't safely restart pi); the
              // current-model check keeps the file scan off the hot path for
              // sessions already on Anthropic.
              if (
                resolution.kind !== "exhausted" &&
                session.activeTurnId === undefined &&
                slugRoutesToAnthropic(resolution.slug) &&
                !slugRoutesToAnthropic(session.session.model ?? "") &&
                threadSessionHasPoisonedToolIds(session.session.threadId)
              )
                yield* relaunchWithSanitisedHistory(session);
              yield* applyModelSelection(session, turnInput.modelSelection, resolution);
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
            // loom: D8 — the moment pi ACCEPTS a prompt, persist the positive
            // kickoff-delivered marker. Its absence (a pre-dispatch quota
            // exhaustion fails before this line; a provider-guard fork refusal /
            // restart-cleared start never reaches it) is what makes a kickoff
            // replay-eligible; a delivered-then-errored first turn has the marker
            // and is never re-delivered. Written once per session (cheap
            // existence check keeps later turns off the write path). BEST-EFFORT:
            // pi has ALREADY accepted the prompt, so a marker write failure must
            // NOT be reported as a send failure (that would risk duplicate work);
            // log and continue — at worst a later resume re-delivers the kickoff.
            if (!isKickoffDelivered(launchIdentityDir, turnInput.threadId)) {
              const markerFailure = trySyncWrite(() =>
                markKickoffDelivered(launchIdentityDir, turnInput.threadId),
              );
              if (markerFailure !== undefined)
                yield* Effect.logWarning("forkFrom: failed to persist kickoff-delivered marker", {
                  threadId: turnInput.threadId,
                  error: markerFailure,
                });
            }
            return { threadId: turnInput.threadId, turnId } satisfies ProviderTurnStartResult;
          }),
        ),
      ),
    interruptTurn: (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((session) =>
          cancelPendingUserInputs(session).pipe(
            Effect.andThen(
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
    // DELIVERY of an already-settled outcome (the server settles first, then
    // dispatches here), which is why neither branch below emits
    // `user-input.resolved`: the durable row already exists, and a second one
    // would double the timeline. A failure here therefore cannot leave the
    // question open — it is a delivery diagnostic and nothing more.
    respondToUserInput: (threadId, requestId, answers, settlement) =>
      requireSession(threadId).pipe(
        Effect.flatMap((session) =>
          Effect.tryPromise({
            try: async (): Promise<UserInputDeliveryResult> => {
              // The broker's poll carries the full outcome (including a
              // `superseded` message) straight to the blocked ask_user_question
              // tool call, so pi's content delivery is always complete.
              if (resolvePiAskUserQuestion(threadId, requestId, answers, settlement))
                return userInputContentDelivered;
              const method = session.uiRequests.get(requestId);
              // D2: the canonical wording every other adapter uses. Clients no
              // longer prose-match anything, but the server-side reactor path
              // still recognises this form uniformly across providers — pi was
              // the only one whose wording matched nothing.
              if (!method) throw new Error(`Unknown pending user-input request: ${requestId}.`);
              const rawAnswer = answers[requestId];
              const answer = Array.isArray(rawAnswer) ? rawAnswer[0] : rawAnswer;
              // A non-`answered` outcome carries no value for a native dialog:
              // dismissed/superseded/cancelled all mean "this dialog gets no
              // answer", so it is cancelled rather than fed a wrong value.
              const settledWithoutAnswer =
                settlement !== undefined && settlement.outcome !== "answered";
              const response =
                settledWithoutAnswer || (typeof answer !== "string" && !Array.isArray(rawAnswer))
                  ? ({ type: "extension_ui_response", id: requestId, cancelled: true } as const)
                  : method === "confirm"
                    ? answer === "Yes"
                      ? ({ type: "extension_ui_response", id: requestId, confirmed: true } as const)
                      : answer === "No"
                        ? ({
                            type: "extension_ui_response",
                            id: requestId,
                            confirmed: false,
                          } as const)
                        : ({
                            type: "extension_ui_response",
                            id: requestId,
                            cancelled: true,
                          } as const)
                    : typeof answer === "string"
                      ? ({ type: "extension_ui_response", id: requestId, value: answer } as const)
                      : ({
                          type: "extension_ui_response",
                          id: requestId,
                          cancelled: true,
                        } as const);
              // Claim before the process write so interrupt/stop cannot emit a
              // terminal event for the same native request.
              session.uiRequests.delete(requestId);
              await session.process.write(response);
              // A legacy dialog is a single value slot: it can carry an answer but
              // not a supersede message, so that content needs a new turn.
              return settledWithoutAnswer && settlement?.outcome === "superseded"
                ? userInputContentUndelivered
                : userInputContentDelivered;
            },
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
          cancelPendingUserInputs(session).pipe(
            Effect.andThen(Effect.promise(() => session.process.stop())),
            Effect.tap(() =>
              Effect.sync(() => {
                if (session.retry?.timer !== undefined) clearTimeout(session.retry.timer);
                session.unregisterAskUserEmitter();
                sessions.delete(threadId);
              }),
            ),
          ),
        ),
      ),
    listSessions: () => Effect.sync(() => [...sessions.values()].map((session) => session.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    getSession: (threadId) => Effect.sync(() => sessions.get(threadId)?.session),
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
        (session) =>
          cancelPendingUserInputs(session).pipe(
            Effect.andThen(Effect.promise(() => session.process.stop())),
            Effect.tap(() => Effect.sync(() => session.unregisterAskUserEmitter())),
          ),
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
      const healthRegistry = yield* ProviderHealthRegistry;
      const serverSettings = yield* ServerSettingsService;
      const readFailover = serverSettings.getSettings.pipe(
        Effect.map((s) => ({
          enabled: s.providerFailover.enabled,
          chains: s.providerFailover.chains,
        })),
        Effect.orElseSucceed(() => DEFAULT_FAILOVER),
      );
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
      const readInstanceUsesUsageSources = serverSettings.getSettings.pipe(
        Effect.map((s) => (s.providerInstances[instanceId]?.usageSources?.length ?? 0) > 0),
        Effect.orElseSucceed(() => false),
      );
      const adapter = makePiAdapter({
        instanceId,
        settings: effectiveConfig,
        serverConfig,
        events,
        modelContextWindows,
        healthRegistry,
        readFailover,
        readInstanceUsesUsageSources,
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
