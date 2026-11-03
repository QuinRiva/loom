/**
 * Attaches `workstream` to each V2 thread shell with a sidecar row (one store call per snapshot);
 * other threads keep upstream's shape. Wraps `getShellSnapshot` / `getThreadShell`, so every
 * orchestrator reader sees the joined shape.
 */
import type {
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadShellSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { ActiveShellIndexEntry } from "../../orchestration-v2/ProjectionStore.ts";
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

type GoalRootFields = Pick<OrchestrationV2ThreadShell, "lineage" | "settledOverride"> & {
  readonly workstream?: { readonly goalId: string | null } | undefined;
};

/**
 * Whether a thread belongs to a goal with an unsettled top-level thread: such a goal keeps its older
 * settled roots in the cold shell, so the goal panel lists every session and a source's timeline
 * keeps its "continued in" receipt.
 */
export const inLiveLoomGoal = (threads: ReadonlyArray<GoalRootFields>) => {
  const live = new Set(
    threads.flatMap((thread) =>
      thread.lineage.relationshipToParent !== "subagent" && thread.settledOverride !== "settled"
        ? [thread.workstream?.goalId ?? null]
        : [],
    ),
  );
  live.delete(null);
  return (thread: GoalRootFields) => live.has(thread.workstream?.goalId ?? null);
};

/**
 * The cold shell's index step keeps every entry the two keeps above could: a Loom entry whose row
 * holds a flag or no outcome (the SQL's coarse superset), a Loom child under an unsettled root, or
 * a Loom root of a live goal. Over-keeping costs a decoded shell; the trims then decide exactly.
 */
export const keepsLoomEntryInColdShell = (index: ReadonlyArray<ActiveShellIndexEntry>) => {
  const unsettledIds = new Set(
    index.flatMap((entry) => (entry.settledOverride === "settled" ? [] : [entry.id])),
  );
  const inLiveGoal = inLiveLoomGoal(index);
  return (entry: ActiveShellIndexEntry) =>
    entry.workstream !== undefined &&
    (entry.workstream.keep ||
      (entry.lineage.relationshipToParent === "subagent"
        ? unsettledIds.has(entry.lineage.rootThreadId)
        : inLiveGoal(entry)));
};

const STEP_ITEM_TYPES = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
]);
const TERMINAL_ITEM_STATUSES = new Set(["completed", "interrupted", "failed", "cancelled"]);

/**
 * A subagent's tool start or end, which moves the card's `activeStep` (`LoomStore.threadStats`).
 * Upstream keeps subagent transcript events off the shell stream, and every workstream child is a
 * subagent. A tool's first update has `updatedAt === startedAt` and its partial-output updates
 * almost never do (live data: 1.2 matches per tool, at most 5), so stateless start detection holds.
 */
export const isLoomStepBoundary = (event: OrchestrationV2StoredEvent["event"]): boolean => {
  if (event.type !== "turn-item.updated") return false;
  const item = event.payload;
  return (
    STEP_ITEM_TYPES.has(item.type) &&
    (TERMINAL_ITEM_STATUSES.has(item.status) ||
      (item.startedAt !== null &&
        DateTime.toEpochMillis(item.startedAt) === DateTime.toEpochMillis(item.updatedAt)))
  );
};
