/**
 * Loom's open-session composition seam (pull 9 strategy Area G; Phase 3 plan seam 4).
 *
 * `ProviderSessionManager.open` asks the composer for the thread's prompt,
 * skills and extensions on every provider process spawn and passes them on the
 * open-session input as `loom`; `buildPiRpcLaunch` turns them into argv. Phase 2
 * ships only the seam: the default composes nothing. Phase 3a provides the real
 * composer (role overlay, addendum, ship policy, goal context, launch identity)
 * by re-pointing `LoomSessionComposerLive` in `loom/serverLayers.ts`.
 *
 * @module loom/prompt/sessionComposer
 */
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export interface LoomOpenSessionFields {
  /** Appended to pi's system prompt; `""` appends nothing. */
  readonly appendSystemPrompt: string;
  /** One `--skill <path>` each. */
  readonly skills: ReadonlyArray<string>;
  /** One `--extension <path>` each, beside upstream's bridge extension. */
  readonly extensions: ReadonlyArray<string>;
}

export const EMPTY_LOOM_OPEN_SESSION_FIELDS: LoomOpenSessionFields = {
  appendSystemPrompt: "",
  skills: [],
  extensions: [],
};

/** Composition failed; the open fails loudly rather than launching without the thread's role. */
export class LoomSessionComposerError extends Schema.TaggedError<LoomSessionComposerError>()(
  "LoomSessionComposerError",
  { threadId: ThreadId, cause: Schema.Defect() },
) {}

export interface LoomSessionComposerShape {
  /** Byte-stable for the same inputs: called on every pi process spawn for the thread. */
  readonly compose: (
    threadId: ThreadId,
  ) => Effect.Effect<LoomOpenSessionFields, LoomSessionComposerError>;
}

const emptyComposer: LoomSessionComposerShape = {
  compose: () => Effect.succeed(EMPTY_LOOM_OPEN_SESSION_FIELDS),
};

/**
 * A reference, so `yield* LoomSessionComposer` adds no layer requirement:
 * hand-assembled test layers of the session manager get the empty default.
 */
export class LoomSessionComposer extends Context.Reference<LoomSessionComposerShape>(
  "loom/prompt/LoomSessionComposer",
  { defaultValue: () => emptyComposer },
) {}

/** Until Phase 3a: every session opens with empty Loom fields. */
export const LoomSessionComposerDefaultLive = Layer.succeed(LoomSessionComposer, emptyComposer);
