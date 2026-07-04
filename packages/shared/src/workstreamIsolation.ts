import type { ThreadFanInState, ThreadIsolation } from "@t3tools/contracts";

/**
 * Role-default worktree isolation (worktree-isolation plan §1). Writers are
 * isolated; read-only/parent-tree roles are shared. A gated reviewer is a
 * special case resolved by the spawn path (`attached` — it joins its gate
 * target's worktree), so the table below returns the *ungated* reviewer default.
 * Unknown/free-text roles default to `isolated`: an unexpected writer must not
 * corrupt attribution, and an unexpected reader merely costs a cheap worktree.
 */
export const roleDefaultIsolation = (role: string | null): ThreadIsolation => {
  switch ((role ?? "").trim().toLowerCase()) {
    case "researcher":
    case "reviewer":
    case "shipper":
      return "shared";
    case "coder":
    case "planner":
      return "isolated";
    default:
      return "isolated";
  }
};

/**
 * A thread's fan-in is "settled" once the reactor has recorded a terminal
 * outcome — cleanly merged (`completed`) or aborted on conflict (`conflicted`).
 * The generation-join wake gate uses this: a `done` isolated child whose fan-in
 * is still in flight (`none`) must not wake the parent yet, but a conflicted one
 * must (with the notice).
 */
export const isFanInSettled = (fanInState: ThreadFanInState): boolean =>
  fanInState === "completed" || fanInState === "conflicted";

/**
 * Does an isolated child that has reached `done` still owe an unsettled fan-in?
 * True holds back the parent generation-join wake (and, recursively, a parent's
 * own `done`). Only `done` isolated threads gate; a `cancelled` isolated child
 * never fans in and must not wedge the join forever.
 */
export const isFanInPending = (thread: {
  readonly planLane: string;
  readonly isolation: ThreadIsolation;
  readonly fanInState: ThreadFanInState;
}): boolean =>
  thread.planLane === "done" &&
  thread.isolation === "isolated" &&
  !isFanInSettled(thread.fanInState);
