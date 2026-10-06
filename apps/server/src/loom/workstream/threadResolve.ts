/**
 * Target resolution for the global `mcp__t3-code__consult_thread` / `mcp__t3-code__notify_thread` (any
 * thread the server knows, active or archived, across projects): an exact id,
 * or a fuzzy sidebar name ranked over `getShellSnapshot`. Titles are
 * non-unique, so an ambiguous name returns ranked candidates for the caller to
 * confirm — acting on the wrong thread is costly — and nothing runs. Ported
 * from V1's `threadResolve.ts` (DT-22); the session file is NOT resolved here:
 * consult reads it from the provider thread's `nativeThreadRef`.
 *
 * @module loom/workstream/threadResolve
 */
import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";

/** The minimal fields name ranking reads. */
export interface ThreadNameCandidate {
  readonly id: ThreadId;
  readonly title: string;
  /** ISO timestamp, only a recency tie-break between equal scores. */
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
/** Margin by which the top match must beat the runner-up to act without confirming. */
const UNAMBIGUOUS_MARGIN = 20;
/** Candidates surfaced on an ambiguous name: a focused set, not the server's whole list. */
export const CANDIDATE_LIMIT = 8;

const isSubsequence = (query: string, text: string): boolean => {
  let index = 0;
  for (const char of text) {
    if (char === query[index]) index += 1;
    if (index === query.length) return true;
  }
  return query.length === 0;
};

const scoreTitle = (query: string, title: string): number => {
  const text = title.toLowerCase();
  if (text === query) return EXACT;
  if (text.startsWith(query)) return PREFIX;
  if (text.split(/\s+/).some((word) => word.startsWith(query))) return WORD_PREFIX;
  if (text.includes(query)) return SUBSTRING;
  return isSubsequence(query, text) ? SUBSEQUENCE : 0;
};

/**
 * Threads ranked by how well their title matches `query`, best first; zero
 * scores dropped. Ties break toward the shorter title, then the more recent.
 */
export const rankThreadsByName = <T extends ThreadNameCandidate>(
  query: string,
  threads: ReadonlyArray<T>,
): ReadonlyArray<RankedThread<T>> => {
  const normalised = query.trim().toLowerCase();
  if (normalised.length === 0) return [];
  return threads
    .map((thread) => ({ thread, score: scoreTitle(normalised, thread.title) }))
    .filter((ranked) => ranked.score > 0)
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        a.thread.title.length - b.thread.title.length ||
        b.thread.updatedAt.localeCompare(a.thread.updatedAt),
    );
};

/**
 * Safe to act without confirming: a substring-or-better top match that beats
 * the runner-up by a margin. Two threads sharing a title never qualify.
 */
export const isUnambiguousMatch = <T extends ThreadNameCandidate>(
  ranked: ReadonlyArray<RankedThread<T>>,
): boolean => {
  const [top, next] = ranked;
  if (top === undefined || top.score < SUBSTRING) return false;
  return next === undefined || top.score - next.score >= UNAMBIGUOUS_MARGIN;
};

export type ThreadResolution =
  | { readonly kind: "thread"; readonly shell: OrchestrationV2ThreadShell }
  | { readonly kind: "candidates"; readonly shells: ReadonlyArray<OrchestrationV2ThreadShell> }
  | { readonly kind: "missing"; readonly message: string };

const missing = (message: string): ThreadResolution => ({ kind: "missing", message });
const found = (shell: OrchestrationV2ThreadShell): ThreadResolution => ({ kind: "thread", shell });

/** Resolves exactly one of `threadId` / `name` over every live or archived thread. */
export const resolveThread = Effect.fn("loom.resolveThread")(function* (target: {
  readonly threadId?: string | undefined;
  readonly name?: string | undefined;
}) {
  const threadId = target.threadId?.trim() || undefined;
  const name = target.name?.trim() || undefined;
  if ((threadId === undefined) === (name === undefined))
    return missing("Provide exactly one of threadId or name.");
  const snapshot = yield* Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getShellSnapshot(),
  );
  const shells = [...snapshot.threads, ...snapshot.archivedThreads];
  if (threadId !== undefined) {
    const shell = shells.find((candidate) => candidate.id === threadId);
    return shell === undefined ? missing(`Thread ${threadId} was not found.`) : found(shell);
  }
  const ranked = rankThreadsByName(
    name!,
    shells.map((shell) => ({
      id: shell.id,
      title: shell.title,
      updatedAt: DateTime.formatIso(shell.updatedAt),
      shell,
    })),
  );
  if (ranked.length === 0) return missing(`No thread matches "${name}".`);
  return isUnambiguousMatch(ranked)
    ? found(ranked[0]!.thread.shell)
    : ({
        kind: "candidates",
        shells: ranked.slice(0, CANDIDATE_LIMIT).map((entry) => entry.thread.shell),
      } satisfies ThreadResolution);
});
