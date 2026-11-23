#!/usr/bin/env python3
"""Appendix C input: silently merged both-modified files, by zone, with Loom-line survival.

For every path in <out>/both-modified-automerged.txt (files both sides changed that git
merged with no marker) count lines mentioning `loom` (case-sensitive, a superset of
`// loom:` markers) in the trial tree's merged file and in Loom's HEAD blob. A difference
means a Loom line was lost or duplicated by the silent merge; the differing `loom` lines are
printed. Also: upstream first-parent commits touching the path in range, the commit with the
largest change to the path, upstream churn (numstat add+del base..target), and a risk score
(HEAD loom lines x churn) whose top 25 Gate 2 reads first.

Read-only. Run from this worktree's root (the trial worktree is only read):
  python3 docs/upstream-sync/41-cadence-pull-16-20261122/tools/overlap.py \
      .artifacts/pull16-measure /home/Carl/.t3/cockpit/worktrees/loom/t3-7634b056-pull16-trial
Writes <out>/silent-overlap.md and <out>/silent-overlap.json.
"""
import collections, json, os, subprocess, sys

O, TRIAL = sys.argv[1], sys.argv[2]
BASE, UP, HEAD = "3fa57b92a2", "a09738fb43", "HEAD"
git = lambda *a: subprocess.run(["git", *a], capture_output=True, text=True).stdout


def zone(p):
    s = p.removeprefix("apps/server/src/")
    if p.startswith("apps/server/"):
        if s.startswith(("orchestration-v2/", "cli/", "auth/", "observability/Rpc")) or s.split(".")[0] in ("ws", "server", "bin", "serverRuntimeStartup") or s.startswith(("ws/", "server/")):
            return "server-core"
        if s.startswith("persistence/"): return "persistence"
        if s.startswith(("provider/", "mcp/")): return "server-provider/mcp"
        return "server-other"
    if p.startswith("packages/provider-"): return "provider packages"
    for pkg in ("contracts", "shared", "client-runtime"):
        if p.startswith(f"packages/{pkg}/"): return pkg
    if p.startswith("apps/web/"):
        r = p.removeprefix("apps/web/src/")
        if r.startswith(("components/chat/", "components/ChatView", "components/ChatMarkdown", "components/composer",
                         "composerDraftStore", "session-logic", "components/timeline/")):
            return "web-chat"
        if r.startswith(("components/Sidebar", "components/sidebar/", "components/CommandPalette", "components/ThreadRouteView",
                         "components/ThreadNotification", "routes/")):
            return "web-sidebar"
        return "web-panels/other"
    if p.startswith("apps/mobile/"): return "mobile"
    if p.startswith("apps/desktop/"): return "desktop"
    if p.startswith("docs/"): return "docs"
    return "root/config"


def loom_lines(text):
    return [l.strip() for l in text.splitlines() if "loom" in l]


rows = []
for p in open(f"{O}/both-modified-automerged.txt").read().split():
    merged = open(os.path.join(TRIAL, p), errors="replace").read() if os.path.exists(os.path.join(TRIAL, p)) else ""
    mh, hh = loom_lines(merged), loom_lines(git("show", f"{HEAD}:{p}"))
    lost = list((collections.Counter(hh) - collections.Counter(mh)).elements())
    gained = list((collections.Counter(mh) - collections.Counter(hh)).elements())
    # every line Loom added to this file (vs base) should still be in the merged file
    added = [l[1:].strip() for l in git("diff", "-U0", BASE, HEAD, "--", p).splitlines() if l.startswith("+") and not l.startswith("+++") and l[1:].strip()]
    mset = collections.Counter(l.strip() for l in merged.splitlines())
    missing = list((collections.Counter(added) - mset).elements())
    ns = git("diff", "--numstat", BASE, UP, "--", p).split()
    churn = (int(ns[0]) + int(ns[1])) if ns and ns[0] != "-" else 0
    # per-commit numstat for this path, first-parent (upstream lands squash merges)
    log = git("log", "--first-parent", "--numstat", "--format=@%h %s", f"{BASE}..{UP}", "--", p).splitlines()
    commits, cur, best = 0, None, (0, "")
    for l in log:
        if l.startswith("@"):
            commits, cur = commits + 1, l[1:]
        elif l.strip() and cur:
            a, d, *_ = l.split("\t")
            n = (int(a) + int(d)) if a != "-" else 0
            if n > best[0]: best = (n, cur)
    rows.append(dict(path=p, zone=zone(p), merged=len(mh), head=len(hh), lost=lost, gained=gained, added=len(added), missing=missing,
                     commits=commits, churn=churn, top=best[1], top_lines=best[0], score=len(hh) * churn))

json.dump(rows, open(f"{O}/silent-overlap.json", "w"), indent=1)
Z = collections.defaultdict(list)
for r in rows: Z[r["zone"]].append(r)
out = ["# Silently merged overlap (pull 16 trial)", "",
       f"{len(rows)} files both sides changed merged with no marker. `merged` / `HEAD` = lines mentioning `loom` "
       "in the trial tree's merged file / Loom's HEAD blob; `commits` = upstream first-parent commits in range touching "
       "the path; `churn` = upstream add+del base..target; `largest` = the upstream commit with the biggest change to this path.", "",
       "| zone | files | with `loom` | `loom` lines merged | `loom` lines at HEAD | files whose count differs |",
       "| --- | ---: | ---: | ---: | ---: | ---: |"]
for z in sorted(Z):
    rs = Z[z]
    out.append(f"| {z} | {len(rs)} | {sum(r['head'] > 0 for r in rs)} | {sum(r['merged'] for r in rs)} | {sum(r['head'] for r in rs)} | {sum(r['merged'] != r['head'] or bool(r['lost']) for r in rs)} |")
out.append(f"| **total** | **{len(rows)}** | **{sum(r['head'] > 0 for r in rows)}** | **{sum(r['merged'] for r in rows)}** | **{sum(r['head'] for r in rows)}** | **{sum(r['merged'] != r['head'] or bool(r['lost']) for r in rows)}** |")
out += ["", "## Files whose `loom` lines changed in the silent merge", ""]
for r in rows:
    if r["lost"] or r["gained"]:
        out.append(f"### `{r['path']}` ({r['head']} -> {r['merged']})\n")
        out += ["```diff"] + [f"- {l}" for l in r["lost"]] + [f"+ {l}" for l in r["gained"]] + ["```", ""]
out += ["## Loom-added lines (any, marked or not) absent from the merged file", "",
        f"{sum(r['added'] for r in rows)} non-blank lines Loom added across these files; missing from the merged file:", ""]
for r in rows:
    if r["missing"]:
        out += [f"### `{r['path']}` ({len(r['missing'])} of {r['added']})", "", "```"] + r["missing"] + ["```", ""]
out += ["## Top 25 by risk (HEAD `loom` lines x upstream churn)", "", "| # | path | zone | `loom` HEAD | churn | score |", "| ---: | --- | --- | ---: | ---: | ---: |"]
for i, r in enumerate(sorted(rows, key=lambda r: -r["score"])[:25], 1):
    out.append(f"| {i} | `{r['path']}` | {r['zone']} | {r['head']} | {r['churn']} | {r['score']} |")
for z in sorted(Z):
    out += ["", f"## {z} ({len(Z[z])})", "", "| path | `loom` merged | `loom` HEAD | upstream commits | churn | largest upstream commit (lines in this file) |", "| --- | ---: | ---: | ---: | ---: | --- |"]
    for r in Z[z]:
        out.append(f"| `{r['path']}` | {r['merged']} | {r['head']} | {r['commits']} | {r['churn']} | {r['top'].replace('|', '/')} ({r['top_lines']}) |")
open(f"{O}/silent-overlap.md", "w").write("\n".join(out) + "\n")
print(f"{len(rows)} files; differing: {sum(r['merged'] != r['head'] or bool(r['lost']) for r in rows)}")
