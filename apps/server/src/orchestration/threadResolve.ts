/**
 * threadResolve - target resolution for the USER-DIRECTED `consult_thread`
 * capability (global scope: any thread the server knows, across worktrees).
 *
 * Two independent concerns, both deliberately OUTSIDE the workstream-tree scope:
 *
 *  1. `rankThreadsByName` - pure fuzzy match of a sidebar name to ranked
 *     candidate threads. Titles are non-unique, truncated, and span every
 *     worktree, so the caller disambiguates (confirm with the user) instead of
 *     guessing. `isUnambiguousMatch` is the conservative "safe to auto-run"
 *     gate — consulting the wrong thread is costly.
 *
 *  2. `resolveSessionFilePath` - resolve a thread's deterministic pi session id
 *     to the ABSOLUTE `.jsonl` path on disk (re-exported from `provider/
 *     piSessionFiles.ts`, where it lives alongside `piSessionIdForThread`). This sidesteps
 *     pi's id-scoping trap: `pi --fork <bareId>` resolves the id rooted at the
 *     caller's project slug, so a target living in a *different* worktree/project
 *     slug yields "No session found". A full path bypasses pi's id search
 *     entirely, which is exactly what cross-worktree reach needs.
 *
 * @module threadResolve
 */
import type { ProjectId, ThreadId, ThreadPlanLane } from "@t3tools/contracts";

export { defaultSessionsRoot, resolveSessionFilePath } from "../provider/piSessionFiles.ts";

/** The minimal thread fields name resolution reads (a subset of the shell). */
export interface ThreadNameCandidate {
  readonly id: ThreadId;
  readonly title: string;
  readonly role: string | null;
  readonly planLane: ThreadPlanLane;
  readonly projectId: ProjectId;
  readonly worktreePath: string | null;
  /** ISO timestamp used only as a recency tie-break between equal scores. */
  readonly updatedAt: string;
}

export interface RankedThread<T extends ThreadNameCandidate> {
  readonly thread: T;
  readonly score: number;
}

const EXACT = 100;
const PREFIX = 80;
const WORD_PREFIX = 70;
const SUBSTRING = 60;
const SUBSEQUENCE = 40;

/** Does every char of `q` appear in order within `text` (fuzzy subsequence)? */
const isSubsequence = (q: string, text: string): boolean => {
  let i = 0;
  for (const char of text) {
    if (char === q[i]) i += 1;
    if (i === q.length) return true;
  }
  return q.length === 0;
};

/** Best single-thread score for the query against its title (0 = no match). */
const scoreTitle = (query: string, title: string): number => {
  const t = title.toLowerCase();
  if (t === query) return EXACT;
  if (t.startsWith(query)) return PREFIX;
  if (t.split(/\s+/).some((word) => word.startsWith(query))) return WORD_PREFIX;
  if (t.includes(query)) return SUBSTRING;
  if (isSubsequence(query, t)) return SUBSEQUENCE;
  return 0;
};

/**
 * Rank candidate threads by how well their title matches `query`, best first.
 * Zero-score threads are dropped. Ties break toward the shorter title (a tighter
 * match) then the more recently updated thread, so ordering is deterministic.
 */
export const rankThreadsByName = <T extends ThreadNameCandidate>(
  query: string,
  threads: ReadonlyArray<T>,
): ReadonlyArray<RankedThread<T>> => {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  return threads
    .map((thread) => ({ thread, score: scoreTitle(q, thread.title) }))
    .filter((ranked) => ranked.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.thread.title.length - b.thread.title.length ||
        b.thread.updatedAt.localeCompare(a.thread.updatedAt),
    );
};

/** Margin by which the top match must beat the runner-up to auto-run. */
const UNAMBIGUOUS_MARGIN = 20;

/**
 * Conservative "safe to consult without confirming" gate: a clear top match
 * (substring-or-better) that strictly beats the runner-up by a margin. Two
 * threads sharing a title (equal top score) are deliberately NOT unambiguous —
 * they fall through to candidate disambiguation.
 */
export const isUnambiguousMatch = <T extends ThreadNameCandidate>(
  ranked: ReadonlyArray<RankedThread<T>>,
): boolean => {
  const [top, next] = ranked;
  if (top === undefined || top.score < SUBSTRING) return false;
  return next === undefined || top.score - next.score >= UNAMBIGUOUS_MARGIN;
};
