## Appendix A: reproduce the sizing

Run from this worktree's root unless a line says otherwise. `T` is the
mid-merge trial worktree (read-only), `O` the capture directory, `R` this
runbook's directory. Numbers after `#` are what S0 measured on 23 Nov 2026;
live counts drift.

```sh
T=/home/Carl/.t3/cockpit/worktrees/loom/t3-7634b056-pull16-trial
O=.artifacts/pull16-measure
R=docs/upstream-sync/41-cadence-pull-16-20261122
B=3fa57b92a2; U=a09738fb43

git fetch origin && git fetch upstream
git merge-base HEAD $U                                        # 3fa57b92a238cdd8e079af925b673b2f99618b98
git rev-list --count --first-parent $B..$U                    # 3335
git log -1 --format='%H %ci %s' $U                            # a09738fb43… 2026-11-22 14:46:37 -0800 fix(claude): … (#41086)
git -c diff.renameLimit=30000 diff --shortstat $B $U          # 6278 files, +1237746/−314884
git -c diff.renameLimit=30000 diff --shortstat $B $U -- . ':!.repos'   # 5273 files, +993653/−216095
git -c diff.renameLimit=30000 diff --name-status $B $U -- . ':!.repos' | cut -c1 | sort | uniq -c   # 1217 A / 62 D / 3960 M / 34 R
python3 $R/tools/composition.py $O                            # translations 182,191 · vendored C 151,096 · generated 64,125 · lockfile 3,425 · fixtures 1,459 · source 295,403 · tests 284,350; commits by type and scope
git log --first-parent --format='%h %ad %s' --date=short $B..$U > $O/upstream-log.txt

# The trial merge (what the orchestrator ran; S0 only read it). In a scratch worktree on a detached origin/main:
#   git -c rerere.enabled=false -c merge.renameLimit=30000 merge --no-commit --no-ff a09738fb435120d08707db0142ca55b3b7b5c7ec
# Captures, against that mid-merge worktree (pull 9's tools write into $O; run them with cwd = $T and $O absolute):
(cd $T && A=$OLDPWD/$O && P=$OLDPWD/docs/upstream-sync/pull9-tools \
  && git rev-parse HEAD > $A/ours.txt && echo a09738fb435120d08707db0142ca55b3b7b5c7ec > $A/theirs.txt && git merge-base HEAD $U > $A/base.txt \
  && git -c diff.renameLimit=30000 diff --name-status $B $U > $A/upstream-namestatus.txt \
  && git -c diff.renameLimit=30000 diff --name-status $B HEAD > $A/loom-namestatus.txt \
  && git status --porcelain=v2 > $A/status-v2.txt && git ls-files -u > $A/ls-files-u.txt \
  && git diff --name-only --diff-filter=U > $A/unmerged.txt \
  && python3 $P/classify.py $A && python3 $P/automerged.py $A && python3 $P/dangling.py $A && python3 $P/zones.py $A > $A/zones.md)
#   -> conflicted 193 (191 UU, 2 UD); markers 513; loom: lines 1530; both-modified automerged 170; lost-ours 7 files / 9 names; dangling 9 files / 20 specifiers
python3 $R/tools/hunks.py $T $O                               # 193 files, 513 hunks: 472 c / 27 o / 13 B / 1 A  -> $O/hunks.json, hunks.md
python3 $R/tools/peek.py $T <path> 40                         # both sides of each hunk of one file
python3 - <<'EOF'                                             # hunks with a side >= 20 lines: 98 in 64 files
import json;h=json.load(open('.artifacts/pull16-measure/hunks.json'))
big=[(p,sum(1 for x in hs if max(x['ours'],x['theirs'])>=20)) for p,hs in h.items()]
print(sum(n for p,n in big), sum(1 for p,n in big if n))
EOF

# Upstream commits behind the conflicts
while read p; do echo "## $p"; git log --format='%h %ad %s' --date=short $B..$U -- "$p"; done < $O/unmerged.txt > $O/conflict-commits.txt
git log --format='%h' $B..$U -- $(cat $O/unmerged.txt) | sort -u | wc -l          # 1299 commits touch a conflicted path
for h in 055b44919e 60863edc41 fe9c98c98f 521ac7c218 0fb6ac6e65 0597b9edcd 7c6e889ddb ee645553a9; do
  echo "$h $(git show $h --format= --name-only | grep -Fxf $O/unmerged.txt | wc -l)"; done
#   -> 66 (translation) 35 (multi-repo) 22 (feedback) 20 (Labs) 18 (markdown) 16 (issue tools) 13 (subagents open) 11 (Effect.scoped)

# Silent overlap, lost declarations, Loom-only imports, Loom PR digest (Appendix C, §6.14, §6.15)
python3 $R/tools/overlap.py $O $T                             # 170 files; 629 loom lines merged = 629 at HEAD; 0 files differ; top 25 by risk
awk -F'\t' '$1 ~ /^R/ {print $2"\t"$3"\t"$1}' $O/upstream-namestatus.txt | sort > /tmp/r.tsv
awk -F'\t' '$1 ~ /^[MR]/ {print $2}' $O/loom-namestatus.txt | sort | join -t$'\t' - /tmp/r.tsv   # the 2 renamed overlaps automerged.py misses
python3 $R/tools/imports.py $T $O/loom-only-imports.md        # Loom-only 804 (733 Loom's own, 71 carried upstream deletions); 23 broken (15 eval-fixture strings, 8 real)
$R/tools/prdigest.sh $O '#537'                                # 28 PRs, 315 files, +28483/−1867; pull 15's merge is 1c7adff34d
readlink ~/loom-releases/current                              # …/20261120-015646-6be88bb (#589); git diff --shortstat 6be88bb66e HEAD -> 43 files (#590, #591)

# Zone assignment and the Appendix B files: .artifacts/pull16-measure/assign/assignment.json (path -> zone key), built by pattern over
# unmerged.txt; every path in exactly one zone:
python3 -c "import json;a=json.load(open('.artifacts/pull16-measure/assign/assignment.json'));print(len(a))"   # 193

# Agent tools (§4)
for r in $B HEAD $U; do for f in $(git ls-tree -r --name-only $r apps/server/src/mcp | grep -v '\.test\.' | grep '\.ts$'); do
  git show $r:$f | grep -oE 'Tool\.make\(\s*"[^"]+"' | sed "s|^|$r\t$f\t|"; done; done | sort > /tmp/tools.tsv   # 23 names new at $U; none removed or renamed
grep -n 'PULL_REQUESTS\b.*=\|UPSTREAM_WITHHELD_TOOLS' apps/server/src/mcp/toolkits/workstream/families.ts
sed -n 116,123p $T/apps/server/src/pullRequest/PullRequestWatchService.ts          # the subagent refusal with no Loom exemption
for c in $(git log --reverse --format=%h $B..$U -- apps/server/src/provider/agentContextBudget.json); do git show $c:apps/server/src/provider/agentContextBudget.json | grep mcpToolListJsonBytes; done   # 48202 -> 60374

# i18n lint (§5.1): the target's rule sources with this worktree's oxlint, written to scratch only
git show $U:vite.config.ts | sed -n 585,600p                  # the rule's scope
git show $U:vite.config.ts | sed -n 680,684p                  # reportUnusedDisableDirectives: "error"
S=$O/scratch/i18n   # plugin/ = the target's oxlint-plugin-t3code sources; oxlintrc.json enables only t3code/no-untranslated-copy
OX=$(ls -d node_modules/.pnpm/oxlint@*/node_modules/oxlint)/bin/oxlint
$OX -c $S/oxlintrc.json --format=unix apps/web/src apps/mobile/src packages/client-runtime/src > $S/head-lint.txt
#   Loom-only files (in HEAD, not in $B, not in $U; tests excluded as the rule excludes them): 1096 errors / 121 files
#   Loom-added lines in upstream files (flagged lines ∩ `git diff -U0 $B HEAD` added lines): 42 to 44 / 19 files
#   upstream's own files extracted with `git archive $U`: 0 errors
# After `vp i` on the merged tree, `vp check` is the measurement.

# Toolchain (§5.2 to §5.6)
git diff $B $U -- tsconfig.effect.json | wc -l                # 0: no new Effect diagnostics
git show $U:pnpm-workspace.yaml | grep -n '^  effect:'        # 4.1.5
git show $U:package.json | grep -n '"node"'                   # 26.13.1 ; node --version here: v26.12.1 (~/.n)
git show $U:apps/web/package.json | grep -cE '"(react-markdown|remark-[a-z]+|unified|@types/mdast)"'   # 0: removed by #27866
grep -cE '"(unified|@types/mdast)"' $T/apps/web/package.json  # 0: dropped outside any marker
rg -n 'json_set\(.*\(\s*$' apps/server/src/persistence/Migrations/1066_DropHumanMessageDigestItems.ts    # the two unwrapped subqueries

# Migrations and the cockpit database (§5.5), read-only and in place
DB="file:$HOME/.t3/cockpit/userdata/statev2.sqlite?mode=ro"
git diff --name-status $B $U -- apps/server/src/persistence/Migrations | grep -v test | cut -c1 | sort | uniq -c   # 28 A, 5 M
git show $U:apps/server/src/persistence/Migrations.ts | cmp - $T/apps/server/src/persistence/Migrations.ts        # identical
git grep -n "DROP INDEX\|DROP TABLE\|DROP TRIGGER\|DROP COLUMN\|RENAME" $U -- apps/server/src/persistence/Migrations ':!*.test.ts'
ls apps/server/src/persistence/Migrations | grep -E '^107[0-9]'                    # Loom's lane head 1072
git diff --stat $B $U -- apps/server/src/orchestration-v2/ProjectionMaintenance.ts # empty; grep -c loom <that file> -> 0 (the guard is gone, 2e76814b9e)
ls -la ~/.t3/cockpit/userdata/statev2.sqlite*; df -h / /mnt/fast                   # 4.73 GB + WAL; / 97-98 %, /mnt/fast 116 GB free
sqlite3 "$DB" "PRAGMA page_count; PRAGMA freelist_count; PRAGMA auto_vacuum; SELECT MAX(migration_id) FROM effect_sql_migrations; SELECT MAX(migration_id) FROM loom_sql_migrations; SELECT COUNT(*) FROM orchestration_events; SELECT COUNT(*) FROM loom_thread_history;"
#   -> 1154696 ; 0 ; 2 ; 80 ; 1072 ; 102956 ; 46920
sqlite3 "$DB" "SELECT type, COUNT(*), SUM(length(payload_json))/1048576 FROM orchestration_v2_projection_turn_items GROUP BY type"   # 511,221 rows; one full scan, about 15 s
#   row counts: messages 165,442 · nodes 365,422 · threads 7,626 · runs 10,609 · projects 40 · auth_pairing_links 387 · auth_sessions 197
#   per-migration predicate counts (each the migration's own WHERE clause): 081 citations 546 · 082 176,530 · 085 groups 14,701 · 086 125 · 095 49 · 099 24 · 100 6 · 101 messages 49, runs 0 · 087 0 · 096 0 · subagent-lineage threads 6,527
python3 -c "import json;print(json.load(open('/home/Carl/loom-releases/deploy.json'))['startTimeoutSeconds'])"       # 240

# Remote access (§6.7)
sqlite3 "$DB" "SELECT subject, COUNT(*) FROM auth_sessions GROUP BY 1; SELECT subject, COUNT(*) FROM auth_pairing_links GROUP BY 1;"   # no cloud-connect row
git show $U:apps/server/src/cloud/serviceProtocol.ts | grep -n 'SERVICE_LAUNCHER_PROTOCOL =\|SupportedLauncherProtocol ='           # 4 ; 3 | 4

# Threads by role since 1 Nov (§4.2)
sqlite3 "$DB" "select coalesce(role,'(none)'),count(*) from loom_thread_workstream w join orchestration_v2_projection_threads t using(thread_id) where t.created_at>'2026-11-01' group by 1 order by 2 desc"
sqlite3 "$DB" "select runtime_mode,count(*) from orchestration_v2_projection_threads where created_at>'2026-11-01' group by 1"
```

The seventeen research threads that read both sides of every seam each left a
findings file with its own command list under
`.artifacts/pull16-measure/findings/` (gitignored). The Appendix B zone files
and §4 to §6 were assembled from them; where a zone file cites "§9" of its
research, the command is in that findings file, and every count it gives is
restated above or in the section that uses it.
