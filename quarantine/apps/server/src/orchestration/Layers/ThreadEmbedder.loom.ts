// @effect-diagnostics preferSchemaOverJson:off - settings are compared by a JSON key, never parsed.
/**
 * ThreadEmbedder — the semantic half of thread search (plans/thread-content-search).
 *
 * Keeps `loom_thread_embeddings` (one vector per root thread) in agreement with
 * the current root documents under the configured provider, by a hash sweep at
 * startup, every two minutes and on a provider change — not by event plumbing.
 * Vectors carry the identity `<provider>/<model>/<dim>`; only rows matching the
 * current provider are held in memory and searched, and the sweep re-embeds the
 * rest. Provider `none`, or one that cannot be reached, means `nearest` answers
 * `undefined` and search runs lexical-only.
 *
 * @module ThreadEmbedder
 */
import * as NodeCrypto from "node:crypto";

import type { ThreadSearchEmbeddingSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { EmbeddingProvider } from "./embedding/EmbeddingProvider.loom.ts";
import { makeLocalProvider } from "./embedding/local.loom.ts";
import { makeOpenAiCompatibleProvider } from "./embedding/openaiCompatible.loom.ts";
import { makeVertexProvider } from "./embedding/vertex.loom.ts";

const SWEEP_INTERVAL = Duration.minutes(2);
const BATCH = 8;
const QUERY_TIMEOUT = Duration.seconds(2);

export const providerFromSettings = (
  settings: ThreadSearchEmbeddingSettings,
  modelsDir: string,
): EmbeddingProvider | undefined => {
  switch (settings.provider) {
    case "none":
      return undefined;
    case "local":
      return makeLocalProvider(settings.model, modelsDir);
    case "openai-compatible":
      return makeOpenAiCompatibleProvider(settings);
    case "vertex":
      return makeVertexProvider(settings);
  }
};

/**
 * One document per root: title, purpose, goal, the first non-automated user
 * message (800 chars) and its direct children's titles (400 chars). The title
 * comes first (providers that take a separate title split it off) and the
 * lowest-value text last, so window truncation drops the right end.
 */
const rootDocuments = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly threadId: string;
    readonly title: string;
    readonly purpose: string | null;
    readonly goalTitle: string | null;
    readonly goalDescription: string | null;
    readonly firstUser: string | null;
    readonly childTitles: string | null;
  }>`
    SELECT
      t.thread_id AS "threadId", t.title, t.purpose,
      g.title AS "goalTitle", g.description AS "goalDescription",
      (SELECT m.text FROM projection_thread_messages m
        WHERE m.thread_id = t.thread_id AND m.role = 'user' AND m.origin IS NULL
        ORDER BY m.created_at LIMIT 1) AS "firstUser",
      (SELECT group_concat(c.title, char(10)) FROM projection_threads c
        WHERE c.parent_thread_id = t.thread_id AND c.deleted_at IS NULL) AS "childTitles"
    FROM projection_threads t
    JOIN projection_projects p ON p.project_id = t.project_id AND p.deleted_at IS NULL
    LEFT JOIN projection_goals g ON g.goal_id = t.goal_id AND g.deleted_at IS NULL
    WHERE t.parent_thread_id IS NULL AND t.deleted_at IS NULL
  `.pipe(
    Effect.map((rows) =>
      rows.map((row) => {
        const text = [
          row.title,
          row.purpose,
          row.goalTitle,
          row.goalDescription,
          row.firstUser?.slice(0, 800),
          row.childTitles?.slice(0, 400),
        ]
          .filter(Boolean)
          .join("\n");
        return {
          threadId: row.threadId,
          text,
          hash: NodeCrypto.createHash("sha1").update(text).digest("hex"),
        };
      }),
    ),
  );

const normalise = (vector: Float32Array) => {
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
};

export class ThreadEmbedder extends Context.Service<
  ThreadEmbedder,
  {
    /** Root thread ids nearest the query, best first, never one in `skip`; `undefined` = lexical-only. */
    readonly nearest: (
      query: string,
      k: number,
      skip?: ReadonlySet<string>,
    ) => Effect.Effect<ReadonlyArray<string> | undefined>;
    /** Bring the stored vectors in line with the root documents and provider. */
    readonly sweep: Effect.Effect<{ readonly embedded: number; readonly identity?: string }>;
  }
>()("t3/orchestration/Layers/ThreadEmbedder.loom/ThreadEmbedder") {}

interface ProviderState {
  readonly provider: EmbeddingProvider | undefined;
  identity?: string;
  warned: boolean;
  readonly vectors: Map<string, Float32Array>;
}

/** `currentProvider` is read at every sweep; a different provider resets the state. */
export const makeThreadEmbedder = (currentProvider: Effect.Effect<EmbeddingProvider | undefined>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lock = yield* Semaphore.make(1);
    let state: ProviderState | undefined;

    const resolveState = Effect.gen(function* () {
      const provider = yield* currentProvider;
      if (!state || state.provider !== provider)
        state = { provider, warned: false, vectors: new Map() };
      return state;
    });

    const warnOnce = (current: ProviderState, reason: string) =>
      current.warned
        ? Effect.void
        : Effect.sync(() => (current.warned = true)).pipe(
            Effect.andThen(
              Effect.logWarning("thread-search.embedder.unavailable", {
                provider: current.provider?.name,
                reason,
                fallback: "lexical-only search",
              }),
            ),
          );

    /** Probe the provider once; on success load the identity-matched vectors. */
    const activate = (current: ProviderState) =>
      Effect.gen(function* () {
        const provider = current.provider!;
        const probe = yield* provider.embed(["thread search"], "query");
        const identity = `${provider.name}/${probe[0]!.length}`;
        const rows = yield* sql<{ readonly threadId: string; readonly vector: Uint8Array }>`
          SELECT thread_id AS "threadId", vector FROM loom_thread_embeddings
          WHERE identity = ${identity}`;
        for (const row of rows) {
          current.vectors.set(
            row.threadId,
            new Float32Array(
              row.vector.buffer.slice(
                row.vector.byteOffset,
                row.vector.byteOffset + row.vector.byteLength,
              ),
            ),
          );
        }
        current.identity = identity;
        current.warned = false;
        yield* Effect.logInfo("thread-search.embedder.ready", { identity, stored: rows.length });
      });

    const sweepOnce = Effect.gen(function* () {
      const current = yield* resolveState;
      if (!current.provider) return { embedded: 0 };
      if (!current.identity) {
        const activated = yield* activate(current).pipe(
          Effect.as(true),
          Effect.catch((error) => warnOnce(current, String(error)).pipe(Effect.as(false))),
        );
        if (!activated) return { embedded: 0 };
      }
      const identity = current.identity!;
      const started = yield* Clock.currentTimeMillis;
      const docs = yield* rootDocuments(sql);
      const stored = new Map(
        (yield* sql<{
          readonly threadId: string;
          readonly identity: string;
          readonly hash: string;
        }>`
          SELECT thread_id AS "threadId", identity, source_hash AS hash FROM loom_thread_embeddings`).map(
          (row) => [row.threadId, row] as const,
        ),
      );
      const live = new Set(docs.map((doc) => doc.threadId));
      for (const threadId of current.vectors.keys())
        if (!live.has(threadId)) current.vectors.delete(threadId);
      yield* sql`DELETE FROM loom_thread_embeddings WHERE thread_id NOT IN (
        SELECT thread_id FROM projection_threads WHERE parent_thread_id IS NULL AND deleted_at IS NULL)`;

      const todo = docs.filter((doc) => {
        const row = stored.get(doc.threadId);
        return row?.identity !== identity || row.hash !== doc.hash;
      });
      let embedded = 0;
      for (let start = 0; start < todo.length; start += BATCH) {
        const batch = todo.slice(start, start + BATCH);
        const vectors = yield* current.provider.embed(
          batch.map((doc) => doc.text),
          "document",
        );
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        for (const [index, doc] of batch.entries()) {
          const vector = normalise(vectors[index]!);
          yield* sql`
            INSERT INTO loom_thread_embeddings (thread_id, identity, source_hash, vector, updated_at)
            VALUES (${doc.threadId}, ${identity}, ${doc.hash}, ${new Uint8Array(vector.buffer)}, ${updatedAt})
            ON CONFLICT (thread_id) DO UPDATE SET identity = excluded.identity,
              source_hash = excluded.source_hash, vector = excluded.vector, updated_at = excluded.updated_at`;
          current.vectors.set(doc.threadId, vector);
        }
        embedded += batch.length;
      }
      if (embedded > 0)
        yield* Effect.logInfo("thread-search.embedder.sweep", {
          identity,
          embedded,
          roots: docs.length,
          ms: (yield* Clock.currentTimeMillis) - started,
        });
      return { embedded, identity };
    });

    const sweep = lock.withPermits(1)(
      sweepOnce.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("thread-search.embedder.sweep-failed", { cause }).pipe(
            Effect.as({ embedded: 0 }),
          ),
        ),
      ),
    );

    /** Set by a failed query embed, cleared by the next success: one warning per outage. */
    let queryWarned = false;
    const nearest = (query: string, k: number, skip?: ReadonlySet<string>) =>
      Effect.gen(function* () {
        const current = state;
        if (!current?.provider || !current.identity) return undefined;
        const [embedded] = yield* current.provider.embed([query], "query");
        queryWarned = false;
        const vector = normalise(embedded!);
        return [...current.vectors]
          .filter(([threadId]) => !skip?.has(threadId))
          .map(([threadId, candidate]) => {
            let score = 0;
            for (let index = 0; index < vector.length; index++)
              score += vector[index]! * candidate[index]!;
            return [threadId, score] as const;
          })
          .toSorted((a, b) => b[1] - a[1])
          .slice(0, k)
          .map(([threadId]) => threadId);
      }).pipe(
        Effect.timeoutOption(QUERY_TIMEOUT),
        Effect.map(Option.getOrUndefined),
        Effect.catch((error) =>
          queryWarned
            ? Effect.succeed(undefined)
            : Effect.sync(() => (queryWarned = true)).pipe(
                Effect.andThen(
                  Effect.logWarning("thread-search.embedder.query-failed", {
                    error: String(error),
                  }),
                ),
                Effect.as(undefined),
              ),
        ),
      );

    return ThreadEmbedder.of({ nearest, sweep });
  });

/** Settings-driven embedder with its background sweep, for the server build. */
export const ThreadEmbedderLive = Layer.effect(
  ThreadEmbedder,
  Effect.gen(function* () {
    const settings = yield* ServerSettingsService;
    const { stateDir } = yield* ServerConfig;
    const modelsDir = (yield* Path.Path).join(stateDir, "models");
    let current:
      | { readonly key: string; readonly provider: EmbeddingProvider | undefined }
      | undefined;
    const embedder = yield* makeThreadEmbedder(
      settings.getSettings.pipe(
        Effect.orDie,
        Effect.map(({ threadSearchEmbedding }) => {
          const key = JSON.stringify(threadSearchEmbedding);
          if (current?.key !== key)
            current = { key, provider: providerFromSettings(threadSearchEmbedding, modelsDir) };
          return current.provider;
        }),
      ),
    );
    yield* settings.ready.pipe(
      Effect.andThen(embedder.sweep.pipe(Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)))),
      Effect.catchCause((cause) => Effect.logWarning("thread-search.embedder.stopped", { cause })),
      Effect.forkScoped,
    );
    yield* settings.streamChanges.pipe(
      Stream.map((value) => JSON.stringify(value.threadSearchEmbedding)),
      Stream.changes,
      Stream.runForEach(() => embedder.sweep),
      Effect.forkScoped,
    );
    return embedder;
  }),
);
