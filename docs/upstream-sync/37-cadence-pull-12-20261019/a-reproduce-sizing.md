## Appendix A — reproduce the sizing

```sh
git fetch origin && git fetch upstream
git merge-base HEAD 07d38b8d17                                  # 737192594f47d87f28b5f5a3fda3ef792a0d7972
git rev-list --count 737192594f..07d38b8d17                     # 850
# Either (clean worktree):
THEIRS=07d38b8d17167c8d17fba1184dbe13a307fada74 \
  bash docs/upstream-sync/pull9-tools/remeasure.sh .artifacts/pull12-remeasure
# Or, against an existing mid-merge worktree (what S0 did):
cd /tmp/loom-pull12-trial && O=/tmp/pull12-measure && T=<repo>/docs/upstream-sync/pull9-tools
git rev-parse HEAD > $O/ours.txt; echo 07d38b8d17167c8d17fba1184dbe13a307fada74 > $O/theirs.txt
git merge-base HEAD 07d38b8d17 > $O/base.txt
git -c diff.renameLimit=30000 diff --name-status 737192594f 07d38b8d17 > $O/upstream-namestatus.txt
git -c diff.renameLimit=30000 diff --name-status 737192594f HEAD > $O/loom-namestatus.txt
git status --porcelain=v2 > $O/status-v2.txt; git ls-files -u > $O/ls-files-u.txt
git diff --name-only --diff-filter=U > $O/unmerged.txt
python3 $T/classify.py $O && python3 $T/automerged.py $O && python3 $T/dangling.py $O && python3 $T/zones.py $O > $O/zones.md
#   -> conflicted: 101; by kind: 5 UD 96 UU; markers: 178; automerged both-modified: 172; dangling: 5 files / 14 specifiers
# Comment-prune share:
git show 86534db4d3 --stat --format= | awk '{print $1}' | grep -Fxf $O/unmerged.txt | wc -l   # 63
```
