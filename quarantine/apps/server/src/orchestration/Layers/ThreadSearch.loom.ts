// @effect-diagnostics preferSchemaOverJson:off - id arrays are passed to SQLite as json_each() parameters.
/**
 * Thread content search (plans/thread-content-search): root threads only,
 * ranked by fusing the FTS5 index (`loom_thread_search`) with the
 * ThreadEmbedder's nearest roots.
 *
 * - Lexical: one MATCH per query term gives each document its term coverage; a
 *   root scores as its single best document (most terms, then kind-weighted
 *   bm25), credited from anywhere in its subtree.
 * - Fusion: reciprocal rank fusion (k = 60) of the semantic top-50 and the
 *   lexical roots whose best document contains EVERY term — partial-term
 *   lexical matches would outvote a correct semantic #1.
 * - No embedder (provider `none`, unavailable, still loading): the full lexical
 *   order, partial matches included.
 * - `includeArchived: false` drops archived roots (and so their subtrees) from
 *   both candidate sets before ranking, so they never take a result slot.
 *
 * @module ThreadSearch
 */
import {
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadSearchSource,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { THREAD_SEARCH_KIND_CODES } from "../../persistence/threadSearchIndex.loom.ts";
import { ThreadEmbedder } from "./ThreadEmbedder.loom.ts";

const RRF_K = 60;
const CANDIDATES = 50;
const STOPWORDS = new Set(
  "a an the of in on for to with from and or is are was be this that it at by as over into about".split(
    " ",
  ),
);
// By kind code (rowid % 8, see threadSearchIndex.loom.ts): title 4, purpose 3,
// goal 3, brief 1.5, task 1.5, assistant 0.8, user/report 1.
const KIND_WEIGHT = `CASE rowid % 8 WHEN 1 THEN 4 WHEN 2 THEN 3 WHEN 6 THEN 3
  WHEN 3 THEN 1.5 WHEN 7 THEN 1.5 WHEN 5 THEN 0.8 ELSE 1 END`;
const KIND_NAMES = Object.fromEntries(
  Object.entries(THREAD_SEARCH_KIND_CODES).map(([name, code]) => [code, name]),
) as Record<number, OrchestrationThreadSearchSource>;

/** Lowercased word terms, stopwords dropped unless that empties the query. */
export const toTerms = (query: string) => {
  const all = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const kept = all.filter((term) => !STOPWORDS.has(term));
  return kept.length > 0 ? kept : all;
};

/**
 * Each term quoted; the last one is a prefix so results move while typing — from
 * 3 characters, as expanding a 1–2 character prefix costs 0.5–1 s.
 */
const matchTerms = (terms: ReadonlyArray<string>) =>
  terms.map(
    (term, index) => `"${term}"${index === terms.length - 1 && term.length >= 3 ? "*" : ""}`,
  );

/**
 * Every column a document needs comes from its rowid (kind = rowid % 8, owner =
 * the source row at rowid / 8): reading the FTS5 table's own columns per hit,
 * or joining it back by rowid, costs several times the MATCH itself.
 */
const lexicalSql = (termCount: number, includeArchived: boolean) => `
  WITH RECURSIVE roots(thread_id, root_id) AS MATERIALIZED (
    SELECT thread_id, thread_id FROM projection_threads
    WHERE parent_thread_id IS NULL AND deleted_at IS NULL${includeArchived ? "" : " AND archived_at IS NULL"}
    UNION ALL
    -- CROSS JOIN pins the join order (13 s vs 10 ms without it).
    SELECT t.thread_id, r.root_id FROM roots r CROSS JOIN projection_threads t
    ON t.parent_thread_id = r.thread_id AND t.deleted_at IS NULL
  ),
  goal_roots AS MATERIALIZED (
    SELECT goal_id, thread_id AS root_id FROM projection_threads
    WHERE parent_thread_id IS NULL AND deleted_at IS NULL AND goal_id IS NOT NULL${includeArchived ? "" : " AND archived_at IS NULL"}
  ),
  hits AS MATERIALIZED (
    ${Array.from(
      { length: termCount },
      (
        _,
        term,
      ) => `SELECT ${term} AS term, rowid, bm25(loom_thread_search) * ${KIND_WEIGHT} AS score
      FROM loom_thread_search WHERE loom_thread_search MATCH ?`,
    ).join(" UNION ALL ")}
  ),
  docs AS MATERIALIZED (
    SELECT rowid, COUNT(DISTINCT term) AS coverage, SUM(score) AS score FROM hits GROUP BY rowid
  ),
  attributed AS (
    SELECT r.root_id, d.*, t.thread_id FROM docs d
      JOIN projection_threads t ON t.rowid = d.rowid / 8
      JOIN roots r ON r.thread_id = t.thread_id WHERE d.rowid % 8 < 4
    UNION ALL SELECT r.root_id, d.*, m.thread_id FROM docs d
      JOIN projection_thread_messages m ON m.rowid = d.rowid / 8
      JOIN roots r ON r.thread_id = m.thread_id WHERE d.rowid % 8 IN (4, 5)
    UNION ALL SELECT gr.root_id, d.*, NULL FROM docs d
      JOIN projection_goals g ON g.rowid = d.rowid / 8
      JOIN goal_roots gr ON gr.goal_id = g.goal_id WHERE d.rowid % 8 = 6
    UNION ALL SELECT gr.root_id, d.*, NULL FROM docs d
      JOIN projection_goal_tasks k ON k.rowid = d.rowid / 8
      JOIN goal_roots gr ON gr.goal_id = k.goal_id WHERE d.rowid % 8 = 7
  ),
  ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY root_id ORDER BY coverage DESC, score) AS rn
    FROM attributed
  )
  SELECT p.root_id AS "rootId", p.rowid AS "rowid", p.thread_id AS "threadId", p.coverage AS "coverage"
  FROM ranked p JOIN projection_threads t ON t.thread_id = p.root_id
  WHERE p.rn = 1
  ORDER BY p.coverage DESC, p.score, t.updated_at DESC
  LIMIT ${CANDIDATES}`;

interface LexicalHit {
  readonly rootId: string;
  readonly rowid: number;
  readonly threadId: string | null;
  readonly coverage: number;
}

interface RootRow {
  readonly threadId: string;
  readonly projectId: string;
  readonly title: string;
  readonly purpose: string | null;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
}

const clip = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= 240 ? flat : `${flat.slice(0, 239)}…`;
};

export const makeThreadSearch = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const embedder = yield* Effect.serviceOption(ThreadEmbedder);

  const lexical = (terms: ReadonlyArray<string>, includeArchived: boolean) =>
    terms.length === 0
      ? Effect.succeed([] as ReadonlyArray<LexicalHit>)
      : sql.unsafe<LexicalHit>(lexicalSql(terms.length, includeArchived), matchTerms(terms));

  /** Archived roots leave the candidate set before the top-k cut, not after it. */
  const semantic = (query: string, includeArchived: boolean) =>
    Option.isNone(embedder)
      ? Effect.succeed(undefined)
      : includeArchived
        ? embedder.value.nearest(query, CANDIDATES)
        : sql<{ readonly threadId: string }>`
            SELECT thread_id AS "threadId" FROM projection_threads
            WHERE parent_thread_id IS NULL AND archived_at IS NOT NULL`.pipe(
            Effect.flatMap((rows) =>
              embedder.value.nearest(query, CANDIDATES, new Set(rows.map((row) => row.threadId))),
            ),
          );

  /** Live roots (not deleted, project not deleted) among `ids`. */
  const rootRows = (ids: ReadonlyArray<string>) =>
    sql<RootRow>`
      SELECT t.thread_id AS "threadId", t.project_id AS "projectId", t.title, t.purpose,
        t.archived_at AS "archivedAt", t.updated_at AS "updatedAt"
      FROM projection_threads t
      JOIN projection_projects p ON p.project_id = t.project_id AND p.deleted_at IS NULL
      WHERE t.thread_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
        AND t.deleted_at IS NULL`.pipe(
      Effect.map((rows) => new Map(rows.map((row) => [row.threadId, row] as const))),
    );

  /**
   * Both rankings and their fusion, as root ids best-first (the harness reads
   * all three). `semantic` is undefined when search is lexical-only.
   */
  const rank = Effect.fn("ThreadSearch.rank")(function* (query: string, includeArchived = true) {
    const terms = toTerms(query);
    const [hits, nearest] = yield* Effect.all(
      [lexical(terms, includeArchived), semantic(query, includeArchived)],
      { concurrency: 2 },
    );
    const roots = yield* rootRows([...hits.map((hit) => hit.rootId), ...(nearest ?? [])]);
    const lexicalIds = hits.map((hit) => hit.rootId).filter((id) => roots.has(id));
    let fused = lexicalIds;
    if (nearest !== undefined) {
      const scores = new Map<string, number>();
      const vote = (ids: ReadonlyArray<string>) =>
        ids.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1)));
      vote(hits.filter((hit) => hit.coverage === terms.length).map((hit) => hit.rootId));
      vote(nearest);
      fused = [...scores]
        .filter(([id]) => roots.has(id))
        .toSorted(
          ([a, scoreA], [b, scoreB]) =>
            scoreB - scoreA || roots.get(b)!.updatedAt.localeCompare(roots.get(a)!.updatedAt),
        )
        .map(([id]) => id);
    }
    return { terms, hits, roots, lexical: lexicalIds, semantic: nearest, fused };
  });

  const searchThreads = Effect.fn("ThreadSearch.searchThreads")(function* (
    input: OrchestrationSearchThreadsInput,
  ): Effect.fn.Return<OrchestrationSearchThreadsResult, SqlError> {
    const { terms, hits, roots, fused } = yield* rank(input.query, input.includeArchived);
    const ids = fused.slice(0, input.limit ?? CANDIDATES);
    const best = new Map(hits.map((hit) => [hit.rootId, hit] as const));
    const shown = ids.flatMap((id) => best.get(id)?.rowid ?? []);
    // snippet() only for the rows returned: over every hit it costs ~130 ms.
    const snippets =
      shown.length === 0
        ? new Map<
            number,
            { snippet: string; messageCreatedAt: string | null; matchedTitle: string | null }
          >()
        : new Map(
            (yield* sql<{
              readonly rowid: number;
              readonly snippet: string;
              readonly messageCreatedAt: string | null;
              readonly matchedTitle: string | null;
            }>`
              SELECT f.rowid AS "rowid", snippet(loom_thread_search, 3, '', '', '…', 32) AS snippet,
                CASE WHEN f.kind IN ('user', 'assistant') THEN
                  (SELECT created_at FROM projection_thread_messages WHERE rowid = f.rowid / 8) END
                  AS "messageCreatedAt",
                (SELECT title FROM projection_threads WHERE thread_id = f.thread_id) AS "matchedTitle"
              FROM loom_thread_search f
              WHERE loom_thread_search MATCH ${matchTerms(terms).join(" OR ")}
                AND f.rowid IN (SELECT value FROM json_each(${JSON.stringify(shown)}))`).map(
              (row) => [row.rowid, row] as const,
            ),
          );
    const matches = ids.map((id): OrchestrationSearchThreadsResult["matches"][number] => {
      const root = roots.get(id)!;
      const hit = best.get(id);
      const snippet = hit && snippets.get(hit.rowid);
      const matchedThreadId =
        hit?.threadId && hit.threadId !== id ? ThreadId.make(hit.threadId) : null;
      return {
        threadId: ThreadId.make(id),
        projectId: ProjectId.make(root.projectId),
        title: root.title,
        archivedAt: root.archivedAt,
        updatedAt: root.updatedAt,
        // A root only the semantic side found: its purpose (or title) is a true statement about it.
        ...(snippet
          ? {
              source: KIND_NAMES[hit.rowid % 8]!,
              snippet: clip(snippet.snippet),
              messageCreatedAt: snippet.messageCreatedAt,
              matchedThreadId,
              matchedThreadTitle: matchedThreadId ? snippet.matchedTitle : null,
            }
          : {
              source: root.purpose ? "purpose" : "title",
              snippet: clip(root.purpose || root.title),
              messageCreatedAt: null,
              matchedThreadId: null,
              matchedThreadTitle: null,
            }),
      };
    });
    return { matches };
  });

  return { rank, searchThreads };
});
