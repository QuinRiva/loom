-- QA-ONLY. Plan §1 preview.sql: run on the RELOCATED V1 copy
-- (/home/Carl/.t3/qa-pull9/userdata/state.sqlite) BEFORE the first V2 boot.
-- build-home.sh runs it (step r7) and substitutes its target for the literal
-- QA home below when building elsewhere; by hand:
--   sqlite3 'file:/home/Carl/.t3/qa-pull9/userdata/state.sqlite?mode=ro' < preview.sql
.headers on
.mode list
.separator ' | '
-- GATE-BEGIN
-- Relocation complete? ALLOW-LIST: every non-null recorded path must be inside the QA home,
-- and none may climb out of it with a dot segment. Both counts 0 before boot, or STOP.
-- (A search for the cockpit prefix is the wrong test: a worktree recorded under ~/.t3/worktrees/
-- or anywhere else would pass it and become a live target.) Deleted and archived rows included.
-- Exact byte prefix (LIKE is case-insensitive and treats '_' as a wildcard).
SELECT COUNT(*) AS gate_thread_paths_outside_qa FROM (
  SELECT worktree_path AS p, '/home/Carl/.t3/qa-pull9/worktrees/' AS prefix FROM projection_threads
  UNION ALL SELECT report_path, '/home/Carl/.t3/qa-pull9/userdata/' FROM projection_threads
  UNION ALL SELECT kickoff_brief_path, '/home/Carl/.t3/qa-pull9/userdata/' FROM projection_threads)
 WHERE p IS NOT NULL AND (substr(p, 1, length(prefix)) != prefix OR length(p) = length(prefix)
   OR p GLOB '*/../*' OR p GLOB '*/./*' OR p GLOB '*/..' OR p GLOB '*/.' OR p GLOB '*//*');
SELECT COUNT(*) AS gate_project_roots_outside_qa FROM (
  SELECT workspace_root AS p, '/home/Carl/.t3/qa-pull9/repos/' AS prefix FROM projection_projects)
 WHERE p IS NULL OR substr(p, 1, length(prefix)) != prefix OR length(p) = length(prefix)
   OR p GLOB '*/../*' OR p GLOB '*/./*' OR p GLOB '*/..' OR p GLOB '*/.' OR p GLOB '*//*';
-- GATE-END
-- Free text (messages, briefs, reports) is NOT rewritten and still names production paths; the sandbox, not this check, covers that.

.print
.print == Counts-in (verify.sql A, B, H compare against these)
SELECT COUNT(*) AS in_scope_threads FROM projection_threads
 WHERE deleted_at IS NULL AND archived_at IS NULL
   AND (parent_thread_id IS NOT NULL OR goal_id IS NOT NULL OR role IS NOT NULL);
SELECT plan_lane, parent_thread_id IS NOT NULL AS is_child, COUNT(*) AS n FROM projection_threads
 WHERE deleted_at IS NULL AND archived_at IS NULL AND (parent_thread_id IS NOT NULL OR goal_id IS NOT NULL OR role IS NOT NULL)
 GROUP BY 1, 2;
SELECT (SELECT COUNT(*) FROM projection_goals) AS projection_goals, (SELECT COUNT(*) FROM projection_goal_tasks) AS projection_goal_tasks;
SELECT COUNT(*) AS threads_total, SUM(deleted_at IS NOT NULL) AS deleted, SUM(deleted_at IS NULL AND archived_at IS NOT NULL) AS archived
  FROM projection_threads;

.print
.print == The genuine holds: planned children with no turn and no user message (Carl reviews these)
SELECT t.thread_id, t.title, t.role FROM projection_threads t
 WHERE t.plan_lane = 'planned' AND t.parent_thread_id IS NOT NULL AND t.deleted_at IS NULL AND t.archived_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM projection_turns u WHERE u.thread_id = t.thread_id)
   AND NOT EXISTS (SELECT 1 FROM projection_thread_messages m WHERE m.thread_id = t.thread_id AND m.role = 'user');

.print
.print == Would-be kickoffs: ready/planned children, never started, briefed (the dispatcher will start these after import)
SELECT t.thread_id, t.title, t.plan_lane, t.blocked_by FROM projection_threads t
 WHERE t.parent_thread_id IS NOT NULL AND t.plan_lane IN ('ready','planned') AND t.kickoff_brief_path IS NOT NULL
   AND t.deleted_at IS NULL AND t.archived_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM projection_turns u WHERE u.thread_id = t.thread_id);

.print
.print == Dependencies pointing outside the live graph ('done' targets dropped; others kept + needs_guidance)
SELECT t.thread_id, d.value AS dep, x.plan_lane AS dep_lane, x.archived_at IS NOT NULL AS dep_archived, x.deleted_at IS NOT NULL AS dep_deleted
  FROM projection_threads t, json_each(t.blocked_by) d LEFT JOIN projection_threads x ON x.thread_id = d.value
 WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
   AND (x.thread_id IS NULL OR x.deleted_at IS NOT NULL OR x.archived_at IS NOT NULL);   -- the liveness filters are in WHERE: an ON-clause filter on a LEFT JOIN does not drop rows

.print
.print == Routes whose target is outside the live graph (dropped with a warning)
SELECT t.thread_id, json_extract(r.value, '$.to') AS route_to FROM projection_threads t, json_each(t.routes) r
 WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND json_extract(r.value, '$.to') IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM projection_threads x WHERE x.thread_id = json_extract(r.value, '$.to') AND x.deleted_at IS NULL AND x.archived_at IS NULL);

.print
.print == Relocated project roots (only repos/loom exists; the rest are inert by construction)
SELECT project_id, title, workspace_root, auto_pull, deleted_at IS NOT NULL AS deleted FROM projection_projects ORDER BY deleted, title;
