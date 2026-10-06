/**
 * Loom goal selectors over the shell snapshot's `goals` (seam 15). A thread's
 * Loom goal is `thread.workstream.goalId` — never the provider-native `goal`
 * on the thread shell, which is Codex/Claude's own `/goal`.
 *
 * @module state/loom/goals
 */
import type {
  EnvironmentId,
  GoalId,
  LoomGoalShell,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

const EMPTY_GOALS: ReadonlyArray<LoomGoalShell> = Object.freeze([]);

export const goalById = (goals: ReadonlyArray<LoomGoalShell>, goalId: GoalId) =>
  goals.find((goal) => goal.id === goalId) ?? null;

/** The Loom goal a thread works under, from its sidecar's `goalId`. */
export const goalForThread = (
  goals: ReadonlyArray<LoomGoalShell>,
  thread: Pick<OrchestrationV2ThreadShell, "workstream">,
) => {
  const goalId = thread.workstream?.goalId ?? null;
  return goalId === null ? null : goalById(goals, goalId);
};

export function createLoomGoalAtoms(input: {
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
}) {
  const goalsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(input.snapshotAtom(environmentId))?.goals ?? EMPTY_GOALS).pipe(
      Atom.withLabel(`loom-goals:${environmentId}`),
    ),
  );
  return { goalsAtom };
}
