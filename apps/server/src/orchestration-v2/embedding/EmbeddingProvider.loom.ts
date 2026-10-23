import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";

export class EmbeddingError extends Data.TaggedError("EmbeddingError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * One way of turning text into vectors for thread search. Implementations:
 * `local.loom.ts` (default), `openaiCompatible.loom.ts`, `vertex.loom.ts`;
 * `none` is the absence of a provider. ThreadEmbedder picks one from settings.
 */
export interface EmbeddingProvider {
  /** '<provider>/<model>'. Stored vectors carry `${name}/${dim}` as their identity. */
  readonly name: string;
  /** Each provider applies its own query/document framing. Vectors need not be normalised. */
  readonly embed: (
    texts: ReadonlyArray<string>,
    kind: "query" | "document",
  ) => Effect.Effect<ReadonlyArray<Float32Array>, EmbeddingError>;
}

/** Root documents start with the thread title on its own line (see ThreadEmbedder). */
export const splitTitle = (text: string) => {
  const newline = text.indexOf("\n");
  return newline < 0
    ? { title: text, body: text }
    : { title: text.slice(0, newline), body: text.slice(newline + 1) };
};
