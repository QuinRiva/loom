/**
 * Loom ws-method commands: goal writes through `loom.goal.*`, the `/handoff` and `/retro` drafter
 * calls and the hub login dialog's two calls. Results also arrive on the shell's goal stream, so
 * callers never patch local state. The spend reads are query families: cost is a batched lookup,
 * never a shell field.
 */
import { LOOM_WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "../runtime.ts";

export function createLoomCommandAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const command = <Tag extends (typeof LOOM_WS_METHODS)[keyof typeof LOOM_WS_METHODS]>(tag: Tag) =>
    createEnvironmentRpcCommand(runtime, { label: `environment-data:${tag}`, tag });
  return {
    goalUpdate: command(LOOM_WS_METHODS.goalUpdate),
    goalTaskRewrite: command(LOOM_WS_METHODS.goalTaskRewrite),
    handoffDraft: command(LOOM_WS_METHODS.handoffDraft),
    retroDraft: command(LOOM_WS_METHODS.retroDraft),
    threadHistory: command(LOOM_WS_METHODS.threadHistory),
    consultCancel: command(LOOM_WS_METHODS.consultCancel),
    promptCapture: command(LOOM_WS_METHODS.promptCapture),
    // The hub login dialog; a double-click must not post one code twice.
    hubLoginStart: command(LOOM_WS_METHODS.usageLimitSourceLoginStart),
    hubLoginFinish: createEnvironmentRpcCommand(runtime, {
      label: `environment-data:${LOOM_WS_METHODS.usageLimitSourceLoginFinish}`,
      tag: LOOM_WS_METHODS.usageLimitSourceLoginFinish,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.sourceId, input.state]),
      },
    }),
    threadSpend: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: `environment-data:${LOOM_WS_METHODS.threadSpend}`,
      tag: LOOM_WS_METHODS.threadSpend,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    topSpend: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: `environment-data:${LOOM_WS_METHODS.topSpend}`,
      tag: LOOM_WS_METHODS.topSpend,
      staleTimeMs: 60_000,
      idleTtlMs: 5 * 60_000,
    }),
  };
}
