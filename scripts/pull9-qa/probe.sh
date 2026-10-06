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
# Run it from the build: <qa>/build/loom/scripts/pull9-qa/probe.sh — the unit sees only the QA home.
#   usage: probe.sh [--qa-home /home/Carl/.t3/qa-pull9]
set -euo pipefail
source "$(dirname "$0")/lib.sh"
qa_strip_env
qa=$QA_HOME_DEFAULT
[[ ${1:-} == --qa-home ]] && qa=$2
qa_require_home "$qa"
qa_require_toolkit_in_build "$qa"
[[ -f $qa/pi-agent/models.json && -d $qa/pi-sessions ]] || qa_die "$qa has no pi-agent/ or pi-sessions/ (build-home.sh first)"
pi_cli=$(realpath "$qa/build/loom/apps/server/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js")
[[ $pi_cli == "$qa/build/"* ]] || qa_die "the build's bundled pi resolves outside the build ($pi_cli)"
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
# Host facts for the inside half: every listening unix socket outside the private /run, /tmp,
# /var/tmp and the QA home (each must be invisible inside), and a /dev/shm marker.
ss -xlH | awk '{print $5}' | grep '^/' | grep -vE "^(/run/|/tmp/|/var/tmp/|$qa/)" | sort -u >"$qa/qa/host-sockets.txt" || true
echo "# host listening unix sockets checked inside: $(wc -l <"$qa/qa/host-sockets.txt")"
touch "/dev/shm/qa-probe-$uuid"

status=0
qa_start_bridge "$qa" loom-qa-pull9-probe-bridge probe
systemd-run --user --quiet --wait --collect --pipe --unit="loom-qa-pull9-probe-$$" "${QA_PROPS[@]}" \
  -- "${QA_EXEC[@]}" /bin/bash "$QA_TOOLKIT/sandbox-entry.sh" "$qa" probe full "$pi_cli" "$uuid" "$cockpit_pid" </dev/null || status=1
rm -f "/dev/shm/qa-probe-$uuid"

echo; echo "== Host side: the relay refuses a management call carrying cliproxy's REAL management key (read here, never given to the unit)"
# The key stays in this host shell; the request goes to the relay's socket, not to cliproxy.
mgmt=$(curl -s -w ' %{http_code}' --unix-socket "$qa/run/cliproxy.sock" -H "Authorization: Bearer $(cat /home/Carl/cli-proxy/.mgmtkey)" \
  http://relay/v0/management/auth-files)
echo "  GET /v0/management/auth-files with the real key via the relay → $mgmt"
[[ $mgmt == "qa relay: refused GET /v0/management/auth-files"*" 403" ]] && echo "PASS  refused by the relay" || { echo "FAIL  the relay did not refuse"; status=1; }
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
grep -q "^PASS .*touch $qa/build/" "$log" || { echo "FAIL  the build's read-only check did not run (build $qa/build missing?)"; status=1; }
[[ $status -eq 0 ]] && echo "PROBE PASSED sandbox=$digest" || echo "PROBE FAILED sandbox=$digest"
exit "$status"
