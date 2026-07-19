/**
 * `/handoff` fork-drafter — server core (plan `plans/2026-07-19-handoff-fork-drafter.md`).
 *
 * Pure builders for the drafter launch: a throwaway `handoff-drafter` ROOT fork
 * of the source pi thread whose first turn is the drafter kickoff prompt. The
 * WS `server.handoffDraft` handler (in `ws.ts`) validates intake, resolves the
 * drafter's model selection, then routes the command this module builds through
 * the existing bootstrap turn-start path (`thread.turn.start` +
 * `bootstrap.createThread`, `origin:"kickoff"`, `setInProgress:true`). No
 * kickoff-brief file, no dispatcher involvement, and NOT the workstream child
 * prompt wrapper (that carries a false completion contract for a root).
 *
 * Kept pure + separate so the title/prompt/model-seeding logic is unit-testable
 * without a live engine.
 *
 * @module loom/handoffDraft
 */
import type {
  CommandId,
  ModelSelection,
  MessageId,
  OrchestrationCommand,
  OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";

import type { LaunchIdentityRecord } from "../orchestration/workstreamLaunchIdentity.ts";

/** The role marker every handoff-drafter special-case keys off (plan D3). */
export const HANDOFF_DRAFTER_ROLE = "handoff-drafter";

const TITLE_EXPLANATION_MAX = 50;

/**
 * The drafter's curated title: `Handoff: <explanation truncated ~50 chars>`
 * (plan D3). Whitespace-collapsed; ellipsised when long. The drafter may
 * `set_thread_title` to the final goal title once known.
 */
export const buildDrafterTitle = (explanation: string): string => {
  const collapsed = explanation.replace(/\s+/g, " ").trim();
  const truncated =
    collapsed.length > TITLE_EXPLANATION_MAX
      ? `${collapsed.slice(0, TITLE_EXPLANATION_MAX - 1).trimEnd()}\u2026`
      : collapsed;
  return `Handoff: ${truncated}`;
};

/**
 * The drafter kickoff prompt (plan §D4, rev 2). Instructs: draft focused
 * brief(s), one `goal_handoff` per independent goal, judgment on splitting, do
 * NOT do the work, do NOT write exhaustive briefs (the consult pointer is the
 * safety net), end the turn once every handoff is placed.
 */
/**
 * Append the drafter consult pointer to a destination brief (plan D5). This is
 * the pressure-release valve that lets a drafter write FOCUSED briefs: anything
 * omitted is recoverable because the receiving agent can `consult_thread` the
 * drafter's frozen fork of the originating session. Mirrors `goal_continue`'s
 * predecessor-pointer pattern.
 */
export const appendDrafterConsultPointer = (brief: string, drafterThreadId: ThreadId): string =>
  `${brief}\n\n---\nContext snapshot: thread ${drafterThreadId} holds a frozen fork of the` +
  ` originating session at handoff time; consult_thread it for anything this brief omits.`;

export const buildDrafterKickoffPrompt = (explanation: string): string =>
  `You are a handoff drafter forked from the preceding session with its full context. The human has flagged out-of-scope work: ${explanation}. Draft a focused brief for it and call \`goal_handoff\` (title, brief, description; name a \`project\` if the work belongs elsewhere). If the human flags multiple separable issues, use your judgment: one goal if they belong together, one \`goal_handoff\` call per goal if they should proceed independently. Do NOT do the work itself, and do not write exhaustive briefs — omissions are recoverable because the receiving agent can consult this frozen session. End your turn once every handoff is placed; you are then archived automatically.`;

/**
 * The raw (unbranded) model selection a drafter should launch with per the D4
 * model policy: the SOURCE's captured launch-identity instance/model/options —
 * the selection that actually consumed the source's cacheable prefix, which is
 * more trustworthy than the projected `sourceThread.modelSelection` after a
 * reroute. Returns `undefined` when there is no usable record (absent, or no
 * applied model) so the caller falls back to the projected selection. The
 * caller schema-validates this candidate (branding + instance existence) and
 * falls back on failure, mirroring the dispatcher's fork re-seed.
 */
export const capturedDrafterSelectionCandidate = (
  record: LaunchIdentityRecord | undefined,
):
  | {
      readonly instanceId: string;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
    }
  | undefined => {
  if (record === undefined || record.model === undefined) return undefined;
  const options = record.options?.map((option) => ({ id: option.id, value: option.value }));
  return {
    instanceId: record.providerInstanceId,
    model: record.model,
    ...(options && options.length > 0 ? { options } : {}),
  };
};

/**
 * Build the internal `thread.turn.start` command that mints the drafter root
 * and injects its kickoff as the first turn (plan D4). `bootstrap.createThread`
 * carries the ROOT fork shape (`parentThreadId:null`, `role:"handoff-drafter"`,
 * `forkFromThreadId:source`, inherited goal/worktree/runtime, curated title);
 * the turn message is the drafter prompt (`origin:"kickoff"`); `setInProgress`
 * flips the lane to `in_progress` atomically with the turn-start.
 */
export const buildHandoffDraftTurnStart = (input: {
  readonly source: OrchestrationThread;
  readonly explanation: string;
  readonly drafterThreadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly now: string;
}): Extract<OrchestrationCommand, { type: "thread.turn.start" }> => {
  const { source } = input;
  const title = buildDrafterTitle(input.explanation);
  return {
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.drafterThreadId,
    message: {
      messageId: input.messageId,
      role: "user",
      text: buildDrafterKickoffPrompt(input.explanation),
      origin: "kickoff",
      attachments: [],
    },
    modelSelection: input.modelSelection,
    titleSeed: title,
    runtimeMode: source.runtimeMode,
    interactionMode: source.interactionMode,
    setInProgress: true,
    bootstrap: {
      createThread: {
        projectId: source.projectId,
        goalId: source.goalId,
        parentThreadId: null,
        role: HANDOFF_DRAFTER_ROLE,
        forkFromThreadId: source.id,
        title,
        titleProvenance: "curated",
        modelSelection: input.modelSelection,
        runtimeMode: source.runtimeMode,
        interactionMode: source.interactionMode,
        branch: source.branch,
        worktreePath: source.worktreePath,
        createdAt: input.now,
      },
    },
    createdAt: input.now,
  };
};
