import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
} from "@t3tools/client-runtime/state/shell";
import type { OrchestrationGoalShell } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const shellEnvironment = createShellEnvironmentAtoms(connectionAtomRuntime);
export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);
export const environmentShellSummaryAtom = createEnvironmentShellSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

const EMPTY_GOALS: ReadonlyArray<OrchestrationGoalShell> = Object.freeze([]);

// DB-authoritative goals, flattened across every connected environment (the
// fork's `selectGoalsAcrossEnvironments`). Goals ride the shell snapshot, so
// this recomputes whenever any environment's snapshot changes.
export const goalsAtom = Atom.make((get): ReadonlyArray<OrchestrationGoalShell> => {
  const goals: OrchestrationGoalShell[] = [];
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    const snapshot = get(environmentSnapshotAtom(environmentId));
    if (snapshot) {
      goals.push(...snapshot.goals);
    }
  }
  return goals.length === 0 ? EMPTY_GOALS : goals;
}).pipe(Atom.withLabel("web-goals"));
