/**
 * What every workstream handler shares: dispatching a command through V2's
 * orchestrator with the decider's own refusal text as the tool error, reading
 * the sidecar and shell, and a thread's direct children.
 *
 * @module mcp/toolkits/workstream/handlers/shared
 */
import {
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as LoomStore from "../../../../loom/projection/LoomStore.ts";
import * as Orchestrator from "../../../../orchestration-v2/Orchestrator.ts";
import { LoomToolError } from "../defs.ts";

export const fail = (message: string) => Effect.fail(new LoomToolError({ message }));

/** Any service error as the text the agent reads. */
export const asToolError = <A, R>(
  effect: Effect.Effect<A, { readonly message: string }, R>,
): Effect.Effect<A, LoomToolError, R> =>
  Effect.mapError(effect, (error) => new LoomToolError({ message: error.message }));

/**
 * The reason a dispatch failed. The arm fails with its refusal as the
 * `OrchestratorDispatchError` cause (a string), which the generic wrapper
 * message would hide.
 */
export const dispatchRefusal = (error: Orchestrator.OrchestratorV2Error): string => {
  const cause = "cause" in error ? error.cause : undefined;
  return typeof cause === "string" ? cause : cause instanceof Error ? cause.message : error.message;
};

export const dispatch = (command: OrchestrationV2ServerCommand) =>
  Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) => orchestrator.dispatch(command)),
    Effect.mapError((error) => new LoomToolError({ message: dispatchRefusal(error) })),
  );

/** The events of one type a dispatch committed. */
export const committed = <T extends OrchestrationV2DomainEvent["type"]>(
  result: Orchestrator.OrchestratorV2DispatchResult,
  type: T,
) =>
  result.storedEvents.flatMap(({ event }) =>
    event.type === type ? [event as Extract<OrchestrationV2DomainEvent, { readonly type: T }>] : [],
  );

export const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/** The thread's V2 shell (with its `workstream` join), or the not-found error. */
export const requireShell = (threadId: ThreadId) =>
  Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) => orchestrator.getThreadShell(threadId)),
    asToolError,
    Effect.flatMap((shell) =>
      shell === null ? fail(`Thread ${threadId} was not found.`) : Effect.succeed(shell),
    ),
  );

/** A thread's children (archived included, DL-211), or of the caller's own thread. */
export const childrenOf = (parentThreadId: ThreadId) =>
  LoomStore.LoomStoreV2.pipe(
    Effect.flatMap((store) => store.listChildren(parentThreadId, { includeArchived: true })),
    asToolError,
  );

export const SCAFFOLD_THREAD_REF_PREFIX = "thread:";

/** A `thread:`-prefixed reference's id, or the reference itself. */
export const stripThreadRef = (ref: string) =>
  ref.startsWith(SCAFFOLD_THREAD_REF_PREFIX)
    ? ThreadId.make(ref.slice(SCAFFOLD_THREAD_REF_PREFIX.length).trim())
    : ThreadId.make(ref.trim());
