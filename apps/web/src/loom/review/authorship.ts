/**
 * loom: the Diff panel's authorship, from one `loom.review.authorship` reply
 * (plans/diff-author-query/plan.mdx §3–§4). Pure: runs to the author of a line, colour slots, and
 * the files each author has lines in. Who may be named is `authorOf`'s rule, applied once here.
 */
import type { LoomReviewAuthorshipResult, ThreadId } from "@t3tools/contracts";
import { authorOf } from "@t3tools/shared/reviewAuthorship.loom";

/** Six theme-aware author colours; a seventh thread shares a slot and its chip's name tells them apart. */
// Clear of the green and red the diff spends on added and removed lines.
export const AUTHOR_COLOURS = ["violet", "amber", "sky", "pink", "orange", "indigo"].map(
  (hue) => `light-dark(var(--color-${hue}-600), var(--color-${hue}-400))`,
);
export const NEUTRAL_AUTHOR_COLOUR = "light-dark(var(--color-zinc-500), var(--color-zinc-400))";

export interface AuthorGroup {
  /** `thread:<id>`, `threads:<ids>`, `git:<name>` or `uncommitted`. */
  readonly key: string;
  readonly kind: "thread" | "threads" | "git" | "uncommitted";
  readonly label: string;
  readonly threadId: ThreadId | null;
  /** A thread's colour slot; null draws the neutral edge (dashed when uncommitted). */
  readonly slot: number | null;
  /** Files holding at least one of its lines. */
  readonly files: ReadonlySet<string>;
}

export interface LineAuthor {
  readonly group: AuthorGroup;
  /** The commit that wrote the line; null when it is not committed. */
  readonly sha: string | null;
}

export interface Authorship {
  /** The "Written by" row's order: threads by colour slot, then the rest, uncommitted last. */
  readonly groups: ReadonlyArray<AuthorGroup>;
  readonly incomplete: boolean;
  /** The author of a new-side line, or null (older than the branch, or never answered for). */
  readonly at: (path: string, line: number) => LineAuthor | null;
  /** Every author of the new-side lines `start`–`end`, in line order, one entry per commit. */
  readonly between: (path: string, start: number, end: number) => ReadonlyArray<LineAuthor>;
}

const KIND_ORDER = { thread: 0, threads: 1, git: 2, uncommitted: 3 } as const;

/** The new-side lines each file of a unified diff adds. */
function addedLinesOf(patch: string): ReadonlyMap<string, ReadonlySet<number>> {
  const added = new Map<string, Set<number>>();
  let lines: Set<number> | null = null;
  let line = 0;
  let previous = "";
  for (const text of patch.split("\n")) {
    const header = previous.startsWith("--- ");
    previous = text;
    if (header && text.startsWith("+++ ")) {
      const path = text.slice(4).replace(/^"(.*)"$/, "$1");
      lines = path === "/dev/null" ? null : new Set();
      if (lines) added.set(path.replace(/^b\//, ""), lines);
    } else if (text.startsWith("@@")) line = Number(/\+(\d+)/.exec(text)?.[1] ?? 0);
    else if (lines === null || text.startsWith("-") || text.startsWith("\\")) continue;
    else if (text.startsWith("+")) lines.add(line++);
    else if (text.startsWith(" ")) line++;
  }
  return added;
}

const narrowed = new WeakMap<
  LoomReviewAuthorshipResult,
  { readonly patch: string; readonly result: LoomReviewAuthorshipResult }
>();

/**
 * The reply cut to the lines `patch` adds. The reply covers the whole branch, and "Since your
 * message" shows only part of it: a line the branch changed before the message must not name its
 * author there.
 */
export function narrowAuthorship(
  result: LoomReviewAuthorshipResult,
  patch: string,
): LoomReviewAuthorshipResult {
  const cached = narrowed.get(result);
  if (cached?.patch === patch) return cached.result;
  const added = addedLinesOf(patch);
  const files = result.files.flatMap((file) => {
    const lines = added.get(file.path);
    if (lines === undefined || lines.size === 0) return [];
    if (file.untracked) return [file];
    const runs = file.runs.flatMap(([start, end, index]) => {
      const kept: Array<[number, number, number]> = [];
      for (let line = start; line <= end; line++) {
        if (!lines.has(line)) continue;
        const last = kept.at(-1);
        if (last && last[1] === line - 1) last[1] = line;
        else kept.push([line, line, index]);
      }
      return kept;
    });
    return runs.length > 0 ? [{ ...file, runs }] : [];
  });
  const next = { ...result, files };
  narrowed.set(result, { patch, result: next });
  return next;
}

const built = new WeakMap<LoomReviewAuthorshipResult, Authorship>();

/** One `Authorship` per reply, so a render that did not change the reply restamps nothing. */
export function authorshipOf(result: LoomReviewAuthorshipResult): Authorship {
  let authorship = built.get(result);
  if (authorship === undefined) {
    authorship = buildAuthorship(result);
    built.set(result, authorship);
  }
  return authorship;
}

function buildAuthorship(result: LoomReviewAuthorshipResult): Authorship {
  const groups = new Map<string, AuthorGroup & { readonly files: Set<string> }>();
  const groupFor = (
    key: string,
    fields: Omit<AuthorGroup, "key" | "files" | "slot">,
    slotted: boolean,
  ) => {
    let group = groups.get(key);
    if (group === undefined) {
      const slot = slotted
        ? [...groups.values()].filter((entry) => entry.slot !== null).length % AUTHOR_COLOURS.length
        : null;
      group = { key, ...fields, slot, files: new Set() };
      groups.set(key, group);
    }
    return group;
  };
  const titleOf = (threadId: ThreadId) =>
    result.threads.find((thread) => thread.threadId === threadId)?.title ?? "another thread";
  // Commits arrive oldest first, so a thread's slot follows its first commit on the branch.
  const commitGroups = result.commits.map((commit) => {
    const author = authorOf(commit, result.threads);
    return author.kind === "thread"
      ? groupFor(
          `thread:${author.thread.threadId}`,
          { kind: "thread", label: author.thread.title, threadId: author.thread.threadId },
          true,
        )
      : author.kind === "threads"
        ? groupFor(
            `threads:${author.threadIds.join(",")}`,
            { kind: "threads", label: author.threadIds.map(titleOf).join(" + "), threadId: null },
            false,
          )
        : groupFor(
            `git:${author.name}`,
            { kind: "git", label: author.name, threadId: null },
            false,
          );
  });
  const uncommitted = groupFor(
    "uncommitted",
    { kind: "uncommitted", label: "uncommitted", threadId: null },
    false,
  );
  const runsByPath = new Map(result.files.map((file) => [file.path, file]));
  for (const file of result.files) {
    if (file.untracked) uncommitted.files.add(file.path);
    for (const [, , index] of file.runs)
      (index === -1 ? uncommitted : commitGroups[index])?.files.add(file.path);
  }
  const ownerOf = (path: string, index: number): LineAuthor | null => {
    if (index === -1) return { group: uncommitted, sha: null };
    const group = commitGroups[index];
    return group ? { group, sha: result.commits[index]!.sha } : null;
  };

  return {
    groups: [...groups.values()]
      .filter((group) => group.files.size > 0)
      .toSorted(
        (left, right) =>
          KIND_ORDER[left.kind] - KIND_ORDER[right.kind] || (left.slot ?? 0) - (right.slot ?? 0),
      ),
    incomplete: result.incomplete,
    at: (path, line) => {
      const file = runsByPath.get(path);
      if (file === undefined) return null;
      if (file.untracked) return { group: uncommitted, sha: null };
      // Runs are sorted and disjoint: binary search for the one holding the line.
      let low = 0;
      let high = file.runs.length - 1;
      while (low <= high) {
        const middle = (low + high) >> 1;
        const [start, end, index] = file.runs[middle]!;
        if (line < start) high = middle - 1;
        else if (line > end) low = middle + 1;
        else return ownerOf(path, index);
      }
      return null;
    },
    between: (path, start, end) => {
      const file = runsByPath.get(path);
      if (file === undefined) return [];
      if (file.untracked) return [{ group: uncommitted, sha: null }];
      const seen = new Set<number>();
      return file.runs.flatMap(([runStart, runEnd, index]) => {
        if (runEnd < start || runStart > end || seen.has(index)) return [];
        seen.add(index);
        const owner = ownerOf(path, index);
        return owner ? [owner] : [];
      });
    },
  };
}
