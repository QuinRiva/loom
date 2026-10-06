/**
 * loom: thread-tab group-key derivation.
 *
 * Centre-panel tabs are grouped per workstream (see `threadTabsStore`): a tab's
 * group key is the `scopedThreadKey` of its **workstream root**, reached by
 * walking V2 `lineage.parentThreadId` across `subagent` edges within the
 * thread's own environment. A fork (`relationshipToParent: "fork"`) is a root
 * in Loom's graph (DL-344), as in V1 where a fork had no parent, so the walk
 * stops there. This is the one place lineage becomes a group key; the store
 * takes keys as arguments.
 *
 * The lineage index keeps its identity until an edge changes, so the readers
 * (the route's sync hook, the tab keyboard and strip actions) do not re-render
 * on ordinary shell updates.
 */
import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useCallback } from "react";

import { environmentThreadShells } from "../state/threads";

/** A tab's workstream-root group key, or null while its thread's shell is unknown. */
export type ThreadGroupResolver = (ref: ScopedThreadRef) => string | null;

/** Every known thread's `subagent` lineage parent (null for a root), by `scopedThreadKey`. */
const subagentParentsAtom = (() => {
  let previous: ReadonlyMap<string, ThreadId | null> = new Map();
  return Atom.make((get) => {
    const next = new Map(
      get(environmentThreadShells.threadShellsAtom).map(
        (shell) =>
          [
            scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.id }),
            shell.lineage.relationshipToParent === "subagent" ? shell.lineage.parentThreadId : null,
          ] as const,
      ),
    );
    if (
      next.size !== previous.size ||
      [...next].some(([key, parent]) => previous.get(key) !== parent)
    ) {
      previous = next;
    }
    return previous;
  }).pipe(Atom.withLabel("loom-tab-subagent-parents"));
})();

/** The root's key for `ref`; an unloaded ancestor still names the root it points at. */
export function resolveThreadGroupKey(
  parents: ReadonlyMap<string, ThreadId | null>,
  ref: ScopedThreadRef,
): string | null {
  const keyFor = (threadId: ThreadId) =>
    scopedThreadKey({ environmentId: ref.environmentId, threadId });
  if (!parents.has(keyFor(ref.threadId))) return null;
  const seen = new Set([ref.threadId]);
  let rootId = ref.threadId;
  for (let parent = parents.get(keyFor(rootId)); parent && !seen.has(parent);) {
    seen.add(parent);
    rootId = parent;
    parent = parents.get(keyFor(rootId));
  }
  return keyFor(rootId);
}

/** A resolver over the live lineage index; its identity changes only when an edge does. */
export function useThreadGroupResolver(): ThreadGroupResolver {
  const parents = useAtomValue(subagentParentsAtom);
  return useCallback((ref) => resolveThreadGroupKey(parents, ref), [parents]);
}
