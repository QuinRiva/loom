/**
 * loom: whether a thread has workstream children, as a derived atom over its
 * environment's shells: it recomputes on any shell change but a reader
 * re-renders only when the answer flips — never subscribe a view to the whole
 * shell list.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "../state/threads";

const keyOf = (ref: ScopedThreadRef) => `${ref.environmentId}\u0000${ref.threadId}`;
const parse = (key: string) => key.split("\u0000") as [EnvironmentId, ThreadId];

/** Whether a thread has Loom (sidecar-bearing) children: a workstream root. */
const hasLoomChildrenAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = parse(key);
  return Atom.make((get) =>
    get(environmentThreadShells.environmentThreadsAtom(environmentId)).some(
      (shell) => shell.lineage.parentThreadId === threadId && shell.workstream !== undefined,
    ),
  ).pipe(Atom.withLabel(`loom-has-children:${key}`));
});

const FALSE_ATOM = Atom.make(false).pipe(Atom.withLabel("loom-has-children:none"));

export function useHasLoomChildren(threadRef: ScopedThreadRef | null): boolean {
  return useAtomValue(threadRef === null ? FALSE_ATOM : hasLoomChildrenAtom(keyOf(threadRef)));
}
