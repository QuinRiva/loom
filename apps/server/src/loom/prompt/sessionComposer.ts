/**
 * Loom's open-session composition seam: `ProviderSessionManager.open` asks it for the prompt, skills,
 * extensions and env on every provider spawn. Kept import-light because upstream files import it;
 * the production composer is `sessionComposerLive.ts`.
 */
import { type LoomOpenSessionFields, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

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
