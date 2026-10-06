/**
 * Loom's open-session composition seam (pull 9 strategy Area G; Phase 3 plan seam 4).
 *
 * `ProviderSessionManager.open` asks the composer for the thread's prompt,
 * skills, extensions and env on every provider process spawn and passes them on
 * the open-session input as `loom`; `buildPiRpcLaunch` turns them into argv and
 * the spawn env. This module is the seam only (upstream files import it, so it
 * stays import-light); the production composer is `sessionComposerLive.ts`,
 * wired by `LoomSessionComposerLive` in `loom/serverLayers.ts`.
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
  /** Merged into the pi process env (`PI_CACHE_RETENTION`, DL-300). */
  readonly env?: Readonly<Record<string, string>>;
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

/** Every session opens with empty Loom fields. */
export const LoomSessionComposerDefaultLive = Layer.succeed(LoomSessionComposer, emptyComposer);
