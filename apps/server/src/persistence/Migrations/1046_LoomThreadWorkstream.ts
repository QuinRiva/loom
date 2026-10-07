import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Pull 9 Phase 2 §5: Loom's sidecar record, one row per Loom thread keyed by
// V2's thread id — written only by the Loom projector inside V2's commit
// transaction (`loom/projection/loomProjection.ts`). Plus DL-196's
// `attention_episodes` (the raise event id per standing reason) and DL-199's
// `unarchived_at` (bounds the unarchive cascade).
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS loom_thread_workstream (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      goal_id TEXT, anchor_task_id TEXT,
      parent_thread_id TEXT, root_thread_id TEXT NOT NULL,
      role TEXT, purpose TEXT, graph_key TEXT, kickoff_brief_path TEXT,
      held INTEGER NOT NULL DEFAULT 0, held_since TEXT,
      outcome TEXT, outcome_at TEXT, outcome_event_id TEXT,
      kickoff_at TEXT,
      attention TEXT NOT NULL DEFAULT '[]',
      attention_episodes TEXT NOT NULL DEFAULT '{}',
      blocked_by TEXT NOT NULL DEFAULT '[]', dependencies_since TEXT,
      spawn_generation TEXT, fork_from_thread_id TEXT, continues_thread_id TEXT,
      routes TEXT NOT NULL DEFAULT '[]', gate_rounds INTEGER NOT NULL DEFAULT 0, pending_rework INTEGER NOT NULL DEFAULT 0,
      last_outcome TEXT, last_route TEXT,
      report_path TEXT,
      handoff_destinations TEXT NOT NULL DEFAULT '[]', notify_send_log TEXT NOT NULL DEFAULT '[]',
      archived_at TEXT, unarchived_at TEXT, unarchived_event_id TEXT, deleted_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_loom_ws_parent ON loom_thread_workstream(parent_thread_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_loom_ws_root ON loom_thread_workstream(root_thread_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS idx_loom_ws_goal ON loom_thread_workstream(goal_id)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_loom_ws_graph_key ON loom_thread_workstream(parent_thread_id, graph_key) WHERE graph_key IS NOT NULL`;
});
