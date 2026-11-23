#!/usr/bin/env bash
# Loom PR digest since the previous pull's merge: per first-parent merge, the PR number and title,
# files changed, how many of them upstream also changed in range (upstream-namestatus.txt, both
# sides of a rename), and which conflicted paths (unmerged.txt) it touched. Read-only.
# Usage (from this worktree's root):
#   docs/upstream-sync/41-cadence-pull-16-20261122/tools/prdigest.sh .artifacts/pull16-measure '#537'
set -euo pipefail
O=$1; PREV=$(git log --first-parent --grep="$2" --format=%h -1)
cut -f2- "$O/upstream-namestatus.txt" | tr '\t' '\n' | sort -u > /tmp/prdigest-up.$$
sort -u "$O/unmerged.txt" > /tmp/prdigest-u.$$
echo "previous pull merge: $(git log -1 --format='%h %ad %s' --date=short "$PREV")"
echo "| PR | merged | title | files | also changed upstream | conflicted paths touched |"
echo "| --- | --- | --- | ---: | ---: | --- |"
git log --first-parent --reverse --format='%h' "$PREV..HEAD" | while read -r m; do
  pr=$(git log -1 --format=%s "$m" | grep -o '#[0-9]*' | head -1)
  title=$(git log -1 --format=%b "$m" | sed -n '1p' | sed 's/|/\//g')
  git diff --name-only "$m^1" "$m" | sort -u > /tmp/prdigest-f.$$
  n=$(wc -l < /tmp/prdigest-f.$$); up=$(comm -12 /tmp/prdigest-f.$$ /tmp/prdigest-up.$$ | wc -l)
  conf=$(comm -12 /tmp/prdigest-f.$$ /tmp/prdigest-u.$$ | sed 's/.*/`&`/' | paste -sd ',' | sed 's/,/, /g')
  echo "| $pr | $(git log -1 --format=%ad --date=short "$m") | $title | $n | $up | ${conf:-none} |"
done
echo; echo "totals: $(git diff --shortstat "$PREV" HEAD)"
echo "running release: $(readlink ~/loom-releases/current 2>/dev/null || echo n/a)"
rm -f /tmp/prdigest-*.$$
