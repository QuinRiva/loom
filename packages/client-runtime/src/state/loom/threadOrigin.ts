import type {
  LoomThreadShellFields,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Whose words opened a root the human did not write: `agent` (an orchestrator's `goal_handoff`, or a
 * root an agent-made scheduled task launched), `requested` (the human's `/handoff`), `continued` (a
 * `goal_continue` successor launched with its predecessor's brief unedited, so the brief is the
 * agent's). Null for the human's own threads, edited continuations, forks, imports and children.
 */
export type ThreadStart = "agent" | "requested" | "continued";

type StartWorkstream = Pick<
  LoomThreadShellFields,
  "handoffOrigin" | "continuesThreadId" | "kickoffAt" | "kickoffOrigin"
>;

/**
 * The thread a handed-off or continued root came from (the handoff's origin,
 * the predecessor) with its start kind; null for any other thread.
 */
export const threadStartOriginOf = (
  workstream: StartWorkstream | undefined,
): { readonly start: ThreadStart; readonly threadId: ThreadId } | null => {
  if (workstream?.handoffOrigin) {
    const { initiatedBy, threadId } = workstream.handoffOrigin;
    return { start: initiatedBy === "human" ? "requested" : "agent", threadId };
  }
  return workstream?.continuesThreadId &&
    (workstream.kickoffAt === null || workstream.kickoffOrigin === "kickoff")
    ? { start: "continued", threadId: workstream.continuesThreadId }
    : null;
};

export const threadStartOf = (
  shell: Pick<OrchestrationV2ThreadShell, "createdBy" | "lineage" | "workstream">,
): ThreadStart | null =>
  threadStartOriginOf(shell.workstream)?.start ??
  (shell.createdBy === "agent" &&
  shell.lineage.relationshipToParent === null &&
  !shell.workstream?.continuesThreadId
    ? "agent"
    : null);
