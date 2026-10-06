/**
 * `/retro` fork-reviewer, out of quarantine onto V2 (Phase 3 plan Track 3b,
 * DT-24). The same fork as `/handoff` (`launchDraftFork`: a root spawned with
 * `forkFromThreadId`, `thread.fork.prepare`, the kickoff) with two deliberate
 * differences: the reviewer stays VISIBLE (the reactor never archives it — the
 * human inspects it), and its kickoff points at an on-disk brief
 * (`RETRO_BRIEF_PATH`) so the retro guidance iterates without a code change.
 *
 * @module loom/handoff/retroDraft
 */
import { buildDraftForkCommands, curatedTitle, type DraftForkInput } from "./handoffDraft.ts";

/** The role every retro-reviewer special case keys on (the composer's server-owned overlay). */
export const RETRO_REVIEWER_ROLE = "retro-reviewer";

/**
 * Where the retro guidance lives on disk. The kickoff tells the reviewer to read
 * it, so the criteria change between runs without shipping code. Deliberately
 * outside the repo: the brief is the experiment's mutable half.
 */
export const RETRO_BRIEF_PATH = "~/loom-retro/retro-brief.md";

/**
 * The retro reviewer's role overlay, SERVER-OWNED: a `/retro` fork is minted by
 * the server, never spawned from the role catalogue, so its policy is this
 * constant rather than a role file. The session composer (3a) supplies it for
 * the `retro-reviewer` role.
 */
export const RETRO_REVIEWER_OVERLAY_PROMPT = `You are a retrospective reviewer: a fork of the thread under review, carrying its full conversation as your context. The transcript that precedes your kickoff is the development process you are reviewing — you did not do that work; you are auditing how it went.

- Your kickoff points at an on-disk retro brief. That brief is your assignment: what to look for, how to generalise findings, and how to deliver proposals. Read it first and follow it.
- **You are report-only towards the work under review.** You change nothing about it: no code edits, no commits, no role/doc/skill/prompt changes, no workstream mutations (no spawning, prompting, or outcome changes). No proposal is ever acted on in this thread — proposals are observations for the human's cross-retro analysis, not a work queue.
- **Write scope (the two deliverables, and nothing else):**
  1. Your proposals batch as an annotatable MDX decision document at \`recaps/retro-<slug>/recap.mdx\` in the inherited worktree, authored per the \`mdx-visual-recap\` skill (one ReviewChoice per proposal, evidence embedded, linted before handback). This is the working surface: the human triages and discusses it with you, refining or dropping proposals over one or more turns.
  2. After the human has triaged, the refined record in the central retro repository under \`~/loom-retro/\` (outside any worktree — an authorised exception to the worktree rule, because the corpus must accumulate across projects for later theme analysis). Record the post-discussion state: refined proposals, dropped ones marked dropped with the reason, and the human's verdicts.
- Evidence discipline: every finding traces to something that actually happened in the transcript or the thread graph. Use \`mcp__t3-code__workstream_list\` to map the source workstream, read child reports, and \`mcp__t3-code__consult_thread\` where a report leaves an ambiguity. Quote evidence verbatim; never paraphrase into something stronger than what occurred.
- When the batch is authored, end your turn naming the recap path and asking the human to triage in-app — there is no parent orchestrator to submit to; the human reads you directly. Expect follow-up turns: verdicts and annotations arrive as review turns on this thread, and you persist the central record once triage settles.`;

/** The reviewer's title, `Retro: <source title>`. */
export const buildRetroTitle = (sourceTitle: string) => curatedTitle("Retro", sourceTitle);

/** The retro kickoff: identity, the pointer to the on-disk brief, and the run's focus. */
export const buildRetroKickoffPrompt = (focus: string | undefined) =>
  `You are a retrospective reviewer, forked from the preceding thread with its full conversation context. The transcript above is the complete development process you are reviewing. Read \`${RETRO_BRIEF_PATH}\` and follow it exactly. Focus: ${focus ?? "general"}`;

/** The `/retro` reviewer's commands (`buildDraftForkCommands` with its role, title and kickoff). */
export const buildRetroDraftTurnStart = (
  input: Omit<DraftForkInput, "role" | "title" | "kickoff"> & {
    readonly sourceTitle: string;
    readonly focus: string | undefined;
  },
) =>
  buildDraftForkCommands({
    ...input,
    role: RETRO_REVIEWER_ROLE,
    title: buildRetroTitle(input.sourceTitle),
    kickoff: buildRetroKickoffPrompt(input.focus),
  });
