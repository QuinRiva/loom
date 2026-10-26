#!/usr/bin/env bash
# Runs loom's MDX render-health check (apps/web/scripts/lint-plan.mjs) from any cwd; arguments pass through.
# The cwd's checkout wins when it is loom (its renderer may be the change under test); otherwise the
# checkout this script physically lives in, which for ~/.pi/agent/skills is the current release.
# ~/loom is never a fallback: it is a working checkout with no contract to be current.
set -euo pipefail
linter=apps/web/scripts/lint-plan.mjs
root=$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z $root || ! -f $root/$linter ]]; then
  root=$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/../../.." && pwd)
  if [[ ! -f $root/$linter ]]; then
    echo "lint-doc: no $linter in the cwd's checkout or in $root (this script's checkout)" >&2
    exit 2
  fi
fi
echo "lint-doc: using the linter in $root" >&2
exec node "$root/$linter" "$@"
