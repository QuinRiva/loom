import {
  AVAILABLE_CONNECTION_STATE,
  connectionProjectionPhase,
} from "@t3tools/client-runtime/connection";
import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createShellEnvironmentAtoms,
} from "@t3tools/client-runtime/state/shell";
import type { OrchestrationGoalShell } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

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

export const allEnvironmentShellsBootstrappedAtom = Atom.make((get) => {
  const catalog = AsyncResult.value(get(environmentCatalog.catalogAtom));
  if (Option.isNone(catalog)) {
    return false;
  }
  for (const environmentId of catalog.value.entries.keys()) {
    if (Option.isSome(get(environmentShell.stateValueAtom(environmentId)).snapshot)) {
      continue;
    }
    const connection = Option.getOrElse(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      () => AVAILABLE_CONNECTION_STATE,
    );
    if (connectionProjectionPhase(connection) !== "disconnected") {
      return false;
    }
    // A retrying environment is only transiently disconnected; give it its
    // first retries before letting the landing settle without its snapshot.
    if (connection.phase === "backoff" && connection.desired && connection.attempt <= 2) {
      return false;
    }
  }
  return true;
}).pipe(Atom.withLabel("web-all-environment-shells-bootstrapped"));
