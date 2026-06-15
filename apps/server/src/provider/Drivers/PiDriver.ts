// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics runEffectInsideEffect:off
// @effect-diagnostics preferSchemaOverJson:off
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

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
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelCapabilities, getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import type {
  BranchNameGenerationInput,
  ThreadTitleGenerationInput,
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
  type PiRpcStdoutMessage,
} from "../Layers/Pi/RpcProcess.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");
const decodePiSettings = Schema.decodeSync(PiSettings);
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(2);
const PI_MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: "@earendil-works/pi-coding-agent",
});
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
  currentAssistantMessageId: string | undefined;
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
  readonly serverConfig: ServerConfigShape;
  readonly snapshot: ServerProvider;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
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
          env: process.env,
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
    yield* input.publishSnapshot({
      ...input.snapshot,
      models: piCatalogModels(response.data?.models ?? [], input.settings),
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
    eventId: EventId.make(`pi-event-${randomUUID()}`),
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

function resolvePiModel(model: string): { provider: string; modelId: string } | undefined {
  const slash = model.indexOf("/");
  return slash > 0 && slash < model.length - 1
    ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }
    : undefined;
}

function imageAttachments(
  attachmentsDir: string,
  attachments: ReadonlyArray<ChatAttachment> | undefined,
) {
  return (attachments ?? []).flatMap((attachment) => {
    const path = resolveAttachmentPath({ attachmentsDir, attachment });
    return path && existsSync(path)
      ? [
          {
            type: "image" as const,
            data: readFileSync(path).toString("base64"),
            mimeType: attachment.mimeType,
          },
        ]
      : [];
  });
}

function makePiAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: PiSettings;
  readonly serverConfig: ServerConfigShape;
  readonly events: Queue.Queue<ProviderRuntimeEvent>;
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
      case "agent_start":
        updateSession(session, { status: "running", activeTurnId: session.activeTurnId });
        return emit({
          ...base(),
          type: "session.state.changed",
          payload: { state: "running", reason: "agent_start" },
        });
      case "turn_start":
        if (!session.activeTurnId) return Effect.void;
        return emit({
          ...base(),
          type: "turn.started",
          payload: session.session.model ? { model: session.session.model } : {},
        });
      case "message_start":
        session.currentAssistantMessageId = `assistant-${randomUUID()}`;
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
      case "message_end":
        if (message.message.role !== "assistant") return Effect.void;
        return emit({
          ...base({ itemId: session.currentAssistantMessageId ?? `assistant-${randomUUID()}` }),
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: "completed",
            title: "Assistant message",
            data: message.message,
          },
        }).pipe(
          Effect.tap(() => Effect.sync(() => (session.currentAssistantMessageId = undefined))),
        );
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end": {
        const itemType = toolItemType(message.toolName);
        const eventType =
          message.type === "tool_execution_start"
            ? "item.started"
            : message.type === "tool_execution_end"
              ? "item.completed"
              : "item.updated";
        const status =
          message.type === "tool_execution_end"
            ? message.isError
              ? "failed"
              : "completed"
            : "inProgress";
        return emit({
          ...base({ itemId: message.toolCallId }),
          type: eventType,
          payload: {
            itemType,
            status,
            title: message.toolName,
            ...(message.type === "tool_execution_end"
              ? { data: message.result }
              : {
                  data:
                    message.type === "tool_execution_update"
                      ? (message.partialResult ?? message.args)
                      : message.args,
                }),
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
      case "turn_end":
        if (!session.activeTurnId) return Effect.void;
        updateSession(session, { status: "ready", activeTurnId: undefined });
        return emit({
          ...base(),
          type: "turn.completed",
          payload: { state: "completed", usage: message.message?.usage },
        });
      case "agent_end":
        session.activeTurnId = undefined;
        updateSession(session, { status: "ready", activeTurnId: undefined });
        return emit({
          ...base(),
          type: "session.state.changed",
          payload: { state: "ready", reason: "agent_end" },
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
          try: () =>
            createPiRpcProcess({
              binaryPath: input.settings.binaryPath,
              platform,
              cwd: startInput.cwd ?? input.serverConfig.cwd,
              env: process.env,
            }),
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
              currentAssistantMessageId: undefined,
            };
            active.unsubscribe = process.subscribe(
              (message) =>
                void Effect.runPromise(handleMessage(active, message)).catch(() => undefined),
            );
            process.child.once("exit", () => {
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
            const turnId = TurnId.make(`pi-turn-${randomUUID()}`);
            session.activeTurnId = turnId;
            session.turns.push({ id: turnId, items: [] });
            updateSession(session, { status: "running", activeTurnId: turnId });
            yield* Effect.tryPromise({
              try: () =>
                session.process.request({
                  type: "prompt",
                  message: text,
                  ...(images.length > 0 ? { images } : {}),
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
          Effect.tryPromise({
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
            Effect.tap(() => Effect.sync(() => sessions.delete(threadId))),
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
      const adapter = makePiAdapter({
        instanceId,
        settings: effectiveConfig,
        serverConfig,
        events,
      });
      yield* Effect.addFinalizer(() =>
        adapter.stopAll().pipe(Effect.ignore, Effect.andThen(Queue.shutdown(events))),
      );
      const deterministicTitle = (message: string) =>
        Effect.succeed({ title: titleFromText(message) });
      const textGeneration = {
        generateCommitMessage: () => Effect.succeed({ subject: "Update from pi", body: "" }),
        generatePrContent: () => Effect.succeed({ title: "Update from pi", body: "" }),
        generateBranchName: (textInput: BranchNameGenerationInput) =>
          Effect.succeed({ branch: branchFromText(textInput.message) }),
        generateThreadTitle: (textInput: ThreadTitleGenerationInput) =>
          deterministicTitle(textInput.message),
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
