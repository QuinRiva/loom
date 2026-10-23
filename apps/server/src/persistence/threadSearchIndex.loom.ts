// @effect-diagnostics nodeBuiltinImport:off - migrations run with SqlClient only; report files are read synchronously.
/**
 * The thread-content search index (plans/thread-content-search): DDL, triggers
 * and backfill for `loom_thread_search` (FTS5, one row per text unit) and
 * `loom_thread_embeddings` (one vector per root thread, filled by ThreadEmbedder).
 *
 * Row identity is derived from the source row, `rowid = source.rowid * 8 + kind`,
 * so triggers delete and replace by primary key instead of scanning. Each kind
 * code belongs to exactly one source table, so two tables can never collide:
 *
 * | code | kind      | source                                                              |
 * |------|-----------|---------------------------------------------------------------------|
 * | 0    | report    | `loom_thread_workstream` (text from the report file; `upsertThreadSearchReport`) |
 * | 1    | title     | `orchestration_v2_projection_threads.title`, every thread            |
 * | 2    | purpose   | `loom_thread_workstream.purpose`                                     |
 * | 3    | brief     | `orchestration_v2_projection_messages`, kick-off (`$.loom.origin = 'kickoff'`), brief only |
 * | 4    | user      | same table, user, origin neither `kickoff` nor `control_notice`      |
 * | 5    | assistant | same table, the last non-empty assistant message of each run         |
 * | 6    | goal      | `loom_goals` (title + description)                                   |
 * | 7    | task      | `loom_goal_tasks.text`                                               |
 *
 * Messages are indexed only once finalised (`streaming = 0`: V2 rewrites the row
 * per delta). An assistant message is a run's answer when no later non-empty
 * assistant message exists in its run; indexing it removes the run's earlier
 * ones. Imported messages with no run count as final when the thread's next
 * message is the user's. A soft-deleted thread drops its rows; hits are credited
 * to roots at query time (ThreadSearch.loom.ts), so nothing here knows the tree.
 *
 * Rowids are stable because every writer upserts with `ON CONFLICT DO UPDATE`
 * and the server never VACUUMs in place; a projection rebuild deletes and
 * re-inserts through the triggers. A migration that rebuilds a source table by
 * copy-and-rename renumbers rowids and must re-run `rebuildThreadSearchIndex`.
 * `ALTER TABLE … DROP COLUMN` fails on a column a trigger references: bracket it
 * with `dropThreadSearchTriggers` / `createThreadSearchTriggers`.
 *
 * @module threadSearchIndex
 */
import * as NodeFS from "node:fs";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { KICKOFF_BRIEF_HEADING, KICKOFF_CLOSING } from "../loom/prompt/prose.ts";

/** rowid = source rowid * 8 + code. */
export const THREAD_SEARCH_KIND_CODES = {
  report: 0,
  title: 1,
  purpose: 2,
  brief: 3,
  user: 4,
  assistant: 5,
  goal: 6,
  task: 7,
} as const;

const tables = [
  `CREATE VIRTUAL TABLE loom_thread_search USING fts5(
    thread_id UNINDEXED, goal_id UNINDEXED, kind UNINDEXED, text,
    tokenize = 'porter unicode61 remove_diacritics 2'
  )`,
  `CREATE TABLE loom_thread_embeddings (
    thread_id TEXT PRIMARY KEY,
    identity TEXT NOT NULL,
    source_hash TEXT NOT NULL,
    vector BLOB NOT NULL,
    updated_at TEXT NOT NULL
  )`,
];

const text = (row: string) => `json_extract(${row}.payload_json, '$.text')`;

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const BRIEF_START = `char(10) || ${quote(KICKOFF_BRIEF_HEADING)} || char(10)`;
const BRIEF_END = `char(10) || char(10) || ${quote(KICKOFF_CLOSING.slice(0, 40))}`;
/**
 * A kick-off message's brief without the role framing and completion contract
 * around it, which every kick-off repeats and which would otherwise make every
 * brief a full-coverage match for words like "thread", "spawned" or "report".
 * A kick-off without the markers is indexed whole.
 */
const brief = (row: string) => {
  const body = text(row);
  const start = `instr(${body}, ${BRIEF_START})`;
  const end = `instr(${body}, ${BRIEF_END})`;
  return `CASE WHEN ${start} = 0 THEN ${body} ELSE substr(${body}, ${start} + ${KICKOFF_BRIEF_HEADING.length + 2},
    CASE WHEN ${end} > ${start} THEN ${end} - ${start} - ${KICKOFF_BRIEF_HEADING.length + 2} ELSE length(${body}) END) END`;
};
const origin = (row: string) => `IFNULL(json_extract(${row}.payload_json, '$.loom.origin'), '')`;

/** Strictly later in its run, by (created_at, message_id). */
const laterInRun = (m: string, than: string) =>
  `${m}.run_id = ${than}.run_id AND ${m}.role = 'assistant' AND ${text(m)} <> ''
   AND (${m}.created_at, ${m}.message_id) > (${than}.created_at, ${than}.message_id)`;

const messageRows = `
  INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
    SELECT NEW.rowid*8+3, NEW.thread_id, 'brief', ${brief("NEW")}
    WHERE NEW.role = 'user' AND ${origin("NEW")} = 'kickoff' AND ${text("NEW")} <> '';
  INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
    SELECT NEW.rowid*8+4, NEW.thread_id, 'user', ${text("NEW")}
    WHERE NEW.role = 'user' AND ${origin("NEW")} NOT IN ('kickoff', 'control_notice')
      AND ${text("NEW")} <> '';
  INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
    SELECT NEW.rowid*8+5, NEW.thread_id, 'assistant', ${text("NEW")}
    WHERE NEW.role = 'assistant' AND ${text("NEW")} <> ''
      AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_messages m WHERE ${laterInRun("m", "NEW")});
  DELETE FROM loom_thread_search WHERE NEW.role = 'assistant' AND ${text("NEW")} <> '' AND rowid IN (
    SELECT m.rowid*8+5 FROM orchestration_v2_projection_messages m WHERE ${laterInRun("NEW", "m")});`;

const titleRow = `
  INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
    SELECT NEW.rowid*8+1, NEW.thread_id, 'title', NEW.title WHERE NEW.deleted_at IS NULL;`;

const purposeRow = `
  INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
    SELECT NEW.rowid*8+2, NEW.thread_id, 'purpose', NEW.purpose WHERE NEW.purpose <> '';`;

const goalRow = `
  INSERT INTO loom_thread_search(rowid, goal_id, kind, text)
    SELECT NEW.rowid*8+6, NEW.goal_id, 'goal', NEW.title || char(10) || NEW.description
    WHERE NEW.deleted_at IS NULL;`;

const taskRow = `
  INSERT INTO loom_thread_search(rowid, goal_id, kind, text)
    SELECT NEW.rowid*8+7, NEW.goal_id, 'task', NEW.text WHERE NEW.deleted_at IS NULL;`;

// Upserts rewrite every column, so each UPDATE trigger is guarded on a real change.
const triggers = [
  `CREATE TRIGGER loom_ts_threads_ai AFTER INSERT ON orchestration_v2_projection_threads
   BEGIN ${titleRow} END`,
  `CREATE TRIGGER loom_ts_threads_au AFTER UPDATE OF title, deleted_at ON orchestration_v2_projection_threads
   WHEN OLD.title IS NOT NEW.title OR OLD.deleted_at IS NOT NEW.deleted_at
   BEGIN
     DELETE FROM loom_thread_search WHERE rowid = OLD.rowid*8+1;
     ${titleRow}
     DELETE FROM loom_thread_search WHERE NEW.deleted_at IS NOT NULL AND rowid IN (
       SELECT rowid*8+3 FROM orchestration_v2_projection_messages WHERE thread_id = NEW.thread_id
       UNION ALL SELECT rowid*8+4 FROM orchestration_v2_projection_messages WHERE thread_id = NEW.thread_id
       UNION ALL SELECT rowid*8+5 FROM orchestration_v2_projection_messages WHERE thread_id = NEW.thread_id
       UNION ALL SELECT rowid*8 FROM loom_thread_workstream WHERE thread_id = NEW.thread_id
       UNION ALL SELECT rowid*8+2 FROM loom_thread_workstream WHERE thread_id = NEW.thread_id);
   END`,
  `CREATE TRIGGER loom_ts_threads_ad AFTER DELETE ON orchestration_v2_projection_threads BEGIN
     DELETE FROM loom_thread_search WHERE rowid = OLD.rowid*8+1;
   END`,
  `CREATE TRIGGER loom_ts_messages_ai AFTER INSERT ON orchestration_v2_projection_messages
   WHEN NEW.streaming = 0 BEGIN ${messageRows} END`,
  `CREATE TRIGGER loom_ts_messages_au AFTER UPDATE OF payload_json, streaming ON orchestration_v2_projection_messages
   WHEN NEW.streaming = 0 AND (OLD.streaming <> 0 OR OLD.payload_json IS NOT NEW.payload_json)
   BEGIN
     DELETE FROM loom_thread_search WHERE rowid IN (OLD.rowid*8+3, OLD.rowid*8+4, OLD.rowid*8+5);
     ${messageRows}
   END`,
  `CREATE TRIGGER loom_ts_messages_ad AFTER DELETE ON orchestration_v2_projection_messages BEGIN
     DELETE FROM loom_thread_search WHERE rowid IN (OLD.rowid*8+3, OLD.rowid*8+4, OLD.rowid*8+5);
   END`,
  `CREATE TRIGGER loom_ts_workstream_ai AFTER INSERT ON loom_thread_workstream BEGIN ${purposeRow} END`,
  `CREATE TRIGGER loom_ts_workstream_au AFTER UPDATE OF purpose ON loom_thread_workstream
   WHEN OLD.purpose IS NOT NEW.purpose
   BEGIN DELETE FROM loom_thread_search WHERE rowid = OLD.rowid*8+2; ${purposeRow} END`,
  `CREATE TRIGGER loom_ts_workstream_ad AFTER DELETE ON loom_thread_workstream BEGIN
     DELETE FROM loom_thread_search WHERE rowid IN (OLD.rowid*8, OLD.rowid*8+2);
   END`,
  `CREATE TRIGGER loom_ts_goals_ai AFTER INSERT ON loom_goals BEGIN ${goalRow} END`,
  `CREATE TRIGGER loom_ts_goals_au AFTER UPDATE OF title, description, deleted_at ON loom_goals
   WHEN OLD.title IS NOT NEW.title OR OLD.description IS NOT NEW.description OR OLD.deleted_at IS NOT NEW.deleted_at
   BEGIN DELETE FROM loom_thread_search WHERE rowid = OLD.rowid*8+6; ${goalRow} END`,
  `CREATE TRIGGER loom_ts_goals_ad AFTER DELETE ON loom_goals BEGIN
     DELETE FROM loom_thread_search WHERE rowid = OLD.rowid*8+6;
   END`,
  `CREATE TRIGGER loom_ts_tasks_ai AFTER INSERT ON loom_goal_tasks BEGIN ${taskRow} END`,
  `CREATE TRIGGER loom_ts_tasks_au AFTER UPDATE OF text, deleted_at ON loom_goal_tasks
   WHEN OLD.text IS NOT NEW.text OR OLD.deleted_at IS NOT NEW.deleted_at
   BEGIN DELETE FROM loom_thread_search WHERE rowid = OLD.rowid*8+7; ${taskRow} END`,
  `CREATE TRIGGER loom_ts_tasks_ad AFTER DELETE ON loom_goal_tasks BEGIN
     DELETE FROM loom_thread_search WHERE rowid = OLD.rowid*8+7;
   END`,
];

const live = (row: string) => `NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads d
  WHERE d.thread_id = ${row}.thread_id AND d.deleted_at IS NOT NULL)`;

const backfill = [
  `INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
     SELECT rowid*8+1, thread_id, 'title', title FROM orchestration_v2_projection_threads
     WHERE deleted_at IS NULL`,
  `INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
     SELECT w.rowid*8+2, w.thread_id, 'purpose', w.purpose FROM loom_thread_workstream w
     WHERE w.purpose <> '' AND ${live("w")}`,
  `INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
     SELECT m.rowid*8 + CASE ${origin("m")} WHEN 'kickoff' THEN 3 ELSE 4 END, m.thread_id,
       CASE ${origin("m")} WHEN 'kickoff' THEN 'brief' ELSE 'user' END,
       CASE ${origin("m")} WHEN 'kickoff' THEN ${brief("m")} ELSE ${text("m")} END
     FROM orchestration_v2_projection_messages m
     WHERE m.role = 'user' AND m.streaming = 0 AND ${origin("m")} <> 'control_notice'
       AND ${text("m")} <> '' AND ${live("m")}`,
  // A run's answer is its last non-empty assistant message; with no run (V1
  // imports), the last one before the user speaks again.
  `INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
     SELECT rowid*8+5, thread_id, 'assistant', body FROM (
       SELECT m.rowid, m.thread_id, m.run_id, m.role, ${text("m")} AS body,
         LEAD(m.role) OVER (PARTITION BY m.thread_id ORDER BY m.created_at, m.message_id) AS next_role,
         ROW_NUMBER() OVER (PARTITION BY m.run_id, m.role ORDER BY m.created_at DESC, m.message_id DESC) AS run_rank
       FROM orchestration_v2_projection_messages m
       WHERE m.role IN ('user', 'assistant') AND m.streaming = 0 AND ${text("m")} <> '' AND ${live("m")})
     WHERE role = 'assistant'
       AND CASE WHEN run_id IS NULL THEN next_role IS NULL OR next_role = 'user' ELSE run_rank = 1 END`,
  `INSERT INTO loom_thread_search(rowid, goal_id, kind, text)
     SELECT rowid*8+6, goal_id, 'goal', title || char(10) || description FROM loom_goals
     WHERE deleted_at IS NULL`,
  `INSERT INTO loom_thread_search(rowid, goal_id, kind, text)
     SELECT rowid*8+7, goal_id, 'task', text FROM loom_goal_tasks WHERE deleted_at IS NULL`,
];

const runAll = (statements: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const statement of statements) yield* sql.unsafe(statement);
  });

/** Latest report per thread wins: a gate round replaces the previous row. */
export const upsertThreadSearchReport = (threadId: string, markdown: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM loom_thread_search WHERE rowid IN (
      SELECT rowid*8 FROM loom_thread_workstream WHERE thread_id = ${threadId})`;
    yield* sql`INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
      SELECT rowid*8, thread_id, 'report', ${markdown} FROM loom_thread_workstream
      WHERE thread_id = ${threadId}`;
  });

/** Reports live in files (`report_path`, absolute); missing files are skipped. */
const backfillReports = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql.unsafe<{ readonly threadId: string; readonly reportPath: string }>(`
    SELECT w.thread_id AS "threadId", w.report_path AS "reportPath" FROM loom_thread_workstream w
    WHERE w.report_path IS NOT NULL AND ${live("w")}`);
  for (const row of rows) {
    const markdown = yield* Effect.sync(() => {
      try {
        return NodeFS.readFileSync(row.reportPath, "utf8");
      } catch {
        return undefined;
      }
    });
    if (markdown !== undefined) yield* upsertThreadSearchReport(row.threadId, markdown);
  }
});

export const createThreadSearchTables = runAll(tables);
export const createThreadSearchTriggers = runAll(triggers);

/** Drops every `loom_ts_*` trigger, whichever generation of the index installed it. */
export const dropThreadSearchTriggers = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'loom_ts_%'`;
  yield* runAll(rows.map(({ name }) => `DROP TRIGGER ${name}`));
});

/**
 * Empties the lexical index and refills it from the projection and report
 * files, with the trigger family reinstalled. Embeddings are left to the sweep,
 * which re-embeds any root whose document hash changed.
 */
export const rebuildThreadSearchIndex = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const started = yield* Clock.currentTimeMillis;
  yield* dropThreadSearchTriggers;
  yield* runAll([`DELETE FROM loom_thread_search`]);
  yield* createThreadSearchTriggers;
  yield* runAll(backfill);
  yield* backfillReports;
  yield* runAll([`INSERT INTO loom_thread_search(loom_thread_search) VALUES('optimize')`]);
  const [counts] = yield* sql<{
    readonly rows: number;
  }>`SELECT count(*) AS rows FROM loom_thread_search`;
  yield* Effect.logInfo("thread-search.index.rebuilt", {
    rows: counts?.rows,
    ms: (yield* Clock.currentTimeMillis) - started,
  });
});
