import {
  EventId,
  WORKTREE_SETUP_ACTIVITY_KIND,
  worktreeSetupActivityId,
  type CommandId,
  type OrchestrationCommand,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";

/**
 * The durable record of a worktree setup: ONE activity per thread, upserted
 * under a fixed id when the setup starts (phase `running`) and again when it
 * settles. `WorktreeSetupTracker` is memory-only and serves live subscribers;
 * this activity is what a reload, a second client or a restarted server reads,
 * and what tells a client to attach the live stream.
 *
 * loom: shared so the root bootstrap (`ws.ts`) and the workstream child
 * provisioner (`WorktreeProvisioner`) write the ONE contract the setup card
 * consumes (`findRecordedWorktreeSetup`) rather than two near-copies.
 */
export const worktreeSetupActivityCommand = (
  commandId: CommandId,
  snapshot: WorktreeSetupSnapshot,
): OrchestrationCommand => ({
  type: "thread.activity.append",
  commandId,
  threadId: snapshot.threadId,
  activity: {
    id: EventId.make(worktreeSetupActivityId(snapshot.threadId)),
    tone:
      snapshot.phase === "failed" || snapshot.stages.some((stage) => stage.status === "failed")
        ? "error"
        : "info",
    kind: WORKTREE_SETUP_ACTIVITY_KIND,
    summary:
      snapshot.phase === "running"
        ? "Setting up worktree"
        : snapshot.phase === "done"
          ? "Worktree ready"
          : snapshot.phase === "cancelled"
            ? "Worktree setup cancelled"
            : "Worktree setup failed",
    payload: snapshot,
    turnId: null,
    createdAt: snapshot.startedAt,
  },
  createdAt: snapshot.endedAt ?? snapshot.startedAt,
});
