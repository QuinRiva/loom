#!/usr/bin/env python3
"""Print each conflict hunk of one file in a mid-merge worktree, both sides, capped.

Usage: peek.py <mid-merge-worktree> <path> [max-lines-per-side=12] [context=2]
"""
import sys
W, p = sys.argv[1], sys.argv[2]
cap = int(sys.argv[3]) if len(sys.argv) > 3 else 12
ctx = int(sys.argv[4]) if len(sys.argv) > 4 else 2
ls = open(f"{W}/{p}", errors="replace").read().split("\n")
i, k = 0, 0
while i < len(ls):
    if ls[i].startswith("<<<<<<< "):
        k += 1
        m = next(j for j in range(i, len(ls)) if ls[j].startswith("======="))
        e = next(j for j in range(m, len(ls)) if ls[j].startswith(">>>>>>> "))
        ours, theirs = ls[i + 1:m], ls[m + 1:e]
        print(f"\n===== hunk {k} @ line {i + 1}: Loom {len(ours)} lines / upstream {len(theirs)} lines =====")
        for c in ls[max(0, i - ctx):i]: print("    " + c)
        for side, body in (("LOOM", ours), ("UPSTREAM", theirs)):
            print(f"  --- {side}")
            for c in body[:cap]: print("  | " + c)
            if len(body) > cap: print(f"  | … {len(body) - cap} more")
        for c in ls[e + 1:e + 1 + ctx]: print("    " + c)
        i = e
    i += 1
