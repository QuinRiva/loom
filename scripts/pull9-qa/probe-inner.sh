#!/bin/bash
# QA-ONLY. The containment probe's inside half: runs INSIDE a unit with the QA
# unit's exact properties (probe.sh starts it through sandbox-entry.sh). Every
# check prints the command, its exit code and its refusal text. Exit 1 if any
# expectation fails.
#   usage (via sandbox-entry.sh): probe-inner.sh <qa> full <pi-cli> <uuid> <cockpit-pid>
#                                 probe-inner.sh <qa> push
# Host facts the probe needs (written by probe.sh before the unit starts):
#   <qa>/qa/host-sockets.txt  every listening unix socket on the host outside /run, /tmp, /var/tmp and the QA home
#   /dev/shm/qa-probe-<uuid>  a host /dev/shm marker that must not be visible inside
set -uo pipefail
qa=$1 mode=$2 pi_cli=${3:-} uuid=${4:-} cockpit_pid=${5:-}
fails=0

run() { # $1 = expect (fail|ok), $2 = regex the output must match ('' = any), rest = command
  local expect=$1 want=$2 out code verdict
  shift 2
  out=$("$@" 2>&1)
  code=$?
  if [[ $expect == fail ]]; then [[ $code -ne 0 ]] && verdict=PASS || verdict=FAIL; else [[ $code -eq 0 ]] && verdict=PASS || verdict=FAIL; fi
  [[ -n $want && $verdict == PASS ]] && ! grep -qE -- "$want" <<<"$out" && verdict=FAIL
  [[ $verdict == FAIL ]] && fails=$((fails + 1))
  printf '%s  expect=%s  exit=%s  $ %s\n' "$verdict" "$expect" "$code" "$*"
  [[ -n $out ]] && head -c 600 <<<"$out" | sed 's/^/      | /'
  return 0
}
# A write that must fail; if it ever succeeds the file is removed at once.
nowrite() { # $1 = dir, $2 = refusal regex
  local f=$1/.qa-probe-$$
  run fail "$2" touch "$f"
  [[ -e $f ]] && rm -f "$f" && echo "      ! created and removed $f"
  return 0
}
section() { printf '\n== %s\n' "$*"; }

push_repo() {
  if [[ -d $qa/repos/loom/.git ]]; then echo "$qa/repos/loom"; return; fi
  local r=$qa/qa/probe-repo
  [[ -d $r/.git ]] || { git init -q "$r" && git -C "$r" -c user.name=qa -c user.email=qa@invalid commit -q --allow-empty -m probe; } >/dev/null
  echo "$r"
}
probe_push() {
  section "GitHub: no identity, a dry-run push fails (never succeeds; --dry-run writes nothing even if it authenticated)"
  run fail '' gh auth status
  run fail '' bash -c "printf 'protocol=https\nhost=github.com\n\n' | git credential fill"
  run fail '' git -C "$(push_repo)" push --dry-run https://github.com/QuinRiva/loom.git HEAD:refs/heads/qa-probe-never
  run fail '' bash -c "env | grep -iE '^(GH_|GITHUB_|GOOGLE_|AWS_|DBUS_)|TOKEN|SECRET|PASSWORD|API_KEY'"
}

echo "probe-inner mode=$mode uid=$(id -u) pid=$$ qa=$qa"
if [[ $mode == push ]]; then
  probe_push
else
  section "Production paths do not exist inside (the home is an empty read-only tmpfs + an allow-list of binds)"
  for d in /home/Carl/.t3/cockpit /home/Carl/.t3/cockpit/worktrees /home/Carl/.t3/userdata /home/Carl/.t3/worktrees \
    /home/Carl/loom-releases /home/Carl/loom /home/Carl/loom/.git /home/Carl/.pi/agent/sessions /home/Carl/.pi/agent \
    /home/Carl/.pi/agent/extensions /home/Carl/pi-craft /home/Carl/cli-proxy /home/Carl/.config/systemd/user; do
    nowrite "$d" 'No such file or directory'
  done
  section "What is visible outside the QA home is read-only"
  for d in /home/Carl /home/Carl/.t3 /home/Carl/.n /home/Carl/.local/share/pnpm "$qa/build"; do
    [[ -d $d ]] && nowrite "$d" 'Read-only file system'
  done
  run ok '' bash -c "ls -A /home/Carl /home/Carl/.t3"

  section "Credentials, production state and host sockets are unreachable"
  for f in /home/Carl/.git-credentials /home/Carl/.config/gh/hosts.yml /home/Carl/.ssh /home/Carl/.config/carl-roobot/config.json \
    /home/Carl/.t3/cockpit/userdata/state.sqlite /home/Carl/.t3/cockpit/userdata/secrets/server-signing-key.bin \
    /home/Carl/cli-proxy/.mgmtkey /home/Carl/cli-proxy/.apikey "/run/user/$(id -u)/bus" /run/docker.sock /var/run/docker.sock; do
    run fail 'No such file or directory' ls -d "$f"
  done
  run fail '' socat -u /dev/null UNIX-CONNECT:/home/Carl/.pi/agent/intercom/broker.sock
  while read -r sock; do
    run fail 'No such file or directory' ls -d "$sock" # path lookup only: never connect to a live host socket
  done <"$qa/qa/host-sockets.txt"
  run fail 'No such file or directory' ls -d "/dev/shm/qa-probe-$uuid"
  run fail '' systemctl --user status
  run fail '' sudo -n true

  section "cliproxy relay forwards inference only: management and everything else refused (403 from the relay)"
  for req in "GET /v0/management/auth-files" "POST /v0/management/auth-files" "PUT /v0/management/config.yaml" \
    "DELETE /v0/management/auth-files" "GET /v1/messages" "POST /v1/messages/../../v0/management/auth-files" \
    "POST /v1/%2e%2e/v0/management/auth-files" "POST /v0/management/api-call" "GET /v1/models"; do
    run ok '^403 qa relay: refused' bash -c "curl -s --path-as-is -X ${req% *} -H 'Authorization: Bearer probe-not-a-key' \
      -w '%{http_code} ' -o /tmp/r 'http://127.0.0.1:8317${req#* }' && cat /tmp/r"
  done

  probe_push

  section "Network: loopback only; production's ports unreachable"
  run ok '' bash -c "ip -o link | cut -c1-60; [ \$(ip -o link | wc -l) -eq 1 ] && ip -o link | grep -q '^1: lo:'"
  for port in 9229 13900 13901 13910 5433 6333; do
    run fail 'refused' bash -c "exec 3<>/dev/tcp/127.0.0.1/$port"
  done
  run fail '' getent hosts github.com

  section "Own PID namespace: production processes invisible"
  run ok '' bash -c "ls /proc | grep -cE '^[0-9]+$'"
  [[ -n $cockpit_pid && $cockpit_pid != 0 ]] && run fail 'No such process' kill -0 "$cockpit_pid"

  section "The QA home is writable"
  run ok '' bash -c "touch '$qa/qa/.probe-$uuid' && rm '$qa/qa/.probe-$uuid'"

  section "pi one-shot with the QA agent dir (cliproxy via the bridge)"
  cd "$qa/qa"
  model=cliproxy/claude-sonnet-5-5
  run ok '' bash -c "env | grep -E '^PI_CODING_AGENT_(DIR|SESSION_DIR)='"
  run ok '(^|[^a-z])ok' node "$pi_cli" -p "Reply with the single word: ok" --model "$model" --session-id "$uuid"
  run ok '' bash -c "ls $qa/pi-sessions/*_$uuid.jsonl"
  f=$(ls "$qa"/pi-sessions/*_"$uuid".jsonl 2>/dev/null | head -1)
  before=$(wc -l <"$f" 2>/dev/null || echo 0)
  run ok '' node "$pi_cli" -p "Reply with the word you replied with last time, nothing else." --model "$model" --session-id "$uuid"
  run ok '' bash -c "n=\$(ls $qa/pi-sessions/*_$uuid.jsonl | wc -l); l=\$(wc -l < '$f'); echo files=\$n lines=$before'->'\$l; [ \$n -eq 1 ] && [ \$l -gt $before ]"
  # One command at a time, each answered before the next (pi handles RPC commands concurrently).
  rpc=$(timeout 120 python3 - "$pi_cli" "$model" "$f" "$qa/qa" <<'PY'
import json, subprocess, sys
cli, model, path, cwd = sys.argv[1:]
p = subprocess.Popen(["node", cli, "--mode", "rpc", "--model", model], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
for cmd in [{"id": "a", "type": "switch_session", "sessionPath": path, "cwdOverride": cwd}, {"id": "b", "type": "get_state"},
            {"id": "c", "type": "new_session"}, {"id": "d", "type": "get_state"}]:
    p.stdin.write(json.dumps(cmd) + "\n"); p.stdin.flush()
    for line in p.stdout:
        try: msg = json.loads(line)
        except ValueError: continue
        if msg.get("type") == "response" and msg.get("id") == cmd["id"]:
            data = msg.get("data") or {}
            print(json.dumps({"id": cmd["id"], "success": msg.get("success"), "error": msg.get("error"),
                              "sessionFile": data.get("sessionFile") if isinstance(data, dict) else None}))
            break
p.stdin.close(); p.wait(timeout=30)
PY
)
  echo "      rpc responses:"; sed 's/^/      | /' <<<"$rpc"
  run ok '^true$' jq -r 'select(.id=="a") | .success' <<<"$rpc"
  run ok "^$f$" jq -r 'select(.id=="b") | .sessionFile' <<<"$rpc"
  run ok "^$qa/pi-sessions/[^/]+\.jsonl$" jq -r 'select(.id=="d") | .sessionFile' <<<"$rpc"
  run ok '' test "$(jq -r 'select(.id=="d") | .sessionFile' <<<"$rpc")" != "$f"
fi

printf '\nprobe-inner: %s expectation(s) failed\n' "$fails"
exit $((fails > 0))
