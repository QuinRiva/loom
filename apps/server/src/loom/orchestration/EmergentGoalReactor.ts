/**
 * Emergent goal ("every session has a goal", Phase 3 plan P3-16; V1's
 * `deriveEmergentGoal` in `ProviderCommandReactor`). When a goal-less ROOT thread
 * completes one of its first two runs, the transcript so far is distilled into a
 * goal through `buildEmergentGoalPrompt`: written to `loom_goals` under the
 * deterministic id `goal:emergent:<threadId>`, published on the goal broadcast, and
 * attached with `thread.goal.set` under `server:loom:emergent-goal:<threadId>`.
 * Run 1 creates the goal only on a confident answer; run 2 takes the best guess.
 * Workstream children never derive one (they inherit the parent's goal).
 *
 * Upstream's `TextGeneration` has no free-form op and Loom's structured op is not
 * re-added (DT-44/DT-54), so the generation is a Loom-owned one-shot over upstream's
 * exported Pi primitives — the same ephemeral, tools-off `pi --mode rpc` launch
 * upstream's `PiTextGeneration` uses — on the text-generation model selection.
 * No effect-outbox kind: at-most-once is the goal id plus the command receipt, and a
 * run is attempted once per process (a failure logs and waits for run 2).
 *
 * @module loom/orchestration/EmergentGoalReactor
 */
import {
  CommandId,
  GoalId,
  type ProjectId,
  PiSettings,
  type RunId,
  TextGenerationError,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import { slugify } from "@t3tools/shared/String";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../../config.ts";
import { makePiRpcConnection, parsePiModelSlug } from "../../orchestration-v2/Adapters/PiRpc.ts";
import {
  buildPiRpcLaunch,
  resolvePiLaunchArgs,
} from "../../orchestration-v2/Adapters/piT3McpInjection.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { resolveLoomPiBinaryPath } from "../../provider/Drivers/Pi/bundledPi.loom.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "../../provider/ProviderInstanceEnvironment.ts";
import { forkParked } from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { buildEmergentGoalPrompt } from "../../textGeneration/TextGenerationPrompts.ts";
import { formatThreadTitleContext } from "../../textGeneration/ThreadTitleContext.ts";
import { goalShellItem, LoomGoalBroadcast } from "../projection/LoomGoalBroadcast.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";

const GENERATION_TIMEOUT = "180 seconds";
const MAX_EMERGENT_GOAL_RUNS = 2;

export const emergentGoalId = (threadId: ThreadId) => GoalId.make(`goal:emergent:${threadId}`);
export const emergentGoalCommandId = (threadId: ThreadId) =>
  CommandId.make(`server:loom:emergent-goal:${threadId}`);

export type EmergentGoalInterpretation = ReturnType<
  typeof buildEmergentGoalPrompt
>["outputSchema"]["Type"];

/** Runs the emergent-goal prompt through a model; the reactor's one seam (tests stub it). */
export class EmergentGoalGenerator extends Context.Service<
  EmergentGoalGenerator,
  {
    readonly generate: (input: {
      readonly projectId: ProjectId;
      readonly cwd: string | null;
      readonly prompt: string;
    }) => Effect.Effect<EmergentGoalInterpretation, TextGenerationError>;
  }
>()("t3/loom/orchestration/EmergentGoalReactor/EmergentGoalGenerator") {}

const decodePiSettings = Schema.decodeUnknownEffect(PiSettings);
const isTextGenerationError = Schema.is(TextGenerationError);
const decodeInterpretation = Schema.decodeEffect(
  Schema.fromJsonString(buildEmergentGoalPrompt({ message: "" }).outputSchema),
);

const fail = (detail: string, cause?: unknown) =>
  new TextGenerationError({ operation: "generateEmergentGoal", detail, cause });

/** The Pi one-shot: ephemeral, tools off, extensions on (cliproxy carries the default model). */
export const EmergentGoalGeneratorPiLive = Layer.effect(
  EmergentGoalGenerator,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const { cwd: serverCwd } = yield* ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    return {
      generate: (input) =>
        Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings;
          const modelSelection = resolveProjectSettings(settings, input.projectId).settings
            .textGenerationModelSelection;
          const instance = deriveProviderInstanceConfigMap(settings)[modelSelection.instanceId];
          if (instance?.driver !== "pi") {
            return yield* fail(
              `Text generation instance '${modelSelection.instanceId}' is not Pi.`,
            );
          }
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
          if (modelSelection.model !== "default") {
            const parsed = parsePiModelSlug(modelSelection.model);
            if (parsed === null) return yield* fail(`Bad Pi model '${modelSelection.model}'.`);
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
          return yield* decodeInterpretation(extractJsonObject(text.trim()));
        }).pipe(
          Effect.scoped,
          Effect.timeout(GENERATION_TIMEOUT),
          Effect.mapError((cause) =>
            isTextGenerationError(cause) ? cause : fail("Emergent goal generation failed.", cause),
          ),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
    };
  }),
);

/**
 * Derives and attaches the emergent goal for one completed run. Returns without
 * effect for a child, a thread that already has a goal, or a run past the second.
 */
export const deriveEmergentGoal = Effect.fn("loom.deriveEmergentGoal")(function* (input: {
  readonly threadId: ThreadId;
  readonly runOrdinal: number;
}) {
  const orchestrator = yield* OrchestratorV2;
  const loomStore = yield* LoomStoreV2;
  const broadcast = yield* LoomGoalBroadcast;
  const generator = yield* EmergentGoalGenerator;
  const { threadId } = input;
  if (input.runOrdinal > MAX_EMERGENT_GOAL_RUNS) return;
  const { thread, messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"], {
    messageRoles: ["user", "assistant"],
  });
  const workstream = yield* loomStore.getWorkstream(threadId);
  if (
    thread.lineage.parentThreadId !== null ||
    workstream?.parentThreadId != null ||
    (workstream?.goalId ?? null) !== null ||
    thread.archivedAt !== null ||
    thread.deletedAt !== null
  ) {
    return;
  }
  const goalId = emergentGoalId(threadId);
  let goal = yield* loomStore.goals.get(goalId);
  if (goal === null) {
    const context = formatThreadTitleContext(messages.filter((message) => !message.streaming));
    if (context.message.length === 0) return;
    const interpretation = yield* generator.generate({
      projectId: thread.projectId,
      cwd: thread.worktreePath,
      prompt: buildEmergentGoalPrompt({ message: context.message }).prompt,
    });
    const title = interpretation.goal.title.trim();
    if (title.length === 0) return;
    if (input.runOrdinal === 1 && interpretation.confidence !== "high") return;
    // `UNIQUE (project_id, slug)` reserves deleted goals' slugs too.
    const taken = new Set(
      (yield* loomStore.goals.listByProject(thread.projectId, { includeDeleted: true })).map(
        (existing) => existing.slug,
      ),
    );
    const base = slugify(title);
    let slug = base;
    for (let suffix = 2; taken.has(slug); suffix += 1) slug = `${base}-${suffix}`;
    goal = yield* loomStore.goals.upsert({
      id: goalId,
      projectId: thread.projectId,
      slug,
      title,
      description: interpretation.goal.description.trim(),
    });
    yield* broadcast.publish(goalShellItem(goal));
  }
  yield* orchestrator.dispatch({
    type: "thread.goal.set",
    commandId: emergentGoalCommandId(threadId),
    threadId,
    createdAt: DateTime.formatIso(yield* DateTime.now),
    goalId: goal.id,
  });
});

/** Started post-activation: each completed run of a goal-less root is tried once per process. */
export const EmergentGoalReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const services = yield* Effect.context<
      OrchestratorV2 | LoomStoreV2 | LoomGoalBroadcast | EmergentGoalGenerator
    >();
    const scope = yield* Effect.scope;
    const attempted = new Set<RunId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        if (
          event.type !== "run.updated" ||
          event.payload.status !== "completed" ||
          event.payload.ordinal > MAX_EMERGENT_GOAL_RUNS ||
          attempted.has(event.payload.id)
        ) {
          return Effect.void;
        }
        attempted.add(event.payload.id);
        // Forked: a generation can take minutes and must not hold up the event stream.
        return deriveEmergentGoal({
          threadId: event.threadId,
          runOrdinal: event.payload.ordinal,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("loom.emergent-goal.failed", { threadId: event.threadId, cause }),
          ),
          Effect.provideContext(services),
          Effect.forkIn(scope),
          Effect.asVoid,
        );
      }),
    );
  }),
);
