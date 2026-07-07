/**
 * Loom fork-owned WebSocket RPC methods.
 *
 * Loom adds four ws handlers (a bypass keepalive plus usage-breakdown and
 * workstream-worktree queries) and their authorization scopes. Extracting them
 * here keeps `ws.ts` at two `// loom:`-marked splice lines (`...LOOM_RPC_SCOPES`
 * in the scope map, `...makeLoomWsHandlers({ … })` in the RPC group) instead of
 * scattered handler blocks. The entangled ws rewrites (subscribeThread
 * connect-gap, provider exhaustion overlay, goal-aggregate shell mapping, …)
 * stay in `ws.ts` — they modify upstream flows, not just add handlers.
 *
 * @module loom/wsMethods
 */
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
  ServerUsageBreakdownError,
  type ServerUsageBreakdownInput,
  type WorkstreamRemoveWorktreeInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as UsageBreakdownQuery from "../orchestration/Services/UsageBreakdownQuery.ts";
import type * as WorkstreamWorktreeStatus from "../orchestration/WorkstreamWorktreeStatus.ts";

/** Fork RPC methods and their required scopes; spread into `RPC_REQUIRED_SCOPE`. */
export const LOOM_RPC_SCOPES: ReadonlyArray<readonly [string, AuthEnvironmentScope]> = [
  [WS_METHODS.serverGetUsageBreakdown, AuthOrchestrationReadScope],
  [WS_METHODS.serverGetWorkstreamWorktrees, AuthOrchestrationReadScope],
  [WS_METHODS.serverRemoveWorkstreamWorktree, AuthOrchestrationOperateScope],
];

export interface LoomWsHandlerDeps {
  /** The local scope-checked + instrumented RPC wrapper from `makeWsRpcLayer`. */
  readonly observeRpcEffect: <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  readonly usageBreakdownQuery: UsageBreakdownQuery.UsageBreakdownQueryShape;
  readonly workstreamWorktreeStatus: WorkstreamWorktreeStatus.WorkstreamWorktreeStatus["Service"];
}

export const makeLoomWsHandlers = ({
  observeRpcEffect,
  usageBreakdownQuery,
  workstreamWorktreeStatus,
}: LoomWsHandlerDeps) => ({
  // Authenticated-session-only keepalive: the WS upgrade already authenticated
  // this session, so the handler just acknowledges. No scope check, no
  // instrumentation (kept out of request telemetry) — hence no
  // `RPC_REQUIRED_SCOPE` entry and no `observeRpcEffect` wrapper.
  [WS_METHODS.heartbeat]: (_input: unknown) => Effect.void,
  [WS_METHODS.serverGetUsageBreakdown]: (input: ServerUsageBreakdownInput) =>
    observeRpcEffect(
      WS_METHODS.serverGetUsageBreakdown,
      usageBreakdownQuery.getBreakdown(input).pipe(
        Effect.tapError((cause) => Effect.logError("usage breakdown query failed", { cause })),
        Effect.mapError(
          (cause) =>
            new ServerUsageBreakdownError({
              message: "Failed to compute usage breakdown",
              cause,
            }),
        ),
      ),
      { "rpc.aggregate": "server" },
    ),
  [WS_METHODS.serverGetWorkstreamWorktrees]: (_input: unknown) =>
    observeRpcEffect(WS_METHODS.serverGetWorkstreamWorktrees, workstreamWorktreeStatus.read, {
      "rpc.aggregate": "server",
    }),
  [WS_METHODS.serverRemoveWorkstreamWorktree]: (input: WorkstreamRemoveWorktreeInput) =>
    observeRpcEffect(
      WS_METHODS.serverRemoveWorkstreamWorktree,
      workstreamWorktreeStatus.remove({
        worktreePath: input.worktreePath,
        acknowledgeDirty: input.acknowledgeDirty ?? false,
        acknowledgeUnmerged: input.acknowledgeUnmerged ?? false,
      }),
      { "rpc.aggregate": "server" },
    ),
});
