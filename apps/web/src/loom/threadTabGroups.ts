/**
 * loom: thread-tab group keys (each tab's root via `subagent` edges in the family-merged snapshot;
 * a fork is a root) and liveness. The cold shell omits settled roots and their idle sub-threads, so
 * absence is not gone: only a removal the shell saw since its latest authoritative snapshot prunes.
 * The index keeps its identity until an edge, the thread set or the removals change.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { environmentShell } from "../state/shell";
import { threadEnvironment } from "../state/threads";

interface EnvironmentLineage {
  /** Threads archived or deleted since the shell's latest authoritative snapshot. */
  readonly removed: ReadonlyMap<ThreadId, number>;
  /** Each unarchived thread's `subagent` parent (null for a root). */
  readonly parents: ReadonlyMap<ThreadId, ThreadId | null>;
}

/** Per environment whose shell snapshot has loaded. */
export type ThreadTabLineage = ReadonlyMap<EnvironmentId, EnvironmentLineage>;

const sameLineage = (left: EnvironmentLineage, right: EnvironmentLineage | undefined) =>
  right !== undefined &&
  left.removed === right.removed &&
  left.parents.size === right.parents.size &&
  [...left.parents].every(([id, parent]) => right.parents.get(id) === parent);

const lineageAtom = (() => {
  let previous: ThreadTabLineage = new Map();
  return Atom.make((get) => {
    const next: ThreadTabLineage = new Map(
      [...enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))].flatMap(
        (environmentId) => {
          const snapshot = get(threadEnvironment.snapshotAtom(environmentId));
          if (snapshot === null) return [];
          const parents = new Map(
            snapshot.threads.map(
              ({ id, lineage }) =>
                [
                  id,
                  lineage.relationshipToParent === "subagent" ? lineage.parentThreadId : null,
                ] as const,
            ),
          );
          const { removedAt } = get(environmentShell.stateValueAtom(environmentId));
          return [[environmentId, { removed: removedAt, parents }] as const];
        },
      ),
    );
    if (
      next.size !== previous.size ||
      [...next].some(([environmentId, entry]) => !sameLineage(entry, previous.get(environmentId)))
    ) {
      previous = next;
    }
    return previous;
  }).pipe(Atom.withLabel("loom-thread-tab-lineage"));
})();

export const useThreadTabLineage = (): ThreadTabLineage => useAtomValue(lineageAtom);

/** The root's group key for a live thread (an unloaded ancestor is still named), else null. */
export function resolveThreadGroupKey(
  lineage: ThreadTabLineage,
  ref: ScopedThreadRef,
): string | null {
  const parents = lineage.get(ref.environmentId)?.parents;
  if (!parents?.has(ref.threadId)) return null;
  const seen = new Set([ref.threadId]);
  let rootId = ref.threadId;
  for (let parent = parents.get(rootId); parent && !seen.has(parent);) {
    seen.add(parent);
    rootId = parent;
    parent = parents.get(rootId);
  }
  return scopedThreadKey({ environmentId: ref.environmentId, threadId: rootId });
}

/** Whether the shell saw the thread archived or deleted and it has not come back. */
export function isThreadGone(lineage: ThreadTabLineage, ref: ScopedThreadRef): boolean {
  const entry = lineage.get(ref.environmentId);
  return entry !== undefined && entry.removed.has(ref.threadId) && !entry.parents.has(ref.threadId);
}
