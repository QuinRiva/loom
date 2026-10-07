// @effect-diagnostics globalFetch:off globalFetchInEffect:off preferSchemaOverJson:off globalTimers:off - provider HTTP adapter at a Promise boundary.
import { GoogleAuth } from "google-auth-library";
import * as Effect from "effect/Effect";

import { EmbeddingError, type EmbeddingProvider, splitTitle } from "./EmbeddingProvider.loom.ts";

/**
 * Vertex AI, native REST (its OpenAI-compatible embeddings route returns HTTP
 * 500 for the Gemini embedding models). Auth is Application Default Credentials.
 *
 * - `gemini-embedding-001`: `:predict` in `location`, one text per request,
 *   `task_type` framing (+ `title` on documents).
 * - `gemini-embedding-2`: `:embedContent` on `global` only — thread text leaves
 *   the configured region — with in-text framing.
 */
export const makeVertexProvider = (settings: {
  readonly project: string;
  readonly location: string;
  readonly model: string;
}): EmbeddingProvider => {
  const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const global = settings.model.startsWith("gemini-embedding-2");
  const location = global ? "global" : settings.location;
  const host = global ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
  const url = `https://${host}/v1/projects/${settings.project}/locations/${location}/publishers/google/models/${settings.model}:${global ? "embedContent" : "predict"}`;

  const request = (text: string, kind: "query" | "document") => {
    const { title, body } = splitTitle(text);
    if (global)
      return {
        content: {
          parts: [
            {
              text:
                kind === "query"
                  ? `task: search result | query: ${text}`
                  : `title: ${title} | text: ${body}`,
            },
          ],
        },
      };
    return {
      instances: [
        kind === "query"
          ? { content: text, task_type: "RETRIEVAL_QUERY" }
          : { content: body, task_type: "RETRIEVAL_DOCUMENT", title },
      ],
    };
  };

  const embedOne = async (text: string, kind: "query" | "document") => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await auth.getAccessToken()}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request(text, kind)),
      });
      if (response.ok) {
        const json = (await response.json()) as {
          predictions?: Array<{ embeddings: { values: number[] } }>;
          embedding?: { values: number[] };
        };
        return Float32Array.from(
          global ? json.embedding!.values : json.predictions![0]!.embeddings.values,
        );
      }
      if (response.status !== 429 || attempt >= 4)
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  };

  return {
    name: `vertex/${settings.model}`,
    embed: (texts, kind) =>
      Effect.tryPromise({
        try: () => Promise.all(texts.map((text) => embedOne(text, kind))),
        catch: (cause) =>
          new EmbeddingError({ message: `vertex embedder (${settings.model}): ${cause}`, cause }),
      }),
  };
};
