#!/usr/bin/env bash
# Enable the first-party MDX document-authoring skills for a coding provider by
# symlinking this repo's skill directories into the provider's skill directory
# (Option A from docs/mdx-plan-authoring-skill-integration.md).
#
# Three sibling directories are linked together:
#   - skills/mdx-visual-plan   (implementation-plan genre skill)
#   - skills/mdx-visual-recap  (recap / decision-batch genre skill)
#   - skills/mdx-doc-core      (shared reference core — NOT a skill itself, but
#                               the genre skills reference it via `../mdx-doc-core`,
#                               so it must sit beside them or the links dangle)
#
# The provider discovers skills natively from its home dir, so symlinks are all
# that is needed — and it keeps the skills reviewed/diffed as repo files while
# tracking edits live. Idempotent and trivially reversible (delete the links).
#
# Usage:
#   scripts/enable-mdx-doc-skills.sh [codex|claude|all]   # default: all
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
skills_dirs=(mdx-visual-plan mdx-visual-recap mdx-doc-core)
target="${1:-all}"

for name in "${skills_dirs[@]}"; do
  [ -d "$repo_root/skills/$name" ] || {
    echo "skill source not found: $repo_root/skills/$name" >&2
    exit 1
  }
done

link_into() {
  local dir="$1"
  mkdir -p "$dir"
  for name in "${skills_dirs[@]}"; do
    ln -sfn "$repo_root/skills/$name" "$dir/$name"
    echo "linked $dir/$name -> $repo_root/skills/$name"
  done
}

case "$target" in
  codex) link_into "$HOME/.codex/skills" ;;
  claude) link_into "$HOME/.claude/skills" ;;
  all) link_into "$HOME/.codex/skills"; link_into "$HOME/.claude/skills" ;;
  *) echo "usage: $0 [codex|claude|all]" >&2; exit 2 ;;
esac

echo "Done. Restart/reload the provider session so it re-lists skills."
