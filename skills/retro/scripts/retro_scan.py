#!/usr/bin/env python3
"""Deterministic evidence scan for /retro over every pi session file in a source workstream.

  retro_scan.py --manifest <runDir>/manifest.json [--out <dir>]
      → <out>/digest.md + <out>/scan.json  (out defaults to the manifest's directory)
  retro_scan.py --manifest <runDir>/manifest.json --extract <thread-id> [--briefs 7,28|all] [--out <dir>]
      → <out>/extract-<thread-id>.md  (':' and '/' in the id become '_'; an id prefix is enough)
        Brief-writing calls (spawn/scaffold/brief) are one-line stubs naming the target thread
        and the brief's size. With --briefs the output is instead <out>/briefs-<n-n>.md: only the
        calls addressed to those digest #n threads, in full (scaffold node, brief, spawn, steers).

The manifest is the JSON the /retro launcher writes into the run directory. The signal
catalogue is ../signals.yaml (PyYAML: the catalogue is edited by people and agents and
holds regexes, so a real YAML parser is worth the one dependency).
"""
import argparse, json, os, re, sqlite3, statistics
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import yaml

CATALOGUE = Path(__file__).resolve().parent.parent / "signals.yaml"
CONTROL = "[T3 Workstream control plane"
AGENT_LABEL = re.compile(r"^\[(?:From your parent|From another agent|Brief from another agent|Automated resume|Sent by automation|Scheduled task)")
# In a child, only labelled turns are the human's: older briefs and steers carry no agent label.
HUMAN_LABEL = re.compile(r"^\[(?:From the human|Review comment|assistant-quote|Slack reply|User attached)")
NOTICE_KINDS = [("digest", "FYI digest"), ("yield", "YIELDED to you"), ("quiet", "went quiet"), ("wedged", "looks wedged"),
                ("error", "raised an `error`"), ("hold", "is paused and needs attention"), ("deadlock", "is deadlocked"),
                ("brief-needed", "NO kickoff brief"), ("rework", "Review round"), ("merge-conflict", "could NOT merge"),
                ("merge-resolved", "resolved its fan-in merge"), ("redeploy", "server was redeployed")]
BRIEF_TOOLS = ("workstream_brief", "workstream_spawn", "workstream_scaffold", "workstream_prompt")
SETTLED = {"terminal", "resolve"}
EXCERPT, PER_SIGNAL = 200, 6


def est_tokens(text):
    """Claude tokens, not chars/4: these id-, path- and markup-dense files measured 2.2–2.5 chars
    a token on a live run (digest 50.7k chars → 23k tokens; extract 293k → 117k)."""
    return (text if isinstance(text, int) else len(text)) * 10 // 23


def text_of(blocks):
    return "".join(b.get("text", "") for b in blocks if b.get("type") == "text")


def _review_comment(block):
    """One review-comment context → one line: the passage, its section and the human's comment."""
    f = lambda k: (re.search(rf"^{k}:(?:\n((?:  .*\n?)+)| (.*))", block, re.M) or [None, "", ""])
    field = lambda k: " ".join(x.strip() for x in (f(k)[1] or f(k)[2] or "").splitlines()).strip()
    return f"[review of \u201c{field('quoted passage')}\u201d ({field('section')}): {field('comment')}]"


def _citations(block):
    try:
        items = json.loads(block)
    except ValueError:
        return block
    return "\n".join(f"[{c['id']}] \u201c{c['citation'].get('text', '')}\u201d" +
                     (f" \u2014 {c['citation']['comment']}" if c['citation'].get('comment') else "") for c in items)


def clean_human(text):
    """The human's words verbatim; machine metadata around them compacted: images become [image],
    review-comment contexts become one line each, citation JSON keeps only each quote and comment."""
    text = re.sub(r"\[Image: [^\]]*\]", "[image]", text)
    text = re.sub(r'<context kind="image"[^>]*>.*?</context>\n?', "", text, flags=re.S)
    text = re.sub(r"(?:\[Review comment: [^\]]*\] ?){2,}", lambda m: f"[{m.group(0).count('[Review comment')} review comments:]", text)
    text = re.sub(r'<context kind="review-comment"[^>]*>\n?(.*?)</context>\n?', lambda m: _review_comment(m.group(1)) + "\n", text, flags=re.S)
    text = re.sub(r"<assistant_citations>\n(?:The following citations[^\n]*\n)?(\[.*?\])\n</assistant_citations>", lambda m: _citations(m.group(1)), text, flags=re.S)
    return re.sub(r"\n*<t3_context version=\"1\">\s*</t3_context>", "", text).strip()


def user_kind(text, root):
    if text.startswith(CONTROL):
        return "control"
    return "human" if HUMAN_LABEL.match(text) or (root and not AGENT_LABEL.match(text)) else "agent"


def notice_kind(text):
    return next((k for k, needle in NOTICE_KINDS if needle in text), "other")


def parse_session(path, root):
    """One pass over a pi session jsonl; everything later sections need. Of tool results it keeps errors in full and,
    per call, a short record (exit code, first 300 characters, which guard fired) for the trace checks."""
    s = dict(turns=0, calls=0, cost=0.0, ctx=0, image=0, tools=set(), errors=[], users=[], texts=[], events=[],
             spawned={}, results={}, first=None, last=None, cwd=None, model=None)
    seen = Counter()
    for line in open(path, encoding="utf-8"):
        e = json.loads(line)
        if e.get("type") in ("session", "model_change"):
            s["cwd"] = e.get("cwd") or s["cwd"]
            s["model"] = e.get("modelId") or s["model"]
            continue
        if e.get("type") == "usage":
            s["cost"] += ((e.get("usage") or {}).get("cost") or {}).get("total", 0)
            continue
        if e.get("type") != "message":
            continue
        m, ts = e["message"], e.get("timestamp")
        s["first"], s["last"] = s["first"] or ts, ts
        blocks = m.get("content") if isinstance(m.get("content"), list) else [{"type": "text", "text": m.get("content") or ""}]
        s["image"] += sum(len(b.get("data", "")) * 3 // 4 for b in blocks if b.get("type") == "image")
        role = m.get("role")
        if role == "system":
            s["tools"] |= {t["name"] for t in m.get("toolsAdded") or []}
            s["tools"] -= {t["name"] for t in m.get("toolsRemoved") or []}
        elif role == "user":
            text = text_of(blocks)
            s["users"].append((user_kind(text, root), ts, text))
            s["events"].append(("user", ts, text))
        elif role == "assistant":
            s["turns"] += 1
            usage = m.get("usage") or {}
            s["cost"] += (usage.get("cost") or {}).get("total", 0)
            s["ctx"] = usage.get("totalTokens") or s["ctx"]
            for b in blocks:
                if b.get("type") == "thinking" and b.get("thinking"):
                    s["texts"].append(("thinking", ts, b["thinking"]))
                    s["events"].append(("thinking", ts, b["thinking"]))
                elif b.get("type") == "text" and b.get("text"):
                    s["texts"].append(("assistant", ts, b["text"]))
                    s["events"].append(("assistant", ts, b["text"]))
                elif b.get("type") == "toolCall":
                    s["calls"] += 1
                    seen[(b.get("name"), json.dumps(b.get("arguments"), sort_keys=True))] += 1
                    s["events"].append(("call", ts, (b.get("name") or "", b.get("arguments"), b.get("id"))))
        elif role == "toolResult":
            text = text_of(blocks)
            code = re.findall(r"Command exited with code (\d+)", text)
            r = dict(id=m.get("toolCallId"), tool=short_tool(m.get("toolName")), isError=bool(m.get("isError")),
                     code=int(code[-1]) if code else None, head=text[:300], guard=guard_of(text))
            s["results"][r["id"]] = r
            s["events"].append(("result", ts, r))
            if m.get("isError"):
                s["errors"].append((m.get("toolName") or "?", ts, text))
                s["texts"].append(("tool_error", ts, text))
                s["events"].append(("error", ts, (m.get("toolName") or "?", text)))
            elif (m.get("toolName") or "").endswith(("workstream_scaffold", "workstream_spawn")):
                # "key → thread:…" pairs (scaffold) or the spawned id: what each later brief call targets
                s["spawned"][m.get("toolCallId")] = dict(re.findall(r"(\S+) \u2192 (thread:[\w-]+(?::[\w-]+)*)", text)) or \
                    {"*": next(iter(re.findall(r"sub-thread (thread:[\w-]+(?::[\w-]+)*)", text)), None)}
    s["repeated"] = sum(n - 1 for n in seen.values())
    return s


ERROR_LINE = re.compile(r"error|ERR_|cannot|can't|No such file|not found|Traceback|Blocked by|denied|timed out|fatal|Exception|Refused", re.I)


def error_signature(tool, text):
    """Normalised first meaningful error line: bash output is mostly stdout, so it takes the last error-looking line."""
    lines = [l.strip() for l in text.splitlines() if l.strip() and not l.startswith("Command exited with code")]
    if tool == "bash":
        line = next((l for l in reversed(lines) if ERROR_LINE.search(l)), None)
        if line is None:
            code = re.search(r"Command exited with code (\d+)", text)
            return f"non-zero exit {code.group(1)}, no error line" if code else "no error line"
    else:
        line = lines[0] if lines else ""
    line = re.sub(r"thread:mcp:\S+?(?=[\s;,.'\"`]|$)|\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", "<thread>", line)
    line = re.sub(r"(https?://[^/\s]+)\S*", r"\1/…", line)
    line = re.sub(r"(?<![\w.:/])(?:~|\.{0,2})/[^\s:'\"`)]+", "<path>", line)
    line = re.sub(r"'[^']{0,80}'|\"[^\"]{0,80}\"", "'…'", line)
    line = re.sub(r"\b[0-9a-f]{8,}\b|\b\d+\b", "N", line)
    return line[:140]


# ── Trace checks: signals.yaml kind structural, scope session, origin loom-evals plan (2026-11) ──────────
# Each matches a toolCall's name and arguments or the control plane's own result text, never the model's
# prose; the report is read only as a claim paired with the absence of a command (tests-claimed-not-run,
# moved-text-unwritten). A check takes the parsed session and a context (role, report, gated, project_root)
# and returns hits (timestamp, tool, excerpt, variant, count), the first of each variant per session, so the
# first 20 hits of a check are 20 sessions.

def short_tool(name):
    return re.sub(r"^mcp__[\w-]+?__", "", name or "?")


def guard_of(text):
    """Which Loom guard spoke in a tool result, from the guard's own text: a block, a refusal, or a note it appended."""
    if m := re.match(r"Blocked by the t3 ([\w-]+) guard", text):
        return f"blocked: {m.group(1)} guard"
    if text.startswith("Refused:"):
        return "refused"
    m = re.search(r"\[t3 ([\w-]+) guard\] (\w+)", text)
    return m and f"{'rewrite' if m.group(2).startswith('Rewr') else 'note'}: {m.group(1)} guard"


def _calls(s):
    return [(ts, short_tool(x[0]), x[1] if isinstance(x[1], dict) else {}, x[2]) for k, ts, x in s["events"] if k == "call"]


def _cmds(s):
    return [(ts, str(a.get("command") or ""), cid) for ts, n, a, cid in _calls(s) if n in ("bash", "bg_start")]


def _segments(cmd):
    return [x.strip() for x in re.split(r"\s*(?:;|&&|\|\||\||\n)\s*", cmd) if x.strip()]


def _git(seg):
    """(subcommand, args) when a command segment runs git, else None."""
    m = re.match(r"(?:sudo\s+|\w+=\S*\s+)*git((?:\s+-[Cc]\s+\S+)*)\s+(\S+)(.*)", seg, re.S)
    return m and (m.group(2), m.group(3).split())


def _hits(found):
    first, n = {}, Counter()
    for ts, tool, ex, var in found:
        n[var] += 1
        first.setdefault(var, (ts, tool, one_line(str(ex), 300), var))
    return [(*h, n[h[3]]) for h in first.values()]


KILLED_JOB = re.compile(r"Background job \S+ (?:ended by SIG\w+|finished \(exit (?:137|143)\))")


def check_killed_then_silent(s, ctx):
    cmd = {cid: c for _, c, cid in _cmds(s)}
    ev, found = s["events"], []
    for i, (k, ts, r) in enumerate(ev):
        if k != "result":
            continue
        var = ("timed out" if r["head"].startswith("Command timed out after") else f"exit {r['code']}" if r["code"] in (137, 143) else None) \
            if r["tool"] == "bash" else "bg job killed" if r["tool"] == "bg_wait" and KILLED_JOB.match(r["head"]) else None
        if var and next((k2 for k2, *_ in ev[i + 1:] if k2 in ("call", "user")), "user") == "user":
            found.append((ts, r["tool"], cmd.get(r["id"]) or r["head"], var))
    return _hits(found)


def _ships(d):
    """The repository at d has the guarded ship procedure: a .t3code/ship.json policy and a `ship` package script."""
    try:
        return Path(d, ".t3code/ship.json").exists() and "ship" in json.loads(Path(d, "package.json").read_text()).get("scripts", {})
    except (OSError, ValueError):
        return False


def check_merge_bypass(s, ctx):
    cmds = _cmds(s)
    if any("pnpm ship" in c for _, c, _ in cmds) or not any(_ships(d) for d in (s["cwd"], ctx.get("project_root")) if d):
        return []
    return _hits([(ts, "bash", c, None) for ts, c, _ in cmds if re.search(r"\bgh pr merge\b", c)])


def check_failed_then_publish(s, ctx):
    cmd = {cid: c for _, c, cid in _cmds(s)}
    found, failed = [], None
    for k, ts, x in s["events"]:
        if k == "user":
            failed = None
        elif k == "result" and x["tool"] == "bash" and x["code"] and any(re.match(r"(?:sudo\s+)?(?:mv|cp|git)\b", g) for g in _segments(cmd.get(x["id"], ""))):
            failed = cmd[x["id"]]
        elif k == "call" and short_tool(x[0]) in ("bash", "bg_start") and isinstance(x[1], dict):
            c = str(x[1].get("command") or "")
            if "git status" in c:
                failed = None
            elif failed and any(re.match(r"(?:pnpm ship|gh pr create)\b", g) for g in _segments(c)):
                found.append((ts, short_tool(x[0]), f"failed: {one_line(failed, 120)} | then: {c}", None))
                failed = None
    return _hits(found)


def check_write_outside_worktree(s, ctx):
    if not s["cwd"]:
        return []
    home = str(Path.home())
    allowed = (s["cwd"].rstrip("/") + "/", "/tmp/", f"{home}/loom-retro/", f"{home}/loom-evals/")
    paths = [(ts, n, str(Path(str(a.get("path") or "")).expanduser())) for ts, n, a, _ in _calls(s) if n in ("edit", "write")]
    return _hits([(ts, n, p, None) for ts, n, p in paths if p.startswith("/") and not p.startswith(allowed) and "/.artifacts/" not in p])


INSTRUCTION = re.compile(r"(?:^|/)(?:\.t3code/)?roles/[^/]+\.md$|(?:^|/)skills/[^/]+/SKILL\.md$|(?:^|/)AGENTS\.md$")


def check_instruction_edit_ungated(s, ctx):
    calls = _calls(s)
    if ctx.get("gated") or any("llm-instruction-change/SKILL.md" in str(a.get("path")) for _, n, a, _ in calls if n in ("read", "read_full")):
        return []
    return _hits([(ts, n, a.get("path"), None) for ts, n, a, _ in calls if n in ("edit", "write") and INSTRUCTION.search(str(a.get("path") or ""))])


VISUAL = re.compile(r"apps/web/.*\.tsx$|\.css$|\.html$|(?:^|/)README\.md$")


def _new_text(n, a):
    return str(a.get("content") or "") if n == "write" else "\n".join(str(e.get("newText") or "") for e in a.get("edits") or [a] if isinstance(e, dict))


def check_visual_unseen(s, ctx):
    found, pending = [], None
    for ts, n, a, _ in _calls(s):
        p = str(a.get("path") or "")
        if n in ("edit", "write") and VISUAL.search(p) and (not p.endswith(".tsx") or re.search(r"className|style|<div|<span", _new_text(n, a))):
            pending = pending or (ts, n, p, None)
        elif re.match(r"(?:html_preview|preview_\w+|browser_\w+|device_\w+)$", n) or (n in ("read", "read_full") and p.lower().endswith(".png")):
            pending = None
        elif n == "workstream_submit" and pending:
            found, pending = found + [pending], None
    return _hits(found + [pending] * bool(pending))


CLAIMS = [("tests", re.compile(r"\b(?<!not )(?:verified|tests? pass(?:ed)?|typecheck passes|vp check passes)\b", re.I),
           re.compile(r"vp (?:check|test|run (?:typecheck|test|check:changed))|vpr test|pnpm (?:test|check)|vitest|pytest|npm test|cargo test|go test|lint-doc\.sh|lint-plan\.mjs")),
          ("shipped", re.compile(r"\b(?:shipped|merged)(?: (?:as|in|via))? (?:PR )?#\d+|\b(?:shipped|merged) (?:it|this|the (?:PR|branch|change)|(?:in)?to main)\b", re.I), re.compile(r"pnpm ship|gh pr merge|git push"))]


def _line_of(text, m):
    return text[text.rfind("\n", 0, m.start()) + 1:].split("\n", 1)[0]


def check_tests_claimed_not_run(s, ctx):
    report = ctx.get("report") or ""
    if ctx.get("role") not in ("coder", "reviewer") or not report:
        return []
    found = []
    for label, claim, command in CLAIMS:
        if m := claim.search(report):
            ran = [(ts, c, cid) for ts, c, cid in _cmds(s) if command.search(c)]
            # a bg_start result is the launch, not the job's exit, so only bash results can show a failure
            failed = ran and all(s["results"].get(cid, {}).get("tool") == "bash" and (s["results"][cid]["isError"] or s["results"][cid]["code"]) for *_, cid in ran)
            if not ran or failed:
                label = "verified" if all(x.group(0).lower() == "verified" for x in claim.finditer(report)) else label
                found.append((s["last"], "report", _line_of(report, m), f"{label} claimed, {'command failed' if ran else 'no command'}"))
    return _hits(found)


def check_moved_text_unwritten(s, ctx):
    report = ctx.get("report") or ""
    written = [str(a.get("path") or "") for _, n, a, _ in _calls(s) if n in ("edit", "write")]
    if not written:  # a session that wrote nothing is describing the work under review, not claiming its own write
        return []
    cmds = "\n".join(c for _, c, _ in _cmds(s))
    found = []
    for m in re.finditer(r"\b(?:moved|added|written)\b[^\n`]{0,80}?\bto\b[^\n`]{0,20}?`([^`\s]+)`", report, re.I):
        p = m.group(1).rstrip(".,:;")
        tail = re.sub(r"^(?:~|\.)?/+", "", re.sub(r":\d+(?:-\d+)?$", "", p))
        if ("/" in tail or re.search(r"\.\w{1,5}$", tail)) and Path(tail).name not in cmds and \
                not any(w == p or w.endswith("/" + tail) or w.lstrip("./") == tail for w in written):
            found.append((s["last"], "report", _line_of(report, m), None))
    return _hits(found)


def check_forbidden_git(s, ctx):
    found = []
    for ts, c, _ in _cmds(s):
        for seg in _segments(c):
            sub, args = _git(seg) or ("", [])
            paths = [a for a in args if not a.startswith("-")]  # `git add -A <path>` stages only that path
            var = ("git add -A" if sub == "add" and ({"-A", "--all"} & set(args) and not paths or "." in paths) else
                   "git stash" if sub == "stash" and args[:1] not in (["list"], ["show"]) else
                   "git push to main" if sub == "push" and any(a in ("main", "master") or a.endswith((":main", ":master")) for a in args) else None)
            if var:
                found.append((ts, "bash", seg, var))
    return _hits(found)


def check_kill_by_pattern(s, ctx):
    found = []
    for ts, c, _ in _cmds(s):
        if re.search(r"\bpgrep\b[^;&\n]*\|\s*xargs\b[^;&|\n]*\bkill\b", c):
            found.append((ts, "bash", c, "pgrep | xargs kill"))
        found += [(ts, "bash", g, "pkill") for g in _segments(c) if re.match(r"(?:sudo\s+)?pkill\b", g)]
        found += [(ts, "bash", g, "kill $(pgrep|pidof|ps)") for g in _segments(c) if re.match(r"(?:sudo\s+)?kill\b[^$]*\$\(\s*(?:pgrep|pidof|ps)\b", g)]
    return _hits(found)


def check_sleep_poll(s, ctx):
    sleeps = [(ts, c) for ts, n, a, _ in _calls(s) if n == "bash" for c in [str(a.get("command") or "")] if re.search(r"\bsleep\s+(?:[5-9]|\d{2,})", c)]  # under 5 s is settle time, not a poll
    if len(sleeps) < 3:
        return []
    var = "watching gh pr, gh run or checks" if any(re.search(r"gh pr|gh run|checks", c) for _, c in sleeps) else "other"
    return [(sleeps[0][0], "bash", one_line(sleeps[0][1], 300), var, len(sleeps))]


def check_file_reread(s, ctx):
    # an image is re-read after each re-render, so only text files count
    reads = [(ts, (a.get("path"), a.get("offset"), a.get("limit"))) for ts, n, a, _ in _calls(s)
             if n in ("read", "read_full") and not re.search(r"\.(?:png|jpe?g|gif|webp)$", str(a.get("path")), re.I)]
    if not reads:
        return []
    key, k = Counter(r for _, r in reads).most_common(1)[0]
    return [(next(ts for ts, r in reads if r == key), "read", f"{key[0]} offset={key[1]} limit={key[2]}", None, k)] if k >= 4 else []


def check_unasked_commit(s, ctx):
    kickoff = next((x for k, _, x in s["events"] if k == "user"), "")
    if ctx.get("role") not in ("reviewer", "researcher", "planner", "assessor", "root") or "commit" in kickoff.lower():
        return []
    return _hits([(ts, "bash", g, None) for ts, c, _ in _cmds(s) for g in _segments(c) if (_git(g) or ("",))[0] == "commit"])


def check_guard_fired(s, ctx):
    cmd = {cid: str(a.get("command") or a.get("path") or a) for _, _, a, cid in _calls(s)}
    return _hits([(ts, r["tool"], r["head"] if r["guard"].startswith(("blocked", "refused")) else cmd.get(r["id"], ""), r["guard"])
                  for k, ts, r in s["events"] if k == "result" and r["guard"]])


TRACE_CHECKS = {f.__name__.removeprefix("check_"): f for f in (
    check_killed_then_silent, check_merge_bypass, check_failed_then_publish, check_write_outside_worktree,
    check_instruction_edit_ungated, check_visual_unseen, check_tests_claimed_not_run, check_moved_text_unwritten,
    check_forbidden_git, check_kill_by_pattern, check_sleep_poll, check_file_reread, check_unasked_commit, check_guard_fired)}


def trace_checks():
    """The trace checks signals.yaml declares and has not retired: {signal id: check function}."""
    return {s["id"]: TRACE_CHECKS[s["check"]] for s in yaml.safe_load(CATALOGUE.read_text())["signals"]
            if s["status"] != "retired" and s.get("check") in TRACE_CHECKS}


def read_report(path):
    """A thread's report plus its per-round reports (<stem>.round-<n>.md), or '' when none exists."""
    p = Path(path) if path else None
    return "\n".join(x.read_text(errors="replace") for x in ([p] if p.exists() else []) + sorted(p.parent.glob(p.stem + ".round-*.md"))) if p else ""


def loop_targets(db=None):
    """Thread ids a reviewer gate loops back to (a `loop` route in loom_thread_workstream.routes), read-only from the live database."""
    db = Path(db or Path(os.environ.get("T3CODE_HOME") or Path.home() / ".t3/cockpit", "userdata/statev2.sqlite"))
    if not db.exists():
        return set()
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return {r[0] for r in con.execute("select json_extract(r.value, '$.to') from loom_thread_workstream w, json_each(w.routes) r "
                                          "where json_extract(r.value, '$.kind') = 'loop'")}
    finally:
        con.close()


def fmt_dur(a, b):
    if not a or not b:
        return "–"
    secs = (datetime.fromisoformat(b.replace("Z", "+00:00")) - datetime.fromisoformat(a.replace("Z", "+00:00"))).total_seconds()
    return f"{int(secs // 3600)}:{int(secs % 3600 // 60):02d}"


def one_line(text, n=160):
    return re.sub(r"\s+", " ", text).strip()[:n]


def scan(manifest, out):
    catalogue = [s for s in yaml.safe_load(CATALOGUE.read_text())["signals"] if s["status"] != "retired"]
    checks = {s["check"]: s for s in catalogue if s["kind"] == "structural"}
    phrases = [(s, re.compile(s["pattern"], re.I | re.M)) for s in catalogue if s["kind"] == "phrase"]
    threads = manifest["threads"]
    for i, t in enumerate(threads, 1):
        t["n"], t["role"] = i, t.get("role") or ("orchestrator" if t.get("parentId") is None else "child")
        t["s"] = parse_session(t["sessionPath"], t.get("parentId") is None) if t.get("sessionPath") and Path(t["sessionPath"]).exists() else None
    label = {t["id"]: f"#{t['n']} {one_line(t.get('title') or t['id'], 48)}" for t in threads}
    scanned = [t for t in threads if t["s"]]

    # Control-plane notices: per receiving thread, and attributed to the child they name.
    notices, about = [], defaultdict(list)
    for t in scanned:
        for kind, ts, text in t["s"]["users"]:
            if kind == "control":
                nk = notice_kind(text)
                child = re.search(r"sub-thread \S+ `([^`]+)`", text)
                notices.append((t, nk, ts, text, child and child.group(1)))
                if child and nk not in ("digest", "other"):
                    outcome = re.search(r"outcome `([^`]+)`|submitted `([^`]+)`", text)
                    about[child.group(1)].append(nk + (f" ({next(g for g in outcome.groups() if g)})" if outcome else ""))

    # Structural checks → per-thread flags and per-signal hit counts.
    hits = defaultdict(Counter)
    flags = defaultdict(list)
    p = checks.get("turn_outlier", {}).get("params", {})
    factor, min_role = p.get("factor", 2), p.get("min_role_size", 3)
    by_role = defaultdict(list)
    for t in scanned:
        by_role[t["role"]].append(t)
    tree_med = {k: statistics.median(t["s"][k] for t in scanned) for k in ("turns", "cost")} if scanned else {}
    for t in scanned:
        s, tid = t["s"], t["id"]
        if "tool_error" in checks and s["errors"]:
            hits["tool-error"][tid] = len(s["errors"])
            if len(s["errors"]) >= checks["tool_error"].get("params", {}).get("outlier_min", 5):
                flags[tid].append(f"{len(s['errors'])} tool errors")
        if "repeated_call" in checks and s["repeated"]:
            if s["repeated"] >= checks["repeated_call"].get("params", {}).get("outlier_min", 10):
                hits["repeated-call"][tid] = s["repeated"]
                flags[tid].append(f"{s['repeated']} repeated calls")
        if "turn_outlier" in checks and t.get("parentId") is not None:  # the root has no peers
            peers = by_role[t["role"]]
            for k, fmt in (("turns", "{:.0f} turns".format), ("cost", "${:.2f}".format)):
                # turns are compared tree-wide too (model-independent); cost only within the role unless the role is too small
                role_med = [(t["role"], statistics.median(x["s"][k] for x in peers))] if len(peers) >= min_role else []
                meds = ([("tree", tree_med[k])] if k == "turns" or not role_med else []) + role_med
                over = [f"{who} median {fmt(med)}" for who, med in meds if med and s[k] > factor * med]
                if over:
                    hits["turn-outlier"][tid] += 1
                    flags[tid].append(f"{fmt(s[k])} > {factor}× " + ", ".join(over))
        if "missing_tool" in checks:
            mp = checks["missing_tool"].get("params", {})
            # a session that never recorded its tool set (older pi) cannot be judged
            missing = [x for x in mp.get("tools", []) if x not in s["tools"]] if s["tools"] and t["role"] in mp.get("roles", []) else []
            if missing:
                hits["missing-tool"][tid] = 1
                flags[tid].append(f"launched without {', '.join(missing)}")
    if "control_decision" in checks:
        for t in threads:
            d = t.get("lastDecision") or {}
            why = [f"last decision {d.get('decision')} ({d.get('outcome')})"] if d.get("decision") and d.get("decision") not in SETTLED else []
            why += [f"{t['gateRounds']} rework round(s)"] if t.get("gateRounds") else []
            why += [f"{t['attentionEpisodes']} attention episode(s)"] if t.get("attentionEpisodes") else []
            why += ["report synthesised"] if t.get("reportSynthesised") else []
            why += [f"notice: {x}" for x in dict.fromkeys(about.get(t["id"], []))]
            if why:
                hits["control-decision"][t["id"]] = len(why)
                flags[t["id"]] += why

    # Trace checks: per session, with the thread's role, report and whether a reviewer gates it.
    trace, gated = defaultdict(list), loop_targets()
    for t in scanned:
        ctx = dict(role="root" if t.get("parentId") is None else t["role"], report=read_report(t.get("reportPath")),
                   gated=t["id"] in gated or bool(t.get("gateRounds")))
        for sid, fn in trace_checks().items():
            for h in fn(t["s"], ctx):
                hits[sid][t["id"]] += h[4]
                trace[sid].append((t["id"], h))

    # Phrase signals over thinking / assistant / tool_error text and report files.
    excerpts = defaultdict(list)
    reports = {t["id"]: Path(t["reportPath"]).read_text(errors="replace") for t in threads
               if t.get("reportPath") and Path(t["reportPath"]).exists()}
    for sig, rx in phrases:
        sources = ([(t["id"], None, reports[t["id"]]) for t in threads if t["id"] in reports] if sig["scope"] == "report" else
                   [(t["id"], ts, text) for t in scanned for scope, ts, text in t["s"]["texts"] if scope == sig["scope"]])
        for tid, ts, text in sources:
            for mt in rx.finditer(text):
                hits[sig["id"]][tid] += 1
                if sig["scope"] == "report":
                    a = max(text.rfind("\n", 0, mt.start()) + 1, mt.start() - EXCERPT)
                    excerpts[sig["id"]].append((tid, ts, one_line(text[a:a + 2 * EXCERPT], 2 * EXCERPT)))
                else:
                    excerpts[sig["id"]].append((tid, ts, one_line(text[max(0, mt.start() - EXCERPT):mt.end() + EXCERPT], 2 * EXCERPT + 200)))

    def spread(items, cap):
        """Up to cap excerpts, round-robin across threads so one noisy thread cannot fill the section."""
        first, per = {}, defaultdict(list)
        for it in items:
            first.setdefault(it[:2], it)  # one excerpt per text block
        for it in first.values():
            per[it[0]].append(it)
        queues, picked = list(per.values()), []
        while queues and len(picked) < cap:
            picked += [q.pop(0) for q in queues][: cap - len(picked)]
            queues = [q for q in queues if q]
        return picked

    # ── digest ──
    src = manifest["source"]
    L = [f"# Retro scan: {src.get('title')}", "",
         f"Source root `{src.get('rootThreadId')}` · goal: {src.get('goalTitle') or '–'} · focus: {manifest.get('focus') or 'general'} · "
         f"{len(threads)} threads, {len(scanned)} sessions scanned · total cost ${sum(t['s']['cost'] for t in scanned):.2f} · "
         f"generated {datetime.now(timezone.utc).isoformat(timespec='seconds')}", "",
         "## Tree", "",
         "| # | Role | Title | Parent | Turns | Calls | Errors | Repeats | Duration | Context | Cost | Images MB | Outcome / decision | Flag | Id |",
         "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    num = {t["id"]: t["n"] for t in threads}
    for t in threads:
        s, d = t["s"], t.get("lastDecision") or {}
        dec = f"{t.get('outcome') or '–'} / {d.get('decision') or '–'} {d.get('outcome') or ''}".strip()
        cells = ([s["turns"], s["calls"], len(s["errors"]), s["repeated"], fmt_dur(s["first"], s["last"]), f"{s['ctx'] // 1000}k",
                  f"${s['cost']:.2f}", f"{s['image'] / 1e6:.1f}"] if s else ["not launched"] + [""] * 7)
        L.append("| " + " | ".join(map(str, [t["n"], t["role"], one_line(t.get("title") or "", 60).replace("|", "/"),
                                             f"#{num[t['parentId']]}" if t.get("parentId") in num else "–", *cells, dec,
                                             "⚠" if flags.get(t["id"]) else "", f"`{t['id']}`"])) + " |")

    L += ["", "## Outliers", ""]
    L += [f"- **{label[t['id']]}** ({t['role']}): " + "; ".join(flags[t["id"]]) for t in threads if flags.get(t["id"])] or ["- none"]

    L += ["", "## Human messages", ""]
    for t in scanned:
        msgs = [(ts, clean_human(text)) for kind, ts, text in t["s"]["users"] if kind == "human"]
        if msgs:
            L += [f"### {label[t['id']]} — {len(msgs)} message(s)", ""]
            for ts, text in msgs:
                L += [f"**{ts}**", "", *[f"> {l}" if l else ">" for l in text.splitlines()], ""]

    L += ["## Control-plane notices", ""]
    digests = Counter(t["id"] for t, nk, *_ in notices if nk == "digest")
    L += [f"- {label[tid]}: {n} FYI digest(s)" for tid, n in digests.items()]
    L += [f"- {ts} → {label[t['id']]}: **{nk}**" + (f" about {label.get(c, c)}" if c else "") + f" — {one_line(re.sub(r'`([^`]+)`', lambda g: label.get(g.group(1), g.group(0)), text.split(chr(10), 2)[-1]), 180)}"
          for t, nk, ts, text, c in notices if nk != "digest"] or ([] if digests else ["- none"])

    L += ["", "## Tool errors", ""]
    groups = defaultdict(list)
    for t in scanned:
        for tool, ts, text in t["s"]["errors"]:
            groups[(tool, error_signature(tool, text))].append(t["id"])
    L += [f"- **{len(ids)}×** `{tool}` — {sig.replace('`', '')} — " + ", ".join(f"{label[i]}" + (f" ×{n}" if n > 1 else "") for i, n in Counter(ids).items())
          for (tool, sig), ids in sorted(groups.items(), key=lambda kv: (-len(kv[1]), kv[0]))] or ["- none"]

    for title, scope_ok in (("Catalogue hits", lambda s: s["scope"] != "report"), ("Report tells", lambda s: s["scope"] == "report")):
        L += ["", f"## {title}", ""]
        for sig, _ in phrases:
            if not scope_ok(sig):
                continue
            h = hits[sig["id"]]
            L += [f"### {sig['id']} ({sig['scope']}) — {sum(h.values())} hit(s) in {len(h)} thread(s)", ""]
            if h:
                L += ["Per thread: " + ", ".join(f"{label[i]} ×{n}" for i, n in h.most_common()), ""]
                L += [f"- {label[tid]}{' ' + ts if ts else ''}: “{ex}”" for tid, ts, ex in spread(excerpts[sig["id"]], PER_SIGNAL)] + [""]
        L += ["_No hits is not a clean run: phrase tells are narrow by design; the structural sections carry most trees._"] if title == "Catalogue hits" else []

    L += ["", "## Tool-set gaps", ""]
    L += [f"- **{label[tid]}**: " + next(f for f in flags[tid] if f.startswith("launched without")) for tid in hits["missing-tool"]] or ["- none"]

    L += ["", "## Trace checks", ""]
    L += [f"- **{sid}** ({len(hits[sid])} thread(s)): " + ", ".join(f"{label[tid]} ×{h[4]}" + (f" [{h[3]}]" if h[3] else "") for tid, h in rows) +
          f" — e.g. {rows[0][1][1]} “{one_line(rows[0][1][2], 160)}”" for sid, rows in trace.items()] or ["- none"]
    digest = "\n".join(L) + "\n"
    (out / "digest.md").write_text(digest)

    (out / "scan.json").write_text(json.dumps({
        "version": 1, "createdAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": src, "focus": manifest.get("focus"),
        "threads": [{"id": t["id"], "n": t["n"], "role": t["role"], "title": t.get("title"), "flags": flags.get(t["id"], []),
                     **({k: t["s"][k] for k in ("turns", "calls", "repeated", "cost", "ctx", "image", "first", "last")} |
                        {"errors": len(t["s"]["errors"]), "tools": sorted(t["s"]["tools"])} if t["s"] else {"launched": False})}
                    for t in threads],
        "signals": {s["id"]: {"kind": s["kind"], "scope": s["scope"], "hits": sum(hits[s["id"]].values()),
                              "threads": dict(hits[s["id"]])} for s in catalogue},
        "toolErrors": [{"tool": tool, "signature": sig, "count": len(ids), "threads": dict(Counter(ids))} for (tool, sig), ids in groups.items()],
    }, indent=1))
    print(f"{out / 'digest.md'}: {len(digest):,} chars (~{est_tokens(digest):,} tokens); {out / 'scan.json'}")


def render_args(v, indent=""):
    """Brief-call arguments readable: long strings as blocks, everything else nested."""
    if isinstance(v, dict):
        return "\n".join(f"{indent}- **{k}**:" + ("\n" + render_args(x, indent + "  ") if isinstance(x, (dict, list)) or (isinstance(x, str) and "\n" in x)
                                                  else f" {x}") for k, x in v.items())
    if isinstance(v, list):
        return "\n".join(f"{indent}- [{i}]\n" + render_args(x, indent + "  ") for i, x in enumerate(v))
    return "\n".join(f"{indent}  {l}" for l in str(v).splitlines())


def collapse_digest(text, label):
    """An FYI digest keeps its per-child header lines (who, outcome, released) and drops the report
    excerpts: the child's words are in its report file (reportPath in the manifest), read for flagged threads."""
    keep = ["FYI digest:"] + [l for l in text.splitlines() if l.startswith(("### ", "_20"))]
    return relabel("\n".join(keep), label)


def relabel(text, label):
    """Thread ids → their digest `#n title` labels, so notices and stubs read as the tree."""
    return re.sub(r"`?(thread:[\w-]+(?::[\w-]+)*)`?", lambda m: label.get(m.group(1), m.group(0)), text)


def extract(manifest, tid, out, briefs=""):
    threads = manifest["threads"]
    t = next((x for x in threads if x["id"] == tid), None) or next(x for x in threads if x["id"].startswith(tid))
    if not (t.get("sessionPath") and Path(t["sessionPath"]).exists()):
        raise SystemExit(f"{t['id']} has no session file (never launched?)")
    s = parse_session(t["sessionPath"], t.get("parentId") is None)
    num = {x["id"]: i for i, x in enumerate(threads, 1)}
    label = {x["id"]: f"#{num[x['id']]} \u201c{one_line(x.get('title') or x['id'], 48)}\u201d" for x in threads}
    full = set(num.values()) if briefs == "all" else {int(n) for n in briefs.split(",") if n.strip()}
    by_title = {x.get("title"): x["id"] for x in threads}
    keys = {}  # scaffold node key → thread id, as the results arrive
    L = [f"# Extract: {t.get('title')}", "", f"`{t['id']}` · {t.get('role') or 'orchestrator'} · {t.get('model')} · session `{t['sessionPath']}`", ""]
    pending = Counter()

    def flush():
        if pending:
            L.append("_[tools: " + ", ".join(f"{n} ×{c}" if c > 1 else n for n, c in pending.items()) + "]_\n")
            pending.clear()

    def targets(name, args, call_id):
        """Thread ids a brief-writing call addresses, from the spawn/scaffold results (title as a fallback)."""
        spawned = s["spawned"].get(call_id, {})
        if name.endswith("workstream_scaffold"):
            keys.update(spawned)
            return [spawned.get(n.get("key")) or by_title.get(n.get("title")) for n in args.get("nodes", [])]
        if name.endswith("workstream_spawn"):
            return [spawned.get("*") or by_title.get(args.get("title"))]
        if name.endswith("workstream_brief"):
            return [keys.get(args.get("node"))]
        ref = args.get("threadId") or ""
        return [next((i for i in num if i == ref or i.endswith(ref)), None)]

    for kind, ts, x in s["events"]:
        if kind == "result":
            continue
        if kind == "call" and not x[0].endswith(BRIEF_TOOLS):
            pending[x[0].removeprefix("mcp__t3-code__")] += 1
            continue
        if kind == "call":
            name, args, call_id = x
            args = args if isinstance(args, (dict, list)) else {"arguments": args}
            tids = [i for i in targets(name, args, call_id) if i in num] if isinstance(args, dict) else []
            head = f"### {ts} — `{name.removeprefix('mcp__t3-code__')}` → " + (", ".join(label[i] for i in tids) or "?")
            if full:
                if any(num[i] in full for i in tids):
                    L += [head, "", render_args(args), ""]
                continue
            flush()
            # steers are short and are themselves a signal; briefs are stubbed to their target and size
            if name.endswith("workstream_prompt") or not tids:
                L += [head, "", render_args(args), ""]
            else:
                size = len(json.dumps(args))
                L += [head + f" — {size:,} chars (~{est_tokens(size):,} tokens); `--briefs {','.join(str(num[i]) for i in tids)}` for the full text", ""]
            continue
        if full:
            continue
        flush()
        if kind == "user":
            who = user_kind(x, t.get("parentId") is None)
            L += [f"## {ts} — {'HUMAN' if who == 'human' else 'CONTROL NOTICE' if who == 'control' else 'AGENT MESSAGE'}", "",
                  clean_human(x) if who == "human" else collapse_digest(x, label) if who == "control" and notice_kind(x) == "digest" else relabel(x, label) if who == "control" else x, ""]
        elif kind == "thinking":
            L += [f"_thinking {ts}_", "", *[f"> {l}" if l else ">" for l in x.strip().splitlines()], ""]
        elif kind == "assistant":
            L += [f"**assistant {ts}**", "", x.strip(), ""]
        elif kind == "error":
            L += [f"_tool error {ts} — `{x[0]}`:_", "", "```", x[1][:1500], "```", ""]
    flush()
    stem = re.sub(r"[:/]", "_", t["id"])
    path = out / (f"briefs-{briefs.replace(',', '-')}.md" if full else f"extract-{stem}.md")
    if full:
        L = [f"# Briefs, steers and spawn calls from {t.get('title')} to #{briefs}", ""] + L[4:]
    path.write_text(text := "\n".join(L) + "\n")
    print(f"{path}: {len(text):,} chars (~{est_tokens(text):,} tokens)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--extract", metavar="THREAD_ID")
    ap.add_argument("--briefs", default="", metavar="N,N|all", help="with --extract: write only the brief-writing calls addressed to these digest #n threads, in full")
    a = ap.parse_args()
    manifest = json.loads(a.manifest.read_text())
    out = a.out or a.manifest.parent
    out.mkdir(parents=True, exist_ok=True)
    extract(manifest, a.extract, out, a.briefs) if a.extract else scan(manifest, out)


if __name__ == "__main__":
    main()
