## Appendix A: reproduce the sizing

```sh
git fetch origin && git fetch upstream
git merge-base HEAD fa31b66bbb                                  # b76a110aa4cf011345ec9d63d37c2dcdf4b751ad
git rev-list --count --first-parent b76a110aa4..fa31b66bbb      # 1374
git -c diff.renameLimit=30000 diff --shortstat b76a110aa4 fa31b66bbb   # 3763 files, +276515/−82925
git log --first-parent --format='%h %s' 6a42b22ff4..fe75bb6833 | wc -l  # 51 Loom PRs since pull 13's merge
# Against the existing mid-merge worktree (what S0 did):
cd /tmp/loom-pull14-trial && O=/tmp/pull14-measure && T=<repo>/docs/upstream-sync/pull9-tools
git rev-parse HEAD > $O/ours.txt; echo fa31b66bbb2ae5234205a8628a78e038d917202f > $O/theirs.txt
git merge-base HEAD fa31b66bbb > $O/base.txt
git -c diff.renameLimit=30000 diff --name-status b76a110aa4 fa31b66bbb > $O/upstream-namestatus.txt
git -c diff.renameLimit=30000 diff --name-status b76a110aa4 HEAD > $O/loom-namestatus.txt
git status --porcelain=v2 > $O/status-v2.txt; git ls-files -u > $O/ls-files-u.txt
git diff --name-only --diff-filter=U > $O/unmerged.txt
python3 $T/classify.py $O && python3 $T/automerged.py $O && python3 $T/dangling.py $O && python3 $T/zones.py $O > $O/zones.md
#   -> conflicted: 123 (121 UU, 2 UD); markers: 299; automerged both-modified: 180; dangling: 8 files / 14 specifiers; lost-ours: 24 files / 53 names
# Hunk shapes (hunks.py, pull 13's, paths re-pointed): per conflicted file, each hunk's ours/theirs line counts, code lines, loom lines;
#   kind = A if theirs has no code and ours has a loom line; B if ours is empty; o if theirs is empty; c otherwise  -> 23 A / 10 B / 12 o / 254 c
# Feature overlap with the conflicted set:
for h in 67661cfbb5 33d0c9637b d897d3f3f0 50c1c5dc53 594f1ce2eb 8b14660b27 5e9d56416f 6b1245cced d2429f733c 8bf4822f5e; do git show $h --format= --name-only | grep -Fxf $O/unmerged.txt | wc -l; done
#   -> 54 (#26238 dead code) 22 (#26161 effects) 15 (#27197 policy) 21 (#26901 side chats) 10+12+8 (linked envs) 9 (#27252 stop) 7 (#26240 paging) 6 (#27106 shell index)
# Tool renames: for each toolkit, diff `Tool.make("…"` names between the two revisions of apps/server/src/mcp/toolkits/<tk>/tools.ts  -> §5.1
# Loom-only import check (imports.py): Loom-only files = ls-tree(origin/main) − ls-tree(fa31b66bbb) under apps, packages, scripts (698);
#   relative, ~/ and @t3tools/* specifiers resolved in the trial tree; named imports checked against the target's exports  -> 9 missing names in 5 files (§6.3 (c))
# lost-ours consumers: each of the 53 names grepped as a word across the 672 Loom-authored files and across Loom's added lines in modified shared files
#   -> ThreadSettlementService.layer (prToolkit.test.ts), encodeScanCache (usageScanCache.test.ts hunk)
# Effects needing a reason: `use(Layout|Insertion)?Effect(` in Loom-authored non-test files under apps/web/src, apps/mobile/src, packages/*/src  -> 54 in 37;
#   plus `+…useEffect(` lines in `git diff b76a110aa4 origin/main --diff-filter=M` over the same roots  -> 2 (FileBrowserPanel.tsx, MarkdownCodeBlock.tsx)
# Re-homing (rehome.py, UP=fa31b66bbb) over the 49 conflicted web files  -> 3 moves, all else "stay" (Appendix D)
# Cockpit data (read-only):
sqlite3 "file:$HOME/.t3/cockpit/userdata/statev2.sqlite?mode=ro" "SELECT COUNT(*) FROM orchestration_v2_projection_turn_items; SELECT COUNT(*) FROM orchestration_v2_projection_subagents; SELECT MAX(migration_id) FROM effect_sql_migrations; SELECT MAX(migration_id) FROM loom_sql_migrations; SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'orchestration_v2_message_search%'; SELECT COUNT(*) FROM loom_thread_workstream WHERE attention <> '[]';"
#   -> 304894 ; 0 ; 69 ; 1066 ; 0 ; 34   at measurement, 1 Nov 23:00 UTC (file 6,272 MB, auto_vacuum 2, 6,055 threads of which 5,139 subagent); the live counts drift
```
