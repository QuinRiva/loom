#!/bin/bash
# QA-ONLY. Stops the QA unit (systemctl waits for the stop job; the unit's whole
# cgroup — server, pi children, relays — goes with it), then the bridge unit.
# Never kill a QA process by name: production's server has a similar argv.
set -euo pipefail
source "$(dirname "$0")/lib.sh"
for unit in "$QA_UNIT" "$QA_BRIDGE_UNIT"; do
  if systemctl --user is-active --quiet "$unit"; then
    systemctl --user stop "$unit"
    qa_log "stopped $unit"
  fi
  ! systemctl --user is-active --quiet "$unit" || qa_die "$unit is still active"
done
