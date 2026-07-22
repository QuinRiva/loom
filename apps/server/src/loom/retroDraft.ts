/**
 * `/retro` fork-reviewer — server core.
 *
 * Pure builders for the retro launch: a VISIBLE `retro-reviewer` ROOT fork of
 * the source pi thread whose first turn is the retro kickoff prompt. The WS
 * `server.retroDraft` handler (in `ws.ts`) validates intake, resolves the
 * reviewer's model selection, then routes the command this module builds
 * through the existing bootstrap turn-start path (`thread.turn.start` +
 * `bootstrap.createThread`, `origin:"kickoff"`, `setInProgress:true`). The
 * source transcript is never touched.
 *
 * Same shape as the `/handoff` fork-drafter (`loom/handoffDraft.ts`) with two
 * deliberate differences: the reviewer stays VISIBLE (no sidebar hiding, no
 * reactor archival — the human inspects it), and its kickoff points at an
 * on-disk brief (`RETRO_BRIEF_PATH`) so the retro guidance iterates without a
 * code change.
 *
 * Kept pure + separate so the title/prompt logic is unit-testable without a
 * live engine.
 *
 * @module loom/retroDraft
 */
import type {
  CommandId,
  MessageId,
  ModelSelection,
  OrchestrationCommand,
  OrchestrationThread,
  ThreadId,
} from "@t3tools/contracts";

/** The role marker every retro-reviewer special-case keys off. */
export const RETRO_REVIEWER_ROLE = "retro-reviewer";

/**
 * Where the retro guidance lives on disk. The kickoff instructs the reviewer to
 * READ this file rather than embedding the guidance, so the review criteria are
 * editable between runs without shipping a change. Deliberately outside the
 * repo: the brief is the experiment's mutable half.
 */
export const RETRO_BRIEF_PATH = "~/loom-retro/retro-brief.md";

const TITLE_SOURCE_MAX = 50;

/**
 * The reviewer's curated title: `Retro: <source title truncated ~50 chars>`.
 * Whitespace-collapsed; ellipsised when long.
 */
export const buildRetroTitle = (sourceTitle: string): string => {
  const collapsed = sourceTitle.replace(/\s+/g, " ").trim();
  const truncated =
    collapsed.length > TITLE_SOURCE_MAX
      ? `${collapsed.slice(0, TITLE_SOURCE_MAX - 1).trimEnd()}\u2026`
      : collapsed;
  return `Retro: ${truncated}`;
};

/**
 * The retro kickoff prompt. Deliberately thin: identity (forked reviewer with
 * the source's full context), the pointer to the on-disk brief that carries
 * the actual review guidance, and the run's focus. Everything about WHAT to
 * look for and HOW to file proposals lives in the brief file so the human can
 * iterate on it between runs.
 */
export const buildRetroKickoffPrompt = (focus: string | undefined): string =>
  `You are a retrospective reviewer, forked from the preceding thread with its full conversation context. The transcript above is the complete development process you are reviewing. Read \`${RETRO_BRIEF_PATH}\` and follow it exactly. Focus: ${focus ?? "general"}`;

/**
 * Build the internal `thread.turn.start` command that mints the reviewer root
 * and injects its kickoff as the first turn. `bootstrap.createThread` carries
 * the ROOT fork shape (`parentThreadId:null`, `role:"retro-reviewer"`,
 * `forkFromThreadId:source`, inherited goal/worktree/runtime, curated title);
 * the turn message is the retro prompt (`origin:"kickoff"`); `setInProgress`
 * flips the lane to `in_progress` atomically with the turn-start.
 */
export const buildRetroDraftTurnStart = (input: {
  readonly source: OrchestrationThread;
  readonly focus: string | undefined;
  readonly reviewerThreadId: ThreadId;
  readonly modelSelection: ModelSelection;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly now: string;
}): Extract<OrchestrationCommand, { type: "thread.turn.start" }> => {
  const { source } = input;
  const title = buildRetroTitle(source.title);
  return {
    type: "thread.turn.start",
    commandId: input.commandId,
    threadId: input.reviewerThreadId,
    message: {
      messageId: input.messageId,
      role: "user",
      text: buildRetroKickoffPrompt(input.focus),
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
        role: RETRO_REVIEWER_ROLE,
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
