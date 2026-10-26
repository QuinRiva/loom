import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// One whole-source snapshot per (human message, review source), bounding the "since your message"
// review intervals. `git_common_dir` is kept so a sweep can delete the ref once the worktree is gone.
// Plain table, not event-sourced: losing a snapshot only merges two adjacent intervals.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE loom_review_snapshots (
      message_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_created_at TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_root TEXT NOT NULL,
      git_common_dir TEXT NOT NULL,
      ref TEXT NOT NULL,
      commit_oid TEXT,
      tree_oid TEXT,
      head_oid TEXT,
      closes_files_changed INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      PRIMARY KEY (message_id, source_id)
    )
  `;
  yield* sql`
    CREATE INDEX loom_review_snapshots_thread
    ON loom_review_snapshots (thread_id, message_created_at)
  `;
});
