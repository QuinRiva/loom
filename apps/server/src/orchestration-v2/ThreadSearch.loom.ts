// @effect-diagnostics globalJsonInEffect:off - id arrays are passed to SQLite as json_each() parameters.
/**
 * Thread content search over `loom_thread_search` (+ the embedder's nearest roots, fused by RRF),
 * credited to roots; `scope: "roots"` (default, the human surfaces) reads a root's own text and
 * every report in its tree, `"all"` (the agent tool) sub-threads and tasks too, and with
 * `subThreadRows` each root's matching sub-threads as rows inside `limit`. See doc 38 §4.
 */
import {
  MessageId,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationThreadSearchSource,
  type OrchestrationThreadSearchSubThreadMatch,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { THREAD_SEARCH_KIND_CODES } from "../persistence/threadSearchIndex.loom.ts";
import { ThreadEmbedder } from "./ThreadEmbedder.loom.ts";
import {
  make as makeUpstreamThreadSearch,
  ThreadSearch,
  ThreadSearchError,
} from "./ThreadSearch.ts";

const RRF_K = 60;
const CANDIDATES = 50;
/** Sub-thread rows a root carries before the rest fold into `subThreadsOmitted`. */
const SUB_THREAD_ROWS = 3;
// Under `roots` most documents (sub-threads' text) are dropped after the cut, so it reads more.
const DOC_CANDIDATES = { all: 1000, roots: 4000 };
/** A document a `roots` search reads: a root's own text (not a task), or any report. */
const IN_ROOTS_SCOPE = `(rowid % 8 IN (0, 6) OR (rowid % 8 <> 7 AND thread_id = root_id))`;
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

/**
 * Lowercased word terms; stopwords and single letters (the "s" of "building's")
 * dropped unless that empties the query.
 */
const toTerms = (query: string) => {
  const all = query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  const kept = all.filter((term) => !STOPWORDS.has(term) && !/^\p{L}$/u.test(term));
  return kept.length > 0 ? kept : all;
};

/**
 * Each term quoted; the last one is a prefix so results move while typing, from
 * 3 characters, as expanding a 1–2 character prefix costs 0.5–1 s.
 */
const matchTerms = (terms: ReadonlyArray<string>) =>
  terms.map(
    (term, index) => `"${term}"${index === terms.length - 1 && term.length >= 3 ? "*" : ""}`,
  );

const THREADS = "orchestration_v2_projection_threads";
const MESSAGES = "orchestration_v2_projection_messages";
/** V2's own lineage: every thread names its root, workstream child or upstream subagent alike. */
const rootOf = (thread: string) => `json_extract(${thread}.payload_json, '$.lineage.rootThreadId')`;

/**
 * Every column a document needs comes from its rowid (kind = rowid % 8, owner =
 * the source row at rowid / 8, see threadSearchIndex.loom.ts): reading the FTS5
 * table's own columns per hit costs several times the MATCH itself. Goals and
 * tasks credit the roots that carry their goal.
 */
const lexicalSql = (termCount: number, scope: SearchScope) => {
  const subRows = withSubThreadRows(scope);
  const roots = `SELECT p.root_id AS "rootId", p.rowid AS "rowid", p.thread_id AS "threadId",
      p.coverage AS "coverage", p.score AS "score", r.updated_at AS "updatedAt"
    FROM ranked p CROSS JOIN ${THREADS} r ON r.thread_id = p.root_id
    WHERE p.rn = 1 AND r.deleted_at IS NULL${scope.includeArchived === false ? " AND r.archived_at IS NULL" : ""}${
      projectsOf(scope) === undefined ? "" : " AND r.project_id IN (SELECT value FROM json_each(?))"
    }${scope.rootThreadId === undefined ? "" : " AND p.root_id = ?"}
    ORDER BY p.coverage DESC, p.score, r.updated_at DESC
    LIMIT ${CANDIDATES}`;
  return `
  WITH hits AS MATERIALIZED (
    ${Array.from(
      { length: termCount },
      (
        _,
        term,
      ) => `SELECT ${term} AS term, rowid, bm25(loom_thread_search) * ${KIND_WEIGHT} AS score
      FROM loom_thread_search WHERE loom_thread_search MATCH ?`,
    ).join(" UNION ALL ")}
  ),
  -- A root ranks by its best document, so the roots of the best documents, in
  -- order, are the best roots: attributing only the top documents is exact while
  -- they hold ${CANDIDATES} roots, and attribution is most of the query's cost.
  docs AS MATERIALIZED (
    SELECT rowid, COUNT(DISTINCT term) AS coverage, SUM(score) AS score FROM hits GROUP BY rowid
    ORDER BY coverage DESC, score LIMIT ${DOC_CANDIDATES[scope.scope ?? "roots"]}
  ),
  owned AS MATERIALIZED (
    SELECT d.*, t.thread_id FROM docs d
      JOIN ${THREADS} t ON t.rowid = d.rowid / 8 WHERE d.rowid % 8 = 1
    UNION ALL SELECT d.*, w.thread_id FROM docs d
      JOIN loom_thread_workstream w ON w.rowid = d.rowid / 8 WHERE d.rowid % 8 IN (0, 2)
    UNION ALL SELECT d.*, m.thread_id FROM docs d
      JOIN ${MESSAGES} m ON m.rowid = d.rowid / 8 WHERE d.rowid % 8 IN (3, 4, 5)
  ),
  attributed AS (
    SELECT ${rootOf("t")} AS root_id, o.* FROM owned o
      JOIN ${THREADS} t ON t.thread_id = o.thread_id AND t.deleted_at IS NULL
    -- CROSS JOIN pins docs outermost: the planner otherwise scans docs once per root (340 ms vs 90).
    UNION ALL SELECT w.thread_id, d.*, NULL FROM docs d
      CROSS JOIN loom_goals g ON g.rowid = d.rowid / 8
      CROSS JOIN loom_thread_workstream w ON w.goal_id = g.goal_id AND w.parent_thread_id IS NULL
      WHERE d.rowid % 8 = 6
    UNION ALL SELECT w.thread_id, d.*, NULL FROM docs d
      CROSS JOIN loom_goal_tasks k ON k.rowid = d.rowid / 8
      CROSS JOIN loom_thread_workstream w ON w.goal_id = k.goal_id AND w.parent_thread_id IS NULL
      WHERE d.rowid % 8 = 7
  ),
  ranked AS ${subRows ? "MATERIALIZED " : ""}(
    SELECT *, ROW_NUMBER() OVER (PARTITION BY root_id ORDER BY coverage DESC, score) AS rn${
      subRows
        ? ",\n      ROW_NUMBER() OVER (PARTITION BY root_id, thread_id ORDER BY coverage DESC, score) AS trn"
        : ""
    }
    FROM attributed${scope.scope === "all" ? "" : ` WHERE ${IN_ROOTS_SCOPE}`}
  )${
    subRows
      ? `,
  -- Then each listed root's sub-threads with a full word match of their own, by their best document.
  top AS MATERIALIZED (${roots})
  SELECT *, 0 AS "sub", NULL AS "archivedAt" FROM top
  UNION ALL SELECT s.root_id, s.rowid, s.thread_id, s.coverage, s.score, NULL, 1, st.archived_at
    FROM top JOIN ranked s ON s.root_id = top."rootId"
    CROSS JOIN ${THREADS} st ON st.thread_id = s.thread_id
    WHERE s.trn = 1 AND s.thread_id <> s.root_id AND s.coverage = ${termCount}${
      scope.includeArchived === false ? " AND st.archived_at IS NULL" : ""
    }
  ORDER BY "sub", "coverage" DESC, "score", "updatedAt" DESC`
      : `\n  ${roots}`
  }`;
};

type SearchScope = Pick<
  OrchestrationSearchThreadsInput,
  "includeArchived" | "projectId" | "projectIds" | "rootThreadId" | "scope" | "subThreadRows"
>;

const withSubThreadRows = (scope: SearchScope) =>
  scope.subThreadRows === true && scope.scope === "all";
/** `projectId` (the agent tool's one project) wins over `projectIds` (the clients' picker). */
const projectsOf = (scope: SearchScope) =>
  scope.projectId === undefined ? scope.projectIds : [scope.projectId];

interface LexicalHit {
  readonly rootId: string;
  readonly rowid: number;
  readonly threadId: string | null;
  readonly coverage: number;
  /** 1 for a sub-thread row (only with `subThreadRows`), which carries its own `archivedAt`. */
  readonly sub?: number;
  readonly archivedAt?: string | null;
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
  /** Reads go to the reader worker, off the writer and the event loop. */
  const read = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql.withTransaction(effect).pipe(NodeSqliteClient.readOnly);

  const lexical = (terms: ReadonlyArray<string>, scope: SearchScope) =>
    terms.length === 0
      ? Effect.succeed([] as ReadonlyArray<LexicalHit>)
      : read(
          sql.unsafe<LexicalHit>(lexicalSql(terms.length, scope), [
            ...matchTerms(terms),
            ...(projectsOf(scope) === undefined ? [] : [JSON.stringify(projectsOf(scope))]),
            ...(scope.rootThreadId === undefined ? [] : [scope.rootThreadId]),
          ]),
        );

  /**
   * Out-of-scope roots leave the candidate set before the top-k cut, not after it. Unfolding one
   * workstream skips the embedding call: its root is already listed.
   */
  const semantic = (query: string, scope: SearchScope) => {
    const projects = projectsOf(scope);
    return Option.isNone(embedder) || scope.rootThreadId !== undefined
      ? Effect.undefined
      : scope.includeArchived !== false && projects === undefined
        ? embedder.value.nearest(query, CANDIDATES)
        : read(sql<{ readonly threadId: string }>`
            SELECT thread_id AS "threadId" FROM orchestration_v2_projection_threads
            WHERE (${scope.includeArchived === false ? 1 : 0} AND archived_at IS NOT NULL)
              OR (${projects === undefined ? 0 : 1} AND project_id NOT IN
                (SELECT value FROM json_each(${JSON.stringify(projects ?? [])})))`).pipe(
            Effect.flatMap((rows) =>
              embedder.value.nearest(query, CANDIDATES, new Set(rows.map((row) => row.threadId))),
            ),
          );
  };

  /** Live roots (not deleted, project not deleted) among `ids`. */
  const rootRows = (ids: ReadonlyArray<string>) =>
    read(sql<RootRow>`
      SELECT t.thread_id AS "threadId", t.project_id AS "projectId", t.title, w.purpose,
        t.archived_at AS "archivedAt", t.updated_at AS "updatedAt"
      FROM orchestration_v2_projection_threads t
      JOIN projection_projects p ON p.project_id = t.project_id AND p.deleted_at IS NULL
      LEFT JOIN loom_thread_workstream w ON w.thread_id = t.thread_id
      WHERE t.thread_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
        AND t.deleted_at IS NULL`).pipe(
      Effect.map((rows) => new Map(rows.map((row) => [row.threadId, row] as const))),
    );

  /**
   * Both rankings and their fusion, as root ids best-first (the harness reads them): `voted` is
   * the fusion, `fused` it without the roots neither a full word match nor the embedder's cut-off
   * lets through. `semantic` is undefined when search is lexical-only.
   */
  const rank = Effect.fn("ThreadSearch.rank")(function* (query: string, scope: SearchScope = {}) {
    const terms = toTerms(query);
    const [rows, nearest] = yield* Effect.all([lexical(terms, scope), semantic(query, scope)], {
      concurrency: 2,
    });
    const hits = rows.filter((row) => !row.sub);
    const subHits = Map.groupBy(
      rows.filter((row) => row.sub),
      (row) => row.rootId,
    );
    const roots = yield* rootRows([...hits.map((hit) => hit.rootId), ...(nearest?.ids ?? [])]);
    const lexicalIds = hits.map((hit) => hit.rootId).filter((id) => roots.has(id));
    let voted = lexicalIds;
    let fused = lexicalIds;
    if (nearest !== undefined) {
      const scores = new Map<string, number>();
      const vote = (ids: ReadonlyArray<string>) =>
        ids.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1)));
      // RRF (k = 60) of the semantic top-50 and the full-coverage lexical roots: partial-term
      // matches would outvote a correct semantic #1. With no embedder, the full lexical order.
      const full = hits.filter((hit) => hit.coverage === terms.length).map((hit) => hit.rootId);
      vote(full);
      vote(nearest.ids);
      voted = [...scores]
        .filter(([id]) => roots.has(id))
        .toSorted(
          ([a, scoreA], [b, scoreB]) =>
            scoreB - scoreA || roots.get(b)!.updatedAt.localeCompare(roots.get(a)!.updatedAt),
        )
        .map(([id]) => id);
      const listed = new Set([...full, ...nearest.close]);
      fused = voted.filter((id) => listed.has(id));
    }
    return {
      terms,
      hits,
      subHits,
      roots,
      lexical: lexicalIds,
      semantic: nearest?.ids,
      voted,
      fused,
    };
  });

  const searchThreads = Effect.fn("ThreadSearch.searchThreads")(function* (
    input: OrchestrationSearchThreadsInput,
  ): Effect.fn.Return<OrchestrationSearchThreadsResult, SqlError> {
    const { terms, hits, subHits, roots, fused } = yield* rank(input.query, input);
    const limit = input.limit ?? CANDIDATES;
    const subRows = withSubThreadRows(input);
    const perRoot = input.rootThreadId === undefined ? SUB_THREAD_ROWS : limit - 1;
    // Roots in order while their rows and their sub-thread rows fit in `limit`.
    const listed: Array<{
      readonly id: string;
      readonly subs: ReadonlyArray<LexicalHit>;
      readonly omitted: number;
    }> = [];
    let used = 0;
    for (const id of fused) {
      if (used >= limit) break;
      const matching = subRows ? (subHits.get(id) ?? []) : [];
      const subs = matching.slice(0, Math.min(perRoot, limit - used - 1));
      listed.push({ id, subs, omitted: matching.length - subs.length });
      used += 1 + subs.length;
    }
    const best = new Map(hits.map((hit) => [hit.rootId, hit] as const));
    const shown = listed.flatMap(({ id, subs }) => [
      ...(best.get(id) === undefined ? [] : [best.get(id)!.rowid]),
      ...subs.map((sub) => sub.rowid),
    ]);
    // snippet() only for the rows returned: over every hit it costs ~130 ms. The
    // unary + keeps `rowid IN` from reaching FTS5 as a rowid constraint, which
    // re-evaluates the whole MATCH (prefix expansion included) once per row:
    // 250 ms instead of 13 for "the thread is in the new one".
    const snippets = new Map(
      shown.length === 0
        ? []
        : (yield* read(sql<{
            readonly rowid: number;
            readonly snippet: string;
            readonly messageCreatedAt: string | null;
            readonly messageId: string | null;
            readonly matchedTitle: string | null;
            readonly reportPath: string | null;
          }>`
            SELECT f.rowid AS "rowid", snippet(loom_thread_search, 3, '', '', '…', 32) AS snippet,
              CASE WHEN f.rowid % 8 IN (3, 4, 5) THEN
                (SELECT created_at FROM orchestration_v2_projection_messages WHERE rowid = f.rowid / 8) END
                AS "messageCreatedAt",
              CASE WHEN f.rowid % 8 IN (3, 4, 5) THEN
                (SELECT message_id FROM orchestration_v2_projection_messages WHERE rowid = f.rowid / 8) END
                AS "messageId",
              (SELECT title FROM orchestration_v2_projection_threads WHERE thread_id = f.thread_id)
                AS "matchedTitle",
              CASE WHEN f.rowid % 8 = 0 THEN
                (SELECT report_path FROM loom_thread_workstream WHERE rowid = f.rowid / 8) END
                AS "reportPath"
            FROM loom_thread_search f
            WHERE loom_thread_search MATCH ${matchTerms(terms).join(" OR ")}
              AND +f.rowid IN (SELECT value FROM json_each(${JSON.stringify(shown)}))`)).map(
            (row) => [row.rowid, row] as const,
          ),
    );
    const located = (row: {
      readonly messageId: string | null;
      readonly reportPath: string | null;
    }) => ({
      ...(row.messageId ? { messageId: MessageId.make(row.messageId) } : {}),
      ...(row.reportPath ? { reportPath: row.reportPath } : {}),
    });
    const subMatches = (subs: ReadonlyArray<LexicalHit>) =>
      subs.flatMap((sub): ReadonlyArray<OrchestrationThreadSearchSubThreadMatch> => {
        const row = snippets.get(sub.rowid);
        return row
          ? [
              {
                threadId: ThreadId.make(sub.threadId!),
                title: row.matchedTitle ?? "",
                source: KIND_NAMES[sub.rowid % 8]!,
                snippet: clip(row.snippet),
                messageCreatedAt: row.messageCreatedAt,
                ...located(row),
                archivedAt: sub.archivedAt ?? null,
              },
            ]
          : [];
      });
    const matches = listed.map(
      ({ id, subs, omitted }, position): OrchestrationSearchThreadsResult["matches"][number] => {
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
          // The fused rank as upstream's match quality: every hit stays a word match, so the
          // clients' rankMessageMatches keeps this order and only a palette pick lifts a root.
          quality: 1 - position / 1000,
          // A root only the semantic side found: its purpose (or title) is a true statement about it.
          ...(snippet
            ? {
                source: KIND_NAMES[hit.rowid % 8]!,
                snippet: clip(snippet.snippet),
                messageCreatedAt: snippet.messageCreatedAt,
                matchedThreadId,
                matchedThreadTitle: matchedThreadId ? snippet.matchedTitle : null,
                // Only a root's own message: the jump opens the root's timeline.
                ...located({ ...snippet, messageId: matchedThreadId ? null : snippet.messageId }),
              }
            : {
                source: root.purpose ? "purpose" : "title",
                snippet: clip(root.purpose || root.title),
                messageCreatedAt: null,
                matchedThreadId: null,
                matchedThreadTitle: null,
              }),
          ...(subRows ? { subThreads: subMatches(subs), subThreadsOmitted: omitted } : {}),
        };
      },
    );
    return { matches };
  });

  return { rank, searchThreads };
});

/**
 * Upstream's `ThreadSearch` service over this index. `searchThreads` is upstream's
 * agent tool (`t3_thread_search`, withheld from Loom roles): its hits, roots only.
 */
export const layer = Layer.effect(
  ThreadSearch,
  Effect.gen(function* () {
    const loom = yield* makeThreadSearch;
    const upstream = yield* makeUpstreamThreadSearch;
    // Clients omit the limit; 30 roots fill the palette and sidebar with room to spare.
    const search = (input: OrchestrationSearchThreadsInput) =>
      loom
        .searchThreads({ limit: 30, ...input })
        .pipe(Effect.mapError((cause) => new ThreadSearchError({ operation: "query", cause })));
    return ThreadSearch.of({
      search,
      searchThreads: Effect.fn("ThreadSearch.searchThreads")(function* (input) {
        const { matches } = yield* search({ ...input, scope: "roots" });
        return {
          matches: matches.map((match) => ({
            threadId: match.threadId,
            projectId: match.projectId,
            title: match.title,
            source: match.source,
            snippet: match.snippet,
            messageCreatedAt: match.messageCreatedAt,
          })),
        };
      }),
      searchOlderSettled: upstream.searchOlderSettled,
    });
  }),
);
