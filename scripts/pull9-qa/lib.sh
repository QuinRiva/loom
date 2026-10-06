# shellcheck shell=bash
# QA-ONLY — never run against the cockpit home. Sourced by every script in
# scripts/pull9-qa/: the constants, the path allow-list, and the ONE definition
# of the sandbox (unit properties + environment + namespace wrapper) shared by
# start.sh and probe.sh so the probe tests exactly what the server runs under.
set -euo pipefail

QA_TOOLKIT=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
QA_HOME_DEFAULT=/home/Carl/.t3/qa-pull9
QA_PORT=13940
QA_UNIT=loom-qa-pull9
QA_BRIDGE_UNIT=loom-qa-pull9-bridge
QA_CLIPROXY_PORT=8317
QA_NODE=/home/Carl/.n/bin/node
QA_GITHUB_ORIGIN=https://github.com/QuinRiva/loom.git

# Production — read, never written. The unit makes these read-only or hidden.
PROD_HOME=/home/Carl/.t3/cockpit
PROD_STATE=/home/Carl/.t3/cockpit/userdata
PROD_DB=/home/Carl/.t3/cockpit/userdata/state.sqlite
PROD_WORKTREES=/home/Carl/.t3/cockpit/worktrees
PROD_SESSIONS=/home/Carl/.pi/agent/sessions
PROD_PI_AGENT=/home/Carl/.pi/agent
PROD_REPO=/home/Carl/loom

qa_log() { printf '[%s] %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
qa_die() { printf 'REFUSED: %s\n' "$*" >&2; exit 1; }

# Strip every inherited T3_*, T3CODE_*, PI_* variable (a parent pi or Loom
# server leaks its own home, session dir and MCP bearer into child shells).
qa_strip_env() {
  local var
  for var in $(compgen -e | grep -E '^(T3_|T3CODE_|PI_)' || true); do unset "$var"; done
}

# ALLOW-LIST for a QA home: a direct child of ~/.t3 named qa-*. Everything else —
# the cockpit home, ~/.t3/userdata, a worktree, a symlink — is refused.
qa_check_home_path() {
  [[ $1 =~ ^/home/Carl/\.t3/qa-[a-z0-9][a-z0-9-]*$ ]] ||
    qa_die "QA home '$1' is not /home/Carl/.t3/qa-<name> (the only allowed shape; never the cockpit home or ~/.t3/userdata)"
}
qa_require_home() {
  qa_check_home_path "$1"
  [[ -d $1 && ! -L $1 && $(realpath "$1") == "$1" ]] || qa_die "QA home $1 is not an existing real directory"
}

# The sandbox. Every property here is load-bearing; PrivateUsers=yes is what
# makes the path properties take effect in a user unit on this host's systemd
# 247 (without it they are silently ignored). See README "The sandbox".
qa_unit_properties() { # $1 = QA home → QA_PROPS
  local qa=$1
  QA_PROPS=(
    -p PrivateUsers=yes
    -p NoNewPrivileges=yes
    -p PrivateNetwork=yes
    -p PrivateTmp=yes
    -p ProtectHome=read-only
    -p TemporaryFileSystem=/run
    -p "ReadWritePaths=$qa"
    -p "ReadOnlyPaths=-$qa/build"
    -p "ReadOnlyPaths=/home/Carl/.t3/cockpit -/home/Carl/.t3/userdata -/home/Carl/.t3/worktrees /home/Carl/loom-releases /home/Carl/loom /home/Carl/.pi"
    -p "InaccessiblePaths=/home/Carl/.t3/cockpit/userdata -/home/Carl/.git-credentials -/home/Carl/.config/gh -/home/Carl/.ssh -/home/Carl/.config/carl-roobot -/home/Carl/.netrc -/home/Carl/.gcp -/home/Carl/.config/gcloud -/home/Carl/.docker -/home/Carl/.slack -/home/Carl/.config/loom-cockpit.env"
    -p "UnsetEnvironment=DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR"
  )
}

# The complete environment of every process in the unit (env -i: nothing is
# inherited, so no credential variable can leak in). No GH_TOKEN, no Google or
# Vertex variable: the unit has no network beyond the cliproxy bridge.
qa_unit_env() { # $1 = QA home → QA_ENV
  local qa=$1
  QA_ENV=(
    HOME=/home/Carl USER=Carl LOGNAME=Carl "LANG=${LANG:-C.UTF-8}" SHELL=/bin/bash TMPDIR=/tmp
    "PATH=$qa/build/loom/node_modules/.bin:/home/Carl/.n/bin:/home/Carl/.local/share/pnpm:/usr/local/bin:/usr/bin:/bin"
    "T3CODE_HOME=$qa" T3CODE_NO_BROWSER=1 T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=false
    "PI_CODING_AGENT_DIR=$qa/pi-agent" "PI_CODING_AGENT_SESSION_DIR=$qa/pi-sessions"
    GIT_TERMINAL_PROMPT=0 GCM_INTERACTIVE=never
    "XDG_CACHE_HOME=$qa/cache" "npm_config_cache=$qa/cache/npm" npm_config_package_import_method=copy
  )
}

# Own PID namespace (production's processes are invisible, so neither kill nor
# /proc/<pid>/environ reaches them) via a nested user namespace, then the env
# allow-list. $1 = QA home; the rest is the command.
qa_exec_prefix() { # → QA_EXEC
  qa_unit_env "$1"
  QA_EXEC=(/usr/bin/unshare --user --map-current-user --mount --pid --fork --mount-proc --kill-child --
    /usr/bin/env -i "${QA_ENV[@]}")
}

# Host side of the two unix-socket bridges: the only flows across the unit's
# network boundary are QA port 13940 (in) and cliproxy 8317 (out).
qa_start_bridge() { # $1 = QA home, $2 = unit name, $3 = mode (server|probe)
  mkdir -p "$1/run"
  rm -f "$1/run/cliproxy.sock" # so the wait below sees the new listener, not a stale socket
  systemd-run --user --quiet --collect --unit="$2" \
    -p PrivateUsers=yes -p NoNewPrivileges=yes -p PrivateTmp=yes -p ProtectHome=read-only \
    -p "ReadWritePaths=$1/run" -p TemporaryFileSystem=/run \
    -- /bin/bash "$QA_TOOLKIT/bridge.sh" "$1" "$3"
  local i
  for i in $(seq 50); do [[ -S $1/run/cliproxy.sock ]] && return 0; sleep 0.1; done
  qa_die "bridge unit $2 did not create $1/run/cliproxy.sock (journalctl --user -u $2)"
}

# Identity of the sandbox definition: probe.sh records it on PROBE PASSED and
# start.sh refuses to start under a definition no probe has passed.
qa_sandbox_digest() { # $1 = QA home
  qa_unit_properties "$1"; qa_exec_prefix "$1"
  printf '%s\n' "${QA_PROPS[@]}" "${QA_EXEC[@]}" | sha256sum | cut -c1-16
}

qa_port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
