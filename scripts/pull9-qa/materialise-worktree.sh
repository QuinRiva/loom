#!/bin/bash
# QA-ONLY. Plan step b6: give an imported thread its worktree back, inside the QA world.
# Reads the thread's branch and RELOCATED worktree_path from the QA copy (read-only) and runs
# `git worktree add` in the QA clone of loom at exactly that path. Refuses any path outside
# <qa>/worktrees/, a thread whose project is not the cloned loom, and an existing path.
#   usage: materialise-worktree.sh <threadId> [--qa-home /home/Carl/.t3/qa-pull9]
set -euo pipefail
source "$(dirname "$0")/lib.sh"
qa_strip_env
tid=${1:?usage: materialise-worktree.sh <threadId> [--qa-home P]}
qa=$QA_HOME_DEFAULT
[[ ${2:-} == --qa-home ]] && qa=$3
qa_require_home "$qa"
[[ $tid =~ ^[A-Za-z0-9-]+$ ]] || qa_die "thread id '$tid' is not [A-Za-z0-9-]+"
clone=$qa/repos/loom
IFS=$'\x1f' read -r branch path root < <(sqlite3 -batch -noheader -separator $'\x1f' -readonly "file:$qa/userdata/state.sqlite?mode=ro" \
  "SELECT t.branch, t.worktree_path, p.workspace_root FROM projection_threads t JOIN projection_projects p USING (project_id) WHERE t.thread_id = '$tid'") ||
  qa_die "no thread $tid in $qa/userdata/state.sqlite"
[[ -n $branch && -n $path ]] || qa_die "thread $tid has no branch or worktree path (branch '$branch', path '$path')"
[[ $root == "$clone" ]] || qa_die "thread $tid belongs to project root $root — only $clone is cloned"
[[ $path == "$qa/worktrees/"?* && $path != *"/.."* && $path != *"/./"* && $(realpath -m "$path") == "$path" ]] ||
  qa_die "worktree path $path is not inside $qa/worktrees/"
[[ ! -e $path ]] || qa_die "$path exists"
if git -C "$clone" show-ref --verify --quiet "refs/heads/$branch"; then
  git -C "$clone" worktree add "$path" "$branch"
elif git -C "$clone" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
  git -C "$clone" worktree add -b "$branch" "$path" "origin/$branch"
else
  qa_die "branch $branch is not in the QA clone (neither local nor origin/$branch)"
fi
qa_log "materialised $tid: $path on $branch ($(git -C "$path" rev-parse --short HEAD))"
