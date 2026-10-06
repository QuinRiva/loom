// Loom workstream state for the web surfaces (Phase 3 track 3d-2): every
// sidecar-bearing V2 shell of one environment as `WorkstreamNode`s, and the
// board's controls dispatched as Loom commands through upstream's V2
// `orchestration.dispatchCommand` (no Loom ws method).
import {
  CommandId,
  type EnvironmentId,
  type LoomOutcome,
  type OrchestrationV2Command,
  type ThreadId,
} from "@t3tools/contracts";
import { workstreamRollupOf } from "@t3tools/client-runtime/state/loom/rollup";
import { workstreamIndexOf } from "@t3tools/client-runtime/state/loom/workstream";
import { useCallback, useMemo } from "react";

import { useArchivedThreadSnapshots } from "../lib/archivedThreadsState";
import { randomUUID } from "../lib/utils";
import { buildWorkstreamNodes, type WorkstreamNode } from "../lib/workstreamPresentation";
import { useThreadShells } from "../state/entities";
import { orchestrationEnvironment } from "../state/orchestration";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * The environment's workstream nodes. Archived shells come from upstream's
 * archived-shell snapshot query (the same one the Lineage panel reads) so an
 * archived unfinished dependency still gates and an archived done one releases
 * (DL-211/DL-422); live shells win over a stale archived copy.
 */
export function useWorkstreamNodes(environmentId: EnvironmentId | null) {
  const shells = useThreadShells();
  const environmentIds = useMemo(() => (environmentId ? [environmentId] : []), [environmentId]);
  const archived = useArchivedThreadSnapshots(environmentIds);
  const archivedShells = archived.snapshots.find((entry) => entry.environmentId === environmentId)
    ?.snapshot.threads;
  return useMemo(() => {
    // Archived first so a live shell overwrites a stale archived copy.
    const all = [
      ...new Map(
        [
          ...(archivedShells ?? []),
          ...shells.filter((shell) => shell.environmentId === environmentId).map((s) => s.source),
        ].map((shell) => [shell.id, shell]),
      ).values(),
    ];
    const startIndex = workstreamIndexOf(all);
    return {
      nodes: buildWorkstreamNodes(all),
      /** The three rollups of a thread's live descendants, or null for a leaf. */
      rollupOf: (threadId: ThreadId) => {
        const rollup = workstreamRollupOf(threadId, all, startIndex);
        return rollup.plan.total === 0 ? null : rollup;
      },
    };
  }, [archivedShells, environmentId, shells]);
}

/** A fresh command id and timestamp for one dispatch. */
const commandMeta = () => ({
  commandId: CommandId.make(randomUUID()),
  createdAt: new Date().toISOString(),
});

/** The board's and graph's controls for one environment. */
export function useWorkstreamCommands(environmentId: EnvironmentId | null) {
  const dispatchCommand = useAtomCommand(orchestrationEnvironment.v2.dispatchCommand);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);
  const dispatch = useCallback(
    (input: OrchestrationV2Command) => {
      if (environmentId !== null) void dispatchCommand({ environmentId, input });
    },
    [dispatchCommand, environmentId],
  );
  return useMemo(
    () => ({
      /** Accept done / cancel (`outcome`), or reopen (`null`). */
      setOutcome: (threadId: ThreadId, outcome: LoomOutcome | null) =>
        dispatch({ type: "thread.outcome.set", ...commandMeta(), threadId, outcome }),
      /** Replace a child's sibling dependencies; carries the parent the arm locks. */
      setDependencies: (node: WorkstreamNode, blockedBy: ReadonlyArray<ThreadId>) => {
        if (node.parentThreadId === null) return;
        dispatch({
          type: "thread.dependencies.set",
          ...commandMeta(),
          threadId: node.id,
          parentThreadId: node.parentThreadId,
          blockedBy: [...blockedBy],
        });
      },
      /** Clear every stored attention reason (an absent `reason`). */
      clearAttention: (threadId: ThreadId) =>
        dispatch({ type: "thread.attention.clear", ...commandMeta(), threadId }),
      stop: (threadId: ThreadId) => {
        if (environmentId !== null) void interruptTurn({ environmentId, input: { threadId } });
      },
    }),
    [dispatch, environmentId, interruptTurn],
  );
}

export type WorkstreamCommands = ReturnType<typeof useWorkstreamCommands>;
