#!/usr/bin/env python3
"""Hunk shapes of every conflicted file in a mid-merge worktree.

Usage: hunks.py <mid-merge-worktree> <out-dir>     (reads <out-dir>/unmerged.txt)
Writes <out-dir>/hunks.json and <out-dir>/hunks.md.

Per hunk: the line it starts on, the line count of each side, the code lines of
each side (non-blank, not a pure comment), the `loom` lines on Loom's side, and a
kind: A = upstream's side has no code and Loom's has a loom line; B = Loom's side
is empty; o = upstream's side is empty; c = both sides have content.
"""
import json, os, re, sys

W, O = sys.argv[1], sys.argv[2]
COMMENT = re.compile(r"^\s*(//|/\*|\*|#|<!--|\{/\*)")
code = lambda ls: [l for l in ls if l.strip() and not COMMENT.match(l)]
out = {}
for p in open(f"{O}/unmerged.txt").read().split("\n"):
    f = os.path.join(W, p)
    if not p or not os.path.isfile(f): continue
    hunks, state, ours, theirs, start = [], None, [], [], 0
    for n, l in enumerate(open(f, errors="replace").read().split("\n"), 1):
        if l.startswith("<<<<<<< "): state, ours, theirs, start = "o", [], [], n
        elif l.startswith("=======") and state == "o": state = "t"
        elif l.startswith(">>>>>>> ") and state == "t":
            co, ct = code(ours), code(theirs)
            lo = [x for x in ours if re.search(r"loom", x, re.I)]
            kind = "B" if not ours else "o" if not theirs else "A" if not ct and lo else "c"
            hunks.append(dict(line=n - len(ours) - len(theirs) - 2, ours=len(ours), theirs=len(theirs),
                              ours_code=len(co), theirs_code=len(ct), loom=len(lo), kind=kind))
            state = None
        elif state == "o": ours.append(l)
        elif state == "t": theirs.append(l)
    out[p] = hunks
json.dump(out, open(f"{O}/hunks.json", "w"), indent=1)
tot = {}
with open(f"{O}/hunks.md", "w") as md:
    for p, hs in sorted(out.items()):
        md.write(f"- `{p}` ({len(hs)}): " + " ".join(f"[{h['ours']}/{h['theirs']}{h['kind']}{'·L' + str(h['loom']) if h['loom'] else ''}@{h['line']}]" for h in hs) + "\n")
        for h in hs: tot[h["kind"]] = tot.get(h["kind"], 0) + 1
    md.write(f"\nfiles {len(out)} · hunks {sum(tot.values())} · {tot}\n")
print(len(out), sum(tot.values()), tot)
