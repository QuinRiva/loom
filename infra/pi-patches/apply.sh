#!/usr/bin/env bash
# Re-apply the local pi patches to the installed @earendil-works/pi-coding-agent
# dist. pi ships compiled JS, so patches are applied to dist/ directly and must be
# re-applied after every `pi update` / npm reinstall.
#
# Usage:
#   infra/pi-patches/apply.sh [--check] [--revert] [--pi-root <dir>]
#
#   --check    report whether each patch is already applied; change nothing
#   --revert   reverse the patches
#   --pi-root  package root (default: derived from `which pi`)
set -euo pipefail

PATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE=apply
PI_ROOT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE=check; shift ;;
    --revert) MODE=revert; shift ;;
    --pi-root) PI_ROOT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$PI_ROOT" ]]; then
  pi_bin="$(command -v pi || true)"
  if [[ -z "$pi_bin" ]]; then
    echo "pi not found on PATH; pass --pi-root <package dir>" >&2
    exit 1
  fi
  # <root>/dist/cli.js -> <root>
  PI_ROOT="$(cd "$(dirname "$(readlink -f "$pi_bin")")/.." && pwd)"
fi

if [[ ! -d "$PI_ROOT/dist" ]]; then
  echo "not a pi package root (no dist/): $PI_ROOT" >&2
  exit 1
fi

echo "pi root: $PI_ROOT ($(node -e "console.log(require('$PI_ROOT/package.json').version)"))"

status=0
for patch in "$PATCH_DIR"/*.patch; do
  name="$(basename "$patch")"
  if patch -p1 --dry-run --forward --silent -d "$PI_ROOT" < "$patch" >/dev/null 2>&1; then
    applied=no
  elif patch -p1 --dry-run --reverse --silent -d "$PI_ROOT" < "$patch" >/dev/null 2>&1; then
    applied=yes
  else
    echo "  $name: DOES NOT APPLY CLEANLY (pi upstream drifted — re-derive the patch)"
    status=1
    continue
  fi

  case "$MODE" in
    check)
      echo "  $name: applied=$applied"
      [[ "$applied" == yes ]] || status=1
      ;;
    apply)
      if [[ "$applied" == yes ]]; then
        echo "  $name: already applied"
      else
        # Keep a .orig alongside each patched file for emergency restore.
        patch -p1 --forward --backup --suffix=.orig -d "$PI_ROOT" < "$patch" >/dev/null
        echo "  $name: applied"
      fi
      ;;
    revert)
      if [[ "$applied" == yes ]]; then
        patch -p1 --reverse -d "$PI_ROOT" < "$patch" >/dev/null
        echo "  $name: reverted"
      else
        echo "  $name: not applied"
      fi
      ;;
  esac
done

exit $status
