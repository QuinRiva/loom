import * as Effect from "effect/Effect";

import { createThreadSearchTriggers, dropThreadSearchTriggers } from "../threadSearchIndex.loom.ts";

/**
 * Reinstalls the `loom_ts_*` triggers so a finished message's index rows are
 * rewritten only when its text or origin changes, not on every payload rewrite
 * (upstream's 069 index makes the same promise). The rows stay valid.
 */
export default Effect.gen(function* () {
  yield* dropThreadSearchTriggers;
  yield* createThreadSearchTriggers;
});
