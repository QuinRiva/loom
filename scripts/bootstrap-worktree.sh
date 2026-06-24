#!/usr/bin/env bash
# Bootstrap a fresh git worktree so coding agents never have to discover setup.
#
# Invoked by T3 Code's `runOnWorktreeCreate` project script. T3 Code runs this
# in a terminal opened in the new worktree, with these env vars available:
#   T3CODE_PROJECT_ROOT  - the primary checkout (source of gitignored local files)
#   T3CODE_WORKTREE_PATH - the newly created worktree (our target cwd)
#
# A fresh `git worktree add` contains only tracked files: no node_modules, no
# gitignored local env. This script restores both.
set -euo pipefail

cd "${T3CODE_WORKTREE_PATH:-$PWD}"

# Carry over gitignored local env from the primary checkout if it exists.
# Optional for this repo (only enables local T3 Connect features), but harmless.
if [ -n "${T3CODE_PROJECT_ROOT:-}" ] && [ -f "$T3CODE_PROJECT_ROOT/.env" ] && [ ! -f .env ]; then
  cp "$T3CODE_PROJECT_ROOT/.env" .env
fi

# Install dependencies. Deps hardlink into the shared global pnpm store (cheap,
# no per-worktree duplication). The dev server watches only source dirs via
# --watch-path, so this hardlink churn no longer triggers spurious restarts.
#
# If you ever run the dev server WITHOUT the --watch-path change, add
# `--package-import-method=copy` here to avoid sharing store inodes.
pnpm install --prefer-offline
