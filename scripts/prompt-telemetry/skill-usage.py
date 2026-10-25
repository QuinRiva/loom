#!/usr/bin/env python3
"""Skill declared-vs-read census over pi session logs (a hand-run /skill-doctor).

Usage: python3 skill-usage.py [--days 14] [--sessions-root ~/.pi/agent/sessions] > per-session.jsonl
Streams every session jsonl under the sessions root modified in the last DAYS
days and emits one JSON record per session: population, role, the skills its
system prompt declared (from the logged `system` message's `sections.skills`),
and every SKILL.md read (read / read_full tool calls, or a bash cat/sed/head/...).
Aggregate with skill-usage-agg.py.
"""
import argparse, json, os, re, time

ap = argparse.ArgumentParser()
ap.add_argument("--days", type=float, default=14)
ap.add_argument("--sessions-root", default=os.path.expanduser("~/.pi/agent/sessions"))
args = ap.parse_args()
ROOT = args.sessions_root
cutoff = time.time() - args.days * 86400

SKILL_RE = re.compile(r"<skill>\s*<name>([^<]+)</name>.*?<location>([^<]+)</location>", re.S)
ROLE_RE = re.compile(r"You are an? ([a-z-]+) sub-thread")
TOKEN_RE = re.compile(r"""[^\s'"`;|&()<>]*SKILL\.md""")
BASH_READ_RE = re.compile(r"(^|[\s|;&(])(cat|sed|head|tail|less|more|bat|nl|awk)\s")


def text_of(content):
    if isinstance(content, str):
        return content
    return "\n".join(c.get("text", "") for c in content or [] if isinstance(c, dict) and c.get("type") == "text")


def scan(path):
    rec = {"file": path, "cwd": None, "start": None, "declared": {}, "role": None,
           "addendum": False, "user_msgs": 0, "reads": [], "edits": []}
    with open(path, errors="replace") as fh:
        for line in fh:
            # cheap prefilter: only parse lines that can matter
            if '"type":"session"' not in line[:40] and '"role":"system"' not in line \
                    and '"role":"user"' not in line and "SKILL.md" not in line:
                continue
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("type") == "session":
                rec["cwd"], rec["start"], rec["parent"] = e.get("cwd"), e.get("timestamp"), e.get("parentSession")
                continue
            m = e.get("message") or {}
            role = m.get("role")
            if role == "system":
                sec = m.get("sections") or {}
                for name, loc in SKILL_RE.findall(sec.get("skills") or ""):
                    rec["declared"][name.strip()] = loc.strip()
                add = sec.get("addendum") or ""
                if add:
                    rec["addendum"] = True
                    r = ROLE_RE.search(add)
                    if r and not rec["role"]:
                        rec["role"] = r.group(1)
            elif role == "user":
                rec["user_msgs"] += 1
                if rec["user_msgs"] == 1 and not rec["role"]:
                    r = ROLE_RE.search(text_of(m.get("content"))[:600])
                    if r:
                        rec["role"] = r.group(1)
            elif role == "assistant":
                for c in m.get("content") or []:
                    if not isinstance(c, dict) or c.get("type") != "toolCall":
                        continue
                    name, args = c.get("name"), c.get("arguments") or {}
                    hits = []
                    if name in ("read", "read_full"):
                        p = str(args.get("path") or "")
                        if p.endswith("SKILL.md"):
                            hits = [p]
                    elif name == "bash":
                        cmd = str(args.get("command") or "")
                        if "SKILL.md" in cmd and BASH_READ_RE.search(cmd):
                            # drop globs and shell variables: they name no one skill
                            hits = [t for t in TOKEN_RE.findall(cmd)
                                    if "/" in t and not re.search(r"[$*?{\[]", t)]
                    elif name in ("edit", "write"):
                        p = str(args.get("path") or "")
                        if p.endswith("SKILL.md"):
                            rec["edits"].append(p.rsplit("/", 2)[-2])
                    for p in hits:
                        parts = p.rsplit("/", 2)
                        if len(parts) < 2:
                            continue
                        rec["reads"].append({"skill": parts[-2], "path": p, "tool": name,
                                             "turn": rec["user_msgs"], "id": c.get("id")})
    return rec


for d in sorted(os.listdir(ROOT)):
    dp = os.path.join(ROOT, d)
    if not os.path.isdir(dp):
        continue
    for f in os.listdir(dp):
        fp = os.path.join(dp, f)
        if f.endswith(".jsonl") and os.path.getmtime(fp) >= cutoff:
            print(json.dumps(scan(fp)), flush=True)
