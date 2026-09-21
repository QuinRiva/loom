/**
 * Loom fork-owned WebSocket RPC methods.
 *
 * Loom adds three ws handlers (a bypass keepalive plus the workstream-worktree
 * read/remove queries) and their authorization scopes. Extracting them
 * here keeps `ws.ts` at one `// loom:`-marked splice line
 * (`...makeLoomWsHandlers({ … })` in the RPC group) instead of scattered
 * handler blocks; the fork RPCs' scopes live with upstream's canonical map in
 * `auth/RpcAuthorization.ts`. The entangled ws rewrites (subscribeThread
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
  type WorkstreamRemoveWorktreeInput,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as WorkstreamWorktreeStatus from "../orchestration/WorkstreamWorktreeStatus.ts";

export interface LoomWsHandlerDeps {
  /** The local scope-checked + instrumented RPC wrapper from `makeWsRpcLayer`. */
  readonly observeRpcEffect: <A, E, R>(
    method: string,
    effect: Effect.Effect<A, E, R>,
    traceAttributes?: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<A, E | EnvironmentAuthorizationError, R>;
  readonly workstreamWorktreeStatus: WorkstreamWorktreeStatus.WorkstreamWorktreeStatus["Service"];
}

export const makeLoomWsHandlers = ({
  observeRpcEffect,
  workstreamWorktreeStatus,
}: LoomWsHandlerDeps) => ({
  // Authenticated-session-only keepalive: the WS upgrade already authenticated
  // this session, so the handler just acknowledges. No scope check, no
  // instrumentation (kept out of request telemetry) — hence no
  // scope check and no `observeRpcEffect` wrapper (see `RPC_REQUIRED_SCOPES`).
  [WS_METHODS.heartbeat]: (_input: unknown) => Effect.void,
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
