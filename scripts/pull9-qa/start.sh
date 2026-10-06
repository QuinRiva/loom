#!/bin/bash
# QA-ONLY — never run against the cockpit home. The ONLY way the QA server is
# started: the bridge unit, then the sandboxed transient unit loom-qa-pull9 running
# build/loom's server with --base-dir <qa> --port 13940. A hand-started server
# without this unit's environment would index pi's default sessions root and bind
# production's session files. Logs: journalctl --user -u loom-qa-pull9 -f
#   usage: start.sh [--qa-home /home/Carl/.t3/qa-pull9]
set -euo pipefail
source "$(dirname "$0")/lib.sh"
qa_strip_env
qa=$QA_HOME_DEFAULT
[[ ${1:-} == --qa-home ]] && qa=$2
qa_require_home "$qa"

qa_unit_properties "$qa"
printf '%s\n' "${QA_PROPS[@]}" | grep -qx 'PrivateUsers=yes' ||
  qa_die "the unit's property list lacks PrivateUsers=yes — every path property would be silently ignored"
for unit in "$QA_UNIT" "$QA_BRIDGE_UNIT"; do
  ! systemctl --user is-active --quiet "$unit" || qa_die "$unit is already active (stop.sh first)"
done
[[ -f $qa/build/loom/apps/server/dist/bin.mjs ]] || qa_die "no build at $qa/build/loom (run build-loom.sh)"
digest=$(qa_sandbox_digest "$qa")
grep -qx "PROBE PASSED sandbox=$digest" "$qa/qa/probe.log" 2>/dev/null ||
  qa_die "no passing sandbox probe for this sandbox definition ($digest) in $qa/qa/probe.log — run probe.sh"
! qa_port_busy "$QA_PORT" || qa_die "port $QA_PORT is busy"

# server-runtime.json: a pid written by a previous unit run is a pid in that run's
# own PID namespace and means nothing here; the server's own boot check handles it.
# What we refuse is a live host process serving this home (a hand-started server).
runtime=$qa/userdata/server-runtime.json
if [[ -f $runtime ]]; then
  pid=$(jq -r '.pid // empty' "$runtime")
  if [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null && tr '\0' ' ' <"/proc/$pid/cmdline" | grep -qF -- "$qa"; then
    qa_die "$runtime names live pid $pid serving $qa outside the unit — stop it by that pid"
  fi
  qa_log "server-runtime.json present (pid ${pid:-?}); not a live host server for $qa — left for the server's own check"
fi

qa_exec_prefix "$qa"
qa_start_bridge "$qa" "$QA_BRIDGE_UNIT" server
qa_log "bridge $QA_BRIDGE_UNIT active: 127.0.0.1:$QA_PORT → $qa/run/server.sock, $qa/run/cliproxy.sock → 127.0.0.1:$QA_CLIPROXY_PORT"
systemd-run --user --quiet --collect --unit="$QA_UNIT" "${QA_PROPS[@]}" -p TimeoutStopSec=30 \
  -- "${QA_EXEC[@]}" /bin/bash "$QA_TOOLKIT/sandbox-entry.sh" "$qa" server
qa_log "started $QA_UNIT on 127.0.0.1:$QA_PORT (journalctl --user -u $QA_UNIT -f)"
