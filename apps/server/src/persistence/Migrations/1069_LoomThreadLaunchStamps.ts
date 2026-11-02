import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Launch provenance (plans/loom-evals §2.2): the commit and instruction-file hashes that composed a
// thread's prompt, one row per first composed launch, written by the session composer. A plain
// ledger like `loom_usage_ledger`, not event-sourced. Starts empty: no backfill.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE loom_thread_launch_stamps (
      thread_id TEXT PRIMARY KEY,
      launched_at TEXT NOT NULL,
      loom_commit TEXT NOT NULL,
      role TEXT,
      role_sha TEXT,
      project_role_sha TEXT,
      skills_sha TEXT,
      agents_global_sha TEXT,
      agents_project_sha TEXT,
      prompt_sha TEXT NOT NULL,
      skill_paths TEXT
    )
  `;
  yield* sql`
    CREATE INDEX idx_loom_launch_stamps_commit ON loom_thread_launch_stamps(loom_commit, launched_at)
  `;
});
