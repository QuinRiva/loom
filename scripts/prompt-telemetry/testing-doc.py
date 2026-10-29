#!/usr/bin/env python3
"""Testing-doc census: do sessions that write a loom test read docs/internals/testing.md first, and trip the test lints?

Usage: python3 testing-doc.py [--days 14] [--sessions-root ~/.pi/agent/sessions] > section.md
PR #460 moved the test-writing conventions out of AGENTS.md into that doc, behind one pointer. AGENTS.md is read from the
session's checkout, so each session is classed by the AGENTS.md in its own prompt: the pointer, the conventions inline
(landed with the test lints in #445, 2026-10-26), or neither (an older checkout: no conventions, no test lints).
A test writer `edit`s or `write`s a `*.test.ts(x)` under `apps/` or `packages/` of a loom checkout. Read first: a
`read`/`read_full` of the doc, or a bash `cat|sed|head|...` naming it, before the first such edit. Lint hit: a bash or
bg_wait result after that edit with an oxlint diagnostic `t3code(<rule>)` for a test rule on a test file the session
edited (`t3code/<rule>` is AGENTS.md text or a disable comment, not a hit). Census population: forks and /tmp dev
instances dropped, and sessions editing the doc or the lint rules (authoring, not use). run.sh's fourth section;
compare.py reads its table rows by label.
"""
import argparse, collections, json, os, re, time

ap = argparse.ArgumentParser()
ap.add_argument("--days", type=float, default=14)
ap.add_argument("--sessions-root", default=os.path.expanduser("~/.pi/agent/sessions"))
args = ap.parse_args()
cutoff = time.time() - args.days * 86400
home = re.escape(os.path.expanduser("~"))

LOOM_CWD = re.compile(rf"/worktrees/(loom/|t3code-|ws-[^/]*t3code)|^{home}/loom(/|$)|/loom-releases/")
DOC = "docs/internals/testing.md"
TEST_FILE = re.compile(r"(?:^|/)((?:apps|packages)/\S+\.test\.tsx?)$")
LINT_CMD = re.compile(r"\bvp (check|lint)\b|\boxlint\b|check:changed|\bvp run lint\b|pnpm ship\b")
READ_CMD = re.compile(r"\b(cat|sed|head|tail|less|more|bat|nl|awk)\b[^\n;|&]*" + re.escape(DOC))
INLINE = "Lint enforces this: `t3code/no-test-timeout-or-unreasoned-skip`"
REGIMES = ["inline", "pointer", "neither"]
RULES = "no-test-timeout-or-unreasoned-skip|no-frame-waits-in-browser-tests|no-wall-clock-in-tests" \
        "|no-real-time-wait-in-tests|no-polling-loop-in-tests|require-disposable-render"
# oxlint's unix reporter puts the path first; its default reporter puts it on the next line, `,-[path:line:col]`.
DIAG = re.compile(rf"(\S+?):\d+:\d+: (?:error|warning) t3code\(({RULES})\)"
                  rf"|t3code\(({RULES})\)[^\n]*\n\s*,-\[([^\]:]+)")


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(c.get("text", "") for c in content or [] if isinstance(c, dict) and c.get("type") == "text")


def test_file(path, cwd):
    """The `apps/…` or `packages/…` relative path when `path` is a loom test file, else None."""
    m = TEST_FILE.search(path)
    in_loom = LOOM_CWD.search(path) if path.startswith(("/", "~")) else LOOM_CWD.search(cwd)
    return m[1] if m and in_loom and "/.repos/" not in path and "node_modules" not in path else None


def scan(path):
    r = {"regime": "neither", "cwd": "", "fork": False, "role": None, "authored": False, "tests": set(), "first_edit": None,
         "read_at": None, "linted": False, "any_hit": False, "own_hit": False, "rules": set()}
    i = 0
    with open(path, errors="replace") as fh:
        for line in fh:
            if '"type":"session"' not in line[:40] and '"toolCall"' not in line \
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
                ctx = (m.get("sections") or {}).get("project_context") or ""
                r["regime"] = "pointer" if DOC in ctx else "inline" if INLINE in ctx else r["regime"]
                role = re.search(r"You are an? ([a-z-]+) sub-thread", (m.get("sections") or {}).get("addendum") or "")
                r["role"] = r["role"] or (role[1] if role else "root" if (m.get("sections") or {}).get("addendum") else None)
            elif m.get("role") == "assistant":
                for c in m.get("content") or []:
                    if not isinstance(c, dict) or c.get("type") != "toolCall":
                        continue
                    i += 1
                    name, a = c.get("name") or "", c.get("arguments") or {}
                    p = str(a.get("path") or "")
                    if name in ("edit", "write"):
                        r["authored"] |= p.endswith(DOC) or "oxlint-plugin-t3code/" in p
                        if t := test_file(p, r["cwd"]):
                            r["tests"].add(t)
                            r["first_edit"] = r["first_edit"] or i
                    if r["read_at"] is None and (name in ("read", "read_full") and p.endswith(DOC)
                                                 or name == "bash" and READ_CMD.search(str(a.get("command") or ""))):
                        r["read_at"] = i
                    if r["first_edit"] and name in ("bash", "bg_start"):
                        r["linted"] |= bool(LINT_CMD.search(str(a.get("command") or "")))
            elif m.get("role") == "toolResult" and r["first_edit"] and m.get("toolName") in ("bash", "bg_wait"):
                for d in DIAG.finditer(text_of(m.get("content"))):
                    rule, where = d[2] or d[3], d[1] or d[4]
                    r["any_hit"] = True
                    if any(where.endswith(t) for t in r["tests"]):
                        r["own_hit"] = True
                        r["rules"].add(rule)
    return r


recs = []
for d in os.listdir(args.sessions_root):
    dp = os.path.join(args.sessions_root, d)
    if os.path.isdir(dp):
        recs += [scan(fp) for f in os.listdir(dp)
                 if f.endswith(".jsonl") and os.path.getmtime(fp := os.path.join(dp, f)) >= cutoff]
dropped = sum(r["fork"] or r["cwd"].startswith("/tmp") or r["authored"] for r in recs)
recs = [r for r in recs if not (r["fork"] or r["cwd"].startswith("/tmp") or r["authored"])]
writers = [r for r in recs if r["first_edit"]]
read_first = lambda r: r["read_at"] is not None and r["read_at"] < r["first_edit"]
ROWS = {
    "wrote a loom test (`edit`/`write` on `apps/` or `packages/` `*.test.ts(x)`)": lambda r: True,
    f"of those, read `{DOC}` before the first test edit": read_first,
    "of those, read it only after": lambda r: r["read_at"] is not None and not read_first(r),
    "of those, ran lint after the first test edit (`vp check`, `oxlint`, `check:changed`, `pnpm ship`, ...)": lambda r: r["linted"],
    "of those, a later test-lint diagnostic on a test file they edited": lambda r: r["own_hit"],
    "of those, a later test-lint diagnostic on any file (pre-existing code included)": lambda r: r["any_hit"],
}

print(f"{len(recs)} sessions modified in the last {args.days:g} days; {dropped} forks, /tmp dev instances "
      f"and sessions editing `{DOC}` or `oxlint-plugin-t3code/` dropped. Columns: the session's AGENTS.md "
      "carries the test conventions inline, the pointer to the doc (PR #460), or neither (before the test lints).\n")
print("| Sessions | inline | pointer | neither |\n|---|--:|--:|--:|")
for label, pred in ROWS.items():
    print(f"| {label} | " + " | ".join(str(sum(1 for r in writers if r["regime"] == g and pred(r))) for g in REGIMES) + " |")

roles = collections.defaultdict(lambda: [0, 0, 0])
for r in writers:
    if r["regime"] != "neither":
        row = roles[(r["role"] or "terminal", r["regime"])]
        row[0] += 1; row[1] += read_first(r); row[2] += r["own_hit"]
print("\n| role | AGENTS.md | wrote a test | read the doc first | lint hit on own test |\n|---|---|--:|--:|--:|")
for (role, regime), (n, rd, hit) in sorted(roles.items(), key=lambda kv: (kv[0][1], -kv[1][0])):
    print(f"| {role} | {regime} | {n} | {rd} | {hit} |")
rules = collections.Counter(x for r in writers for x in r["rules"])
print("\nRules hit on own tests (sessions): " + (", ".join(f"`{k}` {v}" for k, v in rules.most_common()) or "none") + ".")
