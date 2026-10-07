/**
 * loom: thread-tab group keys and tab liveness, from V2 lineage.
 *
 * Centre-panel tabs are grouped per workstream (see `threadTabsStore`): a tab's
 * group key is the `scopedThreadKey` of its **workstream root**, reached by
 * walking V2 `lineage.parentThreadId` across `subagent` edges within the
 * thread's own environment. A fork (`relationshipToParent: "fork"`) is a root
 * in Loom's graph (DL-344), as in V1 where a fork had no parent, so the walk
 * stops there. This is the one place lineage becomes a group key; the store
 * takes keys as arguments.
 *
 * The index covers environments whose shell snapshot has loaded (cached or
 * live). V2 shells carry only unarchived threads, so a thread missing from a
 * **live** snapshot — one past the server's catch-up `synchronized` marker
 * (`shellResumeCompletionMarker`) — has been archived or deleted and its tab
 * has nothing to show; a cached snapshot may lag, so it never prunes. The
 * index keeps its identity until an edge, the thread set or liveness changes,
 * so its readers do not re-render on ordinary shell updates.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { environmentShell } from "../state/shell";

interface EnvironmentLineage {
  /** Past the catch-up marker: absence from `parents` means archived or deleted. */
  readonly live: boolean;
  /** Each unarchived thread's `subagent` parent (null for a root). */
  readonly parents: ReadonlyMap<ThreadId, ThreadId | null>;
}

/** Per environment whose shell snapshot has loaded. */
export type ThreadTabLineage = ReadonlyMap<EnvironmentId, EnvironmentLineage>;

const sameLineage = (left: EnvironmentLineage, right: EnvironmentLineage | undefined) =>
  right !== undefined &&
  left.live === right.live &&
  left.parents.size === right.parents.size &&
  [...left.parents].every(([id, parent]) => right.parents.get(id) === parent);

const lineageAtom = (() => {
  let previous: ThreadTabLineage = new Map();
  return Atom.make((get) => {
    const next: ThreadTabLineage = new Map(
      [...enabledEnvironmentIds(get(environmentCatalog.catalogValueAtom))].flatMap(
        (environmentId) => {
          const { snapshot, status } = get(environmentShell.stateValueAtom(environmentId));
          if (Option.isNone(snapshot)) return [];
          const parents = new Map(
            snapshot.value.threads.map(
              ({ id, lineage }) =>
                [
                  id,
                  lineage.relationshipToParent === "subagent" ? lineage.parentThreadId : null,
                ] as const,
            ),
          );
          return [[environmentId, { live: status === "live", parents }] as const];
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

/** Whether the thread is absent from its environment's live snapshot (archived or deleted). */
export function isThreadGone(lineage: ThreadTabLineage, ref: ScopedThreadRef): boolean {
  const entry = lineage.get(ref.environmentId);
  return entry?.live === true && !entry.parents.has(ref.threadId);
}
