#!/usr/bin/env python3
"""Deterministic evidence scan for /retro over every pi session file in a source workstream.

  retro_scan.py --manifest <runDir>/manifest.json [--out <dir>]
      → <out>/digest.md + <out>/scan.json  (out defaults to the manifest's directory)
  retro_scan.py --manifest <runDir>/manifest.json --extract <thread-id> [--out <dir>]
      → <out>/extract-<thread-id>.md  (':' and '/' in the id become '_'; an id prefix is enough)

The manifest is the JSON the /retro launcher writes into the run directory. The signal
catalogue is ../signals.yaml (PyYAML: the catalogue is edited by people and agents and
holds regexes, so a real YAML parser is worth the one dependency).
"""
import argparse, json, re, statistics
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
    return len(text) * 10 // 23


def text_of(blocks):
    return "".join(b.get("text", "") for b in blocks if b.get("type") == "text")


def clean_human(text):
    """Human text verbatim, minus attachment metadata: images become [image]."""
    text = re.sub(r"\[Image: [^\]]*\]", "[image]", text)
    text = re.sub(r'<context kind="image"[^>]*>.*?</context>\n?', "", text, flags=re.S)
    return re.sub(r"\n*<t3_context version=\"1\">\s*</t3_context>", "", text).strip()


def user_kind(text, root):
    if text.startswith(CONTROL):
        return "control"
    return "human" if HUMAN_LABEL.match(text) or (root and not AGENT_LABEL.match(text)) else "agent"


def notice_kind(text):
    return next((k for k, needle in NOTICE_KINDS if needle in text), "other")


def parse_session(path, root):
    """One pass over a pi session jsonl; everything later sections need, nothing kept from tool results but errors."""
    s = dict(turns=0, calls=0, cost=0.0, ctx=0, image=0, tools=set(), errors=[], users=[], texts=[], events=[],
             first=None, last=None)
    seen = Counter()
    for line in open(path, encoding="utf-8"):
        e = json.loads(line)
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
                    s["events"].append(("call", ts, (b.get("name") or "", b.get("arguments"))))
        elif role == "toolResult" and m.get("isError"):
            text = text_of(blocks)
            s["errors"].append((m.get("toolName") or "?", ts, text))
            s["texts"].append(("tool_error", ts, text))
            s["events"].append(("error", ts, (m.get("toolName") or "?", text)))
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


def extract(manifest, tid, out):
    t = next((x for x in manifest["threads"] if x["id"] == tid), None) or next(x for x in manifest["threads"] if x["id"].startswith(tid))
    if not (t.get("sessionPath") and Path(t["sessionPath"]).exists()):
        raise SystemExit(f"{t['id']} has no session file (never launched?)")
    s = parse_session(t["sessionPath"], t.get("parentId") is None)
    L = [f"# Extract: {t.get('title')}", "", f"`{t['id']}` · {t.get('role') or 'orchestrator'} · {t.get('model')} · session `{t['sessionPath']}`", ""]
    pending = Counter()

    def flush():
        if pending:
            L.append("_[tools: " + ", ".join(f"{n} ×{c}" if c > 1 else n for n, c in pending.items()) + "]_\n")
            pending.clear()
    for kind, ts, x in s["events"]:
        if kind == "call" and not x[0].endswith(BRIEF_TOOLS):
            pending[x[0].removeprefix("mcp__t3-code__")] += 1
            continue
        flush()
        if kind == "user":
            who = user_kind(x, t.get("parentId") is None)
            L += [f"## {ts} — {'HUMAN' if who == 'human' else 'CONTROL NOTICE' if who == 'control' else 'AGENT MESSAGE'}", "",
                  clean_human(x) if who == "human" else x, ""]
        elif kind == "thinking":
            L += [f"_thinking {ts}_", "", *[f"> {l}" if l else ">" for l in x.strip().splitlines()], ""]
        elif kind == "assistant":
            L += [f"**assistant {ts}**", "", x.strip(), ""]
        elif kind == "call":
            L += [f"### {ts} — `{x[0]}`", "", render_args(x[1] if isinstance(x[1], (dict, list)) else {"arguments": x[1]}), ""]
        elif kind == "error":
            L += [f"_tool error {ts} — `{x[0]}`:_", "", "```", x[1][:1500], "```", ""]
    flush()
    path = out / f"extract-{re.sub(r'[:/]', '_', t['id'])}.md"
    path.write_text(text := "\n".join(L) + "\n")
    print(f"{path}: {len(text):,} chars (~{est_tokens(text):,} tokens)")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--manifest", required=True, type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--extract", metavar="THREAD_ID")
    a = ap.parse_args()
    manifest = json.loads(a.manifest.read_text())
    out = a.out or a.manifest.parent
    out.mkdir(parents=True, exist_ok=True)
    extract(manifest, a.extract, out) if a.extract else scan(manifest, out)


if __name__ == "__main__":
    main()
