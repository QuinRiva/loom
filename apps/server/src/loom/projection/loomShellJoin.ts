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
