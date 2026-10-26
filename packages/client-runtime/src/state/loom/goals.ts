/**
 * Loom goals (seam 15), keyed by `thread.workstream.goalId`, never the provider-native `goal`.
 * The snapshot carries only its threads' goals; any other is asked for with `loom.goal.get`,
 * and a later write to it arrives on the goal stream and joins the snapshot.
 */
import {
  type EnvironmentId,
  type GoalId,
  LOOM_WS_METHODS,
  type LoomGoalShell,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "../runtime.ts";

export function createLoomGoalAtoms<R, E>(input: {
  readonly runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
}) {
  const goalQuery = createEnvironmentRpcQueryAtomFamily(input.runtime, {
    label: `environment-data:${LOOM_WS_METHODS.goalGet}`,
    tag: LOOM_WS_METHODS.goalGet,
    staleTimeMs: 60_000,
    idleTtlMs: 5 * 60_000,
  });
  const heldGoal = (snapshot: OrchestrationV2ShellSnapshot | null, goalId: GoalId) =>
    snapshot?.goals?.find((goal) => goal.id === goalId) ?? null;

  /** The goal, `null` when there is none, `undefined` while it loads. Key: `[environmentId, goalId]` JSON. */
  const goalAtom = Atom.family((key: string) => {
    const [environmentId, goalId] = JSON.parse(key) as [EnvironmentId, GoalId];
    return Atom.make((get): LoomGoalShell | null | undefined => {
      const snapshot = get(input.snapshotAtom(environmentId));
      if (snapshot === null) return undefined;
      const held = heldGoal(snapshot, goalId);
      if (held !== null) return held;
      const result = get(goalQuery({ environmentId, input: { goalId } }));
      const answer = Option.getOrNull(AsyncResult.value(result));
      return answer !== null ? answer.goal : result._tag === "Failure" ? null : undefined;
    }).pipe(Atom.withLabel(`loom-goal:${key}`));
  });

  return {
    goalAtom: (environmentId: EnvironmentId, goalId: GoalId) =>
      goalAtom(JSON.stringify([environmentId, goalId])),
    heldGoal,
    goalQuery,
  };
}
