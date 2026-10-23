// @effect-diagnostics globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off globalTimers:off - provider HTTP adapter at a Promise boundary.
import * as Effect from "effect/Effect";

import { EmbeddingError, type EmbeddingProvider } from "./EmbeddingProvider.loom.ts";

/** POST {baseUrl}/embeddings — OpenAI, Ollama (`/v1`), vLLM, LiteLLM. Raw text, no framing. */
export const makeOpenAiCompatibleProvider = (settings: {
  readonly baseUrl: string;
  readonly model: string;
  readonly dim: number;
  readonly apiKey?: string;
}): EmbeddingProvider => ({
  name: `openai-compatible/${settings.model}`,
  embed: (texts) =>
    Effect.tryPromise({
      try: async () => {
        const response = await fetch(`${settings.baseUrl.replace(/\/+$/, "")}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: settings.model, input: texts }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        const body = (await response.json()) as {
          data: Array<{ index: number; embedding: number[] }>;
        };
        const vectors = body.data
          .toSorted((a, b) => a.index - b.index)
          .map((item) => Float32Array.from(item.embedding));
        if (vectors[0]?.length !== settings.dim)
          throw new Error(`expected ${settings.dim} dimensions, got ${vectors[0]?.length}`);
        return vectors;
      },
      catch: (cause) =>
        new EmbeddingError({ message: `openai-compatible embedder: ${cause}`, cause }),
    }),
});
