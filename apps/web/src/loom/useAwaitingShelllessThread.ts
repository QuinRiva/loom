import { useAtomValue } from "@effect/atom-react";
import { shelllessThreadState } from "@t3tools/client-runtime/state/loom/shelllessThreads";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { shelllessThreads } from "../state/threads";

const NO_SHELL_ATOM = Atom.make(AsyncResult.initial<{ readonly thread: null }>()).pipe(
  Atom.withLabel("web-shellless-thread:none"),
);

/**
 * An archived root opened from thread search has no shell on the stream. Once
 * the live snapshot is authoritative and still lacks the route's thread, ask
 * for that one shell and join it to the shells (state/loom/shelllessThreads),
 * so the thread view renders it as any other. True while that answer is
 * outstanding; a thread that does not exist answers null and the route bounces.
 */
export function useAwaitingShelllessThread(
  ref: ScopedThreadRef | null,
  input: { readonly shellExists: boolean; readonly bootstrapComplete: boolean },
): boolean {
  const wanted = ref !== null && !input.shellExists && input.bootstrapComplete ? ref : null;
  const result = useAtomValue(wanted === null ? NO_SHELL_ATOM : shelllessThreads.shellAtom(wanted));
  const environmentId = wanted?.environmentId ?? null;
  const threadId = wanted?.threadId ?? null;
  useEffect(() => {
    if (environmentId === null || threadId === null) return;
    appAtomRegistry.update(shelllessThreads.openedAtom(environmentId), (opened) =>
      opened.has(threadId) ? opened : new Set([...opened, threadId]),
    );
  }, [environmentId, threadId]);
  return wanted !== null && shelllessThreadState(result) !== "missing";
}
