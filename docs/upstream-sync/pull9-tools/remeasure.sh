#!/usr/bin/env bash
# Re-measure the pull-9 merge surface: run the trial merge of upstream/main onto
# HEAD in THIS worktree, capture everything the runbook's zone partition is
# built from, and abort. Never commits. Never stashes. rerere is disabled for
# the invocation because the shared rr-cache holds unresolved preimages from the
# earlier trials and recording more is noise.
#
# Usage: [THEIRS=<oid>] remeasure.sh [out-dir]   (default THEIRS=upstream/main; out .artifacts/pull9-remeasure, gitignored)
# Requires a clean worktree (no unstaged or staged changes).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
O=${1:-.artifacts/pull9-remeasure}
tools=docs/upstream-sync/pull9-tools
[[ -z $(git status --porcelain | grep -v '^??') ]] || { echo "worktree not clean" >&2; exit 2; }
mkdir -p "$O"
git fetch upstream main
git rev-parse HEAD > "$O/ours.txt"
THEIRS=${THEIRS:-upstream/main}
git rev-parse "$THEIRS" > "$O/theirs.txt"
git merge-base HEAD "$THEIRS" > "$O/base.txt"
base=$(cat "$O/base.txt")
git -c diff.renameLimit=30000 diff --name-status "$base" "$THEIRS" > "$O/upstream-namestatus.txt"
git -c diff.renameLimit=30000 diff --name-status "$base" HEAD > "$O/loom-namestatus.txt"
git -c rerere.enabled=false -c merge.renameLimit=30000 merge --no-commit --no-ff "$THEIRS" \
  > "$O/merge-output.txt" 2>&1 || true
git status --porcelain=v2 > "$O/status-v2.txt"
git ls-files -u > "$O/ls-files-u.txt"
git diff --name-only --diff-filter=U > "$O/unmerged.txt"
python3 "$tools/classify.py" "$O"
python3 "$tools/automerged.py" "$O"
python3 "$tools/dangling.py" "$O" | tee "$O/dangling-summary.txt"
python3 "$tools/zones.py" "$O" > "$O/zones.md"
git merge --abort
echo "ours $(cat "$O/ours.txt") theirs $(cat "$O/theirs.txt") base $base"
echo "conflicted: $(wc -l < "$O/unmerged.txt"); by kind: $(grep '^u ' "$O/status-v2.txt" | awk '{print $2}' | sort | uniq -c | tr '\n' ' ')"
echo "markers: $(python3 -c "import json;print(sum(o['markers'] for o in json.load(open('$O/conflicts.json'))))")"
