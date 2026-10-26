#!/usr/bin/env bash
# Run the prompt measurements (skill-usage census, child delegation rate, capability census) and write one markdown report
# ending in a comparison against baselines/. Read-only everywhere. See README.md.
# Usage: run.sh [--days 14] [--sessions-root DIR] [--db PATH] [--out FILE]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
days=14
sessions=$HOME/.pi/agent/sessions
db=${T3CODE_HOME:-$HOME/.t3/cockpit}/userdata/statev2.sqlite
out=$(git -C "$here" rev-parse --show-toplevel)/.artifacts/prompt-telemetry-$(date -u +%Y%m%dT%H%M%SZ).md
while (($#)); do
  case $1 in
    --days) days=$2 ;;
    --sessions-root) sessions=$2 ;;
    --db) db=$2 ;;
    --out) out=$2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift 2
done
# Cumulative since role-resident tool exposure landed, and since the trimmed prompt deployed
# (release 20261022-230214-40ddbac): the second bound is the one that tests the wording.
since_tools=2026-10-13
since_deploy=2026-10-22T23:04:44Z

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
python3 "$here/capabilities.py" --days "$days" --sessions-root "$sessions" >"$work/capabilities.md" &
capabilities=$!
echo "census over $sessions, last $days days..." >&2
python3 "$here/skill-usage.py" --days "$days" --sessions-root "$sessions" >"$work/sessions.jsonl"
python3 "$here/skill-usage-agg.py" "$work/sessions.jsonl" all >"$work/table.md" 2>"$work/populations.txt"
echo "missed-fire check..." >&2
python3 "$here/skill-usage-triggers.py" --days "$days" --sessions-root "$sessions" >"$work/triggers.txt"
echo "delegation from $db..." >&2
"$here/delegation.sh" "$since_tools" "$db" >"$work/delegation-cumulative.txt"
"$here/delegation.sh" "$since_deploy" "$db" >"$work/delegation-since-deploy.txt"
echo "capability census..." >&2
wait "$capabilities"

mkdir -p "$(dirname "$out")"
{
  echo "# Prompt telemetry, $(date -u +%Y-%m-%dT%H:%MZ)"
  echo
  echo "Skill census: session files under \`$sessions\` modified in the last $days days. Delegation: \`$db\`."
  echo
  echo "## Comparison with baselines"
  echo
  python3 "$here/compare.py" "$here/baselines/skill-usage-30d.md" "$here/baselines/delegation-2026-10-22.txt" \
    "$work/table.md" "$work/triggers.txt" "$work/delegation-cumulative.txt" "$work/delegation-since-deploy.txt" "$days" \
    "$here/baselines/capabilities-2026-10-26.md" "$work/capabilities.md"
  echo
  echo "## Delegation since $since_tools"
  echo
  echo '```'; cat "$work/delegation-cumulative.txt"; echo '```'
  echo
  echo "## Delegation since $since_deploy (deploy of the trimmed prompt)"
  echo
  echo '```'; cat "$work/delegation-since-deploy.txt"; echo '```'
  echo
  echo "## Skill census, last $days days"
  echo
  cat "$work/populations.txt"
  echo
  cat "$work/table.md"
  echo
  echo "## Missed-fire check (did the skill fire when its work came up)"
  echo
  echo '```'; cat "$work/triggers.txt"; echo '```'
  echo
  echo "## Capability census, last $days days"
  echo
  cat "$work/capabilities.md"
} >"$out"
echo "$out"
