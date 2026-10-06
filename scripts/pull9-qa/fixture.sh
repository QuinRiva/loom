#!/bin/bash
# QA-ONLY. Fixture-scale dry run of build-home.sh: builds a tiny V1 "production"
# (database with the six tables the relocation and preview touch — schemas copied
# from the live V1 database — plus a state dir, sessions root and git repo) under
# <src>, then
#   1. builds a QA world from it into <target> (the gate must pass), and prints preview.txt;
#   2. shows build-home refusing: an existing target, the cockpit home, ~/.t3/userdata, and a
#      source whose recorded worktree path escapes the QA home after relocation (r7 gate);
#   3. shows the r7 allow-list catching an un-relocated production path injected into a copy.
# Nothing here reads production except what build-home.sh's own defaults would, and the
# fixture overrides every source.
#   usage: fixture.sh <src-dir> <target: /home/Carl/.t3/qa-<name>>
set -euo pipefail
source "$(dirname "$0")/lib.sh"
src=$(realpath -m "$1") target=$2
[[ ! -e $src && ! -e $target ]] || qa_die "$src or $target exists"
qa_check_home_path "$target"
mkdir -p "$src"/{state/workstream-reports,state/workstream-briefs,state/workstream-launch-identity,state/secrets,state/attachments,worktrees/loom,sessions/--a--,sessions/--b--,foreign}
db=$src/state/state.sqlite
sqlite3 "$db" >/dev/null <<SQL
CREATE TABLE projection_projects (project_id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_root TEXT NOT NULL, scripts_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, default_model_selection_json TEXT, default_thread_env_mode TEXT,
  favicon_path TEXT, auto_pull INTEGER NOT NULL DEFAULT 0, project_icon_json TEXT);
CREATE UNIQUE INDEX uq_projection_projects_active_workspace_root ON projection_projects(workspace_root) WHERE deleted_at IS NULL;
CREATE TABLE projection_threads (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, branch TEXT, worktree_path TEXT,
  latest_turn_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, runtime_mode TEXT NOT NULL DEFAULT 'full-access',
  interaction_mode TEXT NOT NULL DEFAULT 'default', model_selection_json TEXT, archived_at TEXT, latest_user_message_at TEXT,
  pending_approval_count INTEGER NOT NULL DEFAULT 0, pending_user_input_count INTEGER NOT NULL DEFAULT 0, has_actionable_proposed_plan INTEGER NOT NULL DEFAULT 0,
  goal_id TEXT, parent_thread_id TEXT, role TEXT, purpose TEXT, blocked_by TEXT NOT NULL DEFAULT '[]', brief TEXT, spawn_generation TEXT, report_path TEXT,
  cumulative_cost_usd REAL NOT NULL DEFAULT 0, plan_lane TEXT NOT NULL DEFAULT 'planned', attention TEXT NOT NULL DEFAULT '[]', tool_uses INTEGER,
  used_tokens INTEGER, max_tokens INTEGER, routes TEXT NOT NULL DEFAULT '[]', gate_rounds INTEGER NOT NULL DEFAULT 0, pending_rework INTEGER NOT NULL DEFAULT 0,
  last_outcome TEXT, isolation TEXT NOT NULL DEFAULT 'shared', fan_in_state TEXT NOT NULL DEFAULT 'none', diff_additions INTEGER, diff_deletions INTEGER,
  fork_from_thread_id TEXT, graph_key TEXT, kickoff_brief_path TEXT, plan_lane_since TEXT, dependencies_since TEXT, fanin_since TEXT, settled_override TEXT,
  settled_at TEXT, snoozed_until TEXT, snoozed_at TEXT, final_commit_sha TEXT, continues_thread_id TEXT, handoff_destinations TEXT NOT NULL DEFAULT '[]',
  title_regeneration_request_id TEXT, title_regeneration_started_at TEXT, pinned_at TEXT, pin_order_key TEXT, linked_pull_request_json TEXT,
  unsettled_at TEXT, branch_pull_request_json TEXT, active_order_key TEXT, title_state_json TEXT, anchor_task_id TEXT, pending_user_input_header TEXT,
  pending_user_input_since TEXT, auto_settle_disabled_at TEXT);
CREATE TABLE projection_goals (goal_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, slug TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT, deleted_at TEXT, UNIQUE (project_id, slug));
CREATE TABLE projection_goal_tasks (task_id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, parent_task_id TEXT, position INTEGER NOT NULL, text TEXT NOT NULL,
  done INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, FOREIGN KEY (goal_id) REFERENCES projection_goals(goal_id));
CREATE TABLE projection_turns (row_id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id TEXT NOT NULL, turn_id TEXT, pending_message_id TEXT,
  assistant_message_id TEXT, state TEXT NOT NULL, requested_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, checkpoint_turn_count INTEGER,
  checkpoint_ref TEXT, checkpoint_status TEXT, checkpoint_files_json TEXT NOT NULL, source_proposed_plan_thread_id TEXT, source_proposed_plan_id TEXT,
  UNIQUE (thread_id, turn_id), UNIQUE (thread_id, checkpoint_turn_count));
CREATE TABLE projection_thread_messages (message_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, turn_id TEXT, role TEXT NOT NULL, text TEXT NOT NULL,
  is_streaming INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, attachments_json TEXT, origin TEXT, control_payload_json TEXT, context_json TEXT);
PRAGMA journal_mode = WAL;

INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at, auto_pull) VALUES
  ('p-loom', 'loom', '$src/repo', '[]', 't', 't', NULL, 0),
  ('p-fathom', 'fathom', '/home/Carl/.t3/project-roots/fathom-platform/x', '[]', 't', 't', NULL, 1),
  ('p-gone', 'gone', '$src/repo', '[]', 't', 't', 't', 0);
INSERT INTO projection_goals VALUES ('g1', 'p-loom', 'g1', 'Fixture goal', 'd', 't', 't', NULL, NULL);
INSERT INTO projection_goal_tasks VALUES ('k1', 'g1', NULL, 0, 'task one', 1, 't', 't', NULL), ('k2', 'g1', 'k1', 0, 'task two', 0, 't', 't', NULL);
-- t-root: orchestrator, worktree under the cockpit worktrees dir, report + brief under the state dir
-- t-child: worktree under ~/.t3/worktrees (outside → NULL), foreign report (exists → copied), foreign brief (absent)
-- t-deleted / t-archived / t-planned (genuine hold + would-be kickoff) / t-blocked (dangling dep + route) / t-chat
INSERT INTO projection_threads (thread_id, project_id, title, branch, worktree_path, created_at, updated_at, deleted_at, archived_at,
  goal_id, parent_thread_id, role, plan_lane, report_path, kickoff_brief_path, blocked_by, routes) VALUES
  ('11111111-1111-4111-8111-111111111111', 'p-loom', 'root', 'main', '$src/worktrees/loom/t3code-aaaa', '2026-01-01', 't', NULL, NULL,
    'g1', NULL, 'orchestrator', 'planned', '$src/state/workstream-reports/11111111-1111-4111-8111-111111111111.md', '$src/state/workstream-briefs/root.md', '[]', '[]'),
  ('22222222-2222-4222-8222-222222222222', 'p-loom', 'child', 't3/child', '/home/Carl/.t3/worktrees/loom/t3code-bbbb', '2026-01-02', 't', NULL, NULL,
    'g1', '11111111-1111-4111-8111-111111111111', 'coder', 'done', '$src/foreign/child-report.md', '/nonexistent/old-home/brief.md', '[]', '[]'),
  ('33333333-3333-4333-8333-333333333333', 'p-loom', 'deleted', NULL, '$src/worktrees/loom/t3code-cccc', '2026-01-03', 't', 't', NULL,
    NULL, '11111111-1111-4111-8111-111111111111', 'coder', 'in_progress', NULL, NULL, '[]', '[]'),
  ('44444444-4444-4444-8444-444444444444', 'p-loom', 'archived', NULL, NULL, '2026-01-04', 't', NULL, 't',
    'g1', '11111111-1111-4111-8111-111111111111', 'reviewer', 'in_progress', NULL, NULL, '[]', '[]'),
  ('55555555-5555-4555-8555-555555555555', 'p-loom', 'planned', NULL, NULL, '2026-01-05', 't', NULL, NULL,
    'g1', '11111111-1111-4111-8111-111111111111', 'coder', 'planned', NULL, '$src/state/workstream-briefs/55555555-5555-4555-8555-555555555555.md', '[]', '[]'),
  ('66666666-6666-4666-8666-666666666666', 'p-loom', 'blocked', NULL, NULL, '2026-01-06', 't', NULL, NULL,
    'g1', '11111111-1111-4111-8111-111111111111', 'coder', 'ready', NULL, NULL,
    '["44444444-4444-4444-8444-444444444444","99999999-9999-4999-8999-999999999999"]', '[{"to":"33333333-3333-4333-8333-333333333333","on":"done"}]'),
  ('77777777-7777-4777-8777-777777777777', 'p-fathom', 'chat', NULL, NULL, '2026-01-07', 't', NULL, NULL, NULL, NULL, NULL, 'planned', NULL, NULL, '[]', '[]');
INSERT INTO projection_turns (thread_id, turn_id, state, requested_at, checkpoint_files_json) VALUES
  ('11111111-1111-4111-8111-111111111111', 'u1', 'completed', '2026-01-01T00:00:01Z', '[]'),
  ('22222222-2222-4222-8222-222222222222', 'u2', 'completed', '2026-01-02T00:00:01Z', '[]');
INSERT INTO projection_thread_messages VALUES ('m1', '11111111-1111-4111-8111-111111111111', 'u1', 'user', 'hello', 0, 't', 't', NULL, NULL, NULL, NULL);
SQL
echo '# root report' >"$src/state/workstream-reports/11111111-1111-4111-8111-111111111111.md"
echo '# root brief' >"$src/state/workstream-briefs/root.md"
echo '# planned brief' >"$src/state/workstream-briefs/55555555-5555-4555-8555-555555555555.md"
echo '{}' >"$src/state/workstream-launch-identity/11111111-1111-4111-8111-111111111111.json"
echo '# child report written under an old home' >"$src/foreign/child-report.md"
echo usage-source >"$src/state/secrets/usage-limit-source-Zml4dHVyZQ.bin"
echo NEVER-COPY >"$src/state/secrets/server-signing-key.bin"
echo NEVER-COPY >"$src/state/attachments/image.png"
cat >"$src/state/settings.json" <<'JSON'
{"projectAutoPullOverrides": {"p-fathom": true}, "projectSettingsFolded": true,
 "projectSettingsOverrides": {"p-fathom": {"defaultAutoPull": true, "defaultProjectScripts": []}},
 "providerInstances": {"pi": {"driver": "pi", "enabled": true, "config": {"binaryPath": "pi", "customModels": []}}}}
JSON
session() { # $1 slug dir, $2 thread id, $3 timestamp, [$4 = truncated]
  local f=$src/sessions/$1/$3_$2.jsonl
  printf '{"type":"session","version":3,"id":"%s","timestamp":"t","cwd":"/x"}\n{"type":"message","id":"a"}\n' "$2" >"$f"
  [[ ${4:-} == truncated ]] && printf '{"type":"message","id":"b","text":"mid-wri' >>"$f"
  return 0
}
session --a-- 11111111-1111-4111-8111-111111111111 2026-01-01T00-00-00-000Z
session --a-- 22222222-2222-4222-8222-222222222222 2026-01-02T00-00-00-000Z truncated
session --b-- 44444444-4444-4444-8444-444444444444 2026-01-04T00-00-00-000Z
session --b-- 33333333-3333-4333-8333-333333333333 2026-01-03T00-00-00-000Z
session --b-- aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa 2026-01-09T00-00-00-000Z
git init -q -b main "$src/repo"
git -C "$src/repo" -c user.name=f -c user.email=f@invalid commit -q --allow-empty -m one
git -C "$src/repo" branch t3/child
sources=(--source-db "$db" --source-state-dir "$src/state" --source-worktrees "$src/worktrees" --source-sessions "$src/sessions" --source-repo "$src/repo")

echo "===== 1. build-home.sh into $target (expect: gate passes)"
"$QA_TOOLKIT/build-home.sh" "${sources[@]}" --target "$target"
echo "----- $target/qa/preview.txt"; cat "$target/qa/preview.txt"
echo "----- not copied: $(ls "$target/userdata/secrets"; ls "$target/userdata" | grep -c attachments) (attachments dirs: 0 expected)"

echo; echo "===== 2. refusals"
for t in "$target" /home/Carl/.t3/cockpit /home/Carl/.t3/cockpit/qa-x /home/Carl/.t3/userdata; do
  "$QA_TOOLKIT/build-home.sh" "${sources[@]}" --target "$t" 2>&1 | tail -1 || true
done
escape=$target-escape
sqlite3 "$db" "UPDATE projection_threads SET worktree_path = '$src/worktrees/../../../.t3/cockpit/worktrees/x' WHERE thread_id LIKE '1111%'"
"$QA_TOOLKIT/build-home.sh" "${sources[@]}" --target "$escape" 2>&1 | grep -E 'r7|REFUSED' || true
rm -rf -- "$escape"
sqlite3 "$db" "UPDATE projection_threads SET worktree_path = '$src/worktrees/loom/t3code-aaaa' WHERE thread_id LIKE '1111%'"

echo; echo "===== 3. the r7 allow-list on a copy with one un-relocated production path injected"
cp "$target/userdata/state.sqlite" "$src/injected.sqlite"
sqlite3 "$src/injected.sqlite" "UPDATE projection_threads SET report_path = '/home/Carl/.t3/cockpit/userdata/workstream-reports/x.md' WHERE thread_id LIKE '2222%';
  UPDATE projection_projects SET workspace_root = '/home/Carl/loom' WHERE project_id = 'p-loom'"
sed "s#/home/Carl/.t3/qa-pull9/#$target/#g" "$QA_TOOLKIT/preview.sql" | sed -n '/^-- GATE-BEGIN/,/^-- GATE-END/p' |
  sqlite3 -batch -readonly "file:$src/injected.sqlite?mode=ro" | paste -sd' ' | sed 's/^/gate on the injected copy (threads, projects): /'
