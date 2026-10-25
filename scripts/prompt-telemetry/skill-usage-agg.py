#!/usr/bin/env python3
"""Aggregate skill-usage.py output into the declared-vs-read table.

Usage: python3 skill-usage-agg.py per-session.jsonl [all|loom|terminal]
Population: real sessions only. Dropped: forks (header has parentSession: consult
forks and continuations, which copy the parent's history) and dev/test instances
(cwd under /tmp). A skill counts as read in a session when that session declared
it and a read/read_full/bash-cat of any `<name>/SKILL.md` ran there, excluding
sessions that also edited or wrote that skill's SKILL.md (authoring, not use) and
skill audits (a session reading >= 8 distinct skills is surveying them, not using them).
"""
import collections, json, sys

recs = [json.loads(l) for l in open(sys.argv[1])]
want = sys.argv[2] if len(sys.argv) > 2 else "all"


def pop(r):
    if r.get("parent"):
        return "fork"
    if (r["cwd"] or "").startswith("/tmp"):
        return "devtmp"
    return "loom" if r["addendum"] else "terminal"


def source(loc):
    if "/pi-fathom/" in loc or "lease-extraction/.agents/" in loc:
        return "pi-fathom"
    if "/pi-craft/" in loc:
        return "pi-craft"
    if "/npm/" in loc or "/git/github.com/" in loc:
        return "npm/git"
    if "loom-slack-bridge" in loc:
        return "slack-bridge"
    return "loom"


print("population counts:", dict(collections.Counter(pop(r) for r in recs)), file=sys.stderr)
recs = [r for r in recs if pop(r) in (("loom", "terminal") if want == "all" else (want,))]

declared, src, read, first, roles_decl, roles_read, undeclared_read, edited = (
    collections.Counter(), {}, collections.Counter(), collections.Counter(),
    collections.defaultdict(collections.Counter), collections.defaultdict(collections.Counter),
    collections.Counter(), collections.Counter())
audits, perday = 0, collections.Counter()
for r in recs:
    for name in r["declared"]:
        perday[name, r["start"][:10]] += 1
# "declared since": first day >= 5 sessions declared it, so one resumed old session does not backdate it
since = {}
for (name, day), n in sorted(perday.items()):
    if n >= 5:
        since.setdefault(name, day)
for name, day in sorted(perday):
    since.setdefault(name, day + "*")
for r in recs:
    role = r["role"] or ("root" if r["addendum"] else "terminal")
    ed = set(r["edits"])
    if len({x["skill"] for x in r["reads"]}) >= 8:
        audits += 1
        continue
    for e in ed:
        edited[e] += 1
    byskill = collections.defaultdict(list)
    for x in r["reads"]:
        byskill[x["skill"]].append(x["turn"])
    for name, loc in r["declared"].items():
        declared[name] += 1
        src.setdefault(name, source(loc))
        roles_decl[name][role] += 1
        if name in byskill and name not in ed:
            read[name] += 1
            roles_read[name][role] += 1
            first[name] += min(byskill[name]) == 1
    for name in byskill:
        if name not in r["declared"] and name not in ed:
            undeclared_read[name] += 1

rows = sorted(declared, key=lambda n: (read[n] > 0, read[n] / declared[n], -declared[n], n))
print(f"Sessions: {len(recs)} ({want}); skill audits excluded: {audits}\n")
print("| skill | source | declared since | declared | read | rate | first-turn reads | top reading roles (read/declared) |")
print("|---|---|---|--:|--:|--:|--:|---|")
for n in rows:
    top = ", ".join(f"{k} {v}/{roles_decl[n][k]}" for k, v in roles_read[n].most_common(3)) or "never"
    print(f"| {n} | {src[n]} | {since[n]} | {declared[n]} | {read[n]} | {100 * read[n] / declared[n]:.1f}% | "
          f"{first[n]} | {top} |")
print("\nRead without being declared in that session (sessions):",
      ", ".join(f"{k} {v}" for k, v in undeclared_read.most_common() if v > 1))
print("\nSessions that edited/wrote the skill (excluded from its read count):",
      ", ".join(f"{k} {v}" for k, v in edited.most_common()))
