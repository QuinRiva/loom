import type { ThreadId } from "@t3tools/contracts";

/** What the lineage walk reads from a thread: its V2 lineage parent and title. */
export interface LineageThread {
  readonly title: string;
  /** `lineage.parentThreadId` (authoritative in V2). */
  readonly parentThreadId: ThreadId | null;
  readonly archived: boolean;
}

export interface LineageSegment {
  threadId: ThreadId;
  title: string;
  archived: boolean;
  missing: boolean;
  /** True only for the segment whose own parent is null (the real root). */
  isRoot: boolean;
}

/** Stable empty-lineage reference so consumers' memo/identity checks don't churn. */
export const EMPTY_LINEAGE: ReadonlyArray<LineageSegment> = [];

/**
 * Walk the lineage parent upward from `childThreadId`, returning the ancestor
 * chain ordered root → immediate parent. Bounded: a `visited` set breaks
 * cycles and `maxDepth` caps runaway chains. A parent with no entry (missing,
 * archived away, another environment) becomes one trailing `missing` segment.
 */
export function buildThreadLineage(
  threads: ReadonlyMap<ThreadId, LineageThread>,
  childThreadId: ThreadId,
  { maxDepth = 16 }: { maxDepth?: number } = {},
): LineageSegment[] {
  const segments: LineageSegment[] = [];
  const visited = new Set<ThreadId>([childThreadId]);
  let parentId = threads.get(childThreadId)?.parentThreadId ?? null;

  while (parentId !== null && !visited.has(parentId) && segments.length < maxDepth) {
    visited.add(parentId);
    const thread = threads.get(parentId);
    if (!thread) {
      segments.push({
        threadId: parentId,
        title: "parent unavailable",
        archived: false,
        missing: true,
        isRoot: false,
      });
      break;
    }
    segments.push({
      threadId: parentId,
      title: thread.title,
      archived: thread.archived,
      missing: false,
      isRoot: thread.parentThreadId === null,
    });
    parentId = thread.parentThreadId;
  }

  return segments.toReversed();
}
