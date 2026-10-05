#!/usr/bin/env python3
"""Find files whose relative imports no longer resolve in the merged worktree.

The structural half of pull 9 (modify/delete, directory-rename relocations,
deleted contract modules) produces no conflict markers, so a file can be left
importing a module that is gone. This walks every tracked `.ts/.tsx/.mts` file
under apps/ and packages/, resolves each relative specifier against the
worktree, and writes `<out>/dangling-imports.json` (file, missing specifiers,
loom-side and upstream-side name-status) plus a summary of the most-referenced
missing targets. Run from the repo root on the merged tree (in-progress merge or
after the resolving commit); re-run until it reports zero outside quarantine.

Usage: dangling.py <out-dir> [--exclude <prefix>]...
"""
import collections, json, os, re, subprocess, sys

O = sys.argv[1]
excl = [sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--exclude"]
ls = sorted(set(subprocess.run(["git", "ls-files"], capture_output=True, text=True).stdout.split("\n")) - {""})  # unmerged paths list once per stage
files = [f for f in ls if re.search(r"\.(ts|tsx|mts)$", f) and f.startswith(("apps/", "packages/"))
         and os.path.exists(f) and not f.startswith(tuple(excl))]
exists = set(ls)
imp = re.compile(r'''(?:from\s+|import\s*\(\s*|import\s+|vi\.mock\(\s*)["'](\.{1,2}/[^"'?]+)["'?]''')

def resolves(base, spec):
    p = os.path.normpath(os.path.join(os.path.dirname(base), spec))
    stem = re.sub(r"\.(js|ts|tsx|mjs)$", "", p)
    cands = [p, stem + ".ts", stem + ".tsx", stem + ".mts", stem + "/index.ts", stem + "/index.tsx", p + ".ts", p + ".tsx"]
    return any(c in exists or os.path.isfile(c) for c in cands)

status = lambda name: {l.rstrip("\n").split("\t")[-1]: l[0] for l in open(f"{O}/{name}")}
loom_status, up_status = status("loom-namestatus.txt"), status("upstream-namestatus.txt")
out = []
for f in files:
    src = open(f, errors="replace").read()
    bad = sorted({s for s in imp.findall(src) if not resolves(f, s)})
    if bad:
        out.append(dict(file=f, missing=bad, loom=loom_status.get(f), up=up_status.get(f)))
json.dump(out, open(f"{O}/dangling-imports.json", "w"), indent=1)
print("files with dangling relative imports:", len(out), "specifiers:", sum(len(o["missing"]) for o in out))
print("by (loom-side / upstream-side status):", collections.Counter(f"{o['loom'] or '-'}/{o['up'] or '-'}" for o in out))
tgt = collections.Counter(os.path.normpath(os.path.join(os.path.dirname(o["file"]), s)) for o in out for s in o["missing"])
print("most-referenced missing targets:")
for t, n in tgt.most_common(30):
    print(f"{n:4} {t}")
