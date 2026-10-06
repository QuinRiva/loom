/**
 * Loom's WebSocket RPC handlers (Pull 9 Phase 3, seam 21), spliced into
 * `ws.ts`'s RPC group by ONE marked line (`...(yield* makeLoomWsHandlers)`);
 * the Rpc members are `packages/contracts/src/rpc.loom.ts`, the scopes a marked
 * block in `auth/RpcAuthorization.ts`. 3b lands the drafter methods; 3d appends
 * its goal and spend handlers here (DL-432/433).
 *
 * @module loom/wsMethods
 */
import {
  type HandoffDraftInput,
  LOOM_WS_METHODS,
  type RetroDraftInput,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { buildHandoffDraftTurnStart, launchDraftFork } from "./handoff/handoffDraft.ts";
import { buildRetroDraftTurnStart } from "./handoff/retroDraft.ts";
import { LoomStoreV2 } from "./projection/LoomStore.ts";

export const makeLoomWsHandlers = Effect.gen(function* () {
  const services = yield* Effect.context<OrchestratorV2 | LoomStoreV2 | Crypto.Crypto>();
  return {
    // `/handoff`: a hidden `handoff-drafter` fork of the source, kicked off on the explanation.
    [LOOM_WS_METHODS.handoffDraft]: (input: HandoffDraftInput) =>
      observeRpcEffect(
        LOOM_WS_METHODS.handoffDraft,
        launchDraftFork({
          method: LOOM_WS_METHODS.handoffDraft,
          verb: "handed off",
          sourceThreadId: input.sourceThreadId,
          build: (fork) => buildHandoffDraftTurnStart({ ...fork, explanation: input.explanation }),
        }).pipe(
          Effect.map((drafterThreadId) => ({ drafterThreadId })),
          Effect.provideContext(services),
        ),
        { "rpc.aggregate": "loom" },
      ),
    // `/retro`: a visible `retro-reviewer` fork of the source, kicked off on the retro brief.
    [LOOM_WS_METHODS.retroDraft]: (input: RetroDraftInput) =>
      observeRpcEffect(
        LOOM_WS_METHODS.retroDraft,
        launchDraftFork({
          method: LOOM_WS_METHODS.retroDraft,
          verb: "reviewed",
          sourceThreadId: input.sourceThreadId,
          build: (fork, source) =>
            buildRetroDraftTurnStart({ ...fork, sourceTitle: source.title, focus: input.focus }),
        }).pipe(
          Effect.map((reviewerThreadId) => ({ reviewerThreadId })),
          Effect.provideContext(services),
        ),
        { "rpc.aggregate": "loom" },
      ),
  };
});
