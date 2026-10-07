/**
 * Loom's seam into upstream's `PiAdapterV2` (pull 9 Phase 3 track 3c).
 *
 * `PiAdapterV2Driver.create` yields {@link LoomPiAdapterHooks} and passes it as
 * the adapter's `loom` option. A reference, so the yield adds no layer
 * requirement: upstream's tests, the replay kit and any layer that does not
 * provide it get the passthrough default, which leaves upstream's behaviour
 * unchanged. The live hooks are `LoomPiAdapterHooksLive` in `loom/serverLayers.ts`.
 *
 * 3c-1 calls only `classifier`; `sanitiser` (3c-2, before `switch_session` on
 * resume) and `steerStash` (3c-3: pi's `queue_update` mirror, and the restart
 * continuation's read — DL-690/691) exist so their call sites need no further option change.
 *
 * @module provider/Drivers/Pi/loomAdapterHooks
 */
import type { OrchestrationV2ProviderFailure, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { makeProviderFailure } from "../../../orchestration-v2/ProviderFailure.ts";
import type { ClassifiedPiFailure, PiFailureSelection } from "./piQuotaClassifier.loom.ts";

export interface LoomPiAdapterHooksShape {
  /** Is this pi error text a usage limit, and when does it reset? */
  readonly classifier: (
    errorText: string,
    selection: PiFailureSelection,
  ) => Effect.Effect<ClassifiedPiFailure>;
  /** Rewrite codex-shaped tool ids in a session file before an Anthropic-family resume. */
  readonly sanitiser: (sessionFilePath: string, modelSlug: string) => Effect.Effect<void>;
  /** Durable mirror of pi's undelivered steers (`loom/steering/pendingSteering`). */
  readonly steerStash: {
    readonly write: (threadId: ThreadId, steering: ReadonlyArray<string>) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<string | null>;
  };
}

export const passthroughLoomPiAdapterHooks: LoomPiAdapterHooksShape = {
  classifier: () => Effect.succeed({ usageLimit: false }),
  sanitiser: () => Effect.void,
  steerStash: { write: () => Effect.void, read: () => Effect.succeed(null) },
};

export class LoomPiAdapterHooks extends Context.Reference<LoomPiAdapterHooksShape>(
  "loom/provider/LoomPiAdapterHooks",
  { defaultValue: () => passthroughLoomPiAdapterHooks },
) {}

/** Upstream's failure, re-classed `usage_limit` (with any known `resetAt`) when the classifier says so. */
export const classifyLoomPiFailure = (
  hooks: LoomPiAdapterHooksShape,
  selection: PiFailureSelection,
  failure: OrchestrationV2ProviderFailure,
) =>
  hooks
    .classifier(failure.message, selection)
    .pipe(
      Effect.map(({ usageLimit, resetAt }) =>
        usageLimit
          ? makeProviderFailure({ ...failure, class: "usage_limit", resetAt: resetAt ?? null })
          : failure,
      ),
    );
