/**
 * Loom's seam into upstream's `PiAdapterV2` (pull 9 Phase 3 track 3c).
 *
 * `makePiAdapterV2` takes the hooks from its `loom` option, else yields
 * {@link LoomPiAdapterHooks} from the context `PiAdapterV2Driver.create` runs in.
 * A reference, so the yield adds no layer requirement: upstream's tests, the
 * replay kit and any layer that does not provide it get the passthrough default,
 * which leaves upstream's behaviour unchanged (and the adapter logs a warning).
 * The live hooks are `LoomPiAdapterHooksLive` in `apps/server/src/loom/serverLayers.ts`;
 * `PiAdapterV2.loom.test.ts` proves they reach the driver (gate `hooks`).
 *
 * `classifier` re-classes quota errors (3c-1), `sanitiser` runs before
 * `switch_session` on resume (3c-2), and `steerStash` mirrors pi's
 * `queue_update` for the restart continuation (3c-3, DL-690/691).
 *
 * @module provider-pi/server/loomAdapterHooks
 */
import type { IsoDateTime, OrchestrationV2ProviderFailure, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

/** The classifier's verdict on one pi error text (`piQuotaClassifier.loom.ts` in apps/server). */
export interface ClassifiedPiFailure {
  readonly usageLimit: boolean;
  /** Absent when neither the text nor a telemetry mark names a reset; never guessed. */
  readonly resetAt?: IsoDateTime;
  /** The provider's own wait, when the text carries one. */
  readonly retryAfterMs?: number;
  /** The tripped window ("5-hour", "weekly") when `resetAt` came from a telemetry mark. */
  readonly windowLabel?: string;
}

/** The instance and model a failed turn ran on. */
export interface PiFailureSelection {
  readonly instanceId: string;
  readonly model: string;
}

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
    readonly write: (
      threadId: ThreadId,
      runId: string | null,
      steering: ReadonlyArray<string>,
    ) => Effect.Effect<void>;
    readonly read: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly runId: string | null; readonly text: string } | null>;
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
