// @effect-diagnostics preferSchemaOverJson:off nodeBuiltinImport:off - settings are compared by a JSON key, never parsed; sha1 of a root document is a sync hash.
/**
 * The semantic half of thread search: keeps `loom_thread_embeddings` (one vector per root, identity
 * `<provider>/<model>/<dim>`) in step with the root documents by a hash sweep at startup, every two
 * minutes and on a provider change. Provider `none` or unreachable: `nearest` is undefined (lexical).
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
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
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
 * One document per root (a thread whose lineage names no parent): title, purpose, goal, the first
 * non-automated user message (800 chars), direct children's titles (400). Title first, lowest-value
 * text last, so window truncation drops the right end.
 */
const ROOT_DOCUMENTS = `
  WITH lineage AS MATERIALIZED (
    SELECT thread_id, project_id, title, deleted_at,
      json_extract(payload_json, '$.lineage.parentThreadId') AS parent_id
    FROM orchestration_v2_projection_threads
  ),
  children AS MATERIALIZED (
    SELECT parent_id, group_concat(title, char(10)) AS titles FROM lineage
    WHERE parent_id IS NOT NULL AND deleted_at IS NULL GROUP BY parent_id
  )
  SELECT
    t.thread_id AS "threadId", t.title, w.purpose,
    g.title AS "goalTitle", g.description AS "goalDescription",
    (SELECT json_extract(m.payload_json, '$.text') FROM orchestration_v2_projection_messages m
      WHERE m.thread_id = t.thread_id AND m.role = 'user'
        AND json_extract(m.payload_json, '$.loom.origin') IS NULL
      ORDER BY m.created_at LIMIT 1) AS "firstUser",
    c.titles AS "childTitles"
  FROM lineage t
  JOIN projection_projects p ON p.project_id = t.project_id AND p.deleted_at IS NULL
  LEFT JOIN loom_thread_workstream w ON w.thread_id = t.thread_id
  LEFT JOIN loom_goals g ON g.goal_id = w.goal_id AND g.deleted_at IS NULL
  LEFT JOIN children c ON c.parent_id = t.thread_id
  WHERE t.parent_id IS NULL AND t.deleted_at IS NULL`;

const rootDocuments = (sql: SqlClient.SqlClient) =>
  sql
    .unsafe<{
      readonly threadId: string;
      readonly title: string;
      readonly purpose: string | null;
      readonly goalTitle: string | null;
      readonly goalDescription: string | null;
      readonly firstUser: string | null;
      readonly childTitles: string | null;
    }>(ROOT_DOCUMENTS)
    .pipe(
      sql.withTransaction,
      NodeSqliteClient.readOnly,
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
>()("t3/orchestration-v2/ThreadEmbedder.loom/ThreadEmbedder") {}

interface ProviderState {
  readonly provider: EmbeddingProvider | undefined;
  identity?: string;
  warned: boolean;
  readonly vectors: Map<string, Float32Array>;
}

/** `currentProvider` is read at every sweep; a different provider resets the state. */
export const makeThreadEmbedder = Effect.fn("ThreadEmbedder.make")(function* (
  currentProvider: Effect.Effect<EmbeddingProvider | undefined>,
) {
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
  const activate = Effect.fn("ThreadEmbedder.activate")(function* (current: ProviderState) {
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
    for (const threadId of stored.keys())
      if (!live.has(threadId))
        yield* sql`DELETE FROM loom_thread_embeddings WHERE thread_id = ${threadId}`;

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
  const nearest = Effect.fn("ThreadEmbedder.nearest")(
    function* (query: string, k: number, skip?: ReadonlySet<string>) {
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
    },
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
