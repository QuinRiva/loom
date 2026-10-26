/**
 * Attaches `workstream` to each V2 thread shell with a sidecar row (one store call per snapshot);
 * other threads keep upstream's shape. Wraps `getShellSnapshot` / `getThreadShell`, so every
 * orchestrator reader sees the joined shape.
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
 * Loom's rollup badge counts every descendant of an active root, so the cold shell keeps what
 * upstream drops: a Loom child of a live root, and any Loom thread with a reason the rollup reads
 * (stored flag, failed unfinished run, or an un-started child that may be owed a brief).
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
