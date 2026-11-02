#!/usr/bin/env bash
# Weekly Loom evals: outcome dashboard, trace checks, gate escape proxy, joined into ~/loom-evals/dashboard.md.
# Read-only against the database and session files. See README.md.
# Usage: run.sh [--week 2026-W44]   (default: the previous complete ISO week, local time)
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
export PYTHONDONTWRITEBYTECODE=1
week=$(python3 -c "import sys; sys.path.insert(0, '$here'); from dashboard import default_week; print(default_week())")
while (($#)); do
  case $1 in
    --week) week=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
readings=$HOME/loom-evals/readings/$week
mkdir -p "$readings"

# A script that fails leaves its fragment absent (never a stale one), and render.py reports it missing.
for step in dashboard.py:metrics.json trace_corpus.py:trace.json gate_escapes.py:escapes.json; do
  script=${step%%:*} fragment=${step#*:}
  rm -f "$readings/$fragment"
  if [[ ! -f $here/$script ]]; then
    echo "skip $script: not present" >&2
  elif ! python3 "$here/$script" --week "$week" >&2; then
    echo "$script failed; $fragment left absent" >&2
    rm -f "$readings/$fragment"
  fi
done
python3 "$here/render.py" --week "$week"
