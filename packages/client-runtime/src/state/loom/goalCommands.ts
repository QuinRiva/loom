/**
 * Loom ws-method commands (seam 21): the goal panel and goal menu write goals
 * through `loom.goal.*`; the `/handoff` and `/retro` intercepts call 3b's
 * drafter methods by name. Results also arrive on the shell's goal stream, so
 * callers never patch local state.
 *
 * @module state/loom/goalCommands
 */
import { LOOM_WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../../connection/registry.ts";
import { createEnvironmentRpcCommand } from "../runtime.ts";

export function createLoomCommandAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const command = <Tag extends (typeof LOOM_WS_METHODS)[keyof typeof LOOM_WS_METHODS]>(tag: Tag) =>
    createEnvironmentRpcCommand(runtime, { label: `environment-data:${tag}`, tag });
  return {
    goalUpdate: command(LOOM_WS_METHODS.goalUpdate),
    goalArchive: command(LOOM_WS_METHODS.goalArchive),
    goalUnarchive: command(LOOM_WS_METHODS.goalUnarchive),
    goalTaskRewrite: command(LOOM_WS_METHODS.goalTaskRewrite),
    handoffDraft: command(LOOM_WS_METHODS.handoffDraft),
    retroDraft: command(LOOM_WS_METHODS.retroDraft),
  };
}
