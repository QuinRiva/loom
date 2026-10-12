/**
 * Loom's one-shot model call. Upstream's `TextGeneration` has no free-form op
 * and Loom's structured op is not re-added (DT-44/DT-54), so Loom's own
 * generations (the emergent goal, the handoff duplicate check) run here: the
 * same ephemeral, tools-off `pi --mode rpc` launch upstream's
 * `PiTextGeneration` uses, on the project's text-generation instance, which
 * must be Pi. Extensions stay on: cliproxy is extension-registered.
 *
 * @module loom/textGeneration/piOneShot
 */
import { PiSettings, type ProjectId, TextGenerationError } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../../config.ts";
import { makePiRpcConnection, parsePiModelSlug } from "../../orchestration-v2/Adapters/PiRpc.ts";
import {
  buildPiRpcLaunch,
  resolvePiLaunchArgs,
} from "../../orchestration-v2/Adapters/piT3McpInjection.ts";
import { resolveLoomPiBinaryPath } from "../../provider/Drivers/Pi/bundledPi.loom.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const decodePiSettings = Schema.decodeUnknownEffect(PiSettings);
const isTextGenerationError = Schema.is(TextGenerationError);

export interface PiOneShotInput {
  /** Names the generation in errors and logs. */
  readonly operation: string;
  readonly projectId: ProjectId;
  /** The pi process's cwd; the server's when null. */
  readonly cwd: string | null;
  readonly prompt: string;
  /** A `provider/model` slug overriding the text-generation selection's model. */
  readonly model?: string | undefined;
}

/** Builds the runner: one prompt in, the reply's trimmed text out. */
export const makePiOneShot = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  const { cwd: serverCwd } = yield* ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return (input: PiOneShotInput): Effect.Effect<string, TextGenerationError> => {
    const fail = (detail: string, cause?: unknown) =>
      new TextGenerationError({ operation: input.operation, detail, cause });
    return Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const selection = resolveProjectSettings(settings, input.projectId).settings
        .textGenerationModelSelection;
      const instance = deriveProviderInstanceConfigMap(settings)[selection.instanceId];
      if (instance?.driver !== "pi")
        return yield* fail(`Text generation instance '${selection.instanceId}' is not Pi.`);
      const pi = yield* decodePiSettings(instance.config ?? {});
      const launchArgs = resolvePiLaunchArgs(pi.launchArgs);
      if (!launchArgs.ok) return yield* fail(launchArgs.message);
      const launch = buildPiRpcLaunch({
        launchArgs: launchArgs.args,
        environment: mergeProviderInstanceEnvironment(instance.environment),
        mcpSession: undefined,
        extensionPath: undefined,
        ephemeral: true,
        disableExtensions: false,
        disableTools: true,
      });
      const connection = yield* makePiRpcConnection({
        command: resolveLoomPiBinaryPath(pi.binaryPath || "pi"),
        args: launch.args,
        cwd: input.cwd ?? serverCwd,
        env: launch.env,
      });
      const model = input.model ?? selection.model;
      if (model !== "default") {
        const parsed = parsePiModelSlug(model);
        if (parsed === null) return yield* fail(`Bad Pi model '${model}'.`);
        yield* connection.request({ type: "set_model", ...parsed });
      }
      yield* connection.request({ type: "prompt", message: input.prompt });
      while (true) {
        const event = yield* Queue.take(connection.events);
        if (event["type"] === "agent_settled") break;
        // No user is present: cancel extension dialogs rather than wait for the timeout.
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
      const data = yield* connection.request({ type: "get_last_assistant_text" });
      const text = (data as { text?: unknown } | null)?.text;
      if (typeof text !== "string" || text.trim() === "")
        return yield* fail("Pi returned no text.");
      return text.trim();
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        isTextGenerationError(cause) ? cause : fail(`${input.operation} failed.`, cause),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  };
});
