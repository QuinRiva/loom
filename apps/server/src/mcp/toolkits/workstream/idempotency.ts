/**
 * Deterministic ids for handlers that create things (spawn, scaffold,
 * goal_task_add, goal_handoff, goal_continue, thread_fork), in upstream's
 * `stableCommandId` shape (`OrchestratorMcpService.ts`): the credential's
 * `requestNamespace`, the operation and the request key. With the agent's
 * `clientRequestId` a retry reproduces the same ids, so the command receipt
 * makes it a no-op; without one the key is a fresh uuid.
 *
 * @module mcp/toolkits/workstream/idempotency
 */
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import type { WorkstreamCaller } from "./authorisation.ts";

export const requestKey = (clientRequestId: string | undefined) =>
  clientRequestId === undefined
    ? Crypto.Crypto.pipe(
        Effect.flatMap((crypto) => crypto.randomUUIDv4),
        Effect.orDie,
      )
    : Effect.succeed(clientRequestId);

const stableId = (
  kind: string,
  caller: WorkstreamCaller,
  key: string,
  operation: string,
  index: number | undefined,
) =>
  [
    kind,
    "mcp",
    ...[caller.scope.requestNamespace, operation, key].map(encodeURIComponent),
    ...(index === undefined ? [] : [String(index)]),
  ].join(":");

export const stableCommandId = (
  caller: WorkstreamCaller,
  key: string,
  operation: string,
  index?: number,
) => CommandId.make(stableId("command", caller, key, operation, index));

/** A child's thread id; the operation segment keeps it apart from upstream's delegate_task ids. */
export const stableThreadId = (
  caller: WorkstreamCaller,
  key: string,
  operation: string,
  index?: number,
) => ThreadId.make(stableId("thread", caller, key, operation, index));
