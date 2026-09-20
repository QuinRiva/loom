"""Structural lost-declaration audit for a merge.

For every file that differs from BOTH parents, compare the set of top-level
exported declaration names in the merged file against each parent's. A name
that exists in a parent but not in the merge is either a deliberate drop or
merge damage; the point is to see all of them at once.
"""
import re, subprocess, sys

OURS, THEIRS = sys.argv[1], sys.argv[2]
DECL = re.compile(
    r'^export\s+(?:declare\s+)?(?:default\s+)?'
    r'(?:async\s+)?(?:abstract\s+)?'
    r'(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)',
    re.M,
)

def show(rev, path):
    r = subprocess.run(['git','show',f'{rev}:{path}'],capture_output=True,text=True)
    return r.stdout if r.returncode == 0 else None

def names(src):
    return set(DECL.findall(src)) if src else set()

files = subprocess.run(
    ['git','diff','--name-only','--diff-filter=M',OURS,'HEAD'],
    capture_output=True,text=True).stdout.split()
files = [f for f in files if f.endswith(('.ts','.tsx'))]

report = []
for f in files:
    try:
        merged = open(f).read()
    except OSError:
        continue
    m = names(merged)
    lost_ours = names(show(OURS,f)) - m
    lost_theirs = names(show(THEIRS,f)) - m
    if lost_ours or lost_theirs:
        report.append((f, sorted(lost_ours), sorted(lost_theirs)))

for f, lo, lt in report:
    print(f"## {f}")
    if lt: print(f"   upstream-only-lost: {', '.join(lt)}")
    if lo: print(f"   loom-lost:          {', '.join(lo)}")
print(f"\n{len(report)} files with lost top-level exports (of {len(files)} modified)")
