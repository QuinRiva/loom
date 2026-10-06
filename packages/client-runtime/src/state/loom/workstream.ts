/**
 * Workstream selectors over V2 thread shells: the sidecar (`thread.workstream`),
 * lineage children, and the derived board column (Phase 3 plan, track 3d).
 * Columns are derived, never stored; yielded is not a column but the
 * `awaiting_orchestrator` attention reason.
 *
 * @module state/loom/workstream
 */
import type {
  LoomThreadShellFields,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { isEligibleToStart, type StartNode } from "@t3tools/shared/workstreamStart.loom";

export type WorkstreamBoardColumn =
  | "held"
  | "blocked"
  | "ready"
  | "in_progress"
  | "done"
  | "cancelled";

export type WorkstreamIndex = ReadonlyMap<ThreadId, StartNode>;

export const workstreamOf = (thread: Pick<OrchestrationV2ThreadShell, "workstream">) =>
  thread.workstream ?? null;

/** Direct children by V2 lineage (authoritative; equals `workstream.parentThreadId`). */
export const childrenOf = <T extends Pick<OrchestrationV2ThreadShell, "lineage">>(
  parentThreadId: ThreadId,
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> => threads.filter((thread) => thread.lineage.parentThreadId === parentThreadId);

const startNodeOf = (workstream: LoomThreadShellFields): StartNode => ({
  ...workstream,
  id: workstream.threadId,
});

/**
 * The dependency map `deriveBoardColumn` reads. Pass every shell you hold,
 * archived ones included (DL-211): a done-then-archived dependency releases,
 * an archived unfinished one still gates.
 */
export const workstreamIndexOf = (
  threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "workstream">>,
): WorkstreamIndex =>
  new Map(
    threads.flatMap((thread) =>
      thread.workstream === undefined
        ? []
        : [[thread.workstream.threadId, startNodeOf(thread.workstream)] as const],
    ),
  );

/** The board column: outcome, then held, then started, then the one start rule. */
export const deriveBoardColumn = (
  workstream: LoomThreadShellFields,
  byId: WorkstreamIndex,
): WorkstreamBoardColumn => {
  if (workstream.outcome !== null) return workstream.outcome;
  if (workstream.held) return "held";
  if (workstream.kickoffAt !== null) return "in_progress";
  return isEligibleToStart(startNodeOf(workstream), byId) ? "ready" : "blocked";
};
