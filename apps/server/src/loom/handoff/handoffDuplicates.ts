/**
 * The `goal_handoff` duplicate check: before a handoff launches, a cheap model
 * compares its title, objective and brief with the work already open in the
 * inbox — every project's unarchived, unsettled threads that are not done or
 * cancelled — and names any thread that looks like the same work. The check
 * advises and never blocks: an error, a timeout or no Pi text-generation
 * instance finds nothing, so the handoff proceeds.
 *
 * @module loom/handoff/handoffDuplicates
 */
import {
  isProviderNativeSubagentThread,
  type ProjectId,
  TextGenerationError,
  type ThreadId,
} from "@t3tools/contracts";
import { extractJsonObject } from "@t3tools/shared/schemaJson";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";
import { makePiOneShot } from "../textGeneration/piOneShot.ts";

/** The Haiku tier: cheap, and quick enough to sit in front of a handoff. */
const DUPLICATE_CHECK_MODEL = "cliproxy/claude-haiku-5-5";
const CHECK_TIMEOUT = "30 seconds";
/** The most recently updated open threads the model sees. */
const MAX_CANDIDATES = 60;
const MAX_MATCHES = 3;

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const JudgeOutput = Schema.Struct({
  matches: Schema.Array(Schema.Struct({ candidate: Schema.Number, reason: Schema.String })),
});
const decodeJudgeOutput = Schema.decodeEffect(Schema.fromJsonString(JudgeOutput));

/** Runs the duplicate prompt through a model; the check's one seam (tests stub it). */
export class HandoffDuplicateJudge extends Context.Service<
  HandoffDuplicateJudge,
  {
    readonly judge: (input: {
      readonly projectId: ProjectId;
      readonly cwd: string;
      readonly prompt: string;
    }) => Effect.Effect<typeof JudgeOutput.Type, TextGenerationError>;
  }
>()("t3/loom/handoff/handoffDuplicates/HandoffDuplicateJudge") {}

export const HandoffDuplicateJudgePiLive = Layer.effect(
  HandoffDuplicateJudge,
  Effect.map(makePiOneShot, (run) => ({
    judge: (input) =>
      run({ operation: "checkHandoffDuplicate", model: DUPLICATE_CHECK_MODEL, ...input }).pipe(
        Effect.flatMap((text) => decodeJudgeOutput(extractJsonObject(text))),
        Effect.mapError((cause) =>
          Schema.is(TextGenerationError)(cause)
            ? cause
            : new TextGenerationError({
                operation: "checkHandoffDuplicate",
                detail: "The reply was not the expected JSON.",
                cause,
              }),
        ),
      ),
  })),
);

export interface HandoffDuplicate {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly goalTitle: string | null;
  readonly reason: string;
}

/**
 * Open threads that look like the handoff's work, best first; empty when none
 * do or the check could not run. `exclude` is the caller's own context (itself,
 * the thread it was forked from, the handoff's own id on a retry); the
 * caller's descendants are excluded too.
 */
export const findHandoffDuplicates = Effect.fn("loom.findHandoffDuplicates")(
  function* (input: {
    readonly callerThreadId: ThreadId;
    readonly exclude: ReadonlyArray<ThreadId>;
    readonly projectId: ProjectId;
    readonly cwd: string;
    readonly title: string;
    readonly description: string;
    readonly brief: string;
  }) {
    const store = yield* LoomStoreV2;
    const judge = yield* HandoffDuplicateJudge;
    const snapshot = yield* (yield* OrchestratorV2).getShellSnapshot({
      location: "active",
      unsettledOnly: true,
    });
    const parentOf = new Map(
      snapshot.threads.map((shell) => [shell.id, shell.lineage.parentThreadId]),
    );
    const underCaller = (threadId: ThreadId | null): boolean =>
      threadId !== null &&
      (threadId === input.callerThreadId || underCaller(parentOf.get(threadId) ?? null));
    const excluded = new Set(input.exclude);
    const candidates = snapshot.threads
      .filter(
        (shell) =>
          shell.archivedAt === null &&
          shell.settledOverride !== "settled" &&
          shell.workstream?.outcome == null &&
          !isProviderNativeSubagentThread(shell) &&
          !excluded.has(shell.id) &&
          !underCaller(shell.id),
      )
      .toSorted((a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt))
      .slice(0, MAX_CANDIDATES);
    if (candidates.length === 0) return [];

    const projects = new Map(
      (yield* (yield* ProjectService.ProjectService).snapshot).projects.map((project) => [
        project.id,
        project.title,
      ]),
    );
    const goals = new Map(
      (yield* Effect.forEach(new Set(candidates.map((shell) => shell.projectId)), (projectId) =>
        store.goals.listByProject(projectId),
      )).flatMap((list) => list.map((goal) => [goal.id, goal] as const)),
    );
    const goalOf = (shell: (typeof candidates)[number]) => {
      const goalId = shell.workstream?.goalId;
      return (goalId && goals.get(goalId)) || null;
    };

    // One section per goal, so siblings share a single objective line.
    const sections = new Map<string, Array<string>>();
    candidates.forEach((shell, index) => {
      const goal = goalOf(shell);
      const project = projects.get(shell.projectId) ?? shell.projectId;
      const heading =
        goal === null
          ? "No goal:"
          : `Goal "${goal.title}" (project ${project}): ${clip(goal.description, 300)}`;
      const line = `  [${index + 1}] ${shell.title}${goal === null ? ` (project ${project})` : ""}`;
      sections.set(heading, [...(sections.get(heading) ?? []), line]);
    });
    const inbox = [...sections].map(([heading, lines]) => [heading, ...lines].join("\n"));

    const prompt = [
      "An agent is about to hand off work to a new thread. Decide whether an open thread is already doing that work.",
      "",
      "New handoff:",
      `Title: ${input.title}`,
      `Objective: ${input.description}`,
      `Brief:\n${clip(input.brief, 4_000)}`,
      "",
      "Open threads, numbered, grouped by goal:",
      inbox.join("\n\n"),
      "",
      "A thread is a duplicate only when it already pursues substantially the same objective, so the new thread would redo or race its work. A shared topic, codebase or project, adjacent work, or a follow-up to it is NOT a duplicate. When unsure, it is not a duplicate.",
      `Return only a JSON object: {"matches": [{"candidate": <number>, "reason": "<one short sentence on why it is the same work>"}]}, at most ${MAX_MATCHES} entries, best first, or {"matches": []}.`,
    ].join("\n");

    const [elapsed, output] = yield* judge
      .judge({ projectId: input.projectId, cwd: input.cwd, prompt })
      .pipe(Effect.timeout(CHECK_TIMEOUT), Effect.timed);
    const matches = output.matches
      .flatMap(({ candidate, reason }) => {
        const shell = candidates[candidate - 1];
        return shell === undefined
          ? []
          : [
              {
                threadId: shell.id,
                title: shell.title,
                goalTitle: goalOf(shell)?.title ?? null,
                reason: reason.trim(),
              } satisfies HandoffDuplicate,
            ];
      })
      .slice(0, MAX_MATCHES);
    yield* Effect.logInfo("loom.handoff.duplicate-check", {
      candidates: candidates.length,
      matches: matches.map((match) => match.threadId),
      ms: Duration.toMillis(elapsed),
    });
    return matches;
  },
  // Fail open: the check must never be the reason a handoff cannot happen.
  Effect.catchCause((cause) =>
    Effect.logWarning("loom.handoff.duplicate-check.failed", { cause: Cause.pretty(cause) }).pipe(
      Effect.as<ReadonlyArray<HandoffDuplicate>>([]),
    ),
  ),
);
