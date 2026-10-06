#!/bin/bash
# QA-ONLY. Plan step r8: the build the QA unit runs — a clone of the integration branch at
# <ref> under <qa>/build/loom, installed and built. Never the release store (~/loom-releases is
# production's; no deployctl, no --build-only). The unit mounts <qa>/build read-only.
#   usage: build-loom.sh --ref <commit-or-branch> [--qa-home /home/Carl/.t3/qa-pull9] [--source-repo /home/Carl/loom]
set -euo pipefail
source "$(dirname "$0")/lib.sh"
qa_strip_env
qa=$QA_HOME_DEFAULT src_repo=$PROD_REPO ref=
while [[ $# -gt 0 ]]; do
  case $1 in
    --ref) ref=$2 ;; --qa-home) qa=$2 ;; --source-repo) src_repo=$2 ;;
    *) qa_die "unknown argument $1" ;;
  esac
  shift 2
done
[[ -n $ref ]] || qa_die "--ref is required (the integration branch commit the QA soak runs)"
qa_require_home "$qa"
[[ ! -e $qa/build/loom ]] || qa_die "$qa/build/loom exists (update it in place: git -C … pull && vp i && pnpm build)"
! systemctl --user is-active --quiet "$QA_UNIT" || qa_die "$QA_UNIT is running"
mkdir -p "$qa/build"
git clone --quiet --no-local "$src_repo" "$qa/build/loom" # eta: ~2 min
git -C "$qa/build/loom" checkout --quiet --detach "$ref"
git -C "$qa/build/loom" remote remove origin # nothing pushes from the build
cd "$qa/build/loom"
CI=true vp i --no-frozen-lockfile # eta: ~5 min
pnpm build                        # eta: ~5 min
[[ -f apps/server/dist/bin.mjs ]] || qa_die "build produced no apps/server/dist/bin.mjs"
git rev-parse HEAD | tee "$qa/qa/build-commit.txt"
qa_log "built $(cat "$qa/qa/build-commit.txt") at $qa/build/loom; next: probe.sh, then start.sh"
