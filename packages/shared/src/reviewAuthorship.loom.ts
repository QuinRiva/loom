/**
 * The one naming rule of the diff's authorship (plans/diff-author-query/plan.mdx §3): a commit names
 * a thread only when it carries exactly one `Loom-Thread` trailer and that thread is held here.
 * Everything else shows what is known and offers no Query, because no author beats a guess.
 */
import type {
  LoomReviewAuthorshipCommit,
  LoomReviewAuthorshipThread,
  ThreadId,
} from "@t3tools/contracts";

export type ReviewAuthor =
  | { readonly kind: "thread"; readonly thread: LoomReviewAuthorshipThread }
  /** Two threads committed it (one amended the other's commit): both are named, neither is asked. */
  | { readonly kind: "threads"; readonly threadIds: ReadonlyArray<ThreadId> }
  /** No trailer, or one naming a thread this server does not hold: the git author only. */
  | { readonly kind: "git"; readonly name: string };

export function authorOf(
  commit: Pick<LoomReviewAuthorshipCommit, "threadIds" | "gitAuthor">,
  threads: ReadonlyArray<LoomReviewAuthorshipThread>,
): ReviewAuthor {
  if (commit.threadIds.length > 1) return { kind: "threads", threadIds: commit.threadIds };
  const thread = threads.find((candidate) => candidate.threadId === commit.threadIds[0]);
  return thread ? { kind: "thread", thread } : { kind: "git", name: commit.gitAuthor };
}
