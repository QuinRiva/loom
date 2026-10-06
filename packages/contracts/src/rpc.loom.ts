// Loom's WebSocket RPCs (Pull 9 Phase 3, seam 21), spliced into `WsRpcGroup`
// by ONE marked line in `rpc.ts`; the handlers are `apps/server/src/loom/wsMethods.ts`
// and the scopes a marked block in `auth/RpcAuthorization.ts`.
//
// 3b lands this file with the drafter methods (`loom.handoffDraft` /
// `loom.retroDraft`, typed by `HandoffDraft*` / `RetroDraft*` in `server.ts`);
// 3d appends its goal and spend methods (DL-432/433 — the same names and shapes).
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  HandoffDraftInput,
  HandoffDraftResult,
  RetroDraftInput,
  RetroDraftResult,
} from "./server.ts";

export const LOOM_WS_METHODS = {
  handoffDraft: "loom.handoffDraft",
  retroDraft: "loom.retroDraft",
} as const;

/** Every Loom ws method fails with this (plus the group's authorization error). */
export class LoomWsMethodError extends Schema.TaggedError<LoomWsMethodError>()(
  "LoomWsMethodError",
  {
    method: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const LoomWsError = Schema.Union([LoomWsMethodError, EnvironmentAuthorizationError]);

/** The members `rpc.ts` spreads into `WsRpcGroup`. */
export const LoomWsRpcs = [
  Rpc.make(LOOM_WS_METHODS.handoffDraft, {
    payload: HandoffDraftInput,
    success: HandoffDraftResult,
    error: LoomWsError,
  }),
  Rpc.make(LOOM_WS_METHODS.retroDraft, {
    payload: RetroDraftInput,
    success: RetroDraftResult,
    error: LoomWsError,
  }),
] as const;
