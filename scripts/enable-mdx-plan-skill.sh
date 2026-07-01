#!/usr/bin/env bash
# Enable the first-party `mdx-visual-plan` authoring skill for a coding provider
# by symlinking this repo's `skills/mdx-visual-plan/` into the provider's skill
# directory (Option A from docs/mdx-plan-authoring-skill-integration.md).
#
# The provider discovers skills natively from its home dir, so a symlink is all
# that is needed — and it keeps the skill reviewed/diffed as a repo file while
# tracking edits live. Idempotent and trivially reversible (delete the link).
#
# Usage:
#   scripts/enable-mdx-plan-skill.sh [codex|claude|all]   # default: all
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$repo_root/skills/mdx-visual-plan"
target="${1:-all}"

[ -d "$src" ] || { echo "skill source not found: $src" >&2; exit 1; }

link_into() {
  local dir="$1" dest="$1/mdx-visual-plan"
  mkdir -p "$dir"
  ln -sfn "$src" "$dest"
  echo "linked $dest -> $src"
}

case "$target" in
  codex) link_into "$HOME/.codex/skills" ;;
  claude) link_into "$HOME/.claude/skills" ;;
  all) link_into "$HOME/.codex/skills"; link_into "$HOME/.claude/skills" ;;
  *) echo "usage: $0 [codex|claude|all]" >&2; exit 2 ;;
esac

echo "Done. Restart/reload the provider session so it re-lists skills."
