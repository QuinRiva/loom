/**
 * `/handoff` fork-drafter, out of quarantine onto V2 (Phase 3 plan Track 3b,
 * DT-24). The human's composer intercept calls `loom.handoffDraft`; the server
 * forks the source into a `handoff-drafter` ROOT whose first message is the
 * drafter kickoff. The source transcript is never touched; the drafter is
 * archived once its handoff is recorded (`HandoffDrafterReactor`).
 *
 * The fork is three Loom commands (DL-384): `thread.spawn` of a root carrying
 * the role, the source's goal, worktree, modes and projected model selection
 * and `forkFromThreadId`; `thread.fork.prepare`, which writes upstream's pending
 * `fork` context transfer from the source's latest finished run (what
 * `thread.fork`'s `latest_stable` picks; a V1-imported thread with no V2 run forks
 * its bound pi session) for upstream to resolve natively at the drafter's first run
 * (P3-28's mechanism); then the kickoff as a Loom control message. A mid-turn
 * source defers the fork, and `HandoffDrafterReactor` sends the fork and kickoff
 * once the turn ends, so the drafter carries that turn too. V2's bare `thread.fork` would leave the drafter without a sidecar
 * row, and the role is what `mcp__t3-code__goal_handoff`, the composer's overlay and the
 * reactor key on.
 *
 * `/retro` (`retroDraft.ts`) reuses `launchDraftFork` with its own role and kickoff.
 *
 * @module loom/handoff/handoffDraft
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
 * can consult this frozen fork), end the turn once every handoff is placed.
 */
export const buildDrafterKickoffPrompt = (explanation: string) =>
  `You are a handoff drafter forked from the preceding session with its full context. The human has flagged out-of-scope work: ${explanation}. Draft a focused brief for it and call \`mcp__t3-code__goal_handoff\` (title, brief, description; name a \`project\` if the work belongs elsewhere). If the human flags multiple separable issues, use your judgment: one goal if they belong together, one \`mcp__t3-code__goal_handoff\` call per goal if they should proceed independently. Do NOT do the work itself, and do not write exhaustive briefs — omissions are recoverable because the receiving agent can \`mcp__t3-code__consult_thread\` this frozen session. End your turn once every handoff is placed; you are then archived automatically.`;

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
 * is re-sent under the same ids (`continueDraftFork`).
 */
export const buildDraftForkLaunch = (input: {
  readonly drafterThreadId: ThreadId;
  readonly sourceThreadId: ThreadId;
  readonly kickoff: string;
  readonly createdAt: string;
}) => {
  const id = (step: string) => `server:loom:draft:${input.drafterThreadId}:${step}`;
  return [
    {
      type: "thread.fork.prepare",
      commandId: CommandId.make(id("fork")),
      threadId: input.drafterThreadId,
      createdAt: input.createdAt,
      sourceThreadId: input.sourceThreadId,
    },
    controlMessage({
      threadId: input.drafterThreadId,
      id: id("kickoff"),
      tier: "steered",
      origin: "kickoff",
      text: input.kickoff,
    }),
  ] as const;
};

/**
 * The drafter fork's three commands, dispatched in order: the root (role,
 * `forkFromThreadId`, the source's goal, worktree, modes and model), the fork
 * transfer, the kickoff.
 */
export const buildDraftForkCommands = (input: DraftForkInput) => {
  const { source } = input;
  return [
    {
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
    },
    ...buildDraftForkLaunch({
      drafterThreadId: input.drafterThreadId,
      sourceThreadId: source.id,
      kickoff: input.kickoff,
      createdAt: input.createdAt,
    }),
  ] as const satisfies ReadonlyArray<OrchestrationV2ServerCommand>;
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
export const dispatchDraftFork = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  Effect.gen(function* () {
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
 * Validates the source and launches a drafter fork; returns the drafter's id.
 * The source must exist and be pi-backed with a strong native session ref (the
 * drafter's whole value is the source's native session): its latest finished
 * run's, or for a V1-imported thread with no V2 run yet, the session the importer
 * bound (`runlessFork.loom.ts`). A source that is mid-turn is accepted: the drafter
 * appears now and forks when the turn ends, so it carries that turn too. The model
 * is the source's projected selection (DL-384: launch identity is the composer's).
 * Fails with `LoomWsMethodError` naming `method`.
 */
export const launchDraftFork = (input: {
  readonly method: string;
  /** "handed off" / "reviewed": the refusal wording. */
  readonly verb: string;
  readonly sourceThreadId: ThreadId;
  readonly build: (
    fork: Omit<DraftForkInput, "role" | "title" | "kickoff">,
    source: OrchestrationV2ThreadShell,
  ) => ReadonlyArray<OrchestrationV2ServerCommand>;
}) =>
  Effect.gen(function* () {
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
    const drafterThreadId = ThreadId.make(yield* (yield* Crypto.Crypto).randomUUIDv4);
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
  }).pipe(
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
  );
