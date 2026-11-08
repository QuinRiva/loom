## Appendix A: reproduce the sizing

```sh
git fetch origin && git fetch upstream
git merge-base HEAD 3fa57b92a2                                  # fa31b66bbb2ae5234205a8628a78e038d917202f
git rev-list --count --first-parent fa31b66bbb..3fa57b92a2      # 725
git -c diff.renameLimit=30000 diff --shortstat fa31b66bbb 3fa57b92a2 -- . ':!.repos'   # 2503 files, +150782/−53683
git -c diff.renameLimit=30000 diff --name-status fa31b66bbb 3fa57b92a2 -- . ':!.repos' | cut -c1 | sort | uniq -c   # 413 A / 37 D / 2012 M / 41 R
git -c diff.renameLimit=30000 diff --name-status fa31b66bbb 3fa57b92a2 -- .repos | cut -c1 | sort | uniq -c       # 2904 A / 613 D / 2625 M / 16673 R
git log --first-parent --format='%h %s' 7a93601aaf..ce1bdbcd96 | wc -l   # 20 Loom PRs since pull 14's merge
git diff --shortstat 7a93601aaf origin/main                                # 353 files, +20932/−8639
readlink ~/loom-releases/current                                           # 20261105-132859-30ec64c (PR #533)
# Against the existing mid-merge worktree (what S0 did):
cd /tmp/loom-pull15-trial && O=/tmp/pull15-measure && T=<repo>/docs/upstream-sync/pull9-tools
git rev-parse HEAD > $O/ours.txt; echo 3fa57b92a238cdd8e079af925b673b2f99618b98 > $O/theirs.txt
git merge-base HEAD 3fa57b92a2 > $O/base.txt
git -c diff.renameLimit=30000 diff --name-status fa31b66bbb 3fa57b92a2 > $O/upstream-namestatus.txt
git -c diff.renameLimit=30000 diff --name-status fa31b66bbb HEAD > $O/loom-namestatus.txt
git status --porcelain=v2 > $O/status-v2.txt; git ls-files -u > $O/ls-files-u.txt
git diff --name-only --diff-filter=U > $O/unmerged.txt
python3 $T/classify.py $O && python3 $T/automerged.py $O && python3 $T/dangling.py $O && python3 $T/zones.py $O > $O/zones.md
#   -> conflicted: 74 (73 UU, 1 DU); markers: 138; automerged both-modified: 187; dangling: 7 files / 13 specifiers; lost-ours: 6 files / 19 names
# Hunk shapes (hunks.py, pull 13's, paths re-pointed): per conflicted file, each hunk's ours/theirs line counts, code lines, loom lines;
#   kind = A if theirs has no code and ours has a loom line; B if ours is empty; o if theirs is empty; c otherwise  -> 3 A / 2 B / 5 o / 128 c
# Per-hunk peek: python3 /tmp/pull14-measure/peek.py <file> 10  (first lines of each side)
# Feature overlap with the conflicted set:
for h in 57cd05904d 30654b3e91 a10490937d 95e53a54db 99e361e415 251369d31c 8be19ed3f1 0d266fbe52 e66c3168a4 550c5fa34b; do git show $h --format= --name-only | grep -Fxf $O/unmerged.txt | wc -l; done
#   -> 16 (Effect 4.1.2) 8 (tags) 7 (secret-provider keys) 7 (tsgo) 6 (/clear) 6 (Copy thread) 5 (pi --offline) 5 (pi extension status) 4 (snooze) 4 (prune)
# Tool renames: for each toolkit, diff `Tool.make("…"` names between the two revisions of apps/server/src/mcp/toolkits/<tk>/tools.ts  -> none
# Loom-only files: ls-tree(origin/main) − ls-tree(3fa57b92a2) under apps, packages, scripts, evals, .ts/.tsx/.mjs  -> 732, of which 71 exist at fa31b66bbb (upstream deletions, e.g. TurnItemCompaction.test.ts and ~60 mobile workspace files): 661 genuine Loom-only files; the checks below ran over the 732 superset
# Loom-only import check (imports.py, UP=3fa57b92a2): relative, ~/ and @t3tools/* specifiers resolved in the trial tree; named imports checked against the target's exports
#   -> 0 missing names; the 8 `?raw`/`?worker` hits are query-suffixed specifiers (false positives)
# lost-ours consumers: each of the 19 names grepped as a word across the 732-file superset and across Loom's added lines in modified shared files (git diff fa31b66bbb origin/main --diff-filter=M -- apps packages scripts | grep '^+')  -> none
# Effect 4.1 / mechanical-refactor exposure, over the 266 non-test Loom-only server/package files and the 5,932 Loom-added non-test server/package lines:
#   grep -l 'effect/Crypto"|Crypto\.Crypto|randomUUIDv4'  -> 8 files;  Data\.TaggedError -> 2;  'Effect\.try\(' -> 2 (1 without catch);  process\.env -> 7 hits / 6 files (3 inside Effect code);  'Effect\.succeed\(undefined\)' -> 4
# Diagnostics delta: tsconfig.effect.json (target) vs tsconfig.base.json (base) diagnosticSeverity keys  -> 54 -> 93 entries, 47 -> 86 at error: 40 new names, preferSchemaOverJson -> globalJsonInEffect, net +39
# Both-modified loom counts (Appendix C): for f in $(cat $O/both-modified-automerged.txt); do grep -c loom "$f"; done  -> 185 of 187 files, 975 lines
# Cockpit data (read-only):
sqlite3 "file:$HOME/.t3/cockpit/userdata/statev2.sqlite?mode=ro" "SELECT MAX(migration_id) FROM effect_sql_migrations; SELECT MAX(migration_id) FROM loom_sql_migrations; SELECT COUNT(*) FROM orchestration_events; SELECT application_event_version, COUNT(*) FROM orchestration_events GROUP BY 1; SELECT application_event_version, COUNT(*) FROM orchestration_events WHERE aggregate_kind='thread' AND event_type IN ('thread.report-set','thread.outcome-recorded','thread.attention-raised','thread.attention-cleared','thread.route-taken','thread.gate-rework-accepted','thread.outcome-set','thread.plan-lane-set') GROUP BY 1; SELECT COUNT(*) FROM orchestration_events WHERE application_event_version=2 AND occurred_at < datetime('now','-1 day'); SELECT COUNT(*) FROM orchestration_v2_legacy_imports WHERE transcript_imported_at IS NOT NULL; SELECT COUNT(*) FROM orchestration_events WHERE application_event_version=1 AND aggregate_kind='thread' AND stream_id IN (SELECT thread_id FROM orchestration_v2_legacy_imports WHERE transcript_imported_at IS NOT NULL); SELECT COUNT(*) FROM orchestration_v2_projection_threads WHERE json_type(payload_json,'\$.settledOverride') IN ('true','false'); SELECT name FROM sqlite_master WHERE name='idx_orch_events_correlation_id'; SELECT task_id, title, thread_id IS NOT NULL, enabled FROM scheduled_tasks; SELECT page_count*page_size/1048576 FROM pragma_page_count, pragma_page_size;"
#   -> 76 ; 1069 ; 1448632 ; 1|40150 2|1408482 ; 1|33696 2|8159 ; 1407133 ; 4340 ; 33696 ; 0 ; idx_orch_events_correlation_id ; 3 tasks (2 bound) ; 6764 MB   at measurement, 8 Nov 23:00 UTC; the live counts drift
```
