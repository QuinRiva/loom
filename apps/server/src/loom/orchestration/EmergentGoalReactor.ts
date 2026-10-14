/**
 * Emergent goal ("every session has a goal", Phase 3 plan P3-16; V1's
 * `deriveEmergentGoal` in `ProviderCommandReactor`). When a goal-less ROOT thread
 * STARTS one of its first two runs — at the message, as V1 did (DL-671) — the
 * transcript so far is distilled into a goal through `buildEmergentGoalPrompt`:
 * written to `loom_goals` under the deterministic id `goal:emergent:<threadId>`,
 * published on the goal broadcast, and attached with `thread.goal.set` under
 * `server:loom:emergent-goal:<threadId>`. Run 1 creates the goal only on a confident
 * answer; run 2 takes the best guess, and so does a goal tool called by the goal-less
 * root (`EmergentGoals.derive`, awaiting a derivation already in flight), so a root's
 * first turn can lay out its plan. Workstream children never derive one (they inherit the parent's goal), nor does a `/retro`
 * reviewer (goal-less by design). A goal set while the generation runs wins: the derivation re-checks before writing, and the
 * orchestrator drops an emergent `thread.goal.set` on a thread that already has a goal.
 *
 * The generation is Loom's Pi one-shot (`makePiOneShot`) on the text-generation
 * model selection.
 * No effect-outbox kind: at-most-once is the goal id plus the command receipt, and a
 * run is attempted once per process (a failure logs and waits for run 2 or a goal tool).
 *
 * @module loom/orchestration/EmergentGoalReactor
 */
import {
  CommandId,
  GoalId,
  type ProjectId,
  type RunId,
  TextGenerationError,
  type ThreadId,
} from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { slugify } from "@t3tools/shared/String";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { LOOM_EMERGENT_GOAL_PREFIX } from "../../orchestration-v2/Orchestrator.loom.ts";
import { forkParked } from "../../serverActivation.ts";
import { RETRO_REVIEWER_ROLE } from "../handoff/retroRole.ts";
import { buildEmergentGoalPrompt } from "@t3tools/provider-core/server/textGenerationPrompts";
import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
import { goalShellItem, LoomGoalBroadcast } from "../projection/LoomGoalBroadcast.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";
import { makePiOneShot } from "../textGeneration/piOneShot.ts";

const GENERATION_TIMEOUT = "180 seconds";
const MAX_EMERGENT_GOAL_RUNS = 2;

export const emergentGoalId = (threadId: ThreadId) => GoalId.make(`goal:emergent:${threadId}`);
export const emergentGoalCommandId = (threadId: ThreadId) =>
  CommandId.make(`${LOOM_EMERGENT_GOAL_PREFIX}${threadId}`);

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

const isTextGenerationError = Schema.is(TextGenerationError);
const decodeInterpretation = Schema.decodeEffect(
  Schema.fromJsonString(buildEmergentGoalPrompt({ message: "" }).outputSchema),
);

const fail = (detail: string, cause?: unknown) =>
  new TextGenerationError({ operation: "generateEmergentGoal", detail, cause });

/** The Pi one-shot on the text-generation model selection. */
export const EmergentGoalGeneratorPiLive = Layer.effect(
  EmergentGoalGenerator,
  Effect.map(makePiOneShot, (run) => ({
    generate: (input) =>
      run({ operation: "generateEmergentGoal", ...input }).pipe(
        Effect.flatMap((text) => decodeInterpretation(extractJsonObject(text))),
        Effect.timeout(GENERATION_TIMEOUT),
        Effect.mapError((cause) =>
          isTextGenerationError(cause) ? cause : fail("Emergent goal generation failed.", cause),
        ),
      ),
  })),
);

/**
 * Derives and attaches the emergent goal; `force` takes the best guess, otherwise
 * only a confident answer makes a goal. Returns without effect for a child or a
 * thread that already has a goal.
 */
export const deriveEmergentGoal = Effect.fn("loom.deriveEmergentGoal")(function* (input: {
  readonly threadId: ThreadId;
  readonly force: boolean;
}) {
  const orchestrator = yield* OrchestratorV2;
  const loomStore = yield* LoomStoreV2;
  const broadcast = yield* LoomGoalBroadcast;
  const generator = yield* EmergentGoalGenerator;
  const { threadId } = input;
  const { thread, messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"], {
    messageRoles: ["user", "assistant"],
  });
  const workstream = yield* loomStore.getWorkstream(threadId);
  if (
    thread.lineage.parentThreadId !== null ||
    workstream?.parentThreadId != null ||
    (workstream?.goalId ?? null) !== null ||
    // A `/retro` reviewer is goal-less by design: its goal tools refuse rather than mint one.
    workstream?.role === RETRO_REVIEWER_ROLE ||
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
    if (!input.force && interpretation.confidence !== "high") return;
    // The generation takes seconds; a goal set meanwhile wins, and no orphan goal is written.
    if (((yield* loomStore.getWorkstream(threadId))?.goalId ?? null) !== null) return;
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

/**
 * `deriveEmergentGoal`, serialised per thread and failure-logged: a caller arriving while
 * a derivation is in flight waits for it, then finds the goal attached (or, after a
 * low-confidence run 1, takes its own best guess when forced).
 */
export class EmergentGoals extends Context.Service<
  EmergentGoals,
  {
    readonly derive: (input: {
      readonly threadId: ThreadId;
      readonly force: boolean;
    }) => Effect.Effect<void>;
  }
>()("t3/loom/orchestration/EmergentGoalReactor/EmergentGoals") {}

export const EmergentGoalsLive = Layer.effect(
  EmergentGoals,
  Effect.gen(function* () {
    const services = yield* Effect.context<
      OrchestratorV2 | LoomStoreV2 | LoomGoalBroadcast | EmergentGoalGenerator
    >();
    const threadLocks = yield* KeyedLock.make<ThreadId>();
    return {
      derive: (input) =>
        threadLocks.withLock(input.threadId, deriveEmergentGoal(input)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("loom.emergent-goal.failed", { threadId: input.threadId, cause }),
          ),
          Effect.provideContext(services),
        ),
    };
  }),
);

/**
 * Started post-activation: each of a goal-less root's first two runs is tried once per
 * process, at its creation (the user's message), forked so a generation never holds up
 * the event stream.
 */
export const EmergentGoalReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const emergentGoals = yield* EmergentGoals;
    const scope = yield* Effect.scope;
    const attempted = new Set<RunId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        if (
          event.type !== "run.created" ||
          event.payload.ordinal > MAX_EMERGENT_GOAL_RUNS ||
          attempted.has(event.payload.id)
        ) {
          return Effect.void;
        }
        attempted.add(event.payload.id);
        return emergentGoals
          .derive({ threadId: event.threadId, force: event.payload.ordinal > 1 })
          .pipe(Effect.forkIn(scope), Effect.asVoid);
      }),
    );
  }),
);
