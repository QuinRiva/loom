#!/usr/bin/env bash
# Find loom code hiding in upstream-owned files with no `// loom:` marker.
#
# An unmarked fork hunk is invisible to every audit: the next cadence pull takes
# upstream's side of the file and nobody can tell what was lost. That is how the
# By-coder diff scope silently lost its range arm in pull 7.
#
# Two scopes, deliberately different:
#
#   unmarkedsweep.sh            GATE. Only the files THIS branch changes vs
#                               origin/main. Exits 1 if any of them is an
#                               upstream-owned file gaining a non-trivial
#                               unmarked delta. This is what `pnpm ship` runs.
#
#   unmarkedsweep.sh --report   AUDIT. The whole fork delta vs the recorded
#                               upstream base. Always exits 0. Use at cadence
#                               pulls; the accumulated backlog is large and is
#                               tracked in the sync notes, not gated on.
#
# Files absent at the comparison base (loom-only) are exempt automatically;
# deliberate exemptions live in docs/upstream-sync/unmarkedsweep.allow.
# MIN_LINES (default 15) sets what counts as non-trivial.

set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

BASE_FILE=docs/upstream-sync/UPSTREAM_BASE
ALLOW_FILE=docs/upstream-sync/unmarkedsweep.allow
MIN_LINES=${MIN_LINES:-15}
report=0
[[ ${1:-} == --report ]] && report=1

[[ -f $BASE_FILE ]] || { echo "missing $BASE_FILE" >&2; exit 2; }
upstream_base=$(grep -v '^[[:space:]]*#' "$BASE_FILE" | tr -d '[:space:]')
git rev-parse --verify --quiet "$upstream_base^{commit}" >/dev/null ||
  { echo "$BASE_FILE names '$upstream_base', which is not a commit here" >&2; exit 2; }

# The gate asks "what is this branch adding?", the audit "what has the fork
# accumulated?". Either way a file is only in scope if upstream owns it, which
# is always judged against the upstream base.
if (( report )); then
  diff_base=$upstream_base
else
  diff_base=$(git merge-base origin/main HEAD 2>/dev/null ||
              git merge-base main HEAD 2>/dev/null || echo "$upstream_base")
fi

allowed() {
  [[ -f $ALLOW_FILE ]] || return 1
  while read -r pat; do
    [[ -z $pat || $pat == \#* ]] && continue
    [[ $1 == "$pat" || $1 == "$pat"* ]] && return 0
  done < "$ALLOW_FILE"
  return 1
}

unmarked=() thin=()
while read -r added deleted path; do
  [[ $added == - ]] && continue                                  # binary
  (( added + deleted >= MIN_LINES )) || continue
  [[ -f $path ]] || continue                                     # deleted in HEAD
  git cat-file -e "$upstream_base:$path" 2>/dev/null || continue # loom-only file
  allowed "$path" && continue
  # Non-TS files carry the marker in their own comment syntax, so match bare `loom:`.
  case $path in
    *.ts|*.tsx|*.js|*.jsx|*.mjs|*.cjs) pattern='// loom:' ;;
    *) pattern='loom:' ;;
  esac
  markers=$(grep -cF "$pattern" "$path" || true)
  if (( markers == 0 )); then
    unmarked+=("$((added + deleted))	$path")
  elif (( added + deleted >= 200 && markers < 3 )); then
    thin+=("$((added + deleted))	$markers	$path")
  fi
# No second rev: compare against the WORKING TREE, so the sweep sees what you
# are about to commit, not just what you already did.
done < <(git diff --numstat "$diff_base")

scope=$( (( report )) && echo "whole fork vs $upstream_base" || echo "this branch vs $(git rev-parse --short "$diff_base")" )

if (( ${#unmarked[@]} )); then
  echo "Unmarked fork deltas — $scope (>=${MIN_LINES} changed lines, zero markers):"
  printf '%s\n' "${unmarked[@]}" | sort -rn | awk -F'\t' '{printf "  %6s  %s\n", $1, $2}'
fi

if (( report && ${#thin[@]} )); then
  echo
  echo "Marked but thin (>=200 changed lines, <3 markers) — worth a look, not a failure:"
  printf '%s\n' "${thin[@]}" | sort -rn | awk -F'\t' '{printf "  %6s lines  %2s markers  %s\n", $1, $2, $3}'
fi

if (( ${#unmarked[@]} == 0 )); then
  echo "unmarked-delta sweep: clean — $scope"
  exit 0
fi

echo
echo "Mark each hunk with '// loom:' (or move it to a *.loom.ts / apps/web/src/loom/ module)."
echo "If a file is deliberately unmarked, add it to $ALLOW_FILE with the reason."
(( report )) && exit 0
exit 1
