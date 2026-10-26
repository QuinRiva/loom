/**
 * The shell join (plans/upstream-pull9-phase2-substrate/plan.mdx §4): attaches
 * `workstream` to each V2 thread shell that has a sidecar row — one store call
 * per snapshot. Threads without a row carry no key, so upstream's shell shape
 * is unchanged for them. Wrapped around the orchestrator's `getShellSnapshot` /
 * `getThreadShell`, so every consumer that reads through the orchestrator sees
 * the joined shape.
 *
 * @module loom/projection/loomShellJoin
 */
import type {
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadShellSnapshot,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { LoomStoreV2Shape } from "./LoomStore.ts";

const joinShells =
  (loomStore: LoomStoreV2Shape) => (shells: ReadonlyArray<OrchestrationV2ThreadShell>) =>
    loomStore.shellFields(shells.map((shell) => shell.id)).pipe(
      Effect.map((fields) =>
        shells.map((shell) => {
          const workstream = fields.get(shell.id);
          return workstream === undefined ? shell : { ...shell, workstream };
        }),
      ),
    );

export const joinLoomShellFields =
  (loomStore: LoomStoreV2Shape) => (snapshot: OrchestrationV2ThreadShellSnapshot) =>
    joinShells(loomStore)([...snapshot.threads, ...snapshot.archivedThreads]).pipe(
      Effect.map((joined) => ({
        ...snapshot,
        threads: joined.slice(0, snapshot.threads.length),
        archivedThreads: joined.slice(snapshot.threads.length),
      })),
    );

export const joinLoomThreadShell =
  (loomStore: LoomStoreV2Shape) => (shell: OrchestrationV2ThreadShell | null) =>
    shell === null
      ? Effect.succeed(null)
      : joinShells(loomStore)([shell]).pipe(Effect.map((joined) => joined[0]!));

/**
 * Upstream's cold shell omits idle subagent rows and older settled roots, but Loom's rollup
 * badge counts every descendant of an active root and raises any thread's stored or derived
 * reason (doc 38 §6.2, DL-1404). Keeps a Loom child of a live root, and any Loom thread that
 * carries a reason the rollup reads: a stored flag, a failed unfinished run (`runFailed`),
 * or an un-started child that may be owed a brief.
 */
export const keepsLoomChildInColdShell = (
  thread: Pick<OrchestrationV2ThreadShell, "workstream" | "status" | "lastErrorClass" | "lineage">,
  roots: ReadonlyMap<string, Pick<OrchestrationV2ThreadShell, "archivedAt" | "settledOverride">>,
): boolean => {
  const workstream = thread.workstream;
  if (workstream === undefined) return false;
  const root =
    workstream.parentThreadId === null ? undefined : roots.get(thread.lineage.rootThreadId);
  return (
    (root !== undefined && root.archivedAt === null && root.settledOverride !== "settled") ||
    workstream.attention.length > 0 ||
    (workstream.outcome === null &&
      ((thread.status === "failed" &&
        thread.lastErrorClass != null &&
        thread.lastErrorClass !== "usage_limit") ||
        (workstream.parentThreadId !== null && workstream.kickoffAt === null && !workstream.held)))
  );
};
