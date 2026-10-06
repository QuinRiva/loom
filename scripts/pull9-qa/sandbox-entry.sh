#!/bin/bash
# QA-ONLY. PID 1 of the QA unit's own PID namespace (see qa_exec_prefix in lib.sh):
# starts the inner halves of the two bridges, then runs the QA server (mode
# server) or the containment probe (mode probe). Never run by hand.
set -euo pipefail
qa=$1 mode=$2
[[ $PI_CODING_AGENT_DIR == "$qa/pi-agent" && $T3CODE_HOME == "$qa" ]] || { echo "sandbox-entry: wrong environment" >&2; exit 1; }
cd "$qa"
socat "TCP-LISTEN:8317,bind=127.0.0.1,fork,reuseaddr" "UNIX-CONNECT:$qa/run/cliproxy.sock" &
case $mode in
  server)
    rm -f "$qa/run/server.sock"
    socat "UNIX-LISTEN:$qa/run/server.sock,fork,mode=600" "TCP:127.0.0.1:13940" &
    cd "$qa/build/loom"
    /home/Carl/.n/bin/node --max-old-space-size=8192 apps/server/dist/bin.mjs serve \
      --base-dir "$qa" --port 13940 --no-browser &
    ;;
  probe) /bin/bash "$(dirname "$0")/probe-inner.sh" "$qa" "${@:3}" & ;;
  *) echo "sandbox-entry: unknown mode $mode" >&2; exit 1 ;;
esac
main=$!
status=0
wait "$main" || status=$?
exit "$status"
