#!/usr/bin/env python3
"""Classify every conflicted path of an in-progress merge (pull 9 structural zones).

Run from the repo root while the merge is in progress (before `git merge --abort`
or the resolving commit). Reads `<out>/status-v2.txt` (git status --porcelain=v2)
and `<out>/upstream-namestatus.txt` (git diff --name-status <base> <theirs>), and
writes `<out>/conflicts.json`: one row per conflicted path with its kind
(both-modified / modify-delete / add-add / file-location relocation), the
pull-8-side origin path for relocations, the area, the `loom:` count in our blob,
our line count and the `<<<<<<<` marker count in the worktree file.

Usage: classify.py <out-dir>
"""
import json, re, subprocess, sys

O = sys.argv[1]
git = lambda *a: subprocess.run(["git", *a], capture_output=True, text=True).stdout

ren = {}
for l in open(f"{O}/upstream-namestatus.txt"):
    p = l.rstrip("\n").split("\t")
    if p[0].startswith("R"):
        ren[p[2]] = (p[1], p[0])

AREAS = [
    ("apps/server/src/orchestration-v2/", "server/orchestration-v2"),
    ("apps/server/src/orchestration/", "server/orchestration (V1)"),
    ("apps/server/src/mcp/", "server/mcp"),
    ("apps/server/src/provider/", "server/provider"),
    ("apps/server/src/persistence/", "server/persistence"),
    ("apps/server/", "server/other"),
    ("packages/contracts/", "packages/contracts"),
    ("packages/client-runtime/", "packages/client-runtime"),
    ("packages/shared/", "packages/shared"),
    ("packages/", "packages/other"),
    ("apps/web/", "apps/web"),
    ("apps/mobile/", "apps/mobile"),
    ("apps/desktop/", "apps/desktop"),
    ("docs/", "docs"),
]
area = lambda p: next((a for pre, a in AREAS if p.startswith(pre)), "root/config/scripts")
blob = lambda sha: git("cat-file", "blob", sha) if sha and set(sha) != {"0"} else ""
KIND = {"UU": "both-modified", "UD": "modify-delete", "DU": "delete-modify", "AA": "add-add", "AU": "file-location"}

rows = []
for l in open(f"{O}/status-v2.txt"):
    if not l.startswith("u "):
        continue
    f = l.rstrip("\n").split(" ", 10)
    xy, h2, path = f[1], f[8], f[10]
    kind, orig = KIND[xy], None
    if xy == "UU" and path in ren:
        kind, orig = "rename/content", ren[path][0]
    if xy == "AU":
        orig = path.replace("apps/server/src/orchestration-v2/", "apps/server/src/orchestration/", 1)
    ours = blob(h2)
    try:
        wt = open(path, errors="replace").read()
    except FileNotFoundError:
        wt = ""
    rows.append(dict(path=path, orig=orig, xy=xy, kind=kind, area=area(orig or path),
                     loom=ours.count("loom:"), lines_ours=ours.count("\n"),
                     markers=len(re.findall(r"^<<<<<<< ", wt, re.M))))
json.dump(rows, open(f"{O}/conflicts.json", "w"), indent=1)
print(len(rows), "conflicted paths ->", f"{O}/conflicts.json")
