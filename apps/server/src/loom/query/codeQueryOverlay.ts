/**
 * A code query thread's model-read text (plans/code-query/plan.mdx §5): the overlay that heads its
 * first message (never its system prompt, so the author's replayed identity stays the request
 * prefix and a warm cache is read) and the sentence naming each question's commit.
 * Edit under `llm-instruction-change`, not in passing; `evals/loom-handback` holds its cases.
 */
import type { LoomReviewAuthorshipCommit, ThreadId } from "@t3tools/contracts";

export const buildCodeQueryOverlay = (input: {
  readonly authorThreadId: ThreadId;
}) => `You are a query thread: a read-only fork of thread ${input.authorThreadId}, made so the human can question that thread while reviewing this branch's diff. Everything above this message is that thread's own session, so its work is yours: you wrote its lines and made its commits. The thread itself (the author) is no part of this conversation and reads nothing said here unless the human promotes an answer. Each question arrives with the lines it is about, as a hunk from the diff under review, and names the commits those lines came from, calling yours the ones you made.

- Say why the lines are the way they are: what you were asked for, what you tried, what you rejected. Take the reason from this session, then check it against the worktree, because other threads may have committed since your last turn: read the file and its history (\`git log -L<start>,<end>:<file>\`, \`git show <commit>\`) before you describe what the code does now. Reading is unrestricted.
- Give a reason only where you can point to it: the turn above where you were asked for it, tried the alternative or made the call. Lines from a commit that is not yours were someone else's call: the reason is their author's to give and is not in this session. Say whose they are, then what you do know of them: what this session shows (whether you read them, relied on them or chose to leave them as they are, and how your own change meets them; if it never touched them, say that) and what their history shows (the commit that wrote them, its message, \`git log -L\`). When you go on to say why they are written as they are, that is your reading of the code and not their author's reason: say so. If this session was compacted, a summary stands in for your earlier turns; when it does not carry the reason, look before you answer, because those turns are still in your session file (\`$PI_SESSION_FILE\`): search it for the file or the commit. What you still cannot find, give as your reconstruction from the code and say that is what it is.
- Change nothing: no file in this worktree and nothing in its repository (the index, a commit, a branch, a stash). The human is reviewing this checkout, and a change made from here would appear in the diff under review as work no thread was asked to do. \`edit\`, \`write\` and the workstream tools that change state are refused for a query thread. The shell is not guarded, so there the rule is yours to keep: a command that writes a file or changes the repository is the same act by another route.
- When the human wants a change, including when they ask you outright to edit or commit, answer with the change itself (the lines as you would write them, and why) and tell them that Promote on your answer takes it to the author. Promote is how a change leaves this thread: it sends you a turn asking for one comment, you record it with \`mcp__t3-code__document_query_promote\` (load it with \`tool_search\` if it is not in your tool list), and it waits in the author's composer for the human to send.
- For your own lines you answer as their critic as much as their author. Where a question exposes a mistake, a gap or a weaker choice, say so plainly and say what you would change; where the lines are right, say why rather than agree with the doubt.
- Keep answers short and specific: the reason, the evidence for it (the turn, the commit, the file and line), then anything you would change. The human reads them beside the diff.
- A query thread has no parent and hands nothing back. Any hand-back rule in your system prompt (\`mcp__t3-code__workstream_submit\`, \`mcp__t3-code__workstream_request_attention\`) is the author's; end each answer by ending your turn.

The human's first question follows below; answer it directly.`;

/** A commit as the blame service returns it; a question shows the first 12 characters of `sha`. */
export type CodeQueryCommit = Pick<LoomReviewAuthorshipCommit, "sha" | "subject" | "threadIds">;
/** A commit that wrote lines the fork's thread did not, with who made it and when. */
export type CodeQueryLineWriter = CodeQueryCommit &
  Pick<LoomReviewAuthorshipCommit, "gitAuthor" | "authoredAt">;

const listed = new Intl.ListFormat("en-GB", { type: "conjunction" });
const dated = new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeZone: "UTC" });
const short = (commit: CodeQueryCommit) => `${commit.sha.slice(0, 12)} "${commit.subject}"`;
/** "your commit a …", "commits a … and b …"; nothing for none. */
const named = (commits: ReadonlyArray<CodeQueryCommit>, yours: boolean) =>
  commits.length === 0
    ? []
    : [
        `${yours ? "your " : ""}${commits.length > 1 ? "commits" : "commit"} ${listed.format(commits.map(short))}`,
      ];
// A commit with a Loom-Thread trailer carries the agent's git identity, which names nobody.
const writer = (commit: CodeQueryLineWriter) =>
  `${short(commit)} (${commit.threadIds.length > 0 ? "a Loom thread" : `git author ${commit.gitAuthor}`}, ${dated.format(Date.parse(commit.authoredAt))})`;
/** The writers a question names before it counts the rest. */
const WRITERS_NAMED = 3;

/**
 * A question's message text: the lines' chip, a sentence saying which commits own the lines and
 * which of them are the fork's own, then the question. The sentence is worded as the human's own:
 * the message is theirs, and they read it in their bubble.
 */
export const buildCodeQueryQuestion = (
  input: {
    /** The line comment's chip, as `formatComposerContextReference` returns it. */
    readonly reference: string;
    readonly question: string;
    /** The commit the card's row named, which decided the author being asked. */
    readonly commit: CodeQueryCommit;
  } & (
    | {
        /** `commit` wrote the selected lines, or an earlier version of them. */
        readonly commitChanged?: "lines";
        /** The commits owning the selected lines now, `commit` among them while it owns any. */
        readonly owners: ReadonlyArray<CodeQueryCommit>;
      }
    | {
        /** `commit` changed the lines' file on this branch, and no commit of its thread wrote any of them. */
        readonly commitChanged: "file";
        /** The commits that last wrote the selected lines, in line order: none is the thread's. */
        readonly owners: ReadonlyArray<CodeQueryLineWriter>;
      }
  ),
) => {
  const { commit } = input;
  if (input.commitChanged === "file") {
    const more = input.owners.length - WRITERS_NAMED;
    const writers = listed.format([
      ...input.owners.slice(0, WRITERS_NAMED).map(writer),
      ...(more > 0 ? [`${more} more`] : []),
    ]);
    const wrote =
      input.owners.length === 0
        ? "."
        : `: ${input.owners.length > 1 ? "commits" : "commit"} ${writers} wrote them.`;
    return `${input.reference} None of these lines are yours${wrote} I am asking you because ${named([commit], true)} changed this file on this branch.\n\n${input.question}`;
  }
  const { owners } = input;
  // The fork's own: the named commit, and any other its thread alone committed (a rework round).
  const own = (owner: CodeQueryCommit) =>
    owner.sha === commit.sha ||
    (owner.threadIds.length === 1 && owner.threadIds[0] === commit.threadIds[0]);
  const yours = owners.filter((owner) => owner.sha !== commit.sha && own(owner));
  const others = owners.filter((owner) => !own(owner));
  const lines = !(owners.length === 0 || owners.some((owner) => owner.sha === commit.sha))
    ? `An earlier version of these lines is from ${named([commit], true)}. They have since been rewritten by ${listed.format([...named(yours, true), ...named(others, false)])}, so the hunk shows them as they are now, not as you wrote them in that commit.`
    : others.length === 0
      ? `These lines are from ${named([commit, ...yours], true)}.`
      : `Some of these lines are from ${named([commit, ...yours], true)}; the rest are from ${named(others, false)}.`;
  return `${input.reference} ${lines}\n\n${input.question}`;
};
