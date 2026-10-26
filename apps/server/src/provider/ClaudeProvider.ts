// loom: the Claude model catalogue and the CLI capability probe.
// @effect-diagnostics nodeBuiltinImport:off
// node:child_process directly: the capability probe must hand the Agent SDK a
// raw `SpawnedProcess`, and it needs the underlying handle to force-kill an
// unresponsive child from a synchronous `process.on("exit")` hook. Effect's
// ChildProcessSpawner exposes neither.
import {
  type ClaudeSettings,
  type ModelCapabilities,
  type ModelSelection,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSlashCommand,
  type ServerProviderResetCredits,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  createModelCapabilities,
  getModelSelectionStringOptionValue, // loom:
  getProviderOptionCurrentValue, // loom:
  getProviderOptionDescriptors, // loom:
} from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  query as claudeQuery,
  type Options as ClaudeQueryOptions,
  type SlashCommand as ClaudeSlashCommand,
  type SDKControlGetUsageResponse,
  type SDKUserMessage,
  type SettingSource,
  type SpawnedProcess as ClaudeSpawnedProcess,
  type SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import * as NodeChildProcess from "node:child_process";

import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  DEFAULT_TIMEOUT_MS,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import { resolveClaudeSdkExecutablePath } from "./Drivers/ClaudeExecutable.ts";
import { hasClaudeManagedMcpConfig, makeClaudeEnvironment } from "./Drivers/ClaudeHome.ts";
import { discoverClaudeSkills } from "./Drivers/ClaudeSkills.ts";
import type { ProviderWorkspaceSnapshot } from "@t3tools/provider-core/server/driver";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import {
  type ClaudeScopedLimitNames,
  claudeUsageResponseToLimits,
  recordClaudeUsageResponse,
} from "./claudeUsageLimits.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  type ClaudeModelCatalog,
  formatClaudeVersionUpgradeMessage,
  resolveClaudeModelsForVersion,
  resolveClaudeUpdateRequiredModels,
} from "./ClaudeModelCatalog.ts";

const DEFAULT_CLAUDE_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const CLAUDE_PRESENTATION = {
  displayName: "Claude",
  showInteractionModeToggle: true,
  reportsContextWindow: true,
} as const;
// loom: Opus 5.5 replaces Opus 5 as the current Opus (Claude Code 2.1.280).
const CURRENT_CLAUDE_MODELS = new Set(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5"]);

export function isLegacyClaudeModel(model: string): boolean {
  return !CURRENT_CLAUDE_MODELS.has(model);
}

const CLAUDE_MODEL_CATALOG: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "claude-fable-5-1",
    name: "Claude Fable 5.1",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            {
              value: "ultracode",
              label: "Ultracode",
              description: "xhigh effort plus multi-agent workflow orchestration",
            },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k" },
            { value: "1m", label: "1M", isDefault: true },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-fable-5",
    name: "Claude Fable 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            {
              value: "ultracode",
              label: "Ultracode",
              description: "xhigh effort plus multi-agent workflow orchestration",
            },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k" },
            { value: "1m", label: "1M", isDefault: true },
          ],
        }),
      ],
    }),
  },
  // loom: Opus 5.5 — Claude Code 2.1.280 ships it as the default Opus; same
  // option surface as Opus 5 (1M context, fast mode, xhigh passes through).
  {
    slug: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            {
              value: "ultracode",
              label: "Ultracode",
              description: "xhigh effort plus multi-agent workflow orchestration",
            },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          // Claude Code selects the 1M variant explicitly (`claude-opus-5-5[1m]`).
          options: [
            { value: "200k", label: "200k" },
            { value: "1m", label: "1M", isDefault: true },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-5",
    name: "Claude Opus 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            {
              value: "ultracode",
              label: "Ultracode",
              description: "xhigh effort plus multi-agent workflow orchestration",
            },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          // Claude Code selects the 1M variant explicitly (`claude-opus-5[1m]`).
          options: [
            { value: "200k", label: "200k" },
            { value: "1m", label: "1M", isDefault: true },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-8",
    name: "Claude Opus 4.8",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            {
              value: "ultracode",
              label: "Ultracode",
              description: "xhigh effort plus multi-agent workflow orchestration",
            },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-7",
    name: "Claude Opus 4.7",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
            { value: "xhigh", label: "Extra High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-6",
    name: "Claude Opus 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          options: [
            { value: "200k", label: "200k" },
            { value: "1m", label: "1M", isDefault: true },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-opus-4-5",
    name: "Claude Opus 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
          ],
        }),
        buildBooleanOptionDescriptor({
          id: "fastMode",
          label: "Fast Mode",
        }),
      ],
    }),
  },
  {
    slug: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "xhigh", label: "Extra High" },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          // Sonnet is 200k-default in Claude Code (1M is opt-in there too).
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildSelectOptionDescriptor({
          id: "effort",
          label: "Reasoning",
          options: [
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High", isDefault: true },
            { value: "max", label: "Max" },
            { value: "ultrathink", label: "Ultrathink" },
          ],
          promptInjectedValues: ["ultrathink"],
        }),
        buildSelectOptionDescriptor({
          id: "contextWindow",
          label: "Context Window",
          // Sonnet is 200k-default in Claude Code (1M is opt-in there too).
          options: [
            { value: "200k", label: "200k", isDefault: true },
            { value: "1m", label: "1M" },
          ],
        }),
      ],
    }),
  },
  {
    slug: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    isCustom: false,
    capabilities: createModelCapabilities({
      optionDescriptors: [
        buildBooleanOptionDescriptor({
          id: "thinking",
          label: "Thinking",
        }),
      ],
    }),
  },
];

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = CLAUDE_MODEL_CATALOG.map((model) =>
  isLegacyClaudeModel(model.slug) ? { ...model, isLegacy: true } : model,
);

export function getClaudeModelCapabilities(model: string | null | undefined): ModelCapabilities {
  const slug = model?.trim();
  return (
    BUILT_IN_MODELS.find((candidate) => candidate.slug === slug)?.capabilities ??
    DEFAULT_CLAUDE_MODEL_CAPABILITIES
  );
}

export function resolveClaudeEffort(
  caps: ModelCapabilities,
  raw: string | null | undefined,
): string | undefined {
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const effortDescriptor = descriptors.find((descriptor) => descriptor.id === "effort");
  const value = getProviderOptionCurrentValue(effortDescriptor);
  return typeof value === "string" ? value : undefined;
}

/**
 * Maps a resolved Claude effort onto the CLI's `--effort` flag, mirroring the Agent SDK mapping
 * ({@link getEffectiveClaudeAgentEffort}): `ultracode` pairs with `xhigh`, `ultrathink` (a
 * prompt-prefix mode) is filtered out, and older-model compatibility mappings are kept.
 */
export function normalizeClaudeCliEffort(
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!effort || effort === "ultrathink") {
    return undefined;
  }
  if (effort === "ultracode") {
    return "xhigh";
  }
  if (
    effort === "xhigh" &&
    model !== "claude-fable-5-1" &&
    model !== "claude-fable-5" &&
    model !== "claude-opus-5-5" && // loom: pi's catalogue maps xhigh → xhigh for Opus 5.5
    model !== "claude-opus-5" &&
    model !== "claude-opus-4-8" &&
    model !== "claude-sonnet-5"
  ) {
    return "max";
  }
  if (effort === "max" && model === "claude-sonnet-4-6") {
    return "high";
  }
  return effort;
}

export function isClaudeUltracodeEffort(effort: string | null | undefined): boolean {
  return effort === "ultracode";
}

export function resolveClaudeContextWindow(
  modelSelection: ModelSelection | undefined,
): string | undefined {
  const caps = getClaudeModelCapabilities(modelSelection?.model);
  const raw = getModelSelectionStringOptionValue(modelSelection, "contextWindow");
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "contextWindow", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "contextWindow");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function resolveClaudeApiModelId(modelSelection: ModelSelection): string {
  switch (resolveClaudeContextWindow(modelSelection)) {
    case "1m":
      return `${modelSelection.model}[1m]`;
    default:
      return modelSelection.model;
  }
}

function toTitleCaseWords(value: string): string {
  const parts: Array<string> = [];
  for (const part of value.split(/[\s_-]+/g)) {
    if (part.length > 0) {
      parts.push(part[0]!.toUpperCase() + part.slice(1).toLowerCase());
    }
  }
  return parts.join(" ");
}

function claudeSubscriptionLabel(subscriptionType: string | undefined): string | undefined {
  const normalized = subscriptionType?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;

  switch (normalized) {
    case "claudemaxsubscription":
      return "Max";
    case "claudemax5xsubscription":
      return "Max 5x";
    case "claudemax20xsubscription":
      return "Max 20x";
    case "claudeenterprisesubscription":
      return "Enterprise";
    case "claudeteamsubscription":
      return "Team";
    case "claudeprosubscription":
      return "Pro";
    case "claudefreesubscription":
      return "Free";
    case "max":
    case "maxplan":
      return "Max";
    case "max5":
      return "Max 5x";
    case "max20":
      return "Max 20x";
    case "enterprise":
      return "Enterprise";
    case "team":
      return "Team";
    case "pro":
      return "Pro";
    case "free":
      return "Free";
    default:
      return toTitleCaseWords(subscriptionType!);
  }
}

function normalizeClaudeAuthMethod(authMethod: string | undefined): string | undefined {
  const normalized = authMethod?.toLowerCase().replace(/[\s_-]+/g, "");
  if (!normalized) return undefined;
  if (
    normalized === "apikey" ||
    normalized === "anthropicapikey" ||
    normalized === "anthropicauthtoken"
  ) {
    return "apiKey";
  }
  return undefined;
}

function formatClaudeSubscriptionAuthLabel(subscriptionType: string): string {
  const subscriptionLabel =
    claudeSubscriptionLabel(subscriptionType) ?? toTitleCaseWords(subscriptionType);
  const normalized = subscriptionLabel.toLowerCase().replace(/[\s_-]+/g, "");

  if (normalized.startsWith("claude") && normalized.endsWith("subscription")) {
    return subscriptionLabel;
  }
  if (normalized.startsWith("claude")) {
    return `${subscriptionLabel} Subscription`;
  }
  if (normalized.endsWith("subscription")) {
    return `Claude ${subscriptionLabel}`;
  }
  return `Claude ${subscriptionLabel} Subscription`;
}

function claudeAuthMetadata(input: {
  readonly subscriptionType: string | undefined;
  readonly authMethod: string | undefined;
}): { readonly type: string; readonly label: string } | undefined {
  if (normalizeClaudeAuthMethod(input.authMethod) === "apiKey") {
    return {
      type: "apiKey",
      label: "Claude API Key",
    };
  }

  if (input.subscriptionType) {
    return {
      type: input.subscriptionType,
      label: formatClaudeSubscriptionAuthLabel(input.subscriptionType),
    };
  }

  return undefined;
}

function apiProviderAuthMetadata(
  apiProvider: string | undefined,
): { readonly type: string; readonly label: string } | undefined {
  return apiProvider === "bedrock" ? { type: "bedrock", label: "Amazon Bedrock" } : undefined;
}

/** Probe completion only proves Claude started. Only tokenSource: "none" disproves auth. */
function claudeAuthStatus(
  capabilities: Pick<
    ClaudeCapabilitiesProbe,
    "email" | "subscriptionType" | "tokenSource" | "apiKeySource" | "apiProvider"
  >,
): "authenticated" | "unauthenticated" {
  if (capabilities.apiProvider !== undefined && capabilities.apiProvider !== "firstParty") {
    return "authenticated";
  }
  if (capabilities.tokenSource !== "none") return "authenticated";
  // API keys can authenticate with tokenSource: none; also check key and account fields.
  const hasApiKey = Boolean(capabilities.apiKeySource) && capabilities.apiKeySource !== "none";
  return hasApiKey || capabilities.email || capabilities.subscriptionType
    ? "authenticated"
    : "unauthenticated";
}

// Bedrock initialization includes backend startup and awsAuthRefresh, taking longer than first-party auth.
const CAPABILITIES_PROBE_TIMEOUT_MS = 25_000;
// Native CLI startup on Windows can exceed the shared probe deadline.
const CLAUDE_VERSION_CHECK_TIMEOUT_MS = 20_000;

const CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES = [
  "user",
  "project",
  "local",
] as const satisfies ReadonlyArray<SettingSource>;

// loom: Loom-owned probe spawn (force-kills an unreaped probe child on exit); upstream has no equivalent.
/**
 * Probe subprocesses that have not been reaped yet, so we can force-kill them
 * if this process exits before the SDK's termination timers fire.
 */
const liveProbeProcesses = new Set<NodeChildProcess.ChildProcess>();
let probeExitHookInstalled = false;

/**
 * The SDK kills an aborted child on unref'd timers (~7 s to SIGKILL), and its `process.on("exit")`
 * backstop skips children whose `killed` flag SIGTERM already set, so under `Restart=always` a
 * shutdown mid-probe reparents a surviving child to systemd. Spawning it ourselves lets our own
 * exit hook kill it synchronously, without making shutdown wait.
 */
function spawnClaudeCapabilitiesProbeProcess(options: ClaudeSpawnOptions): ClaudeSpawnedProcess {
  const child = NodeChildProcess.spawn(options.command, options.args, {
    // Discard probe stderr at the OS level. The SDK only pipes stderr from its
    // own spawn path, so once we own the spawn a pipe would have no reader and
    // could wedge the very child we are trying to terminate.
    stdio: ["pipe", "pipe", "ignore"],
    signal: options.signal,
    env: options.env,
    windowsHide: true,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  });

  if (!probeExitHookInstalled) {
    probeExitHookInstalled = true;
    process.on("exit", () => {
      for (const live of liveProbeProcesses) {
        try {
          live.kill("SIGKILL");
        } catch {
          // Already gone, or reaped between the check and the signal.
        }
      }
    });
  }

  liveProbeProcesses.add(child);
  child.once("exit", () => liveProbeProcesses.delete(child));
  child.once("error", () => {
    // Abort via the `signal` option surfaces as an `error` while the child is
    // still running, so only a child that never started can be forgotten here.
    if (child.pid === undefined) liveProbeProcesses.delete(child);
  });

  return {
    stdin: child.stdin,
    stdout: child.stdout,
    get killed() {
      return child.killed;
    },
    get exitCode() {
      return child.exitCode;
    },
    kill: child.kill.bind(child),
    on: child.on.bind(child),
    once: child.once.bind(child),
    off: child.off.bind(child),
  };
}

export function buildClaudeCapabilitiesProbeQueryOptions(input: {
  readonly executablePath: string;
  readonly abortController: AbortController;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string | undefined;
  readonly managedMcpConfig: boolean;
}): ClaudeQueryOptions {
  return {
    persistSession: false,
    pathToClaudeCodeExecutable: input.executablePath,
    abortController: input.abortController,
    settingSources: [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES],
    // Keep settings for slash-command discovery, but disable hooks so health checks do not run SessionStart repeatedly.
    settings: { disableAllHooks: true },
    allowedTools: [],
    // Exclude filesystem MCP servers; omit strict mode when managed-mcp.json already excludes them and forbids the flag.
    mcpServers: {},
    ...(input.managedMcpConfig ? {} : { strictMcpConfig: true }),
    env: {
      ...input.environment,
      // Disable claude.ai MCP separately; it is discovered outside filesystem config.
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      // Skipping this avoids a Windows tasklist | findstr process tree on every refresh.
      FORCE_CODE_TERMINAL: undefined,
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1",
    },
    ...(input.cwd ? { cwd: input.cwd } : {}),
    spawnClaudeCodeProcess: spawnClaudeCapabilitiesProbeProcess,
  };
}

function nonEmptyProbeString(value: string): string | undefined {
  const candidate = value.trim();
  return candidate ? candidate : undefined;
}

export type ClaudeCapabilitiesProbe = {
  readonly email: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly subscriptionType: string | undefined;
  readonly tokenSource: string | undefined;
  readonly apiKeySource: string | undefined;
  /** OAuth applies only to firstParty; Bedrock uses external AWS credentials and omits subscription/token fields. */
  readonly apiProvider: string | undefined;
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  /** Undefined means get_usage failed; absent windows on success mean no subscription windows, as with API keys. */
  readonly usage?: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  readonly usageCheckedAt?: string;
};

function parseClaudeInitializationCommands(
  commands: ReadonlyArray<ClaudeSlashCommand> | undefined,
): ReadonlyArray<ServerProviderSlashCommand> {
  return dedupeSlashCommands(
    (commands ?? []).flatMap((command) => {
      const name = nonEmptyProbeString(command.name);
      if (!name) {
        return [];
      }

      const description = nonEmptyProbeString(command.description);
      const argumentHint = nonEmptyProbeString(command.argumentHint);

      return [
        {
          name,
          ...(description ? { description } : {}),
          ...(argumentHint ? { input: { hint: argumentHint } } : {}),
        } satisfies ServerProviderSlashCommand,
      ];
    }),
  );
}

function dedupeSlashCommands(
  commands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commandsByName = new Map<string, ServerProviderSlashCommand>();

  for (const command of commands) {
    const name = nonEmptyProbeString(command.name);
    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = commandsByName.get(key);
    if (!existing) {
      commandsByName.set(key, {
        ...command,
        name,
      });
      continue;
    }

    commandsByName.set(key, {
      ...existing,
      ...(existing.description
        ? {}
        : command.description
          ? { description: command.description }
          : {}),
      ...(existing.input?.hint
        ? {}
        : command.input?.hint
          ? { input: { hint: command.input.hint } }
          : {}),
    });
  }

  return [...commandsByName.values()];
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** A never-yielding prompt allows local initialization IPC without sending an Anthropic request. */
const probeClaudeCapabilities = (
  claudeSettings: ClaudeSettings,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  includeUsage = true,
) => {
  const abort = new AbortController();
  return Effect.gen(function* () {
    const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
    const executablePath = yield* resolveClaudeSdkExecutablePath(
      claudeSettings.binaryPath,
      claudeEnvironment,
    );
    const managedMcpConfig = yield* hasClaudeManagedMcpConfig();
    return yield* Effect.tryPromise(async () => {
      const q = claudeQuery({
        // oxlint-disable-next-line require-yield -- never yields, so no prompt reaches the API
        prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
          await waitForAbortSignal(abort.signal);
        })(),
        options: buildClaudeCapabilitiesProbeQueryOptions({
          executablePath,
          abortController: abort,
          environment: claudeEnvironment,
          cwd,
          managedMcpConfig,
        }),
      });
      const init = await q.initializationResult();
      return { q, init };
    });
  }).pipe(
    Effect.timeout(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.flatMap(({ q, init }) =>
      Effect.gen(function* () {
        // Usage has its own deadline so a slow optional request cannot discard initialization.
        // Only the rate limits are read, so skip the local transcript scan that fills
        // `behaviors`: with a few GB of transcripts it outlasts the deadline.
        const usageCheckedAt = DateTime.formatIso(yield* DateTime.now);
        const usageResult = includeUsage
          ? yield* Effect.tryPromise(() =>
              q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
            ).pipe(Effect.timeout(DEFAULT_TIMEOUT_MS), Effect.result)
          : undefined;
        const usage =
          usageResult && Result.isSuccess(usageResult)
            ? {
                rate_limits_available: usageResult.success.rate_limits_available,
                rate_limits: usageResult.success.rate_limits,
              }
            : undefined;
        const account = init.account as
          | {
              readonly email?: string;
              readonly subscriptionType?: string;
              readonly tokenSource?: string;
              readonly apiKeySource?: string;
              readonly apiProvider?: string;
            }
          | undefined;
        return {
          email: account?.email,
          subscriptionType: account?.subscriptionType,
          tokenSource: account?.tokenSource,
          apiKeySource: account?.apiKeySource,
          apiProvider: account?.apiProvider,
          slashCommands: parseClaudeInitializationCommands(init.commands),
          ...(usage ? { usage, usageCheckedAt } : {}),
        } satisfies ClaudeCapabilitiesProbe;
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.tapError((error) =>
      Effect.logWarning("Claude capability probe failed.", { errorTag: error._tag }),
    ),
  );
};

type ClaudeCapabilitiesProbeError = Effect.Error<ReturnType<typeof probeClaudeCapabilities>>;

const runClaudeCommand = Effect.fn("runClaudeCommand")(function* (
  claudeSettings: ClaudeSettings,
  args: ReadonlyArray<string>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
) {
  const claudeEnvironment = yield* makeClaudeEnvironment(claudeSettings, environment);
  const spawnCommand = yield* resolveSpawnCommand(claudeSettings.binaryPath, args, {
    env: claudeEnvironment,
  });
  const command = ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    env: claudeEnvironment,
    shell: spawnCommand.shell,
    ...(cwd ? { cwd } : {}),
  });
  return yield* spawnAndCollect(claudeSettings.binaryPath, command);
});

export const probeClaudeWorkspaceSnapshot = Effect.fn("probeClaudeWorkspaceSnapshot")(function* (
  claudeSettings: ClaudeSettings,
  machineSnapshot: ServerProvider,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ProviderWorkspaceSnapshot, never, FileSystem.FileSystem | Path.Path> {
  if (!claudeSettings.enabled) return machineSnapshot;
  const skills = yield* discoverClaudeSkills(claudeSettings, cwd, environment);
  const fileSystem = yield* FileSystem.FileSystem;
  // A deleted worktree can never answer the probe. Pending would make clients rescan it forever.
  const cwdExists = yield* fileSystem.exists(cwd).pipe(Effect.orElseSucceed(() => true));
  const probeResult = cwdExists
    ? yield* probeClaudeCapabilities(claudeSettings, environment, cwd, false).pipe(Effect.result)
    : undefined;
  const capabilities =
    probeResult && Result.isSuccess(probeResult) ? probeResult.success : undefined;
  return {
    ...machineSnapshot,
    skills,
    slashCommands: dedupeSlashCommands([
      COMPACT_SLASH_COMMAND,
      ...(capabilities?.slashCommands ?? []),
    ]),
    slashCommandsPending: cwdExists && !capabilities,
  };
});

export const checkClaudeProviderStatus = Effect.fn("checkClaudeProviderStatus")(function* (
  claudeSettings: ClaudeSettings,
  resolveCapabilities?: (
    claudeSettings: ClaudeSettings,
  ) => Effect.Effect<ClaudeCapabilitiesProbe | undefined, ClaudeCapabilitiesProbeError>,
  environment?: NodeJS.ProcessEnv,
  cwd?: string,
  modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
  /** Shared with the adapter so turn events reuse the scoped-bucket names this probe saw. */
  scopedLimitNames?: Ref.Ref<ClaudeScopedLimitNames>,
  resolveResetCredits?: (version: string) => Effect.Effect<ServerProviderResetCredits | undefined>,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const allModels = providerModelsFromSettings(
    modelCatalog.models.map((entry) => entry.model),
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );

  if (!claudeSettings.enabled) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: false,
      checkedAt,
      models: allModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude is disabled in T3 Code settings.",
      },
    });
  }

  const versionProbe = yield* runClaudeCommand(
    claudeSettings,
    ["--version"],
    resolvedEnvironment,
    cwd,
  ).pipe(Effect.timeoutOption(CLAUDE_VERSION_CHECK_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionProbe)) {
    const error = versionProbe.failure;
    yield* Effect.logWarning("Claude Agent CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Claude Agent CLI (`claude`) was not found on PATH."
          : "Failed to execute Claude Agent CLI health check.",
      },
    });
  }

  if (Option.isNone(versionProbe.success)) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message:
          "Claude Agent CLI is installed but failed to run. Timed out while running command.",
      },
    });
  }

  const version = versionProbe.success.value;
  const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
  if (version.code !== 0) {
    yield* Effect.logWarning("Claude Agent CLI version probe exited with a non-zero status.", {
      exitCode: version.code,
      stdoutLength: version.stdout.length,
      stderrLength: version.stderr.length,
    });
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models: allModels,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI is installed but failed to run.",
      },
    });
  }

  const models = providerModelsFromSettings(
    resolveClaudeModelsForVersion(modelCatalog, parsedVersion),
    claudeSettings.customModels,
    DEFAULT_CLAUDE_MODEL_CAPABILITIES,
  );
  const updateRequiredModels = resolveClaudeUpdateRequiredModels(modelCatalog, parsedVersion);
  const versionUpgradeMessage = formatClaudeVersionUpgradeMessage(modelCatalog, parsedVersion);

  const probeResult = resolveCapabilities
    ? yield* resolveCapabilities(claudeSettings).pipe(Effect.result)
    : undefined;
  const capabilities =
    probeResult && Result.isSuccess(probeResult) ? probeResult.success : undefined;
  const probeFailure =
    probeResult && Result.isFailure(probeResult) ? probeResult.failure : undefined;
  const skills = yield* discoverClaudeSkills(claudeSettings, cwd, resolvedEnvironment);
  const slashCommands = [COMPACT_SLASH_COMMAND, ...(capabilities?.slashCommands ?? [])];
  const dedupedSlashCommands = dedupeSlashCommands(slashCommands);

  if (!capabilities) {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      updateRequiredModels,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "warning",
        auth: { status: "unknown" },
        message: probeFailure
          ? Cause.isTimeoutError(probeFailure)
            ? `Timed out after ${CAPABILITIES_PROBE_TIMEOUT_MS / 1_000}s while checking Claude account status.`
            : "Claude Agent CLI failed while checking account status."
          : "Could not verify Claude authentication status from initialization result.",
      },
    });
  }

  // First-party account fields cannot verify custom endpoint credentials.
  const endpoint = URL.parse(resolvedEnvironment.ANTHROPIC_BASE_URL?.trim() ?? "");
  const customApiEndpoint =
    endpoint !== null &&
    (endpoint.protocol === "http:" || endpoint.protocol === "https:") &&
    endpoint.hostname !== "" &&
    endpoint.hostname !== "api.anthropic.com";
  if (!customApiEndpoint && claudeAuthStatus(capabilities) === "unauthenticated") {
    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: claudeSettings.enabled,
      checkedAt,
      models,
      slashCommands: dedupedSlashCommands,
      skills,
      probe: {
        installed: true,
        version: parsedVersion,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Claude Code is not authenticated. Run `claude auth login` and try again.",
      },
    });
  }

  const authMetadata =
    claudeAuthMetadata({
      subscriptionType: capabilities.subscriptionType,
      authMethod: capabilities.tokenSource,
    }) ??
    apiProviderAuthMetadata(capabilities.apiProvider) ??
    (customApiEndpoint ? { type: "customEndpoint", label: "Custom API endpoint" } : undefined);
  const usageCheckedAt = capabilities.usageCheckedAt ?? checkedAt;
  const usageLimits = !capabilities.usage
    ? makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" })
    : scopedLimitNames
      ? yield* recordClaudeUsageResponse(scopedLimitNames, {
          response: capabilities.usage,
          checkedAt: usageCheckedAt,
        })
      : claudeUsageResponseToLimits({
          response: capabilities.usage,
          checkedAt: usageCheckedAt,
        }).limits;
  const resetCredits =
    resolveResetCredits &&
    capabilities.subscriptionType &&
    !usageLimits.unavailable &&
    parsedVersion
      ? yield* resolveResetCredits(parsedVersion)
      : undefined;
  return buildServerProvider({
    presentation: CLAUDE_PRESENTATION,
    enabled: claudeSettings.enabled,
    checkedAt,
    models,
    updateRequiredModels,
    slashCommands: dedupedSlashCommands,
    skills,
    probe: {
      installed: true,
      version: parsedVersion,
      status: "ready",
      auth: {
        status: "authenticated",
        ...(capabilities.email ? { email: capabilities.email } : {}),
        ...(capabilities.workspaceId ? { workspaceId: capabilities.workspaceId } : {}),
        ...(authMetadata ? authMetadata : {}),
      },
      ...(versionUpgradeMessage ? { message: versionUpgradeMessage } : {}),
      usageLimits: resetCredits ? { ...usageLimits, resetCredits } : usageLimits,
    },
  });
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makePendingClaudeProvider = Effect.fn("ClaudeProvider.makePendingClaudeProvider")(
  function* (
    claudeSettings: ClaudeSettings,
    modelCatalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
  ): Effect.fn.Return<ServerProviderDraft> {
    const checkedAt = yield* nowIso;
    const models = providerModelsFromSettings(
      modelCatalog.models.map((entry) => entry.model),
      claudeSettings.customModels,
      DEFAULT_CLAUDE_MODEL_CAPABILITIES,
    );

    if (!claudeSettings.enabled) {
      return buildServerProvider({
        presentation: CLAUDE_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Claude is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: CLAUDE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      },
    });
  },
);

export { probeClaudeCapabilities };
