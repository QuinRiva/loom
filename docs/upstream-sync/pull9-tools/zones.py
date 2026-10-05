#!/usr/bin/env python3
"""Emit the pull-9 zone partition (doc 29 Appendix B) from a remeasure capture.

Every conflicted path lands in exactly one zone; every non-conflicted file the
merge leaves broken (dangling V1 import, removed contract name, Loom thread/
shell field read) lands in the detach seed list with a Q (Loom-only: quarantine
whole) or H (upstream-shared: drop the hunk behind a marker) hint. Reads the
files classify.py / automerged.py / dangling.py write into <out-dir>, plus
`<out-dir>/loom-field-readers.json` and `<out-dir>/removed-name-users.json`
when present (see doc 29 §13 for how those two are produced).

Usage: zones.py <out-dir>   (prints markdown)
"""
import collections, json, os, sys

O = sys.argv[1]
rows = json.load(open(f"{O}/conflicts.json"))
load = lambda n: json.load(open(f"{O}/{n}")) if os.path.exists(f"{O}/{n}") else {}
dangling = {o["file"]: o for o in load("dangling-imports.json") or []}
field_readers, name_users = load("loom-field-readers.json"), load("removed-name-users.json")
loom_added = {l.rstrip("\n").split("\t")[-1] for l in open(f"{O}/loom-namestatus.txt") if l[0] == "A"}
conflicted = {o["path"] for o in rows}

WEB_CHAT = ("components/ChatView", "components/chat/", "composerDraftStore", "components/ChatMarkdown",
            "components/composerContextPresentation", "components/composerInlineChip", "session-logic", "types.ts")
WEB_SIDEBAR = ("components/Sidebar", "components/ThreadNotification", "components/ThreadRouteView",
               "components/ThreadStatusIndicators", "components/CommandPalette", "hooks/useHandleNewThread", "routes/")

def textual_zone(p):
    if p == "pnpm-lock.yaml" or p.endswith("package.json") or p.startswith(("scripts/", "infra/")):
        return "T-lock/config"
    if p.startswith("packages/contracts/"): return "T-contracts"
    if p.startswith("packages/shared/"): return "T-shared"
    if p.startswith("packages/client-runtime/"): return "T-client-runtime"
    if p.startswith("apps/mobile/"): return "T-mobile"
    if p.startswith("apps/web/"):
        rel = p.removeprefix("apps/web/src/")
        if any(rel.startswith(x) for x in WEB_CHAT): return "T-web-chat"
        if any(rel.startswith(x) for x in WEB_SIDEBAR): return "T-web-sidebar"
        return "T-web-panels/other"
    s = p.removeprefix("apps/server/src/")
    if s in ("ws.ts", "server.ts", "bin.ts") or s.startswith(("serverRuntimeStartup", "auth/", "cli/", "orchestration-v2/")):
        return "T-server-core"
    if s.startswith("persistence/"): return "T-server-persistence"
    if s.startswith(("provider/", "mcp/")): return "T-server-provider/mcp"
    return "T-server-other"

zone_of = {}
for o in rows:
    p = o["path"]
    if o["xy"] == "AU": z = "Q-relocated"
    elif o["xy"] == "UD": z = "D-upstream-deletion"
    elif o["xy"] == "AA": z = "AA-add/add"
    else: z = textual_zone(p)
    zone_of[p] = z

seed = {}
for f in set(dangling) | set(field_readers) | set(name_users):
    if f in conflicted or f.startswith("apps/server/src/orchestration-v2/"): continue
    why = []
    if f in dangling and (dangling[f]["loom"] or dangling[f]["up"]):  # both-None = pre-existing false positive
        why.append("V1 import: " + ", ".join(os.path.basename(m) for m in dangling[f]["missing"][:3]))
    if f in name_users: why.append("V1 name: " + ", ".join(name_users[f][:3]))
    if f in field_readers: why.append("Loom field: " + ", ".join(sorted(field_readers[f])[:4]))
    if why: seed[f] = ("Q" if f in loom_added else "H", "; ".join(why))

by = collections.defaultdict(list)
for p, z in zone_of.items(): by[z].append(p)
print("| zone | n | markers | `loom:` lines |\n|---|--:|--:|--:|")
for z in sorted(by):
    ps = by[z]
    print(f"| {z} | {len(ps)} | {sum(o['markers'] for o in rows if o['path'] in ps)} | {sum(o['loom'] for o in rows if o['path'] in ps)} |")
print(f"| **total conflicted** | **{len(rows)}** | **{sum(o['markers'] for o in rows)}** | **{sum(o['loom'] for o in rows)}** |")
print(f"| X-detach seed (not conflicted) | {len(seed)} | — | — |\n")
info = {o["path"]: o for o in rows}
for z in sorted(by):
    print(f"\n### {z} ({len(by[z])})\n")
    for p in sorted(by[z]):
        o = info[p]
        extra = f" ← was `{o['orig']}`" if o["orig"] and o["xy"] == "AU" else ""
        print(f"- `{p}` · {o['markers']}m · {o['loom']}L · {o['lines_ours']} lines{extra}")
print(f"\n### X-detach seed list ({len(seed)}) — Q = Loom-only (quarantine whole), H = upstream-shared (drop hunk behind `// loom:`)\n")
for f, (k, why) in sorted(seed.items()):
    print(f"- {k} `{f}` — {why}")
