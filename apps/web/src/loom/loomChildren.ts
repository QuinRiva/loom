/**
 * loom: a thread's children as derived atoms over its environment's shells.
 * Each atom recomputes on any shell change in the environment, but returns the
 * previous value when the answer is unchanged, so a reader (ChatView, the Diff
 * panel) re-renders only when this thread's children change — never subscribe
 * those views to the whole shell list.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";

import { environmentThreadShells } from "../state/threads";

export interface LoomChild {
  readonly id: ThreadId;
  readonly title: string;
}

const NO_CHILDREN: ReadonlyArray<LoomChild> = Object.freeze([]);
const keyOf = (ref: ScopedThreadRef) => `${ref.environmentId}\u0000${ref.threadId}`;
const parse = (key: string) => key.split("\u0000") as [EnvironmentId, ThreadId];

/**
 * Lineage children ∪ workstream children (`workstream.parentThreadId`), oldest
 * first — the Diff panel's "By coder" scope (DT-33).
 */
const childrenAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = parse(key);
  let previous = NO_CHILDREN;
  return Atom.make((get) => {
    const next = get(environmentThreadShells.environmentThreadsAtom(environmentId))
      .filter(
        (shell) =>
          shell.lineage.parentThreadId === threadId ||
          shell.workstream?.parentThreadId === threadId,
      )
      .toSorted((left, right) => DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt))
      .map((shell) => ({ id: shell.id, title: shell.title }));
    const same =
      next.length === previous.length &&
      next.every((child, index) => {
        const prior = previous[index]!;
        return child.id === prior.id && child.title === prior.title;
      });
    if (!same) previous = next.length === 0 ? NO_CHILDREN : next;
    return previous;
  }).pipe(Atom.withLabel(`loom-children:${key}`));
});

/** Whether a thread has Loom (sidecar-bearing) children: a workstream root. */
const hasLoomChildrenAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = parse(key);
  return Atom.make((get) =>
    get(environmentThreadShells.environmentThreadsAtom(environmentId)).some(
      (shell) => shell.lineage.parentThreadId === threadId && shell.workstream !== undefined,
    ),
  ).pipe(Atom.withLabel(`loom-has-children:${key}`));
});

const NO_CHILDREN_ATOM = Atom.make(NO_CHILDREN).pipe(Atom.withLabel("loom-children:none"));
const FALSE_ATOM = Atom.make(false).pipe(Atom.withLabel("loom-has-children:none"));

export function useLoomChildren(threadRef: ScopedThreadRef | null): ReadonlyArray<LoomChild> {
  return useAtomValue(threadRef === null ? NO_CHILDREN_ATOM : childrenAtom(keyOf(threadRef)));
}

export function useHasLoomChildren(threadRef: ScopedThreadRef | null): boolean {
  return useAtomValue(threadRef === null ? FALSE_ATOM : hasLoomChildrenAtom(keyOf(threadRef)));
}
