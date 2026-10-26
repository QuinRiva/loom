#!/usr/bin/env python3
"""Capability census: do threads find what loom provides, or substitute for it?

Usage: python3 capabilities.py [--days 14] [--sessions-root ~/.pi/agent/sessions] > section.md
Prints a markdown section with three measures from plans/deferred-capabilities §1: threads that
needed a browser, used a browser tool or hand-rolled one; MDX lints outside a loom checkout, by
the path the linter ran from (target: the skills' lint-doc.sh wrapper, never ~/loom); and
tool_search queries that found nothing. Same population as skill-usage-agg.py: forks and /tmp
dev instances dropped. run.sh's third section; compare.py reads its table rows by label.
"""
import argparse, collections, json, os, re, time

ap = argparse.ArgumentParser()
ap.add_argument("--days", type=float, default=14)
ap.add_argument("--sessions-root", default=os.path.expanduser("~/.pi/agent/sessions"))
args = ap.parse_args()
cutoff = time.time() - args.days * 86400
home = re.escape(os.path.expanduser("~"))

LOOM_CWD = re.compile(rf"/worktrees/(loom/|t3code-|ws-[^/]*t3code)|^{home}/loom(/|$)|/loom-releases/")
BROWSER_TOOL = re.compile(r"^(browser_|mcp__t3-code__(preview_|t3_preview_|html_preview))")
HAND_BROWSER = re.compile(
    r"--headless|--screenshot|chromium\.launch|page\.goto|/tmp/pw"
    r"|\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b[^\n;&|]*\b(playwright|puppeteer)"
    r"|\bpip3?\s+install\b[^\n;&|]*playwright|\bplaywright(@\S*)?\s+install", re.I)
LINT_RUN = re.compile(r"\bnode\s+\S*lint-plan\.mjs|\b(ba)?sh\s+\S*lint-doc\.sh|(^|[;&|(]\s*)\S*lint-doc\.sh\s")
STALE_LOOM = re.compile(rf"(~|\$HOME|{home})/loom(?![-\w])")
HUNT = re.compile(r"\b(find|fd|locate|rg --files)\b[^\n;|&]*(lint-plan|lint-doc|mdx-doc-core)", re.I)
VAST_FIND = re.compile(rf"(^|[;&|(]\s*)(timeout \d+ )?find\s+(/|~|\$HOME|{home})(\s|$)")
BROWSER_NOTE = "Loom provides a headless browser"
BOUNDED_NOTE = "[t3 search guard] Your bound let this search walk"
LINT_PATHS = ["lint-doc.sh wrapper", "~/loom", "release path", "checkout-relative", "other path"]


def lint_path(cmd):
    if "lint-doc.sh" in cmd:
        return "lint-doc.sh wrapper"
    if "loom-releases" in cmd:
        return "release path"
    if STALE_LOOM.search(cmd):
        return "~/loom"
    return "other path" if re.search(r"\bcd\s|\bnode\s+/", cmd) else "checkout-relative"


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(c.get("text", "") for c in content or [] if isinstance(c, dict) and c.get("type") == "text")


def scan(path):
    r = {"cwd": "", "fork": False, "loom_thread": False, "browser_tool": False, "hand_browser": False,
         "browser_note": False, "searched_first": False, "tool_search": 0, "misses": [], "wrote_mdx": False, "lints": set(),
         "hunt": False, "vast_find": False, "bounded_note": False}
    ts_ids = {}
    with open(path, errors="replace") as fh:
        for line in fh:
            if '"type":"session"' not in line[:40] and '"role":"assistant"' not in line \
                    and '"role":"toolResult"' not in line and '"role":"system"' not in line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("type") == "session":
                r["cwd"], r["fork"] = e.get("cwd") or "", bool(e.get("parentSession"))
                continue
            m = e.get("message") or {}
            if m.get("role") == "system":
                r["loom_thread"] |= bool((m.get("sections") or {}).get("addendum"))
            elif m.get("role") == "assistant":
                for c in m.get("content") or []:
                    if not isinstance(c, dict) or c.get("type") != "toolCall":
                        continue
                    name, a = c.get("name") or "", c.get("arguments") or {}
                    r["loom_thread"] |= name.startswith("mcp__t3-code__")
                    r["browser_tool"] |= bool(BROWSER_TOOL.match(name))
                    if name == "tool_search":
                        r["tool_search"] += 1
                        ts_ids[c.get("id")] = str(a.get("query", ""))
                    elif name in ("write", "edit"):
                        r["wrote_mdx"] |= str(a.get("path") or "").endswith(".mdx")
                    elif name == "bash":
                        cmd = str(a.get("command") or "")
                        if not r["hand_browser"] and HAND_BROWSER.search(cmd):
                            r["hand_browser"], r["searched_first"] = True, r["tool_search"] > 0
                        r["hunt"] |= bool(HUNT.search(cmd))
                        r["vast_find"] |= bool(VAST_FIND.search(cmd))
                        if LINT_RUN.search(cmd):
                            r["lints"].add(lint_path(cmd))
            elif m.get("role") == "toolResult":
                txt = text_of(m.get("content"))
                q = ts_ids.pop(m.get("toolCallId"), None)
                if q is not None and txt.startswith("No matching"):
                    r["misses"].append(q)
                r["browser_note"] |= BROWSER_NOTE in txt
                r["bounded_note"] |= BOUNDED_NOTE in txt
    return r


recs = []
for d in os.listdir(args.sessions_root):
    dp = os.path.join(args.sessions_root, d)
    if os.path.isdir(dp):
        recs += [scan(fp) for f in os.listdir(dp)
                 if f.endswith(".jsonl") and os.path.getmtime(fp := os.path.join(dp, f)) >= cutoff]
dropped = sum(r["fork"] or r["cwd"].startswith("/tmp") for r in recs)
recs = [r for r in recs if not (r["fork"] or r["cwd"].startswith("/tmp"))]
for r in recs:
    r["in_loom"] = bool(LOOM_CWD.search(r["cwd"]))
per_day = lambda n: f"{n / args.days:.1f}/day"
count = lambda pred, rs=recs: sum(1 for r in rs if pred(r))

print(f"{len(recs)} sessions ({count(lambda r: r['loom_thread'])} loom threads) modified in the last "
      f"{args.days:g} days; {dropped} forks and /tmp dev instances dropped.\n")

needed = [r for r in recs if r["browser_tool"] or r["hand_browser"]]
hand = [r for r in needed if r["hand_browser"]]
hand_out = [r for r in hand if not r["in_loom"]]
print("### Browser\n")
print("| Sessions | Count |\n|---|---|")
print(f"| needed a browser (used a browser tool or hand-rolled one) | {len(needed)} |")
print(f"| used a browser tool (`preview_*`, `html_preview`, pi-browser `browser_*`) | {count(lambda r: r['browser_tool'], needed)} |")
print(f"| hand-rolled one (`--headless`, `playwright install`, `page.goto`, ...) | {len(hand)} |")
print(f"| of those, outside a loom checkout (where a loom install is not the project's own test setup) | {len(hand_out)} ({per_day(len(hand_out))}) |")
print(f"| of those, never called `tool_search` | {count(lambda r: not r['tool_search'], hand_out)} |")
print(f"| of those, called `tool_search` before the first hand-rolled command | {count(lambda r: r['searched_first'], hand_out)} |")
print(f"| got the command guard's browser note | {count(lambda r: r['browser_note'])} |\n")

mdx = [r for r in recs if not r["in_loom"] and (r["wrote_mdx"] or r["lints"])]
print("### MDX linter outside a loom checkout\n")
print("Sessions outside a loom checkout that wrote a `.mdx` or ran the linter, by the path the linter "
      "ran from (a session can use more than one). Target: the wrapper only, `~/loom` at 0.\n")
print("| Sessions | Count |\n|---|---|")
print(f"| authored MDX | {len(mdx)} |")
for p in LINT_PATHS:
    n = count(lambda r: p in r["lints"], mdx)
    print(f"| linted via {p} | {n}{f' ({per_day(n)})' if p == '~/loom' else ''} |")
print(f"| hunted for the linter (`find`/`fd`/`locate`) | {count(lambda r: r['hunt'], mdx)} |")
print(f"| never linted | {count(lambda r: not r['lints'], mdx)} |\n")

misses = collections.Counter(q.strip().lower() for r in recs for q in r["misses"])
print("### Capability searches\n")
print("| Measure | Count |\n|---|---|")
print(f"| `tool_search` calls | {sum(r['tool_search'] for r in recs)} in {count(lambda r: r['tool_search'])} sessions |")
print(f"| found nothing (`No matching tools`) | {sum(misses.values())} in {count(lambda r: r['misses'])} sessions |")
print(f"| `find /` or `find ~` hunts | {count(lambda r: r['vast_find'])} sessions |")
print(f"| got the search guard's bounded-search note | {count(lambda r: r['bounded_note'])} sessions |\n")
if misses:
    print("Most frequent queries that found nothing (a family that does not exist yet, or a phrasing that misses):\n")
    print("| Query | Times |\n|---|---|")
    for q, n in misses.most_common(10):
        print(f"| {q[:80].replace('|', '/')} | {n} |")
