#!/bin/bash
# QA-ONLY — NEVER RUN AGAINST THE COCKPIT HOME, NEVER PART OF A CUT-OVER.
# Builds the relocated QA world of plans/upstream-pull9-phase4-import/plan.mdx §2,
# steps r0–r7 (r8 is build-loom.sh, r9 is probe.sh). Production is only ever READ:
# the database through a read-only `VACUUM INTO`, everything else by copy.
# Every step logs what it did and its counts; the review report is <qa>/qa/preview.txt.
#
#   usage: build-home.sh [--source-db P] [--source-state-dir P] [--source-worktrees P]
#                        [--source-sessions P] [--source-repo P] [--target P]
#   defaults: the cockpit (~/.t3/cockpit/userdata/state.sqlite, its userdata and worktrees),
#             ~/.pi/agent/sessions, /home/Carl/loom → /home/Carl/.t3/qa-pull9
#
# Refuses: a target that exists or is not /home/Carl/.t3/qa-<name> (so never under the cockpit
# home or ~/.t3/userdata); too little free space; port 13940 busy; a copied settings.json whose
# pi launch args name a session location; any recorded path left outside the QA home (r7).
set -euo pipefail
source "$(dirname "$0")/lib.sh"
qa_strip_env
src_db=$PROD_DB src_state=$PROD_STATE src_worktrees=$PROD_WORKTREES src_sessions=$PROD_SESSIONS src_repo=$PROD_REPO qa=$QA_HOME_DEFAULT
while [[ $# -gt 0 ]]; do
  case $1 in
    --source-db) src_db=$2 ;; --source-state-dir) src_state=$2 ;; --source-worktrees) src_worktrees=$2 ;;
    --source-sessions) src_sessions=$2 ;; --source-repo) src_repo=$2 ;; --target) qa=$2 ;;
    *) qa_die "unknown argument $1" ;;
  esac
  shift 2
done

# ---- r0 preconditions -------------------------------------------------------------------
[[ $(id -u) -ne 0 ]] || qa_die "never as root"
qa_check_home_path "$qa"
[[ ! -e $qa && ! -L $qa ]] || qa_die "$qa exists — a refresh is a rebuild: stop.sh; rm -rf $qa; then build again (never re-point)"
# Paths are embedded in SQL literals and shell words: allow a conservative character set only.
for p in "$src_db" "$src_state" "$src_worktrees" "$src_sessions" "$src_repo" "$qa"; do
  [[ $p =~ ^/[A-Za-z0-9._/@+-]+$ && $p != */ ]] || qa_die "path '$p' must be absolute, without a trailing slash, in [A-Za-z0-9._/@+-]"
done
[[ -f $src_db && -d $src_state && -d $src_sessions && -d $src_repo/.git ]] || qa_die "a source is missing (db $src_db, state $src_state, sessions $src_sessions, repo $src_repo)"
for tool in sqlite3 jq python3 git rsync socat systemd-run; do command -v "$tool" >/dev/null || qa_die "$tool not found"; done
db_bytes=$(($(stat -c %s "$src_db") + $(stat -c %s "$src_db-wal" 2>/dev/null || echo 0)))
need=$((2 * db_bytes + 10 * 2 ** 30)) # snapshot + statev2 at first boot + clone/build/report margin; sessions re-checked at r5
free=$(df --output=avail -B1 /home/Carl/.t3 | tail -1)
((free > need)) || qa_die "need $((need / 2 ** 30)) GiB free under /home/Carl/.t3, have $((free / 2 ** 30)) GiB"
! qa_port_busy "$QA_PORT" || qa_die "port $QA_PORT is busy"

mkdir "$qa" # atomic: fails if a concurrent build created it
trap 'rc=$?; ((rc == 0)) || qa_log "BUILD FAILED — $qa is partial: rm -rf $qa before building again"' EXIT
mkdir -p "$qa"/{userdata/workstream-reports,userdata/workstream-briefs,userdata/workstream-launch-identity,pi-sessions,repos/not-cloned,worktrees,qa,run,cache}
copy=$qa/userdata/state.sqlite
report=$qa/qa/preview.txt
note() { qa_log "$*"; printf '%s\n' "$*" >>"$report"; }
q() { sqlite3 -batch -noheader "$copy" "$@"; }
qt() { sqlite3 -batch -noheader -separator $'\t' "$copy" "$@"; }
note "# QA world build $(date -u +%FT%TZ) by scripts/pull9-qa/build-home.sh @ $(git -C "$QA_TOOLKIT" rev-parse --short HEAD)"
note "sources: db=$src_db state=$src_state worktrees=$src_worktrees sessions=$src_sessions repo=$src_repo → target $qa"
note "r0 preconditions ok: target absent and allow-listed; $((free / 2 ** 30)) GiB free (need $((need / 2 ** 30))); port $QA_PORT free"

# ---- r1 snapshot: the source is opened READ-ONLY, once -------------------------------------
# eta: ~5 min for the 6 GB cockpit database
sqlite3 -readonly "file:$src_db?mode=ro" "VACUUM INTO '$copy'"
note "r1 snapshot: VACUUM INTO $copy ($(($(stat -c %s "$copy") / 2 ** 20)) MiB; source opened read-only)"
[[ $(q "PRAGMA quick_check") == ok ]] || qa_die "quick_check failed on the snapshot"

# ---- r2 counts-in (on the snapshot: the same point in time the import will see) ------------
note "r2 counts-in: goals $(q 'SELECT COUNT(*) FROM projection_goals'), goal tasks $(q 'SELECT COUNT(*) FROM projection_goal_tasks'), threads $(q 'SELECT COUNT(*) FROM projection_threads') (in scope: $(q "SELECT COUNT(*) FROM projection_threads WHERE deleted_at IS NULL AND archived_at IS NULL AND (parent_thread_id IS NOT NULL OR goal_id IS NOT NULL OR role IS NOT NULL)")); per-lane counts in the preview section below"

# ---- r4 file copies (before r3: foreign report/brief files land beside these) --------------
for d in workstream-reports workstream-briefs workstream-launch-identity; do
  [[ -d $src_state/$d ]] && rsync -a "$src_state/$d/" "$qa/userdata/$d/" # eta: ~1 min (≈115 MB)
  note "r4 copied $d: $(find "$qa/userdata/$d" -type f | wc -l) files"
done
note "r4 copied NO secrets (the usage-limit source credential is cliproxy's management key — DL-547) and NO attachments"

# ---- r3 relocation, in one transaction on the copy -----------------------------------------
before=$(q "SELECT COUNT(*) FROM projection_threads WHERE worktree_path IS NOT NULL")
autopull_before=$(q "SELECT COUNT(*) FROM projection_projects WHERE auto_pull != 0")
q <<SQL
BEGIN;
UPDATE projection_projects
   SET workspace_root = CASE WHEN workspace_root = '$src_repo' THEN '$qa/repos/loom'
                             ELSE '$qa/repos/not-cloned/' || project_id END,
       auto_pull = 0;
UPDATE projection_threads
   SET worktree_path = CASE WHEN substr(worktree_path, 1, length('$src_worktrees/')) = '$src_worktrees/'
                            THEN '$qa/worktrees/' || substr(worktree_path, length('$src_worktrees/') + 1) END
 WHERE worktree_path IS NOT NULL;
UPDATE projection_threads
   SET report_path = '$qa/userdata/' || substr(report_path, length('$src_state/') + 1)
 WHERE substr(report_path, 1, length('$src_state/')) = '$src_state/';
UPDATE projection_threads
   SET kickoff_brief_path = '$qa/userdata/' || substr(kickoff_brief_path, length('$src_state/') + 1)
 WHERE substr(kickoff_brief_path, 1, length('$src_state/')) = '$src_state/';
COMMIT;
SQL
note "r3 projects: $(q "SELECT COUNT(*) FROM projection_projects WHERE workspace_root = '$qa/repos/loom'") → repos/loom (the only clone), $(q "SELECT COUNT(*) FROM projection_projects WHERE workspace_root != '$qa/repos/loom'") → repos/not-cloned/<project_id> (does not exist: browsable, inert)"
note "r3 worktrees: $before recorded; $(q "SELECT COUNT(*) FROM projection_threads WHERE worktree_path IS NOT NULL") rebased under $qa/worktrees/, $((before - $(q "SELECT COUNT(*) FROM projection_threads WHERE worktree_path IS NOT NULL"))) outside $src_worktrees/ → NULL"

# Report/brief paths outside the source state dir (recorded fact 2): rewritten to
# <qa>/userdata/workstream-reports|briefs/<basename>, the file copied when it exists — never NULLed.
# A bare relative name (V1 stored some as '<threadId>.md') names the file in the source
# reports/briefs dir, already copied by r4: the row points at that copy.
foreign_sql=$qa/qa/foreign-paths.sql
echo BEGIN\; >"$foreign_sql"
copied=0 absent=0 relative=0 rows=0
while IFS=$'\t' read -r col tid path; do
  dir=$([[ $col == report_path ]] && echo workstream-reports || echo workstream-briefs)
  base=$(basename -- "$path")
  [[ $base =~ ^[A-Za-z0-9._@+-]+$ && $base != . && $base != .. ]] || base=$tid.md
  if [[ $path != /* && $path == "$base" && -f $src_state/$dir/$path ]]; then
    # V1 also stored bare names relative to its reports/briefs dir: that file is already copied (r4).
    dest=$qa/userdata/$dir/$path
    relative=$((relative + 1))
  else
    dest=$qa/userdata/$dir/$base
    [[ -e $dest ]] && dest=$qa/userdata/$dir/$tid-$base
    if [[ $path == /* && -f $path ]]; then cp -p -- "$path" "$dest" && copied=$((copied + 1)); else absent=$((absent + 1)); fi
  fi
  [[ $tid =~ ^[A-Za-z0-9._:-]+$ ]] || qa_die "unexpected thread id '$tid'"
  echo "UPDATE projection_threads SET $col = '$dest' WHERE thread_id = '$tid';" >>"$foreign_sql"
  printf '  %s %s: %s → %s\n' "$tid" "$col" "$path" "$dest" >>"$report"
  rows=$((rows + 1))
done < <(qt "
  SELECT 'report_path', thread_id, report_path FROM projection_threads
   WHERE report_path IS NOT NULL AND substr(report_path, 1, length('$qa/userdata/')) != '$qa/userdata/'
  UNION ALL
  SELECT 'kickoff_brief_path', thread_id, kickoff_brief_path FROM projection_threads
   WHERE kickoff_brief_path IS NOT NULL AND substr(kickoff_brief_path, 1, length('$qa/userdata/')) != '$qa/userdata/'")
echo COMMIT\; >>"$foreign_sql"
q <"$foreign_sql"
note "r3 report/brief paths outside $src_state/: $rows rewritten into the QA state dir ($relative bare names resolved to the copied $src_state/<reports|briefs>/ file, $copied files copied, $absent absent — kept as the record; listed above)"

# ---- DL-265: neutralise auto-pull so no boot-time git pull can run ---------------------------
# V1 stores it per project in projection_projects.auto_pull (zeroed above) and in settings.json:
# defaultAutoPull, projectAutoPullOverrides and projectSettingsOverrides[<id>].defaultAutoPull
# (the server folds the column into the last one once; projectSettingsFolded marks that).
settings_src=$src_state/settings.json
project_ids=$(q "SELECT json_group_array(project_id) FROM projection_projects")
if [[ -f $settings_src ]]; then
  launch=$(jq -c '[.providerInstances[]?.config.launchArgs? // empty] | flatten | map(select(test("^--(session|session-dir|fork|resume|continue)")))' "$settings_src")
  [[ $launch == "[]" ]] || qa_die "copied settings.json pi launchArgs name a session location ($launch): it would override PI_CODING_AGENT_SESSION_DIR"
  note "DL-265 before: auto_pull column had $autopull_before project(s) on; settings $(jq -c '{defaultAutoPull, projectAutoPullOverrides, folded: .projectSettingsFolded, overridesWithAutoPull: ([.projectSettingsOverrides // {} | to_entries[] | select(.value.defaultAutoPull == true) | .key])}' "$settings_src")"
  jq --argjson ids "$project_ids" '
    .defaultAutoPull = false
    | .projectAutoPullOverrides = ((.projectAutoPullOverrides // {}) | map_values(false))
    | .projectSettingsOverrides = (reduce $ids[] as $id ((.projectSettingsOverrides // {}); .[$id] = ((.[$id] // {}) + {defaultAutoPull: false})))
  ' "$settings_src" >"$qa/userdata/settings.json"
  note "DL-265 after: auto_pull column on for $(q 'SELECT COUNT(*) FROM projection_projects WHERE auto_pull != 0') project(s); settings defaultAutoPull=$(jq .defaultAutoPull "$qa/userdata/settings.json"), projectAutoPullOverrides all false ($(jq '.projectAutoPullOverrides | length' "$qa/userdata/settings.json")), projectSettingsOverrides[*].defaultAutoPull=false for all $(jq 'length' <<<"$project_ids") projects; pi binaryPath $(jq -c '[.providerInstances[]? | select(.driver == "pi") | .config.binaryPath]' "$qa/userdata/settings.json")"
else
  note "DL-265: no settings.json at the source; auto_pull column zeroed ($(q 'SELECT COUNT(*) FROM projection_projects') projects)"
fi

# ---- r5 sessions: manifest + flat byte copy + last-line check -------------------------------
# eta: 5–15 min depending on the manifest's size
python3 "$QA_TOOLKIT/sessions.py" "$copy" "$src_sessions" "$qa/pi-sessions" "$qa/qa" | tee -a "$report" >&2
note "r5 manifest $qa/qa/session-manifest.txt; threads without a session file: $qa/qa/sessions-missing.txt"

# ---- pi agent dir (recorded fact 4) ---------------------------------------------------------
"$QA_TOOLKIT/build-pi-agent.sh" "$qa/pi-agent" 2>&1 | tee -a "$report" >&2

# ---- r6 clone loom only; origin re-pointed at GitHub -----------------------------------------
# eta: ~2 min. --no-local: a fresh pack, no hard links into production's object store.
git clone --quiet --no-local "$src_repo" "$qa/repos/loom"
git -C "$qa/repos/loom" remote set-url origin "$QA_GITHUB_ORIGIN"
note "r6 cloned $src_repo → $qa/repos/loom ($(git -C "$qa/repos/loom" for-each-ref refs/remotes/origin | wc -l) remote branches, $(du -sh "$qa/repos/loom/.git" | cut -f1)); origin → $QA_GITHUB_ORIGIN (writes are stopped by the unit's sandbox, not by the remote)"

# ---- r7 pre-boot gate --------------------------------------------------------------------------
[[ ! -e $qa/userdata/statev2.sqlite ]] || qa_die "statev2.sqlite already exists in $qa/userdata"
qa_sql() { sed "s#/home/Carl/.t3/qa-pull9/#$qa/#g" "$QA_TOOLKIT/$1"; }
gate=$(qa_sql preview.sql | sed -n '/^-- GATE-BEGIN/,/^-- GATE-END/p' | sqlite3 -batch -noheader -readonly "file:$copy?mode=ro" | paste -sd' ')
if [[ $gate != "0 0" ]]; then
  note "r7 GATE FAILED: recorded paths outside $qa (threads, projects) = $gate — STOP: a boot would act on them"
  qa_die "allow-list gate failed ($gate); do not boot this home"
fi
note "r7 gate passed: every recorded worktree/report/brief path and project root is inside $qa (allow-list counts: $gate); no statev2.sqlite"
{ echo; echo "== preview.sql (review lists)"; qa_sql preview.sql | sqlite3 -batch -readonly "file:$copy?mode=ro"; } >>"$report"
trap - EXIT
qa_log "built $qa — review $report; next: build-loom.sh, probe.sh, start.sh"
