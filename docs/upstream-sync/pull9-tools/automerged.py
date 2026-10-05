#!/usr/bin/env python3
"""List files BOTH sides modified that git merged without a conflict, and which
of them lost an exported top-level name from our side (the lostdecls.py check
applied before the merge is committed, when `git diff ours HEAD` is not yet
possible).

Reads `<out>/{base,ours,theirs}.txt`, `<out>/{loom,upstream}-namestatus.txt` and
`<out>/unmerged.txt`; writes `<out>/both-modified-automerged.txt` and
`<out>/lostdecls-automerged.txt`. Run from the repo root during the in-progress
merge. Every file in the second list needs a pre-ruling or a decision-log row.

Usage: automerged.py <out-dir>
"""
import re, subprocess, sys

O = sys.argv[1]
rd = lambda n: open(f"{O}/{n}").read().split()
ours = rd("ours.txt")[0]
touched = lambda n: {l.rstrip("\n").split("\t")[-1] for l in open(f"{O}/{n}") if l[0] in "MR"}
both = sorted((touched("loom-namestatus.txt") & touched("upstream-namestatus.txt")) - set(rd("unmerged.txt")))
open(f"{O}/both-modified-automerged.txt", "w").write("\n".join(both) + "\n")
print(len(both), "both-modified files auto-merged ->", f"{O}/both-modified-automerged.txt")

DECL = re.compile(r"^export\s+(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:abstract\s+)?"
                  r"(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)", re.M)
show = lambda rev, p: subprocess.run(["git", "show", f"{rev}:{p}"], capture_output=True, text=True).stdout
lost = []
for f in (f for f in both if f.endswith((".ts", ".tsx"))):
    try:
        merged = set(DECL.findall(open(f).read()))
    except OSError:
        continue
    gone = sorted(set(DECL.findall(show(ours, f))) - merged)
    if gone:
        lost.append(f"{f} lost-ours: {gone}")
open(f"{O}/lostdecls-automerged.txt", "w").write("\n".join(lost) + "\n")
print(len(lost), "auto-merged files lost an exported name from our side:")
print("\n".join(lost))
