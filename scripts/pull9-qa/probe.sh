#!/bin/bash
# QA-ONLY. Plan step r9 — the containment gate, run before every first boot of a
# (re)built QA world. Starts a throwaway `systemd-run --user --wait --collect` unit
# with EXACTLY the QA unit's sandbox (lib.sh: qa_unit_properties + qa_exec_prefix,
# the same functions start.sh uses) and proves, by trying, that production is
# read-only or invisible, GitHub has no identity, the bus and production's ports
# and processes are unreachable, the QA home is writable, and pi works with the QA
# agent dir. A second unit — the same sandbox minus PrivateNetwork — proves the
# push fails on authentication, not merely on the missing network.
# Writes $qa/qa/probe.log; on success its last line is `PROBE PASSED sandbox=<digest>`,
# which start.sh requires. Exit 1 if any expectation fails.
#   usage: probe.sh [--qa-home /home/Carl/.t3/qa-pull9] [--pi-checkout <loom checkout>]
set -euo pipefail
source "$(dirname "$0")/lib.sh"
qa_strip_env
qa=$QA_HOME_DEFAULT checkout=
while [[ $# -gt 0 ]]; do
  case $1 in
    --qa-home) qa=$2; shift 2 ;;
    --pi-checkout) checkout=$2; shift 2 ;;
    *) qa_die "unknown argument $1" ;;
  esac
done
qa_require_home "$qa"
[[ -f $qa/pi-agent/models.json && -d $qa/pi-sessions ]] || qa_die "$qa has no pi-agent/ or pi-sessions/ (build-home.sh first)"
checkout=${checkout:-$([[ -d $qa/build/loom ]] && echo "$qa/build/loom" || realpath "$QA_TOOLKIT/../..")}
pi_cli=$(realpath "$checkout/apps/server/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")
mkdir -p "$qa/qa"
log=$qa/qa/probe.log
digest=$(qa_sandbox_digest "$qa")
uuid=$(cat /proc/sys/kernel/random/uuid)
cockpit_pid=$(systemctl --user show -p MainPID --value loom-cockpit 2>/dev/null || echo 0)
hash_pi() { sha256sum /home/Carl/.pi/agent/{auth.json,settings.json,trust.json} 2>/dev/null; find /home/Carl/.pi/agent/extensions -maxdepth 1 | sort | sha256sum; }

exec > >(tee "$log") 2>&1
echo "# probe $(date -u +%FT%TZ)  qa=$qa  sandbox=$digest  pi=$pi_cli  session=$uuid  cockpit-pid=$cockpit_pid"
qa_unit_properties "$qa"
qa_exec_prefix "$qa"
echo "# unit properties:"; printf '#   %s\n' "${QA_PROPS[@]}" | grep -v '^#   -p$'
echo "# exec prefix: ${QA_EXEC[*]:0:10} …env -i <${#QA_ENV[@]} vars>"; printf '#   env %s\n' "${QA_ENV[@]}"
pi_before=$(hash_pi)

status=0
qa_start_bridge "$qa" loom-qa-pull9-probe-bridge probe
systemd-run --user --quiet --wait --collect --pipe --unit="loom-qa-pull9-probe-$$" "${QA_PROPS[@]}" \
  -- "${QA_EXEC[@]}" /bin/bash "$QA_TOOLKIT/sandbox-entry.sh" "$qa" probe full "$pi_cli" "$uuid" "$cockpit_pid" </dev/null || status=1
systemctl --user stop loom-qa-pull9-probe-bridge

echo; echo "== Same sandbox minus PrivateNetwork: the push must fail on authentication"
netprops=()
for p in "${QA_PROPS[@]}"; do [[ $p == PrivateNetwork=yes ]] && unset 'netprops[-1]' || netprops+=("$p"); done
out=$(systemd-run --user --quiet --wait --collect --pipe --unit="loom-qa-pull9-probe-net-$$" "${netprops[@]}" \
  -- "${QA_EXEC[@]}" /bin/bash "$QA_TOOLKIT/probe-inner.sh" "$qa" push </dev/null 2>&1) || status=1
echo "$out"
grep -qE "could not read Username|Authentication failed|terminal prompts disabled|403|401" <<<"$out" ||
  { echo "FAIL  the push did not fail on authentication"; status=1; }

echo; echo "== Host-side checks"
pi_after=$(hash_pi)
echo "$pi_before" | sed 's/^/  before /'; echo "$pi_after" | sed 's/^/  after  /'
[[ $pi_before == "$pi_after" ]] && echo "PASS  ~/.pi/agent hashes unchanged" || { echo "FAIL  ~/.pi/agent changed"; status=1; }
leaked=$(find /home/Carl/.pi/agent/sessions -maxdepth 2 -name "*_$uuid.jsonl" 2>/dev/null)
[[ -z $leaked ]] && echo "PASS  no probe session under ~/.pi/agent/sessions" || { echo "FAIL  session leaked: $leaked"; status=1; }
ls -la "$qa"/pi-sessions/*_"$uuid".jsonl 2>/dev/null | sed 's/^/  /'
[[ $status -eq 0 ]] && echo "PROBE PASSED sandbox=$digest" || echo "PROBE FAILED sandbox=$digest"
exit "$status"
