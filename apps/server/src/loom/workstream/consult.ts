/**
 * The frozen oracle behind `consult_thread`: a throwaway `pi --mode rpc --fork` answers ONE
 * question from a copy of the target's session, launched with the target's launch identity and
 * full tool set (narrowing tools would miss the cache) and a READ-ONLY credential. No duration
 * bound: stopping the asker's turn interrupts this and kills the fork's process group.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the consult id is minted inline.
import * as NodeCrypto from "node:crypto";

import {
  consultQuestionKey,
  defaultInstanceIdForDriver,
  type LoomConsultShellStreamItem,
  type LoomLiveConsult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../../config.ts";
import { McpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import { agentToolName } from "../../mcp/toolkits/workstream/families.ts";
import {
  makePiRpcConnection,
  piRecordField,
  piRecordString,
} from "@t3tools/provider-pi/server/rpc";
import {
  buildPiRpcLaunch,
  materializePiT3McpExtension,
  resolvePiLaunchArgs,
} from "@t3tools/provider-pi/server/mcpInjection";
import { resolveLoomPiBinaryPath } from "@t3tools/provider-pi/server/loom";
import { PI_PROVIDER } from "@t3tools/provider-pi/server";
import { PiSettings } from "@t3tools/provider-pi/settings";
import { deriveProviderInstanceConfigMap } from "../../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { loomPaths } from "../loomPaths.ts";
import { LOOM_HIDDEN_TOOLS_ENV } from "../prompt/sessionComposerLive.ts";
import { makeConsultTracker } from "./consultTracker.ts";
import { readLaunchIdentity } from "./launchIdentity.ts";

/** The live card hears from a fork at most this often (it ticks its own clocks between). */
const PUBLISH_INTERVAL_MS = 500;

/** `23s` / `4m 05s` / `1h 02m`, as the consult card's elapsed reads. */
const formatElapsed = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return hours === 0
    ? `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
    : `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
};

/**
 * The consult framing rides the QUESTION TURN, not the system prompt: only the
 * most recent text reliably wins over the replayed transcript, and it keeps the
 * fork's prefix byte-identical to the target's (a warm prompt cache).
 */
export const composeConsultTurn = (input: { readonly asker: string; readonly question: string }) =>
  `Consult from ${input.asker}, via ${agentToolName("consult_thread")}. What follows is a read-only fork of the session above: a copy of it, frozen at its last turn. The original thread is untouched by anything that happens here, and this fork is discarded once you have answered.

Question:

${input.question}

Answering: reply from the knowledge already in this session's context, addressed to the asker, who sees your reply and nothing else. You may inspect anything that helps you answer (run commands, read files, git log/diff), but do not modify files, git state or any thread; every tool that changes state (the workstream tools, edits, questions to a human) is refused in this fork; use the read-only ones and your context, so do not narrate work, promise follow-up, or offer to go and do something. The tree has moved on since this session's last turn, so treat remembered paths and contents as historical. If this session's context does not resolve the question, say so plainly (for example "this session does not resolve that") and say what it does cover; that is a useful answer, not a failure.`;

export class LoomConsultError extends Schema.TaggedError<LoomConsultError>()("LoomConsultError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface ConsultForkInput {
  /** The target's pi session file: its provider thread's strong `nativeThreadRef`. */
  readonly sessionFile: string;
  readonly question: string;
  /** Who is asking, e.g. `thread «Title» (role, id; relationship)`. */
  readonly asker: string;
  /** The asker's and target's ids, for the asker's live consult card. */
  readonly askerThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  /** The target's worktree (else project root); the server's cwd when absent or deleted. */
  readonly cwd?: string;
}

export interface ConsultForkResult {
  readonly answer: string;
  /** The fork transcript pi wrote into `workstream-consults/`, when it reported one. */
  readonly forkSessionPath?: string;
}

export class LoomThreadConsult extends Context.Service<
  LoomThreadConsult,
  {
    readonly ask: (input: ConsultForkInput) => Effect.Effect<ConsultForkResult, LoomConsultError>;
    /** The card's Stop: ends one running consult (its `ask` fails); false when it already ended. */
    readonly cancel: (consultId: string) => Effect.Effect<boolean>;
    /** One item per running consult, then every update: the shell stream's live-consult tail. */
    readonly subscribeLive: Effect.Effect<
      Stream.Stream<LoomConsultShellStreamItem>,
      never,
      Scope.Scope
    >;
  }
>()("t3/loom/workstream/consult/LoomThreadConsult") {}

const consultError = (detail: string) => (cause: unknown) =>
  new LoomConsultError({
    detail: cause instanceof Error ? `${detail}: ${cause.message}` : detail,
    cause,
  });

interface RunningConsult {
  /** The last figures published, replayed to a new subscriber. */
  published: LoomLiveConsult;
  /** Completed with the reason the consult is being stopped. */
  readonly stop: Deferred.Deferred<string>;
}

export const layer = Layer.effect(
  LoomThreadConsult,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const settings = yield* ServerSettings.ServerSettingsService;
    const config = yield* ServerConfig;
    const registry = yield* McpSessionRegistry;
    const fs = yield* FileSystem.FileSystem;
    const fsContext = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const live = yield* PubSub.unbounded<LoomConsultShellStreamItem>();
    const running = new Map<string, RunningConsult>();
    const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

    const ask = Effect.fn("LoomThreadConsult.ask")(function* (input: ConsultForkInput) {
      // The default pi instance's settings (upstream retired the legacy `providers` block).
      const pi = yield* settings.getSettings.pipe(
        Effect.flatMap((current) =>
          Schema.decodeUnknownEffect(PiSettings)(
            deriveProviderInstanceConfigMap(current)[defaultInstanceIdForDriver(PI_PROVIDER)]
              ?.config ?? {},
          ),
        ),
        Effect.mapError(consultError("Could not read the pi settings")),
      );
      const launchArgs = resolvePiLaunchArgs(pi.launchArgs);
      if (!launchArgs.ok) return yield* new LoomConsultError({ detail: launchArgs.message });
      const consultId = NodeCrypto.randomUUID();
      const identity = yield* readLaunchIdentity(
        loomPaths(config).workstreamLaunchIdentityDir,
        input.targetThreadId,
      ).pipe(Effect.provide(fsContext));
      if (Option.isNone(identity))
        yield* Effect.logWarning("loom.consult.cold-fork", {
          targetThreadId: input.targetThreadId,
          reason: "the target has no launch identity record",
        });
      // Launched like the target so the declared tools match its transcript (see the module doc).
      const warm = Option.isNone(identity)
        ? undefined
        : {
            // The bridge first: a failure there must not strand an issued credential.
            bridge: yield* materializePiT3McpExtension(config.providerStatusCacheDir).pipe(
              Effect.provide(fsContext),
              Effect.mapError(consultError("Could not materialise the T3 MCP bridge")),
            ),
            credential: yield* registry.issue({
              threadId: input.targetThreadId,
              providerInstanceId: identity.value.modelSelection.instanceId,
              capabilities: new Set(["workstream", "pull-requests"]),
              client: {
                sessionId: consultId,
                label: `consult fork of ${input.targetThreadId}`,
                access: "read-only",
              },
            }),
            loom: {
              appendSystemPrompt: identity.value.appendSystemPrompt,
              skills: identity.value.skills,
              extensions: identity.value.extensions,
              // One short-lived turn: the 5-minute arm; reads are content-keyed.
              env: {
                ...identity.value.env,
                ...LOOM_HIDDEN_TOOLS_ENV,
                PI_CACHE_RETENTION: "short",
                T3_LOOM_CONSULT_FORK: "1",
              },
            },
          };
      const launch = buildPiRpcLaunch({
        launchArgs: launchArgs.args,
        // One short-lived turn: always the 5-minute prompt cache (a warm fork's env says so too).
        environment: { ...process.env, PI_CACHE_RETENTION: "short" },
        mcpSession: warm?.credential.config,
        extensionPath: warm?.bridge,
        // The bridge's confirm hook passes everything; any other mode would block bash (dialogs are cancelled).
        runtimeMode: "full-access",
        ...(warm === undefined ? {} : { loom: warm.loom }),
      });
      const cwd =
        input.cwd !== undefined &&
        (yield* fs.exists(input.cwd).pipe(Effect.orElseSucceed(() => false)))
          ? input.cwd
          : config.cwd;
      const tracker = makeConsultTracker({
        consultId,
        askerThreadId: input.askerThreadId,
        questionKey: consultQuestionKey(input.question),
        targetThreadId: input.targetThreadId,
        startedAt: yield* nowIso,
      });
      const entry: RunningConsult = {
        published: tracker.snapshot(),
        stop: yield* Deferred.make<string>(),
      };
      let lastPublishedAt = 0;
      const publish = Effect.gen(function* () {
        entry.published = tracker.snapshot();
        lastPublishedAt = yield* Clock.currentTimeMillis;
        yield* PubSub.publish(live, { kind: "consult.updated" as const, consult: entry.published });
      });
      running.set(consultId, entry);
      // The consult's last item, however it ends: the card freezes on it and the server forgets it.
      const finish = Effect.suspend(() => {
        running.delete(consultId);
        // Only the consult's own credential: revokeThread would kill the target's live token.
        return (
          warm === undefined
            ? Effect.void
            : registry.revokeProviderSession(warm.credential.config.providerSessionId)
        ).pipe(
          Effect.andThen(nowIso),
          Effect.flatMap((at) => {
            tracker.end(at);
            return publish;
          }),
        );
      });

      const { answer, providerError, forkSessionPath } = yield* Effect.gen(function* () {
        const connection = yield* makePiRpcConnection({
          command: resolveLoomPiBinaryPath(pi.binaryPath),
          args: [
            ...launch.args,
            "--session-dir",
            loomPaths(config).workstreamConsultsDir,
            "--fork",
            input.sessionFile,
          ],
          cwd,
          env: launch.env,
        });
        const state = yield* connection.request({ type: "get_state" });
        const forkSessionPath = piRecordString(state, "sessionFile");
        const model = piRecordField(state, "model");
        const [provider, modelId] = [
          piRecordString(model, "provider"),
          piRecordString(model, "id"),
        ];
        yield* connection.request({ type: "prompt", message: composeConsultTurn(input) });
        tracker.begin(
          yield* nowIso,
          provider === undefined || modelId === undefined ? null : `${provider}/${modelId}`,
          forkSessionPath ?? null,
        );
        yield* publish;
        // The latest assistant message's provider error, so an empty answer can say why.
        let providerError: string | undefined;
        // A changed figure waits at most PUBLISH_INTERVAL_MS, however busy or quiet the fork is.
        let pending = false;
        while (true) {
          const sinceLast = (yield* Clock.currentTimeMillis) - lastPublishedAt;
          const next: Option.Option<Record<string, unknown>> = pending
            ? yield* Queue.take(connection.events).pipe(
                Effect.timeoutOption(Math.max(0, PUBLISH_INTERVAL_MS - sinceLast)),
              )
            : Option.some(yield* Queue.take(connection.events));
          if (Option.isNone(next)) {
            pending = false;
            yield* publish;
            continue;
          }
          const event: Record<string, unknown> = next.value;
          if (event["type"] === "agent_settled") break;
          pending = tracker.apply(event, yield* nowIso) || pending;
          if (
            pending &&
            (yield* Clock.currentTimeMillis) - lastPublishedAt >= PUBLISH_INTERVAL_MS
          ) {
            pending = false;
            yield* publish;
          }
          const message = event["message"];
          if (event["type"] === "message_end" && piRecordString(message, "role") === "assistant")
            providerError =
              piRecordString(message, "stopReason") === "error"
                ? piRecordString(message, "errorMessage")
                : undefined;
          // No human is present: cancel any extension dialog instead of stalling.
          if (
            event["type"] === "extension_ui_request" &&
            ["select", "confirm", "input", "editor"].includes(String(event["method"]))
          ) {
            yield* connection.send({
              type: "extension_ui_response",
              id: event["id"],
              cancelled: true,
            });
          }
        }
        const text = yield* connection.request({ type: "get_last_assistant_text" });
        return {
          answer: (piRecordString(text, "text") ?? "").trim(),
          providerError,
          forkSessionPath,
        };
      }).pipe(
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(consultError("Could not fork and replay the target session")),
        // A stop interrupts the fork, whose scope kills the pi process group.
        (fork) =>
          Effect.raceFirst(
            fork,
            Deferred.await(entry.stop).pipe(
              Effect.flatMap((detail) => Effect.fail(new LoomConsultError({ detail }))),
            ),
          ),
        Effect.ensuring(finish),
      );
      if (answer.length === 0)
        return yield* new LoomConsultError({
          detail:
            providerError === undefined
              ? "The fork finished without an answer."
              : `The fork's model request failed: ${providerError}`,
        });
      return { answer, ...(forkSessionPath === undefined ? {} : { forkSessionPath }) };
    });

    return LoomThreadConsult.of({
      ask,
      cancel: Effect.fn("consult.cancel")(function* (consultId) {
        const consult = running.get(consultId);
        if (consult === undefined) return false;
        const elapsed = (yield* Clock.currentTimeMillis) - Date.parse(consult.published.startedAt);
        return yield* Deferred.succeed(
          consult.stop,
          `Stopped from the consult card after ${formatElapsed(elapsed)}.`,
        );
      }),
      subscribeLive: Effect.map(PubSub.subscribe(live), (subscription) =>
        Stream.concat(
          Stream.fromIterable(
            [...running.values()].map((consult): LoomConsultShellStreamItem => ({
              kind: "consult.updated",
              consult: consult.published,
            })),
          ),
          Stream.fromSubscription(subscription),
        ),
      ),
    });
  }),
);
