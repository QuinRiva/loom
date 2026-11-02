## Appendix A: reproduce the sizing

```sh
git fetch origin && git fetch upstream
git merge-base HEAD b76a110aa4                                  # 07d38b8d17167c8d17fba1184dbe13a307fada74
git rev-list --count 07d38b8d17..b76a110aa4                     # 1238
git -c diff.renameLimit=30000 diff --shortstat 07d38b8d17 b76a110aa4   # 4932 files, +415546/−381296
# Against the existing mid-merge worktree (what S0 did):
cd /tmp/loom-pull13-trial && O=/tmp/pull13-measure && T=<repo>/docs/upstream-sync/pull9-tools
git rev-parse HEAD > $O/ours.txt; echo b76a110aa4cf011345ec9d63d37c2dcdf4b751ad > $O/theirs.txt
git merge-base HEAD b76a110aa4 > $O/base.txt
git -c diff.renameLimit=30000 diff --name-status 07d38b8d17 b76a110aa4 > $O/upstream-namestatus.txt
git -c diff.renameLimit=30000 diff --name-status 07d38b8d17 HEAD > $O/loom-namestatus.txt
git status --porcelain=v2 > $O/status-v2.txt; git ls-files -u > $O/ls-files-u.txt
git diff --name-only --diff-filter=U > $O/unmerged.txt
python3 $T/classify.py $O && python3 $T/automerged.py $O && python3 $T/dangling.py $O && python3 $T/zones.py $O > $O/zones.md
#   -> conflicted: 173 (161 UU, 11 UD, 1 DU); markers: 418; automerged both-modified: 144; dangling: 5 files / 12 specifiers; lost-ours: 24 files
# Prune / feature overlap with the conflicted set:
for h in 05696c636e 8f26ed7e27 bb7783e295 e57c093cdd fb76594d7b; do git show $h --format= --name-only | grep -Fxf $O/unmerged.txt | wc -l; done
#   -> 80 (test prune) 101 (comment prune) 22 (#24343 search) 16 (#24723 cold connect) 27 (#24104 guest)
# Hunk shapes (hunks.py): for each conflicted file, each hunk's ours/theirs line counts, code-line counts, loom lines; kind =
#   A if theirs has no code and ours has a loom line; B if ours is empty; o if theirs is empty; c otherwise  -> 86 A / 7 B / 44 o / 281 c
# Loom-only import check (imports.py): Loom-only files = ls-tree(origin/main) − ls-tree(b76a110aa4) under apps, packages, scripts;
#   resolve relative, ~/ and @t3tools/* (via package.json exports) specifiers in the trial tree; check named imports against the
#   target's `export` declarations  -> 3 missing names (§5.4)
# Re-homing map (rehome.py): index every ≥25-char non-comment line of every upstream src file; for each `loom` line in Loom's version
#   of a split file, vote the files that hold its preceding 6 and following 4 context lines  -> Appendix D
# Cockpit data (read-only):
sqlite3 "file:$HOME/.t3/cockpit/userdata/statev2.sqlite?mode=ro" "SELECT COUNT(*) FROM loom_thread_search; SELECT COUNT(*) FROM orchestration_v2_projection_messages m WHERE m.streaming=0 AND (m.role='assistant' OR (m.role='user' AND COALESCE(json_extract(m.payload_json,'\$.createdBy'),'user')='user')) AND json_extract(m.payload_json,'\$.text') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads t WHERE t.thread_id=m.thread_id AND json_extract(t.payload_json,'\$.lineage.relationshipToParent')='subagent');"
#   -> 48069 ; 31749 (21.8 MB of text); threads 5555 of which 4703 subagent; settled top-level active roots 440; auto_vacuum 0; file 11,754 MB; ledgers 64 / 1062
```
