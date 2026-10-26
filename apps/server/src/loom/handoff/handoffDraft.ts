/**
 * `/handoff`: forks the source into a `handoff-drafter` ROOT via three Loom commands: `thread.spawn`
 * with the role and `forkFromThreadId`, `thread.fork.prepare` (upstream's pending fork transfer),
 * then the kickoff. V2's bare `thread.fork` would leave no sidecar row, and the role is what
 * `goal_handoff`, the composer's overlay and the reactor key on. The source is never touched.
 */
import {
  CommandId,
  type GoalId,
  LoomWsMethodError,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { runlessForkSource } from "../../orchestration-v2/runlessFork.loom.ts";
import { isForkableSourceRunStatus } from "../../orchestration-v2/ThreadForkService.ts";
import { controlMessage } from "../orchestration/dispatcher/controlMessage.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";

/** The role every handoff-drafter special case keys on (3a's `mcp__t3-code__goal_handoff`, the reactor). */
export const HANDOFF_DRAFTER_ROLE = "handoff-drafter";

const TITLE_EXPLANATION_MAX = 50;

/** `<prefix>: <text, whitespace-collapsed, ellipsised past ~50 chars>`. */
export const curatedTitle = (prefix: string, text: string) => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return `${prefix}: ${
    collapsed.length > TITLE_EXPLANATION_MAX
      ? `${collapsed.slice(0, TITLE_EXPLANATION_MAX - 1).trimEnd()}\u2026`
      : collapsed
  }`;
};

/** The drafter's title, `Handoff: <explanation>`; it may retitle itself once the goal is known. */
export const buildDrafterTitle = (explanation: string) => curatedTitle("Handoff", explanation);

/**
 * The drafter kickoff: draft focused brief(s), one `mcp__t3-code__goal_handoff` per independent
 * goal, do not do the work, do not write exhaustive briefs (the receiving agent
 * can consult this frozen fork), end the turn silently once every handoff is
 * placed — the drafter runs unattended, so any closing text is never read.
 */
export const buildDrafterKickoffPrompt = (explanation: string) =>
  `You are a handoff drafter forked from the preceding session with its full context. The human has flagged out-of-scope work: ${explanation}. Draft a focused brief for it and call \`mcp__t3-code__goal_handoff\` (title, brief, description; name a \`project\` if the work belongs elsewhere). The receiving root is told the brief is agent-written and treats it as a proposal: quote the human's words where you relay what they asked, mark the rest as your own reading, and describe the problem rather than instructing it what to do. It plans for itself. If the human flags multiple separable issues, use your judgment: one goal if they belong together, one \`mcp__t3-code__goal_handoff\` call per goal if they should proceed independently. Do NOT do the work itself, and do not write exhaustive briefs: omissions are recoverable because the receiving agent can \`mcp__t3-code__consult_thread\` this frozen session. After your last \`mcp__t3-code__goal_handoff\` call, end your turn immediately without further response.`;

const BLOCKING_RUN = new Set(["preparing", "starting", "running", "waiting"]);

/** What a drafter fork is launched from: the source's shell and goal, and the drafter's identity. */
export interface DraftForkInput {
  readonly source: Pick<
    OrchestrationV2ThreadShell,
    | "id"
    | "projectId"
    | "modelSelection"
    | "runtimeMode"
    | "interactionMode"
    | "branch"
    | "worktreePath"
  >;
  readonly sourceGoalId: GoalId | null;
  readonly drafterThreadId: ThreadId;
  readonly role: string;
  readonly title: string;
  readonly kickoff: string;
  /** The human's `/handoff` explanation: the source's receipt row shows it (copyable) while the drafter lives. */
  readonly purpose?: string;
  readonly createdAt: string;
}

/**
 * The fork and kickoff that follow a drafter's spawn. Ids hang off the drafter's
 * id (`server:loom:draft:<id>:<step>`), so a launch deferred behind a busy source
 * is re-sent under the same ids (`HandoffDrafterReactor`).
 */
export const buildDraftForkLaunch = (input: {
  readonly drafterThreadId: ThreadId;
  readonly sourceThreadId: ThreadId;
  readonly kickoff: string;
  readonly createdAt: string;
}) =>
  [
    forkPrepareCommand(input),
    controlMessage({
      threadId: input.drafterThreadId,
      id: `server:loom:draft:${input.drafterThreadId}:kickoff`,
      tier: "steered",
      origin: "kickoff",
      text: input.kickoff,
    }),
  ] as const;

/** The fork transfer from the source onto the drafter, under the drafter's deterministic id. */
export const forkPrepareCommand = (input: {
  readonly drafterThreadId: ThreadId;
  readonly sourceThreadId: ThreadId;
  readonly createdAt: string;
}) =>
  ({
    type: "thread.fork.prepare",
    commandId: CommandId.make(`server:loom:draft:${input.drafterThreadId}:fork`),
    threadId: input.drafterThreadId,
    createdAt: input.createdAt,
    sourceThreadId: input.sourceThreadId,
  }) as const satisfies OrchestrationV2ServerCommand;

/**
 * The drafter fork's three commands, dispatched in order: the root (role,
 * `forkFromThreadId`, the source's goal, worktree, modes and model), the fork
 * transfer, the kickoff.
 */
export const buildDraftForkCommands = (input: DraftForkInput) =>
  [
    buildDraftSpawn(input),
    ...buildDraftForkLaunch({
      drafterThreadId: input.drafterThreadId,
      sourceThreadId: input.source.id,
      kickoff: input.kickoff,
      createdAt: input.createdAt,
    }),
  ] as const satisfies ReadonlyArray<OrchestrationV2ServerCommand>;

/** The drafter's root: role, `forkFromThreadId`, the source's goal, worktree, modes and model. */
export const buildDraftSpawn = (input: Omit<DraftForkInput, "kickoff">) => {
  const { source } = input;
  return {
    type: "thread.spawn",
    commandId: CommandId.make(`server:loom:draft:${input.drafterThreadId}:spawn`),
    threadId: input.drafterThreadId,
    createdAt: input.createdAt,
    // The human asked for it (the composer intercept); the server builds it.
    createdBy: "user",
    creationSource: "server",
    parentThreadId: null,
    projectId: source.projectId,
    title: input.title,
    modelSelection: source.modelSelection,
    runtimeMode: source.runtimeMode,
    interactionMode: source.interactionMode,
    branch: source.branch,
    worktreePath: source.worktreePath,
    role: input.role,
    purpose: input.purpose ?? null,
    goalId: input.sourceGoalId,
    forkFromThreadId: source.id,
  } as const satisfies OrchestrationV2ServerCommand;
};

/** The `/handoff` drafter's commands (`buildDraftForkCommands` with its role, title and kickoff). */
export const buildHandoffDraftTurnStart = (
  input: Omit<DraftForkInput, "role" | "title" | "kickoff"> & { readonly explanation: string },
) =>
  buildDraftForkCommands({
    ...input,
    role: HANDOFF_DRAFTER_ROLE,
    title: buildDrafterTitle(input.explanation),
    kickoff: buildDrafterKickoffPrompt(input.explanation),
    purpose: input.explanation,
  });

/**
 * Sends a drafter fork's commands in order, stopping at the fork when the source
 * is mid-turn (`thread.fork.prepare` defers, unreceipted, until the source's run
 * ends). `deferred` leaves the rest for `HandoffDrafterReactor`, whose pass re-sends
 * them on every run end (a receipted id replays as a no-op); `dead` carries the refusal.
 */
export const dispatchDraftFork = Effect.fn("handoffDraft.dispatchDraftFork")(function* (
  commands: ReadonlyArray<OrchestrationV2ServerCommand>,
) {
  const orchestrator = yield* OrchestratorV2;
  for (const command of commands) {
    const stopped = yield* orchestrator.dispatch(command).pipe(
      Effect.as(null),
      Effect.catch((error) =>
        Effect.succeed(
          error._tag === "LoomDispatchDeferredError"
            ? ({ status: "deferred" } as const)
            : ({ status: "dead", error: error.message } as const),
        ),
      ),
    );
    if (stopped !== null) return stopped;
  }
  return { status: "launched" } as const;
});

/**
 * Validates the source and launches a drafter fork; returns the drafter's id. The source must be
 * pi-backed with a strong native session ref (its latest finished run's, or the importer-bound one
 * for a V1 thread with no V2 run). A mid-turn source is accepted: the drafter forks when the turn
 * ends. The model is the source's projected selection. Fails with `LoomWsMethodError`.
 */
export const launchDraftFork = Effect.fn("handoffDraft.launchDraftFork")(
  function* (input: {
    readonly method: string;
    /** "handed off" / "reviewed": the refusal wording. */
    readonly verb: string;
    readonly sourceThreadId: ThreadId;
    /** Minted here unless the caller needed it first (a query thread writes its brief before). */
    readonly drafterThreadId?: ThreadId;
    readonly build: (
      fork: Omit<DraftForkInput, "role" | "title" | "kickoff">,
      source: OrchestrationV2ThreadShell,
    ) => ReadonlyArray<OrchestrationV2ServerCommand>;
  }) {
    const orchestrator = yield* OrchestratorV2;
    const fail = (message: string) => new LoomWsMethodError({ method: input.method, message });
    const source = yield* orchestrator.getThreadShell(input.sourceThreadId);
    if (source === null || source.deletedAt != null)
      return yield* fail("The source thread was not found.");
    const records = yield* orchestrator.getThreadRecords(input.sourceThreadId, [
      "runs",
      "providerThreads",
    ]);
    // The provider thread the fork will copy: the latest finished run's (a busy
    // source's latest run's, as the fork waits for it), else the V1 import's binding.
    const latest = records.runs
      .filter((run) => isForkableSourceRunStatus(run.status) || BLOCKING_RUN.has(run.status))
      .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    const providerThread =
      latest === undefined
        ? runlessForkSource(records)
        : records.providerThreads.find((thread) => thread.id === latest.providerThreadId);
    if (providerThread === undefined)
      return yield* fail(`This thread has no finished turn yet, so nothing can be ${input.verb}.`);
    if (providerThread.driver !== "pi") {
      return yield* fail(
        `Only pi-backed threads can be ${input.verb} (the fork relies on pi's native session).`,
      );
    }
    // `fork.prepare` refuses without one; checked here so no drafter is created first. A
    // running pi turn's ref is still pending, and turns strong once the session is written.
    if (
      (latest === undefined || !BLOCKING_RUN.has(latest.status)) &&
      providerThread.nativeThreadRef?.strength !== "strong"
    ) {
      return yield* fail(
        `This thread's pi session cannot be forked (no native session reference), so it cannot be ${input.verb}.`,
      );
    }
    const drafterThreadId =
      input.drafterThreadId ?? ThreadId.make(yield* (yield* Crypto.Crypto).randomUUIDv4());
    const launch = yield* dispatchDraftFork(
      input.build(
        {
          source,
          sourceGoalId: (yield* (yield* LoomStoreV2).getWorkstream(source.id))?.goalId ?? null,
          drafterThreadId,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        },
        source,
      ),
    );
    if (launch.status === "dead") return yield* fail(launch.error);
    return drafterThreadId;
  },
  (effect, input) =>
    effect.pipe(
      Effect.catchIf(
        (error) => error._tag !== "LoomWsMethodError",
        (cause) =>
          Effect.fail(
            new LoomWsMethodError({
              method: input.method,
              message: `${input.method} failed to start the fork.`,
              cause,
            }),
          ),
      ),
    ),
);
