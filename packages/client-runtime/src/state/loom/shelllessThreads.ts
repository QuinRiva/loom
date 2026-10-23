/**
 * Shells for threads the shell stream does not carry: an archived root opened
 * from thread search. The stream drops archived threads, yet the thread view
 * is built on a shell, so a route that opens one asks `loom.threadShell` for
 * it and the answer joins the environment's shell snapshot. A live shell for
 * the same id always wins (an unarchive brings it back on the stream). Only
 * opened threads are fetched, one small read each, never the whole archive.
 *
 * @module state/loom/shelllessThreads
 */
import {
  type EnvironmentId,
  LOOM_WS_METHODS,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "../runtime.ts";

const NO_OPENED: ReadonlySet<ThreadId> = new Set();

type Answer = { readonly thread: OrchestrationV2ThreadShell | null };

// Only an archived, undeleted thread joins: a live one is on the stream, and a
// deleted one must read as gone, never reappear in a list.
const joinable = (answer: Answer | null) =>
  answer?.thread != null && answer.thread.archivedAt !== null && answer.thread.deletedAt == null
    ? answer.thread
    : null;

export function createShelllessThreadAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const shellQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: `environment-data:${LOOM_WS_METHODS.threadShell}`,
    tag: LOOM_WS_METHODS.threadShell,
    staleTimeMs: 60_000,
    idleTtlMs: 5 * 60_000,
  });
  const shellAtom = (ref: ScopedThreadRef) =>
    shellQuery({ environmentId: ref.environmentId, input: { threadId: ref.threadId } });
  const openedAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(NO_OPENED).pipe(Atom.keepAlive),
  );

  /** The environment's shell snapshot plus the opened threads it lacks. */
  const withShelllessThreads = (
    snapshotAtom: (environmentId: EnvironmentId) => Atom.Atom<OrchestrationV2ShellSnapshot | null>,
  ) =>
    Atom.family((environmentId: EnvironmentId) =>
      Atom.make((get) => {
        const snapshot = get(snapshotAtom(environmentId));
        const opened = get(openedAtom(environmentId));
        if (snapshot === null || opened.size === 0) return snapshot;
        const live = new Set(snapshot.threads.map((thread) => thread.id));
        const extra = [...opened].flatMap((threadId) => {
          if (live.has(threadId)) return [];
          const thread = joinable(
            Option.getOrNull(AsyncResult.value(get(shellAtom({ environmentId, threadId })))),
          );
          return thread === null ? [] : [thread];
        });
        return extra.length === 0
          ? snapshot
          : { ...snapshot, threads: [...snapshot.threads, ...extra] };
      }).pipe(Atom.withLabel(`environment-shell-snapshot-with-shellless:${environmentId}`)),
    );

  return { shellAtom, openedAtom, withShelllessThreads };
}

/** What a route waiting on a shell-less thread shows: its fetch is pending, or it does not exist. */
export function shelllessThreadState(
  result: AsyncResult.AsyncResult<Answer, unknown>,
): "pending" | "missing" | "found" {
  const value = Option.getOrNull(AsyncResult.value(result));
  if (value !== null) return joinable(value) === null ? "missing" : "found";
  return result._tag === "Failure" ? "missing" : "pending";
}
