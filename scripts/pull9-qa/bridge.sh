#!/bin/bash
# QA-ONLY. Host side of the QA unit's network boundary, run as its own small unit
# (qa_start_bridge in lib.sh). The QA unit has PrivateNetwork=yes; these two relays
# are the only flows across it:
#   out: <qa>/run/cliproxy.sock → 127.0.0.1:8317 (the cliproxy every cliproxy/* model uses)
#   in:  127.0.0.1:13940 → <qa>/run/server.sock (Carl's browser → the QA server; server mode only)
# The inner halves live in sandbox-entry.sh.
set -euo pipefail
qa=$1 mode=$2
source "$(dirname "$0")/lib.sh"
qa_require_home "$qa"
rm -f "$qa/run/cliproxy.sock"
socat "UNIX-LISTEN:$qa/run/cliproxy.sock,fork,mode=600" "TCP:127.0.0.1:$QA_CLIPROXY_PORT" &
if [[ $mode == server ]]; then
  socat "TCP-LISTEN:$QA_PORT,bind=127.0.0.1,fork,reuseaddr" "UNIX-CONNECT:$qa/run/server.sock" &
fi
wait -n
exit 1
