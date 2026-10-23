import type { FeatureExtractionPipeline } from "@huggingface/transformers";
import * as Effect from "effect/Effect";

import { EmbeddingError, type EmbeddingProvider } from "./EmbeddingProvider.loom.ts";

const BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

/**
 * In-process embedder (default: `Xenova/bge-small-en-v1.5`, int8) via
 * `@huggingface/transformers` on onnxruntime-node. The package is imported
 * lazily so a missing install degrades search to lexical-only; the model
 * downloads once into `cacheDir`. Calls run one at a time.
 */
export const makeLocalProvider = (model: string, cacheDir: string): EmbeddingProvider => {
  let extractor: Promise<FeatureExtractionPipeline> | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const load = () =>
    (extractor ??= import("@huggingface/transformers")
      .then(({ pipeline }) =>
        pipeline("feature-extraction", model, {
          dtype: "q8",
          cache_dir: cacheDir,
          session_options: { intraOpNumThreads: 4 },
        }),
      )
      .catch((cause) => {
        extractor = undefined; // retried on the next sweep
        throw cause;
      }));
  // One text per inference: a padded batch costs ~2.5x per text on CPU.
  const run = async (texts: ReadonlyArray<string>) => {
    const extract = await load();
    const vectors: Float32Array[] = [];
    for (const text of texts) {
      const output = await extract(text, { pooling: "cls", normalize: true });
      vectors.push(Float32Array.from(output.data as Float32Array));
    }
    return vectors;
  };
  return {
    name: `local/${model}@q8`,
    embed: (texts, kind) =>
      Effect.tryPromise({
        try: () => {
          const next = queue.then(() =>
            run(kind === "query" ? texts.map((text) => BGE_QUERY_PREFIX + text) : texts),
          );
          queue = next.catch(() => undefined);
          return next;
        },
        catch: (cause) =>
          new EmbeddingError({ message: `local embedder (${model}): ${cause}`, cause }),
      }),
  };
};
