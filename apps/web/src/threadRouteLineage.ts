import type { ThreadId } from "@t3tools/contracts";
import type { ThreadShell } from "./types";

export interface LineageSegment {
  threadId: ThreadId;
  title: string;
  archived: boolean;
  missing: boolean;
  /** True only for the segment whose own `parentThreadId` is null (the real
   * orchestrator root). Stays false if the walk stopped on a missing parent or
   * the depth cap, so the UI never mislabels a mid-chain ancestor as the root. */
  isRoot: boolean;
}

/** Stable empty-lineage reference so consumers' memo/identity checks don't churn. */
export const EMPTY_LINEAGE: ReadonlyArray<LineageSegment> = [];

/**
 * Walk `parentThreadId` upward from `childThreadId` through a single
 * environment's `threadShellById`, returning the ancestor chain ordered
 * root → immediate parent.
 *
 * Pure and bounded: a `visited` set guards against cycles and a hard
 * `maxDepth` cap stops runaway chains. A parent id with no shell in the map
 * (missing / archived-away / cross-environment) becomes a single trailing
 * `missing` segment and ends the walk.
 */
export function buildThreadLineage(
  threadShellById: Record<ThreadId, ThreadShell>,
  childThreadId: ThreadId,
  { maxDepth = 16 }: { maxDepth?: number } = {},
): LineageSegment[] {
  const segments: LineageSegment[] = [];
  const visited = new Set<ThreadId>([childThreadId]);
  let parentId = threadShellById[childThreadId]?.parentThreadId ?? null;

  while (parentId !== null && !visited.has(parentId) && segments.length < maxDepth) {
    visited.add(parentId);
    const shell = threadShellById[parentId];
    if (!shell) {
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
      title: shell.title,
      archived: shell.archivedAt != null,
      missing: false,
      isRoot: shell.parentThreadId == null,
    });
    parentId = shell.parentThreadId;
  }

  return segments.toReversed();
}
