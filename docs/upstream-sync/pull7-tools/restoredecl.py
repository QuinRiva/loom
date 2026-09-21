"""Restore a top-level declaration from a merge parent into the merged file.

Usage: restoredecl.py <rev> <path> <name>...

Extracts each named top-level declaration (with its leading comment block) from
`git show <rev>:<path>` and appends it to the working-tree file if the name is
not already declared there. Prints the block so the caller can eyeball it.
"""

import re
import subprocess
import sys

rev, path, names = sys.argv[1], sys.argv[2], sys.argv[3:]
src = subprocess.run(["git", "show", f"{rev}:{path}"], capture_output=True, text=True).stdout
cur = open(path).read()
lines = src.split("\n")


def find(name):
    pat = re.compile(
        r"^(?:export\s+)?(?:declare\s+)?(?:async\s+)?"
        r"(?:const|let|var|function|class|interface|type|enum)\s+" + re.escape(name) + r"\b"
    )
    for i, line in enumerate(lines):
        if not pat.match(line):
            continue
        start = i
        # pull in the contiguous comment block directly above
        while start > 0 and (
            lines[start - 1].startswith(("//", " *", "/*", "/**")) or lines[start - 1].endswith("*/")
        ):
            start -= 1
        end = i
        for j in range(i, len(lines)):
            if lines[j] in ("}", "};", "];", ")", "]);", "});", ")};"):
                end = j
                break
            if lines[j].rstrip().endswith(";") and j == i:
                end = j
                break
        return "\n".join(lines[start : end + 1])
    return None


out = []
for name in names:
    if re.search(r"^(?:export\s+)?(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+"
                 + re.escape(name) + r"\b", cur, re.M):
        print(f"-- {name}: already declared, skipped")
        continue
    block = find(name)
    if block is None:
        print(f"!! {name}: NOT FOUND in {rev}:{path}")
        continue
    if not block.lstrip().startswith("export"):
        block = re.sub(r"^(\s*)(const|let|var|function|class|interface|type|enum)\b", r"\1export \2", block, count=1, flags=re.M)
    out.append(block)
    print(f"++ {name}: {len(block.splitlines())} lines")

if out:
    with open(path, "a") as fh:
        fh.write("\n" + "\n\n".join(out) + "\n")
