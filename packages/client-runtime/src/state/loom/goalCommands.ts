/**
 * Loom ws-method commands (seam 21): the goal panel and goal menu write goals
 * through `loom.goal.*`; the `/handoff` and `/retro` intercepts call 3b's
 * drafter methods by name. Results also arrive on the shell's goal stream, so
 * callers never patch local state. The two seam-11 spend reads (3d-4) are
 * query families: cost is a batched lookup, never a shell field. The hub
 * login dialog's two calls ride here too.
 *
 * @module state/loom/goalCommands
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
    // The MDX viewer's Query: forks (or reuses) the author's query thread and asks there.
    documentQuery: command(LOOM_WS_METHODS.documentQuery),
    // A query thread's Promote: queues the turn that distils one exchange for the author.
    documentQueryPromote: command(LOOM_WS_METHODS.documentQueryPromote),
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
    // The Query card's pre-flight (which thread a Query forks), once per open document.
    documentQueryAuthor: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: `environment-data:${LOOM_WS_METHODS.documentQueryAuthor}`,
      tag: LOOM_WS_METHODS.documentQueryAuthor,
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
