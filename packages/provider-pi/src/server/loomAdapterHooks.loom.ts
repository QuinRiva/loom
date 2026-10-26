/**
 * Loom's seam into upstream's `PiAdapterV2`: hooks come from the `loom` option, else the
 * {@link LoomPiAdapterHooks} reference, so no layer requirement (absent, a passthrough default
 * keeps upstream's behaviour and logs a warning). Live hooks are `LoomPiAdapterHooksLive` in
 * `apps/server/src/loom/serverLayers.ts`; `PiAdapterV2.loom.test.ts` proves they reach the driver.
 */
import type {
  IsoDateTime,
  LoomThreadCachePatch,
  OrchestrationV2ProviderFailure,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

import { piRecordField, type PiRpcRecord } from "./rpc.ts";

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
      /** pi's session file, where a steer pi delivers is recorded. */
      sessionFile: string | null,
    ) => Effect.Effect<void>;
    readonly read: (
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly runId: string | null; readonly text: string } | null>;
  };
  /** New facts about the thread's prompt cache (`LoomCacheBroadcast.update`). */
  readonly cache: (threadId: ThreadId, patch: LoomThreadCachePatch) => Effect.Effect<void>;
}

export const passthroughLoomPiAdapterHooks: LoomPiAdapterHooksShape = {
  classifier: () => Effect.succeed({ usageLimit: false }),
  sanitiser: () => Effect.void,
  steerStash: { write: () => Effect.void, read: () => Effect.succeed(null) },
  cache: () => Effect.void,
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

/**
 * Reports a pi event that refreshed the prompt cache: an assistant request ending (any stop but
 * error/abort) with its dispatch (pi-ai's `timestamp`, the keep-alive anchor) and end (`timestamp +
 * durationMs`, else now), or an idle `cache_warm` ping (`entry_appended` with a `usage` entry).
 */
export const touchLoomPiCache = (
  hooks: LoomPiAdapterHooksShape,
  threadId: ThreadId,
  event: PiRpcRecord,
): Effect.Effect<void> => {
  const message = event["type"] === "message_end" ? event["message"] : undefined;
  const stopReason = piRecordField(message, "stopReason");
  if (
    piRecordField(message, "role") === "assistant" &&
    stopReason !== "error" &&
    stopReason !== "aborted"
  ) {
    const startedMs = piRecordField(message, "timestamp");
    const durationMs = piRecordField(message, "durationMs");
    return DateTime.now.pipe(
      Effect.flatMap((now) => {
        const nowMs = DateTime.toEpochMillis(now);
        const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
        const stamped = typeof startedMs === "number";
        return hooks.cache(threadId, {
          requestStartedAt: iso(stamped ? startedMs : nowMs),
          requestEndedAt: iso(
            stamped && typeof durationMs === "number" ? startedMs + durationMs : nowMs,
          ),
        });
      }),
    );
  }
  const entry = event["type"] === "entry_appended" ? event["entry"] : undefined;
  const timestamp = piRecordField(entry, "timestamp");
  return piRecordField(entry, "type") === "usage" &&
    piRecordField(entry, "kind") === "cache_warm" &&
    typeof timestamp === "string"
    ? hooks.cache(threadId, { pingedAt: timestamp })
    : Effect.void;
};
