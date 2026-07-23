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

/**
 * The retro reviewer's role overlay, SERVER-OWNED. The generic role-overlay
 * path loads `roles/<role>.md` from the REVIEWED project's worktree — which
 * would make the retro policy exist only in checkouts that happen to carry the
 * file (never other projects, never older worktrees). A `/retro` fork is minted
 * by the server, not spawned from a project's role catalogue, so its policy is
 * a single server-owned source: the reactor injects this text for the
 * `retro-reviewer` role instead of consulting the project's roles dir.
 */
export const RETRO_REVIEWER_OVERLAY_PROMPT = `You are a retrospective reviewer: a fork of the thread under review, carrying its full conversation as your context. The transcript that precedes your kickoff is the development process you are reviewing — you did not do that work; you are auditing how it went.

- Your kickoff points at an on-disk retro brief. That brief is your assignment: what to look for, how to generalise findings, and how to deliver proposals. Read it first and follow it.
- **You are report-only towards the work under review.** You change nothing about it: no code edits, no commits, no role/doc/skill/prompt changes, no workstream mutations (no spawning, prompting, or lane changes). No proposal is ever acted on in this thread — proposals are observations for the human's cross-retro analysis, not a work queue.
- **Write scope (the two deliverables, and nothing else):**
  1. Your proposals batch as an annotatable MDX decision document at \`recaps/retro-<slug>/recap.mdx\` in the inherited worktree, authored per the \`mdx-visual-recap\` skill (one ReviewChoice per proposal, evidence embedded, linted before handback). This is the working surface: the human triages and discusses it with you, refining or dropping proposals over one or more turns.
  2. After the human has triaged, the refined record in the central retro repository under \`~/loom-retro/\` (outside any worktree — an authorised exception to the worktree rule, because the corpus must accumulate across projects for later theme analysis). Record the post-discussion state: refined proposals, dropped ones marked dropped with the reason, and the human's verdicts.
- Evidence discipline: every finding traces to something that actually happened in the transcript or the thread graph. Use \`workstream_list\` to map the source workstream, read child reports, and \`consult_thread\` where a report leaves an ambiguity. Quote evidence verbatim; never paraphrase into something stronger than what occurred.
- When the batch is authored, end your turn naming the recap path and asking the human to triage in-app — there is no parent orchestrator to submit to; the human reads you directly. Expect follow-up turns: verdicts and annotations arrive as review turns on this thread, and you persist the central record once triage settles.`;

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
