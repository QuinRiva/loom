-- QA-ONLY. Plan §1 verify.sql: post-import assertions against
-- /home/Carl/.t3/qa-pull9/userdata/statev2.sqlite with the QA server stopped (stop.sh) or read-only:
--   sqlite3 'file:/home/Carl/.t3/qa-pull9/userdata/statev2.sqlite?mode=ro' < verify.sql
-- Every row must come back 0 unless stated. Counts-in are in /home/Carl/.t3/qa-pull9/qa/preview.txt.
-- Column names checked against: V1 projection_* (live schema), loom_thread_workstream (1046),
-- loom_goals/loom_goal_tasks (1047), orchestration_v2_* (055 + OrchestrationV2/Foundation, which adds
-- provider_threads.driver and threads.provider_instance_id), loom_legacy_imports (migration 1051, DL-512).
.headers on
.mode list
.separator ' | '

.print == A. Counts in = counts out (equal)
SELECT COUNT(*) AS v1_in_scope FROM projection_threads
 WHERE deleted_at IS NULL AND archived_at IS NULL
   AND (parent_thread_id IS NOT NULL OR goal_id IS NOT NULL OR role IS NOT NULL);
SELECT COUNT(*) AS sidecar_rows FROM loom_thread_workstream;

.print == B. Per-lane equalities (each pair equal)
SELECT COUNT(*) AS v1_done FROM projection_threads t JOIN loom_thread_workstream w USING (thread_id) WHERE t.plan_lane = 'done';
SELECT COUNT(*) AS outcome_done FROM loom_thread_workstream WHERE outcome = 'done';
SELECT COUNT(*) AS v1_cancelled FROM projection_threads t JOIN loom_thread_workstream w USING (thread_id) WHERE t.plan_lane = 'cancelled';
SELECT COUNT(*) AS outcome_cancelled FROM loom_thread_workstream WHERE outcome = 'cancelled';
SELECT COUNT(*) AS v1_yielded FROM projection_threads t JOIN loom_thread_workstream w USING (thread_id) WHERE t.plan_lane = 'yielded';
SELECT COUNT(*) AS awaiting_orchestrator FROM loom_thread_workstream WHERE EXISTS (SELECT 1 FROM json_each(attention) WHERE value = 'awaiting_orchestrator');
SELECT COUNT(*) AS v1_expected_holds FROM projection_threads t JOIN loom_thread_workstream w USING (thread_id)
 WHERE t.parent_thread_id IS NOT NULL AND w.kickoff_at IS NULL AND w.outcome IS NULL
   AND (t.plan_lane = 'planned'
     OR EXISTS (SELECT 1 FROM json_each(w.blocked_by) d                   -- DL-511: a kept unsatisfiable dependency also holds
                 WHERE NOT EXISTS (SELECT 1 FROM loom_thread_workstream x WHERE x.thread_id = d.value)));
SELECT COUNT(*) AS held FROM loom_thread_workstream WHERE held = 1;   -- equals the row above

.print == C. Invariants (all 0)
SELECT COUNT(*) AS terminal_with_hold_or_attention FROM loom_thread_workstream WHERE outcome IS NOT NULL AND (held = 1 OR attention != '[]');
SELECT COUNT(*) AS episode_stamps_set FROM loom_thread_workstream
 WHERE outcome_event_id IS NOT NULL OR unarchived_event_id IS NOT NULL OR last_route IS NOT NULL
    OR json_extract(last_outcome, '$.eventId') IS NOT NULL;
SELECT COUNT(*) AS started_without_kickoff FROM loom_thread_workstream w
 WHERE kickoff_at IS NULL AND EXISTS (SELECT 1 FROM projection_turns u WHERE u.thread_id = w.thread_id);
SELECT COUNT(*) AS unflagged_wedges FROM loom_thread_workstream w, json_each(w.blocked_by) d
 WHERE NOT EXISTS (SELECT 1 FROM loom_thread_workstream x WHERE x.thread_id = d.value)
   AND NOT EXISTS (SELECT 1 FROM json_each(w.attention) a WHERE a.value = 'needs_guidance');
SELECT COUNT(*) AS dangling_routes FROM loom_thread_workstream w, json_each(w.routes) r
 WHERE json_extract(r.value, '$.to') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM loom_thread_workstream x WHERE x.thread_id = json_extract(r.value, '$.to'));

.print == D. Kickoff candidates after import (0, or exactly preview.txt's would-be kickoffs)
SELECT thread_id, role, parent_thread_id FROM loom_thread_workstream
 WHERE parent_thread_id IS NOT NULL AND held = 0 AND outcome IS NULL AND kickoff_at IS NULL AND kickoff_brief_path IS NOT NULL;

.print == E. Lineage (0 mismatches each)
SELECT COUNT(*) AS sidecar_child_lineage_mismatch FROM loom_thread_workstream w JOIN orchestration_v2_projection_threads p USING (thread_id)
 WHERE w.parent_thread_id IS NOT NULL
   AND (json_extract(p.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
     OR json_extract(p.payload_json, '$.lineage.parentThreadId') IS NOT w.parent_thread_id);
SELECT COUNT(*) AS any_child_without_subagent_lineage FROM projection_threads t JOIN orchestration_v2_projection_threads p USING (thread_id)
 WHERE t.deleted_at IS NULL AND t.parent_thread_id IS NOT NULL
   AND json_extract(p.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent';

.print == F. Binding (0 mismatches; then the status list; then 0 non-pi bound threads)
SELECT COUNT(*) AS bound_without_strong_pi_ref FROM loom_legacy_imports l JOIN orchestration_v2_projection_threads p USING (thread_id)
 WHERE l.session_status = 'bound' AND (
   COALESCE(p.active_provider_thread_id, json_extract(p.payload_json, '$.activeProviderThreadId')) IS NULL
   OR NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_threads pt
                   WHERE pt.thread_id = l.thread_id AND pt.driver = 'pi'
                     AND json_extract(pt.payload_json, '$.nativeThreadRef.strength') = 'strong'
                     AND json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') = l.session_path));
SELECT session_status, COUNT(*) AS n FROM loom_legacy_imports GROUP BY session_status;   -- 'missing' and 'corrupt': a short, explained list
SELECT COUNT(*) AS bound_not_pi_instance FROM loom_legacy_imports l JOIN orchestration_v2_projection_threads p USING (thread_id)
 WHERE l.session_status = 'bound' AND p.provider_instance_id IS NOT 'pi';

.print == G. Ledger covers every imported V1 row (0 pending)
SELECT COUNT(*) AS pending FROM orchestration_v2_legacy_imports li LEFT JOIN loom_legacy_imports l USING (thread_id) WHERE l.thread_id IS NULL;

.print == H. Ledgers and goals (loom_migration_max = 1051, DL-512; goal/task counts equal preview.txt's counts-in; then a short review list)
SELECT MAX(migration_id) AS loom_migration_max FROM loom_sql_migrations;
SELECT (SELECT COUNT(*) FROM loom_goals) AS loom_goals, (SELECT COUNT(*) FROM loom_goal_tasks) AS loom_goal_tasks;
SELECT g.goal_id, g.title FROM loom_goals g WHERE g.archived_at IS NULL AND g.deleted_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM loom_thread_workstream w WHERE w.goal_id = g.goal_id);

.print == I. First pass wrote no control message to an imported thread that had a transcript (0; after a minute of uptime)
SELECT COUNT(*) AS control_messages_after_import FROM orchestration_v2_projection_messages m
 JOIN loom_legacy_imports l USING (thread_id)
 LEFT JOIN loom_thread_workstream w USING (thread_id)
 WHERE json_extract(m.payload_json, '$.loom.origin') IS NOT NULL
   AND m.created_at > l.imported_at
   AND NOT (w.kickoff_at IS NOT NULL AND w.kickoff_at >= l.imported_at);

.print == J. QA only: every bound session path is inside the QA world (0)
SELECT COUNT(*) AS bound_outside_qa FROM loom_legacy_imports
 WHERE session_status = 'bound'
   AND (substr(session_path, 1, length('/home/Carl/.t3/qa-pull9/pi-sessions/')) != '/home/Carl/.t3/qa-pull9/pi-sessions/'
     OR session_path GLOB '*/../*');
