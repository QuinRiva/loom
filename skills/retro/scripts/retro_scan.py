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
import argparse, functools, itertools, json, os, re, sqlite3, statistics, subprocess
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import yaml

CATALOGUE = Path(__file__).resolve().parent.parent / "signals.yaml"
CONTROL = ("[T3 Workstream control plane", "[T3 Code control plane")  # the second: RerouteSweep.ts resumes, older retries
AGENT_LABEL = re.compile(r"^\[(?:From your parent|From another agent|Brief from another agent|Automated resume|Sent by automation|Scheduled[- ]task)")
# An agent's relay, delivered bare as a user turn (render.ts composeNotifyFramedText; consult.ts for a consult fork).
NOTIFY = re.compile(r"(?:Notification|Consult) from (.+?), (?:sent )?via \S*(?:notify|consult)_thread[:.]")
# The loom server's pi prompt templates (CATCHUP_TEMPLATE_PATH): pi records only the expansion, never the slash command.
PROMPTS = Path(__file__).resolve().parents[3] / "prompts"
PLACEHOLDER = re.compile(r"\$\{@(?::-([^}]*))?[^}]*\}|\$@|\$ARGUMENTS|\$\d+")
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
    """One review-comment context → one line: the passage, its section and the human's comment. A comment promoted
    from a query thread is worded by the query thread's agent (document_query_promote), so it is marked as such."""
    f = lambda k: (re.search(rf"^{k}:(?:\n((?:  .*\n?)+)| (.*))", block, re.M) or [None, "", ""])
    field = lambda k: " ".join(x.strip() for x in (f(k)[1] or f(k)[2] or "").splitlines()).strip()
    promoted = " PROMOTED FROM A QUERY THREAD: an agent's summary of the human's discussion there, not the human's wording" \
        if "promoted from a query thread" in block else ""
    return f"[review of \u201c{field('quoted passage')}\u201d ({field('section')}){promoted}: {field('comment')}]"


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
    return re.sub(r"\s*<t3_context version=\"1\">\s*", "\n", re.sub(r"\s*</t3_context>", "", text)).strip()


@functools.cache
def templates():
    """(command, literal text before its first argument, literal text after it, the argument's default) per template."""
    out = []
    for p in sorted(PROMPTS.glob("*.md")):
        body = re.sub(r"\A---\n.*?\n---\n", "", p.read_text(), flags=re.S).strip()
        m = PLACEHOLDER.search(body)
        nxt = m and PLACEHOLDER.search(body, m.end())
        out.append((p.stem, body[:m.start()] if m else body, body[m.end():nxt.start() if nxt else None][:80] if m else "", m and m.group(1)))
    return out


def command_of(text):
    """(command, argument) when text is a prompt template's expansion: the human's slash command, not their words."""
    for name, head, tail, default in templates():
        if len(head) >= 40 and text.startswith(head):
            arg = text[len(head):].split(tail, 1)[0].strip() if tail else ""
            return name, "" if arg == default else arg
    return None


def answered(text, asked):
    """[(header, question, answer)] when text answers an open ask_user_question asked earlier in the session: the
    server sends each answered question's text, a newline and the answer, joined by blank lines (Orchestrator.ts)."""
    body = text.removeprefix("[From the human]\n\n")
    for qs in reversed(asked):
        ms = sorted((m.start(), m.end(), h, q) for h, q in qs if q and (m := re.search(r"(?:\A|\n\n)" + re.escape(q) + r"\n", body)))
        if ms and ms[0][0] == 0:
            return [(h, q, body[e:ms[i + 1][0] if i + 1 < len(ms) else None].strip()) for i, (_, e, h, q) in enumerate(ms)]
    return None


def user_kind(text, root, asked=()):
    """control | notify (an agent's relay) | agent | human, or, for the human's turns the platform composed, answer (the
    agent's question with the human's answer) and command (a prompt template's expansion). Unclear stays human."""
    if text.startswith(CONTROL):
        return "control"
    if NOTIFY.match(text):
        return "notify"
    if command_of(text):
        return "command"
    if not (HUMAN_LABEL.match(text) or (root and not AGENT_LABEL.match(text))):
        return "agent"
    return "answer" if answered(text, asked) else "human"


HUMAN_KINDS = {"human": "", "answer": "answer to an agent's question", "command": "slash command"}


def human_text(kind, text, asked):
    """A human turn as the reviewer reads it: the human's words verbatim, and what they did not type marked or collapsed."""
    if kind == "command":
        name, arg = command_of(text)
        return f"[/{name}" + (f" {arg}" if arg else "") + f": its {len(text):,}-character template is not shown]"
    if kind == "answer":
        return "\n\n".join(f"[the agent asked \u201c{h}\u201d: \u201c{one_line(q, 200)}\u2026\u201d; the human answered:]\n{clean_human(a)}"
                           for h, q, a in answered(text, asked))
    return clean_human(text)


def notification(text, label):
    """An agent's relay → (sender, its message without the platform's framing and footer)."""
    who = NOTIFY.match(text).group(1)
    sid, title = re.search(r"thread:[\w:-]+", who), re.search(r"\u00ab(.*?)\u00bb", who)
    sender = label.get(sid and sid.group(0)) or (f"\u00ab{title.group(1)}\u00bb (outside this tree)" if title else who)
    return sender, text.split("\n\n", 1)[-1].rsplit("\n\nNo reply is owed.", 1)[0]


def notice_kind(text):
    return next((k for k, needle in NOTICE_KINDS if needle in text), "other")


def parse_session(path, root):
    """One pass over a pi session jsonl; everything later sections need. Of tool results it keeps errors in full and,
    per call, a short record (exit code, first 300 characters, which guard fired) for the trace checks."""
    s = dict(turns=0, calls=0, cost=0.0, ctx=0, image=0, tools=set(), errors=[], users=[], texts=[], events=[],
             spawned={}, results={}, asked=[], first=None, last=None, start=None, cwd=None, model=None)
    seen = Counter()
    for line in open(path, encoding="utf-8"):
        e = json.loads(line)
        if e.get("type") in ("session", "model_change"):
            s["start"] = s["start"] or (e.get("timestamp") if e.get("type") == "session" else None)
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
            s["users"].append((user_kind(text, root, s["asked"]), ts, text))
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
                    if (b.get("name") or "").endswith("ask_user_question") and isinstance(b.get("arguments"), dict):
                        s["asked"].append([(q.get("header") or "", (q.get("question") or "").strip())
                                           for q in b["arguments"].get("questions") or [] if isinstance(q, dict)])
                    seen[(b.get("name"), json.dumps(b.get("arguments"), sort_keys=True))] += 1
                    s["events"].append(("call", ts, (b.get("name") or "", b.get("arguments"), b.get("id"))))
        elif role == "toolResult":
            text = text_of(blocks)
            code = re.findall(r"Command exited with code (\d+)", text)
            r = dict(id=m.get("toolCallId"), tool=short_tool(m.get("toolName")), isError=bool(m.get("isError")),
                     code=int(code[-1]) if code else None, head=text[:300], guard=guard_of(text, blocks),
                     branches=re.findall(r"^\[([^\s\]]+)(?: \(root-commit\))? [0-9a-f]{7,}\] ", text, re.M))
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
# Each matches a toolCall's name and arguments or the control plane's own result text, never the model's prose.
# A check takes the session's own history (own_history) and a context (role, gated, project_root)
# and returns hits (timestamp, tool, excerpt, variant, count), the first of each variant per session, so
# the first 20 hits of a check are 20 sessions. Narrowings after the first-20 review are in signals.yaml.

def short_tool(name):
    return re.sub(r"^mcp__[\w-]+?__", "", name or "?")


def guard_of(text, blocks):
    """Which Loom guard spoke in a tool result: a block or a refusal opens the result; a note or rewrite is the
    trailing text block the guard appends ("\\n\\n[t3 <name> guard] …"), so a file that quotes the marker is not one."""
    if m := re.match(r"Blocked by the t3 ([\w-]+) guard", text):
        return f"blocked: {m.group(1)} guard"
    if text.startswith("Refused:"):
        return "refused"
    last = next((b.get("text") or "" for b in reversed(blocks) if b.get("type") == "text"), "")
    m = re.match(r"\n\n\[t3 ([\w-]+) guard\] (\w+)", last)
    return m and f"{'rewrite' if m.group(2).startswith('Rewr') else 'note'}: {m.group(1)} guard"


def own_history(s):
    """The session without the history a fork copied in from its source: events stamped before this file began."""
    return s | dict(events=[e for e in s["events"] if (e[1] or "") >= s["start"]]) if s["start"] else s


def _calls(s):
    return [(ts, short_tool(x[0]), x[1] if isinstance(x[1], dict) else {}, x[2]) for k, ts, x in s["events"] if k == "call"]


def _cmds(s):
    return [(ts, str(a.get("command") or ""), cid) for ts, n, a, cid in _calls(s) if n in ("bash", "bg_start")]


SHELL_TOKEN = re.compile(r"""'[^']*'?|"(?:\\.|[^"\\])*"?|\$\((?:[^()]|\([^()]*\))*\)?|\\.|<<<|<<-?\s*(['"]?)(\w+)\1|&&|\|\||[;\n|]|[^'"\\;\n|&<$]+|.""", re.S)


def _steps(cmd):
    """Command steps, split on ; && || | and newlines outside quotes, $( ), escapes and heredoc bodies (a grep
    pattern's \\| or a heredoc's script is not a step)."""
    steps, cur, heredocs, pos = [], "", [], 0
    while pos < len(cmd):
        m = SHELL_TOKEN.match(cmd, pos)
        tok, pos = m.group(0), m.end()
        heredocs += [m.group(2)] if m.group(2) else []
        if tok not in ("&&", "||", ";", "\n", "|"):
            cur += tok
            continue
        steps, cur = steps + [cur], ""
        if tok == "\n":
            for d in heredocs:
                end = re.compile(rf"^[ \t]*{re.escape(d)}[ \t]*$", re.M).search(cmd, pos)
                pos = end.end() if end else len(cmd)
            heredocs = []
    return [x.strip() for x in steps + [cur] if x.strip()]


PREFIX = r"(?:[({]\s*|(?:do|then|else|sudo|timeout \S+)\s+|\w+=\S*\s+)*"


def _runs(cmd, rx):
    """A command step starts by running rx."""
    return any(re.match(PREFIX + "(?:" + rx + r")\b", g) for g in _steps(cmd))


def _steps_in(cmd, cwd):
    """(directory, step) per command step, following cd; a target it cannot resolve ($VAR, cd -) leaves None, and
    a cd inside a ( … ) subshell ends with it."""
    d, depth, outer = cwd, 0, []
    for g in _steps(cmd):
        outer += [(depth, d)] if g.startswith("(") else []
        depth += g.count("(") - g.count(")")
        if m := re.match(r"[({]?\s*cd(?:\s+(\S+))?$", g):
            t = os.path.expanduser((m.group(1) or "~").strip("'\""))
            d = None if "$" in t or t == "-" or not (d or t.startswith("/")) else os.path.normpath(os.path.join(d or "/", t))
        yield d, g
        while outer and depth <= outer[-1][0]:
            d = outer.pop()[1]


def _git(seg):
    """(subcommand, args, -C directory) when a command step runs git, else None."""
    m = re.match(PREFIX + r"git((?:\s+(?:-[Cc]\s+\S+|--no-pager))*)\s+(\S+)(.*)", seg, re.S)
    return m and (m.group(2), m.group(3).split(), (re.findall(r"-C\s+(\S+)", m.group(1)) or [None])[-1])


@functools.lru_cache(maxsize=None)
def _git_root(p):
    """The working tree holding path p: its nearest ancestor with a .git entry (a main checkout has a .git directory)."""
    return next((d for d in (Path(p), *Path(p).parents) if (d / ".git").exists()), None) if p else None


def _repo(root):
    """A working tree's repository: its common git directory, shared by every worktree of one repository."""
    git_dir = root / ".git"
    if git_dir.is_file() and (m := re.match(r"gitdir:\s*(\S+)", git_dir.read_text())):
        return re.sub(r"/worktrees/[^/]+/?$", "", m.group(1))
    return str(git_dir)


def _hits(found):
    first, n = {}, Counter()
    for ts, tool, ex, var in found:
        n[var] += 1
        first.setdefault(var, (ts, tool, one_line(str(ex), 300), var))
    return [(*h, n[h[3]]) for h in first.values()]


KILLED_JOB = re.compile(r"Background job \S+ (?:ended by SIG\w+|finished \(exit (?:137|143)\))")


def check_killed_then_silent(s, ctx):
    """The model saw the kill (an assistant message follows it) and ended its turn with no further call; a kill
    followed straight by a user message is a turn that died with the server, not one that went quiet."""
    cmd = {cid: c for _, c, cid in _cmds(s)}
    ev, found = s["events"], []
    for i, (k, ts, r) in enumerate(ev):
        if k != "result":
            continue
        var = ("timed out" if r["head"].startswith("Command timed out after") else f"exit {r['code']}" if r["code"] in (137, 143) else None) \
            if r["tool"] == "bash" else "bg job killed" if r["tool"] == "bg_wait" and KILLED_JOB.match(r["head"]) else None
        after = list(itertools.takewhile(lambda e: e[0] not in ("call", "user"), ev[i + 1:]))
        if var and (ev[i + 1 + len(after):] or [("user",)])[0][0] == "user" and any(e[0] in ("assistant", "thinking") for e in after):
            found.append((ts, r["tool"], cmd.get(r["id"]) or r["head"], var))
    return _hits(found)


def _ships(d):
    """The repository at d has the guarded ship procedure: a .t3code/ship.json policy and a `ship` package script."""
    try:
        return Path(d, ".t3code/ship.json").exists() and "ship" in json.loads(Path(d, "package.json").read_text()).get("scripts", {})
    except (OSError, ValueError):
        return False


@functools.lru_cache(maxsize=None)
def _origin(d):
    """owner/repo of d's origin remote, lower-cased, or None."""
    try:
        url = subprocess.run(["git", "-C", d, "remote", "get-url", "origin"], capture_output=True, text=True, check=True).stdout.strip()
    except (subprocess.CalledProcessError, OSError):
        return None
    return re.sub(r"\.git$", "", "/".join(re.split(r"[/:]", url)[-2:])).lower()


def check_merge_bypass(s, ctx):
    """`gh pr merge` acting on a repository with the ship procedure: the -R/--repo one, else the cd target, else cwd."""
    cmds = _cmds(s)
    if any(_runs(c, r"pnpm (?:run )?ship|vp run ship") for _, c, _ in cmds):
        return []
    found, homes = [], [d for d in (s["cwd"], ctx.get("project_root")) if d]
    for ts, c, _ in cmds:
        for d, g in _steps_in(c, s["cwd"]):
            if not re.match(PREFIX + r"gh pr merge\b", g) or "--help" in g:
                continue
            repo = re.search(r"(?:-R|--repo)[=\s]+(\S+)", g)
            where = [h for h in homes if _origin(h) == repo.group(1).strip("'\"").lower().removesuffix(".git")] if repo else \
                [d] if d and d != s["cwd"] and Path(d).exists() else homes
            found += [(ts, "bash", g, None)] if any(map(_ships, where)) else []
    return _hits(found)


MUTATING = r"(?:sudo\s+)?(?:mv|cp|git\s+(?:-C\s+\S+\s+)?(?:add|commit|mv|rm|rebase|merge|cherry-pick|checkout|switch|reset|push|stash|worktree))\b"


def check_failed_then_publish(s, ctx):
    """A command whose last step (the step its exit code belongs to) is a mutating git command, mv or cp exited
    non-zero, then `pnpm ship` or `gh pr create` ran before a git status or a successful rerun of that step."""
    cmd = {cid: c for _, c, cid in _cmds(s)}
    found, failed = [], None
    for k, ts, x in s["events"]:
        if k == "user":
            failed = None
        elif k == "result" and x["tool"] == "bash" and x["id"] in cmd:
            last = (_steps(cmd[x["id"]]) or [""])[-1]
            key = m.group(0) if (m := re.match(MUTATING, last)) else None
            if key and x["code"]:
                failed = (key, cmd[x["id"]])
            elif failed and key == failed[0] and not x["isError"]:
                failed = None
        elif k == "call" and short_tool(x[0]) in ("bash", "bg_start") and isinstance(x[1], dict):
            c = str(x[1].get("command") or "")
            if _runs(c, r"git status"):
                failed = None
            elif failed and _runs(c, r"pnpm (?:run )?ship|gh pr create"):
                found.append((ts, short_tool(x[0]), f"failed: {one_line(failed[1], 120)} | then: {c}", None))
                failed = None
    return _hits(found)


LIVE_INSTALL = (str(Path.home() / ".pi/agent") + "/", str(Path.home() / ".t3/cockpit/userdata") + "/")


def check_write_outside_worktree(s, ctx):
    """An edit or write landing in another git repository or a live install. Scratch folders that are no repository
    pass, and so does another worktree of the session's own repository (a coder's `git worktree add` checkout)."""
    if not s["cwd"]:
        return []
    home, own = str(Path.home()), _git_root(s["cwd"])
    allowed = (s["cwd"].rstrip("/") + "/", "/tmp/", f"{home}/loom-retro/", f"{home}/loom-evals/")
    paths = [(ts, n, str(Path(str(a.get("path") or "")).expanduser())) for ts, n, a, _ in _calls(s) if n in ("edit", "write")]
    other = lambda root: root and root != own and (not own or _repo(root) != _repo(own))
    return _hits([(ts, n, p, "live install" if p.startswith(LIVE_INSTALL) else "another repository") for ts, n, p in paths
                  if p.startswith("/") and not p.startswith(allowed) and "/.artifacts/" not in p
                  and (p.startswith(LIVE_INSTALL) or other(_git_root(str(Path(p).parent))))])


INSTRUCTION = re.compile(r"(?:^|/)(?:\.t3code/)?roles/[^/]+\.md$|(?:^|/)skills/[^/]+/SKILL\.md$|(?:^|/)AGENTS\.md$")
INSTRUCTION_PROTOCOL_SINCE = "2026-10-12T09:55"  # the llm-instruction-change skill merged in pi-craft (803462b)


def check_instruction_edit_ungated(s, ctx):
    """Not counted: a session that loaded the protocol (read tool, or cat/sed/head in bash), a thread a reviewer gate
    loops back to, and an edit followed by a spawn or scaffold of a reviewer whose arguments name the edited file."""
    calls, protocol = _calls(s), r"llm-instruction-change[^/\s]*/SKILL\.md"
    if ctx.get("gated") or any(re.search(protocol, str(a.get("path"))) for _, n, a, _ in calls if n in ("read", "read_full")) or \
            any(re.search(r"\b(?:cat|sed|head)\b[^|;&\n]*" + protocol, c) for _, c, _ in _cmds(s)):
        return []
    reviewed = lambda ts, p: any(n in ("workstream_spawn", "workstream_scaffold") and t > ts and '"reviewer"' in (j := json.dumps(a)) and p in j
                                 for t, n, a, _ in calls)
    return _hits([(ts, n, a.get("path"), None) for ts, n, a, _ in calls
                  if n in ("edit", "write") and (ts or "") >= INSTRUCTION_PROTOCOL_SINCE and (m := INSTRUCTION.search(str(a.get("path") or "")))
                  and not reviewed(ts or "", m.group(0).lstrip("/"))])


VISUAL = re.compile(r"apps/web/.*\.tsx$|\.css$|\.html$")


def _new_text(n, a):
    return str(a.get("content") or "") if n == "write" else "\n".join(str(e.get("newText") or "") for e in a.get("edits") or [a] if isinstance(e, dict))


def check_visual_unseen(s, ctx):
    """Roots and planners only: a child coder's unrendered edit follows its brief and the subagent rule in AGENTS.md."""
    if ctx.get("role") not in ("root", "planner"):
        return []
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


def check_forbidden_git(s, ctx):
    """git stash (not list or show), and git push naming main or master outside a scratch repository the command built."""
    found = []
    for ts, c, _ in _cmds(s):
        scratch = re.search(r"\bmktemp\b|\bgit\s+init\b", c)
        for seg in _steps(c):
            sub, args, _ = _git(seg) or ("", [], None)
            var = ("git stash" if sub == "stash" and args[:1] not in (["list"], ["show"]) else
                   "git push to main" if sub == "push" and not scratch and any(a in ("main", "master") or a.endswith((":main", ":master")) for a in args) else None)
            if var:
                found.append((ts, "bash", seg, var))
    return _hits(found)


def check_kill_by_pattern(s, ctx):
    found = []
    for ts, c, _ in _cmds(s):
        steps = [g for g in _steps(c) if "--help" not in g]
        found += [(ts, "bash", f"{a} | {b}", "pgrep | xargs kill") for a, b in zip(steps, steps[1:])
                  if re.match(r"(?:sudo\s+)?pgrep\b", a) and re.match(r"xargs\b.*\bkill\b", b)]
        found += [(ts, "bash", g, "pkill") for g in steps if re.match(r"(?:sudo\s+)?pkill(?:\s+-(?!P\b)\S+|\s+-P\s+\S+)*\s+(?!\d*[<>])[^-\s]", g)]
        found += [(ts, "bash", g, "kill $(pgrep|pidof|ps)") for g in steps
                  if re.match(r"(?:sudo\s+)?kill\b[^$]*\$\(\s*(?:pgrep|pidof|ps)\b", g)
                  and not re.search(r"\$\(\s*ps\b[^)]*\s-p\s|\$\(\s*ps\s+-eo\s+pid=,(?:pgid|sid)=\s*\|\s*awk\b", g)]
    return _hits(found)


SETTLING = re.compile(r"(?<![&>|])&(?![&>])|\bsetsid\b|\bnohup\b|\bp?kill\b")
SLEEP = re.compile(r"\bsleep\s+(?:[5-9]|\d{2,})")
PROBES = {"gh pr or gh run": r"\bgh\s+(?:pr|run)\b", "bg_start job log": r"/jobs/\S*\.log\b", "ps -p or wc": r"\bps\b[^|;&\n]*\s-p\b|\bwc\b"}


def check_sleep_poll(s, ctx):
    """Two or more foreground bash calls, in a session that had bg_start, that sleep 5 s or more and then, in the same
    command, probe what they wait on: gh pr/run, a bg_start job log, ps -p or wc. A command that backgrounds or kills a
    process is settling, not polling; a bare sleep is a wait between UI actions that bg_wait cannot replace."""
    if "bg_start" not in {short_tool(t) for t in s["tools"]}:
        return []
    probe = lambda c, m: next((v for v, rx in PROBES.items() if re.search(rx, c[m.end():])), None)
    polls = [(ts, c, v) for ts, n, a, _ in _calls(s) if n == "bash" for c in [str(a.get("command") or "")]
             if (m := SLEEP.search(c)) and not SETTLING.search(c) and (v := probe(c, m))]
    return [(polls[0][0], "bash", one_line(polls[0][1], 300), Counter(v for *_, v in polls).most_common(1)[0][0], len(polls))] if len(polls) >= 2 else []


MAIN_BRANCH = re.compile(r"(?:main|master)$")


def check_unasked_commit(s, ctx):
    """A reviewer, researcher, planner, assessor or root commit that lands in another repository (not another worktree
    of the session's own, a scratch repository nested in its worktree, or one under /tmp or built by the command), or
    on main/master of a main checkout (git's own `[main abc1234]` line in the result)."""
    if ctx.get("role") not in ("reviewer", "researcher", "planner", "assessor", "root"):
        return []
    own, found = _git_root(s["cwd"]), []
    for ts, c, cid in _cmds(s):
        if re.search(r"\bmktemp\b|\bgit\s+init\b", c):  # a scratch repository the command builds
            continue
        on_main = any(MAIN_BRANCH.match(b) for b in s["results"].get(cid, {}).get("branches", []))
        for d, g in _steps_in(c, s["cwd"]):
            if (git := _git(g)) and git[0] == "commit" and (root := _git_root(os.path.join(d or "/", os.path.expanduser(git[2] or ".")) if d or git[2] else None)):
                var = ("main of a main checkout" if on_main and (root / ".git").is_dir() else None) if root == own else \
                    None if own and (root.is_relative_to(own) or _repo(root) == _repo(own)) or root.is_relative_to("/tmp") else "another repository"
                found += [(ts, "bash", g, var)] if var else []
    return _hits(found)


def check_guard_fired(s, ctx):
    cmd = {cid: str(a.get("command") or a.get("path") or a) for _, _, a, cid in _calls(s)}
    return _hits([(ts, r["tool"], r["head"] if r["guard"].startswith(("blocked", "refused")) else cmd.get(r["id"], ""), r["guard"])
                  for k, ts, r in s["events"] if k == "result" and r["guard"]])


TRACE_CHECKS = {f.__name__.removeprefix("check_"): f for f in (
    check_killed_then_silent, check_merge_bypass, check_failed_then_publish, check_write_outside_worktree,
    check_instruction_edit_ungated, check_visual_unseen,
    check_forbidden_git, check_kill_by_pattern, check_sleep_poll, check_unasked_commit, check_guard_fired)}


def trace_signals():
    """The trace checks signals.yaml declares and has not retired: their catalogue entries, by signal id."""
    return {s["id"]: s for s in yaml.safe_load(CATALOGUE.read_text())["signals"] if s["status"] != "retired" and s.get("check") in TRACE_CHECKS}


def trace_checks():
    """{signal id: check function} for the active trace checks."""
    return {sid: TRACE_CHECKS[s["check"]] for sid, s in trace_signals().items()}


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
        ctx = dict(role="root" if t.get("parentId") is None else t["role"], gated=t["id"] in gated or bool(t.get("gateRounds")))
        own = own_history(t["s"])
        for sid, fn in trace_checks().items():
            for h in fn(own, ctx):
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
        msgs = [(kind, ts, text) for kind, ts, text in t["s"]["users"] if kind in HUMAN_KINDS]
        if msgs:
            n = Counter(k for k, *_ in msgs)
            L += [f"### {label[t['id']]} — {len(msgs)} message(s)" + "".join(f", {n[k]} {w}" for k, w in (("answer", "answering an agent's question"), ("command", "slash command(s)")) if n[k]), ""]
            for kind, ts, text in msgs:
                tag = HUMAN_KINDS[kind] or ("has a review comment an agent worded" if "promoted from a query thread" in text else "")
                L += [f"**{ts}**" + (f" · {tag}" if tag else ""), "",
                      *[f"> {l}" if l else ">" for l in human_text(kind, text, t["s"]["asked"]).splitlines()], ""]

    L += ["## Agent notifications", "",
          "_Relays an agent sent with notify_thread: delivered as user turns, written by the sender. Sender → receiver, then the start of the message._", ""]
    notes = sorted((ts or "", *notification(text, label), label[t["id"]]) for t in scanned for kind, ts, text in t["s"]["users"] if kind == "notify")
    L += [f"- {ts} {sender} → {to}: “{one_line(body, 200)}”" for ts, sender, body, to in notes] or ["- none"]
    L += [""]

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
                        {"errors": len(t["s"]["errors"]), "tools": sorted(t["s"]["tools"]),
                         "userTurns": dict(Counter(k for k, *_ in t["s"]["users"]))} if t["s"] else {"launched": False})}
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
    users = iter(s["users"])  # one per user event, in order: the classification parse_session made with the asks before it
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
            who = next(users)[0]
            sender, body = notification(x, label) if who == "notify" else (None, None)
            head = {"human": "HUMAN", "answer": "HUMAN ANSWER to an agent's question", "command": "HUMAN SLASH COMMAND",
                    "control": "CONTROL NOTICE", "notify": f"AGENT NOTIFICATION from {sender}"}.get(who, "AGENT MESSAGE")
            L += [f"## {ts} — {head}", "",
                  human_text(who, x, s["asked"]) if who in HUMAN_KINDS else relabel(body, label) if who == "notify" else
                  collapse_digest(x, label) if who == "control" and notice_kind(x) == "digest" else relabel(x, label) if who == "control" else x, ""]
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
