#!/usr/bin/env python3
"""What upstream's raw diff is made of: translation catalogues, vendored and generated code,
recorded fixtures, lockfile, docs, tests and source, overall and per app/package; and the
commit count by conventional-commit type and scope.

Read-only. Run from this worktree's root:
  python3 docs/upstream-sync/41-cadence-pull-16-20261122/tools/composition.py .artifacts/pull16-measure
Uses `git -c diff.renameLimit=30000 diff --numstat <BASE> <UP> -- . ':!.repos'` (renames resolved
to their destination path) and <out>/upstream-log.txt (`<hash> <date> <subject>` per first-parent
commit). Prints markdown.
"""
import collections, re, subprocess, sys

O = sys.argv[1]
BASE, UP = "3fa57b92a2", "a09738fb43"
CATS = [  # first match wins
    ("translation catalogues", r"/i18n/translations/|^apps/marketing/src/i18n/(?!index|locales)[\w-]+\.ts$"),
    ("vendored third-party source", r"/Vendor/"),
    ("lockfile", r"(^|/)pnpm-lock\.yaml$"),
    ("generated code and schemas", r"\.gen\.ts$|/_generated/|\.graphql(\.ts)?$|githubEmojiAliases\.ts$|/snapshot\.json$"),
    ("recorded fixtures and transcripts", r"/fixtures?/|\.ndjson$|\.jsonl$|__snapshots__/|\.snap$|_transcript\.|/recordings?/|/replays?/"),
    ("docs and skills prose", r"^docs/|\.mdx?$"),
    ("tests", r"\.(test|spec)\.[cm]?[jt]sx?$|/tests?/|/testkit/|/integration/|__tests__/|test-support|\.test-d\.ts$|^apps/server/integration/"),
    ("source", r"\.([cm]?[jt]sx?|css|swift|kt|kts|c|h|m|mm|rs|astro|sh|ps1|sql)$"),
]
def cat(p): return next((n for n, rx in CATS if re.search(rx, p)), "config, CI and assets")
def unit(p):
    m = re.match(r"^(apps/[^/]+|packages)/", p)
    return m.group(1) if m else "root, scripts, evals, CI, docs"

rows = []
for l in subprocess.run(["git", "-c", "diff.renameLimit=30000", "diff", "--numstat", BASE, UP, "--", ".", ":!.repos"],
                        capture_output=True, text=True).stdout.splitlines():
    a, d, p = l.split("\t")
    if "=>" in p:
        p = re.sub(r"^.* => ", "", re.sub(r"\{([^{}]*) => ([^{}]*)\}", r"\2", p)).replace("//", "/")
    rows.append((0 if a == "-" else int(a), 0 if d == "-" else int(d), p))

tot = collections.defaultdict(lambda: [0, 0, 0])
by_unit = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0, 0]))
for a, d, p in rows:
    c = cat(p)
    for t in (tot[c], by_unit[unit(p)][c]):
        t[0] += 1; t[1] += a; t[2] += d
order = [n for n, _ in CATS] + ["config, CI and assets"]
print(f"## Upstream diff composition ({BASE}..{UP}, without .repos/)\n")
print(f"{len(rows)} files, +{sum(r[0] for r in rows):,} / -{sum(r[1] for r in rows):,}\n")
print("| category | files | added | deleted |\n| --- | ---: | ---: | ---: |")
for c in order:
    f, a, d = tot[c]; print(f"| {c} | {f} | +{a:,} | -{d:,} |")
units = sorted(by_unit, key=lambda u: -sum(v[1] for v in by_unit[u].values()))
print("\n### Added lines per app or package group\n")
print("| unit | " + " | ".join(order) + " | total |\n| --- |" + " ---: |" * (len(order) + 1))
for u in units:
    v = by_unit[u]
    print(f"| {u} | " + " | ".join(f"{v[c][1]:,}" for c in order) + f" | {sum(v[c][1] for c in order):,} |")
print("\n### Per packages/* (source and tests added)\n\n| package | source + | tests + | other + |\n| --- | ---: | ---: | ---: |")
pk = collections.defaultdict(lambda: [0, 0, 0])
for a, d, p in rows:
    if p.startswith("packages/"):
        c = cat(p); pk[p.split("/")[1]][0 if c == "source" else 1 if c == "tests" else 2] += a
for k, v in sorted(pk.items(), key=lambda kv: -sum(kv[1]))[:20]:
    print(f"| {k} | {v[0]:,} | {v[1]:,} | {v[2]:,} |")

# conventional commits
types, scopes = collections.Counter(), collections.defaultdict(collections.Counter)
for l in open(f"{O}/upstream-log.txt"):
    subj = l.split(" ", 2)[2]
    m = re.match(r"^(\w+)(?:\(([^)]*)\))?!?:", subj)
    t = m.group(1).lower() if m else "(none)"
    types[t] += 1
    for s in (m.group(2) or "(no scope)").split(",") if m else ["(no scope)"]:
        scopes[t][s.strip().lower()] += 1
print("\n## Upstream commits by conventional-commit type and scope\n")
print("| type | commits | top scopes |\n| --- | ---: | --- |")
for t, n in types.most_common():
    print(f"| {t} | {n} | " + ", ".join(f"{s} {c}" for s, c in scopes[t].most_common(14)) + " |")
