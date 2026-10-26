import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { rebuildThreadSearchIndex } from "../threadSearchIndex.loom.ts";
import { whenV1TableExists } from "../v1Projections.loom.ts";

/**
 * Re-points the search index at the V2 projection (V1-era triggers and rows dropped, V2 family
 * installed, every kind refilled). First, each V1 thread archived at cut-over without a
 * `loom_thread_workstream` row (1,419 on the cockpit) gets an inert sidecar row from V1's data,
 * so archived work is findable by purpose, goal and report; their ledger rows say so.
 */
const backfillArchivedSidecars = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO loom_thread_workstream (
      thread_id, project_id, goal_id, anchor_task_id, parent_thread_id, root_thread_id,
      role, purpose, kickoff_brief_path, report_path, outcome, outcome_at, kickoff_at,
      spawn_generation, fork_from_thread_id, continues_thread_id, gate_rounds,
      archived_at, created_at, updated_at)
    WITH RECURSIVE chain(thread_id, top_id, parent_id) AS (
      SELECT thread_id, thread_id, parent_thread_id FROM projection_threads
      UNION ALL
      SELECT c.thread_id, p.thread_id, p.parent_thread_id
      FROM chain c JOIN projection_threads p ON p.thread_id = c.parent_id
    ),
    roots AS (SELECT thread_id, top_id FROM chain WHERE parent_id IS NULL)
    SELECT v.thread_id, v.project_id, g.goal_id, k.task_id, v.parent_thread_id, r.top_id,
      NULLIF(TRIM(v.role), ''), NULLIF(TRIM(v.purpose), ''),
      NULLIF(TRIM(v.kickoff_brief_path), ''), NULLIF(TRIM(v.report_path), ''),
      CASE WHEN v.plan_lane IN ('done', 'cancelled') THEN v.plan_lane END,
      CASE WHEN v.plan_lane IN ('done', 'cancelled') THEN COALESCE(v.plan_lane_since, v.updated_at) END,
      (SELECT MIN(m.created_at) FROM orchestration_v2_projection_messages m
        WHERE m.thread_id = v.thread_id AND m.role = 'user'),
      NULLIF(TRIM(v.spawn_generation), ''), v.fork_from_thread_id, v.continues_thread_id,
      v.gate_rounds, COALESCE(t.archived_at, v.archived_at), v.created_at, v.updated_at
    FROM projection_threads v
    JOIN roots r ON r.thread_id = v.thread_id
    LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = v.thread_id
    LEFT JOIN loom_goals g ON g.goal_id = v.goal_id AND g.project_id = v.project_id
    LEFT JOIN loom_goal_tasks k ON k.task_id = v.anchor_task_id AND k.goal_id = g.goal_id
    WHERE v.archived_at IS NOT NULL AND v.deleted_at IS NULL
      AND (t.thread_id IS NULL OR (t.archived_at IS NOT NULL AND t.deleted_at IS NULL))
      AND NOT EXISTS (SELECT 1 FROM loom_thread_workstream w WHERE w.thread_id = v.thread_id)`;
  yield* sql`
    UPDATE loom_legacy_imports
    SET sidecar_written = 1,
      warnings_json = json_insert(warnings_json, '$[#]',
        'archived: sidecar row backfilled by migration 1062 for thread search')
    WHERE status IN ('archived-root', 'archived-child') AND sidecar_written = 0
      AND thread_id IN (SELECT thread_id FROM loom_thread_workstream)`;
});

export default Effect.gen(function* () {
  yield* whenV1TableExists("projection_threads", backfillArchivedSidecars);
  yield* rebuildThreadSearchIndex;
});
