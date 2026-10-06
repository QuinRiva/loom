// @effect-diagnostics nodeBuiltinImport:off - migrations run with SqlClient only; report files are read synchronously.
/**
 * The thread-search index (plans/thread-content-search): DDL, triggers and
 * backfill for `loom_thread_search` (FTS5, one row per text unit) and
 * `loom_thread_embeddings` (one vector per root thread).
 *
 * Row identity is derived from the source row: `rowid = source.rowid * 8 + kind`,
 * so triggers delete and replace by primary key instead of scanning.
 *
 * Two hazards for future migrations:
 * - A migration that REBUILDS a source table (copy + rename) renumbers its
 *   rowids. It must re-run `rebuildThreadSearchIndex` afterwards.
 * - `ALTER TABLE … DROP COLUMN` fails on a column a trigger references. Bracket
 *   it with `dropThreadSearchTriggers` / `createThreadSearchTriggers`.
 *
 * @module threadSearchIndex
 */
import * as NodeFS from "node:fs";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** rowid = source rowid * 8 + code. Reports share the thread's rowid. */
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
  // The message triggers and the backfill ask "is this some turn's final answer?".
  `CREATE INDEX IF NOT EXISTS idx_projection_turns_assistant_message_id
    ON projection_turns(assistant_message_id)`,
];

const threadRows = `
  INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
    SELECT NEW.rowid*8+1, NEW.thread_id, 'title', NEW.title WHERE NEW.deleted_at IS NULL;
  INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
    SELECT NEW.rowid*8+2, NEW.thread_id, 'purpose', NEW.purpose WHERE NEW.deleted_at IS NULL AND NEW.purpose <> '';
  INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
    SELECT NEW.rowid*8+3, NEW.thread_id, 'brief', NEW.brief WHERE NEW.deleted_at IS NULL AND NEW.brief <> '';`;

// Streaming deltas UPDATE text with is_streaming = 1 and are never indexed.
const messageRows = `
  INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
    SELECT NEW.rowid*8+4, NEW.thread_id, 'user', NEW.text
    WHERE NEW.role = 'user' AND (NEW.origin IS NULL OR NEW.origin NOT IN ('kickoff', 'control_notice'));
  INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
    SELECT NEW.rowid*8+5, NEW.thread_id, 'assistant', NEW.text
    WHERE NEW.role = 'assistant'
      AND EXISTS (SELECT 1 FROM projection_turns WHERE assistant_message_id = NEW.message_id);`;

// A turn's final message may be recorded before or after the message
// finalises, so both sides index it; the derived rowid makes it idempotent.
const turnRows = `
  DELETE FROM loom_thread_search WHERE rowid IN (
    SELECT rowid*8+5 FROM projection_thread_messages WHERE message_id = NEW.assistant_message_id);
  INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
    SELECT rowid*8+5, thread_id, 'assistant', text FROM projection_thread_messages
    WHERE message_id = NEW.assistant_message_id AND role = 'assistant' AND is_streaming = 0;`;

const goalRows = `
  INSERT INTO loom_thread_search(rowid, goal_id, kind, text)
    SELECT NEW.rowid*8+6, NEW.goal_id, 'goal', NEW.title || char(10) || NEW.description
    WHERE NEW.deleted_at IS NULL;`;

const taskRows = `
  INSERT INTO loom_thread_search(rowid, goal_id, kind, text)
    SELECT NEW.rowid*8+7, NEW.goal_id, 'task', NEW.text WHERE NEW.deleted_at IS NULL;`;

// Upserts rewrite every column, so each UPDATE trigger is guarded on a real change.
const triggers = [
  `CREATE TRIGGER loom_ts_threads_ai AFTER INSERT ON projection_threads BEGIN ${threadRows} END`,
  `CREATE TRIGGER loom_ts_threads_au AFTER UPDATE OF title, purpose, brief, deleted_at ON projection_threads
   WHEN OLD.title IS NOT NEW.title OR OLD.purpose IS NOT NEW.purpose
     OR OLD.brief IS NOT NEW.brief OR OLD.deleted_at IS NOT NEW.deleted_at
   BEGIN
     DELETE FROM loom_thread_search WHERE rowid IN (OLD.rowid*8+1, OLD.rowid*8+2, OLD.rowid*8+3,
       CASE WHEN NEW.deleted_at IS NOT NULL THEN OLD.rowid*8 END);
     ${threadRows}
   END`,
  `CREATE TRIGGER loom_ts_threads_ad AFTER DELETE ON projection_threads BEGIN
     DELETE FROM loom_thread_search WHERE rowid IN (OLD.rowid*8, OLD.rowid*8+1, OLD.rowid*8+2, OLD.rowid*8+3);
   END`,
  `CREATE TRIGGER loom_ts_messages_ai AFTER INSERT ON projection_thread_messages
   WHEN NEW.is_streaming = 0 BEGIN ${messageRows} END`,
  `CREATE TRIGGER loom_ts_messages_au AFTER UPDATE OF text, is_streaming, origin, role ON projection_thread_messages
   WHEN NEW.is_streaming = 0 AND (OLD.text IS NOT NEW.text OR OLD.is_streaming IS NOT NEW.is_streaming
     OR OLD.origin IS NOT NEW.origin OR OLD.role IS NOT NEW.role)
   BEGIN
     DELETE FROM loom_thread_search WHERE rowid IN (NEW.rowid*8+4, NEW.rowid*8+5);
     ${messageRows}
   END`,
  `CREATE TRIGGER loom_ts_messages_ad AFTER DELETE ON projection_thread_messages BEGIN
     DELETE FROM loom_thread_search WHERE rowid IN (OLD.rowid*8+4, OLD.rowid*8+5);
   END`,
  `CREATE TRIGGER loom_ts_turns_ai AFTER INSERT ON projection_turns
   WHEN NEW.assistant_message_id IS NOT NULL BEGIN ${turnRows} END`,
  `CREATE TRIGGER loom_ts_turns_au AFTER UPDATE OF assistant_message_id ON projection_turns
   WHEN OLD.assistant_message_id IS NOT NEW.assistant_message_id
   BEGIN
     DELETE FROM loom_thread_search WHERE rowid IN (
       SELECT rowid*8+5 FROM projection_thread_messages WHERE message_id = OLD.assistant_message_id);
     ${turnRows}
   END`,
  `CREATE TRIGGER loom_ts_turns_ad AFTER DELETE ON projection_turns
   WHEN OLD.assistant_message_id IS NOT NULL BEGIN
     DELETE FROM loom_thread_search WHERE rowid IN (
       SELECT rowid*8+5 FROM projection_thread_messages WHERE message_id = OLD.assistant_message_id);
   END`,
  `CREATE TRIGGER loom_ts_goals_ai AFTER INSERT ON projection_goals BEGIN ${goalRows} END`,
  `CREATE TRIGGER loom_ts_goals_au AFTER UPDATE OF title, description, deleted_at ON projection_goals
   WHEN OLD.title IS NOT NEW.title OR OLD.description IS NOT NEW.description OR OLD.deleted_at IS NOT NEW.deleted_at
   BEGIN DELETE FROM loom_thread_search WHERE rowid = OLD.rowid*8+6; ${goalRows} END`,
  `CREATE TRIGGER loom_ts_goals_ad AFTER DELETE ON projection_goals BEGIN
     DELETE FROM loom_thread_search WHERE rowid = OLD.rowid*8+6;
   END`,
  `CREATE TRIGGER loom_ts_tasks_ai AFTER INSERT ON projection_goal_tasks BEGIN ${taskRows} END`,
  `CREATE TRIGGER loom_ts_tasks_au AFTER UPDATE OF text, deleted_at ON projection_goal_tasks
   WHEN OLD.text IS NOT NEW.text OR OLD.deleted_at IS NOT NEW.deleted_at
   BEGIN DELETE FROM loom_thread_search WHERE rowid = OLD.rowid*8+7; ${taskRows} END`,
  `CREATE TRIGGER loom_ts_tasks_ad AFTER DELETE ON projection_goal_tasks BEGIN
     DELETE FROM loom_thread_search WHERE rowid = OLD.rowid*8+7;
   END`,
];

const triggerNames = triggers.map((ddl) => /CREATE TRIGGER (\w+)/.exec(ddl)![1]!);

const backfill = [
  `INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
     SELECT rowid*8+1, thread_id, 'title', title FROM projection_threads WHERE deleted_at IS NULL`,
  `INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
     SELECT rowid*8+2, thread_id, 'purpose', purpose FROM projection_threads
     WHERE deleted_at IS NULL AND purpose <> ''`,
  `INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
     SELECT rowid*8+3, thread_id, 'brief', brief FROM projection_threads
     WHERE deleted_at IS NULL AND brief <> ''`,
  `INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
     SELECT rowid*8+4, thread_id, 'user', text FROM projection_thread_messages
     WHERE role = 'user' AND is_streaming = 0
       AND (origin IS NULL OR origin NOT IN ('kickoff', 'control_notice'))`,
  `INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
     SELECT rowid*8+5, thread_id, 'assistant', text FROM projection_thread_messages
     WHERE role = 'assistant' AND is_streaming = 0
       AND message_id IN (SELECT assistant_message_id FROM projection_turns WHERE assistant_message_id IS NOT NULL)`,
  `INSERT INTO loom_thread_search(rowid, goal_id, kind, text)
     SELECT rowid*8+6, goal_id, 'goal', title || char(10) || description FROM projection_goals
     WHERE deleted_at IS NULL`,
  `INSERT INTO loom_thread_search(rowid, goal_id, kind, text)
     SELECT rowid*8+7, goal_id, 'task', text FROM projection_goal_tasks WHERE deleted_at IS NULL`,
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
      SELECT rowid*8 FROM projection_threads WHERE thread_id = ${threadId})`;
    yield* sql`INSERT INTO loom_thread_search(rowid, thread_id, kind, text)
      SELECT rowid*8, thread_id, 'report', ${markdown} FROM projection_threads
      WHERE thread_id = ${threadId} AND deleted_at IS NULL`;
  });

/** Reports live in files (`report_path`, absolute); missing files are skipped. */
const backfillReports = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly threadId: string; readonly reportPath: string }>`
    SELECT thread_id AS "threadId", report_path AS "reportPath" FROM projection_threads
    WHERE deleted_at IS NULL AND report_path IS NOT NULL`;
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

export const createThreadSearchTriggers = runAll(triggers);
export const dropThreadSearchTriggers = runAll(
  triggerNames.map((name) => `DROP TRIGGER IF EXISTS ${name}`),
);

/** Empty and refill the lexical index from the projection (and report files). */
export const rebuildThreadSearchIndex = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const started = yield* Clock.currentTimeMillis;
  yield* runAll([`DELETE FROM loom_thread_search`, ...backfill]);
  yield* backfillReports;
  yield* runAll([`INSERT INTO loom_thread_search(loom_thread_search) VALUES('optimize')`]);
  const [counts] = yield* sql<{
    readonly rows: number;
  }>`SELECT count(*) AS rows FROM loom_thread_search`;
  yield* Effect.logInfo("thread-search.index.backfilled", {
    rows: counts?.rows,
    ms: (yield* Clock.currentTimeMillis) - started,
  });
});

export const createThreadSearchIndex = Effect.gen(function* () {
  yield* runAll(tables);
  yield* createThreadSearchTriggers;
  yield* rebuildThreadSearchIndex;
});
