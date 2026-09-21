#!/usr/bin/env bash
# Which names a merged file references but no longer declares/imports, and which
# parent still has them. Usage: whatismissing.sh <path-relative-to-repo-root> <name>...
set -euo pipefail
f="$1"; shift
for n in "$@"; do
  echo "### $n"
  for r in c14f6015bf 5c350f7a63; do
    label=$([ "$r" = c14f6015bf ] && echo upstream || echo loom)
    hit=$(git show "$r:$f" 2>/dev/null | grep -nE "(const|function|class|type|interface|import).*\b$n\b" | head -3 || true)
    [ -n "$hit" ] && echo "  [$label] $hit"
  done
done
