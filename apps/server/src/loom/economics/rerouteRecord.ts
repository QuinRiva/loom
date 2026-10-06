/**
 * The reroute record (plan seam 12): one row per pi thread the reroute sweep
 * moved onto the fallback model, holding the selection to move it back to.
 * Migration 1050 (3c-3) creates the table with exactly {@link LOOM_THREAD_REROUTE_DDL}.
 *
 * @module loom/economics/rerouteRecord
 */
import { ModelSelection, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export const LOOM_THREAD_REROUTE_DDL = `CREATE TABLE IF NOT EXISTS loom_thread_reroute (
  thread_id TEXT PRIMARY KEY,
  intended_selection TEXT,
  rerouted_selection TEXT,
  rerouted_at TEXT,
  window_label TEXT,
  reset_at TEXT
)`;

const ThreadReroute = Schema.Struct({
  threadId: ThreadId,
  /** The selection the thread was on when its vendor ran out; restored by the move-back. */
  intendedSelection: Schema.fromJsonString(ModelSelection),
  reroutedSelection: Schema.fromJsonString(ModelSelection),
  reroutedAt: Schema.String,
  /** The tripped window ("5-hour", "weekly") when the registry knew it. */
  windowLabel: Schema.NullOr(Schema.String),
  resetAt: Schema.NullOr(Schema.String),
});
export type ThreadReroute = typeof ThreadReroute.Type;

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ThreadReroute));
const encodeRow = Schema.encodeEffect(ThreadReroute);

export const listReroutes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* decodeRows(
    yield* sql`
      SELECT thread_id AS "threadId", intended_selection AS "intendedSelection",
        rerouted_selection AS "reroutedSelection", rerouted_at AS "reroutedAt",
        window_label AS "windowLabel", reset_at AS "resetAt"
      FROM loom_thread_reroute`,
  );
});

/** Keeps the first record: a thread rerouted twice still moves back to what it started on. */
export const insertReroute = (reroute: ThreadReroute) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const row = yield* encodeRow(reroute);
    yield* sql`
      INSERT INTO loom_thread_reroute
        (thread_id, intended_selection, rerouted_selection, rerouted_at, window_label, reset_at)
      VALUES (${row.threadId}, ${row.intendedSelection}, ${row.reroutedSelection},
        ${row.reroutedAt}, ${row.windowLabel}, ${row.resetAt})
      ON CONFLICT (thread_id) DO NOTHING`;
  });

export const deleteReroute = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DELETE FROM loom_thread_reroute WHERE thread_id = ${threadId}`;
  });
