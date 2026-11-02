#!/usr/bin/env python3
"""Outcome dashboard (Eval 2): the plan's §1.3 metrics from statev2.sqlite, read-only, as metrics.json.

Usage: dashboard.py [--week 2026-W44] [--db PATH]
Writes ~/loom-evals/readings/<week>/metrics.json in the fragment shape of plans/loom-evals/plan.mdx §5.
"""
import argparse
import json
import os
import re
import sqlite3
import statistics
import sys
import time
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

# The August runaway coder (13,582 attention raises in a control-plane loop); applied to every query.
EXCLUDED_THREADS = ("9d1afa3a-43e9-4807-9f3a-286313c6d341",)
ERA = date(2026, 10, 7)  # orchestration re-platform: no humanAuthored, ask rows, outcome events before it
ERA_LIMITED = {
    "first_verdict_rework_rate",
    "human_messages_per_goal_mean",
    "human_messages_per_goal_median",
    "children_with_human_message_rate",
    "human_messages_into_children",
    "asks",
    "ask_free_text_share",
    "quiescent_rate",
    "cancels",
    "cancel_restarts",
    "cancel_and_replace",
    "quote_and_ask",
    "quote_and_ask_share",
    "quote_and_ask_per_goal",
    "tool_failure_rate",
    "protocol_refusals",
}
VERDICTS = {"clean", "fixed_inline", "needs_rework"}
WINDOWS = ("week", "4w", "prev4w", "since-2026-10-07")
HOUR = timedelta(hours=1)
EVALS_HOME = Path.home() / "loom-evals"
DEPLOY_LOG = Path.home() / "loom-releases" / "deploy.log"


def parse_week(s):
    m = re.fullmatch(r"(\d{4})-W(\d{2})", s)
    if not m:
        raise SystemExit(f"--week must look like 2026-W44, got {s!r}")
    return int(m[1]), int(m[2])


def default_week():
    y, w, _ = (date.today() - timedelta(days=7)).isocalendar()
    return f"{y}-W{w:02d}"


def local_midnight(d):
    return datetime(d.year, d.month, d.day).astimezone()


def week_windows(week):
    """Window label -> (from, to) as aware datetimes; ISO weeks in the machine's local time."""
    start = date.fromisocalendar(*parse_week(week), 1)
    end = start + timedelta(days=7)
    return {
        "week": (local_midnight(start), local_midnight(end)),
        "4w": (local_midnight(start - timedelta(days=21)), local_midnight(end)),
        "prev4w": (local_midnight(start - timedelta(days=49)), local_midnight(start - timedelta(days=21))),
        "since-2026-10-07": (local_midnight(ERA), local_midnight(end)),
    }


def iso(dt):
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def short_model(m):
    return m.split("/")[-1].removeprefix("claude-") if m else "unknown"


def connect(path):
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    con.execute("PRAGMA query_only = 1")
    return con


class Query:
    def __init__(self, con):
        self.con, self.timings = con, []

    def __call__(self, name, sql, *params):
        t = time.monotonic()
        rows = self.con.execute(sql.replace(":excluded", ",".join("?" * len(EXCLUDED_THREADS))), (*params, *EXCLUDED_THREADS) if ":excluded" in sql else params).fetchall()
        self.timings.append((name, time.monotonic() - t, len(rows)))
        return rows


def title_key(t):
    t = re.sub(r"\([^)]*\b(fresh|retry|v\d+)\b[^)]*\)", " ", (t or "").lower())
    return " ".join(re.sub(r"\b(fresh|retry|v\d+)\b", " ", re.sub(r"[^a-z0-9]+", " ", t)).split())


def load(q, to):
    threads = {
        tid: {"title": title, "created_at": created, "model": short_model(model)}
        for tid, title, created, model in q(
            "threads",
            "select thread_id, title, created_at, json_extract(payload_json, '$.modelSelection.model') "
            "from orchestration_v2_projection_threads where thread_id not in (:excluded)",
        )
    }
    ws = {}
    for tid, goal, parent, root, role, kickoff, created, routes, gate_rounds, last_outcome in q(
        "workstream",
        "select thread_id, goal_id, parent_thread_id, root_thread_id, role, kickoff_at, created_at, routes, gate_rounds, last_outcome "
        "from loom_thread_workstream where thread_id not in (:excluded)",
    ):
        loop = next((r for r in json.loads(routes or "[]") if r.get("kind") == "loop"), None)
        ws[tid] = {
            "goal": goal, "parent": parent, "root": root, "kickoff_at": kickoff, "created_at": created,
            "role": role or ("root" if parent is None else "unknown"),
            "coder": loop and loop.get("to"), "gate_rounds": gate_rounds,
            "last_outcome": json.loads(last_outcome) if last_outcome else None,
        }
    goals = dict(q("goals", "select goal_id, created_at from loom_goals where created_at < ?", iso(to)))
    events = q(
        "outcome events",
        "select stream_id, event_type, occurred_at, command_id, payload_json from orchestration_events "
        "where application_event_version = 2 and event_type in ('thread.outcome-recorded', 'thread.outcome-set') "
        "and occurred_at < ? and stream_id not in (:excluded) order by sequence",
        iso(to),
    )
    messages = q(
        "user messages",
        "select thread_id, created_at, message_id, json_extract(payload_json, '$.loom.humanAuthored'), "
        "case when json_extract(payload_json, '$.loom.humanAuthored') = 1 then json_extract(payload_json, '$.text') end "
        "from orchestration_v2_projection_messages where role = 'user' and created_at < ? and thread_id not in (:excluded) "
        "order by created_at, message_id",
        iso(to),
    )
    asks = q(
        "ask_user_question",
        "select r.thread_id, r.created_at, json_extract(r.payload_json, '$.answers'), json_extract(i.payload_json, '$.questions') "
        "from orchestration_v2_projection_runtime_requests r "
        "left join orchestration_v2_projection_turn_items i on i.thread_id = r.thread_id and i.type = 'user_input_request' "
        "and json_extract(i.payload_json, '$.requestId') = r.runtime_request_id "
        "where r.runtime_request_id like 'loom-ask:%' and r.created_at < ? and r.thread_id not in (:excluded)",
        iso(to),
    )
    tools = q(
        "tool items",
        "select thread_id, updated_at, status, coalesce(json_extract(payload_json, '$.toolName'), json_extract(payload_json, '$.title')) "
        "from orchestration_v2_projection_turn_items where type in ('dynamic_tool', 'command_execution') "
        "and status in ('completed', 'failed') and updated_at >= ? and updated_at < ? and thread_id not in (:excluded)",
        iso(local_midnight(ERA)), iso(to),
    )
    return threads, ws, goals, events, messages, asks, tools


class Rows(list):
    def add(self, metric, by, key, window, value, n, note=None):
        if isinstance(value, float):
            value = round(value, 4)
        self.append({"metric": metric, "by": by, "key": key, "window": window, "value": value, "n": n, "note": note})


def compute(q, wins):
    _, to = wins["week"]
    prev_end = wins["prev4w"][1]
    era = local_midnight(ERA)
    threads, ws, goals, events, messages, asks, tools = load(q, to)
    rows = Rows()

    model = lambda t: threads.get(t, {}).get("model", "unknown")
    role = lambda t: ws[t]["role"] if t in ws else "root"
    root_of = lambda t: ws[t]["root"] if t in ws else t
    is_root = lambda t: t not in ws or ws[t]["parent"] is None
    roots_by_goal = defaultdict(list)
    for t, w in sorted(ws.items(), key=lambda kv: kv[1]["created_at"]):
        if w["parent"] is None and w["goal"]:
            roots_by_goal[w["goal"]].append(t)
    goal_model = {g: model(roots_by_goal[g][0]) if roots_by_goal[g] else "no root" for g in goals}
    goal_of_root = {t: w["goal"] for t, w in ws.items() if w["parent"] is None}

    # Per-thread facts from events and messages, computed once, bucketed per window below.
    first_verdict, finished, synthesised, cancels = {}, {}, set(), []
    for stream, etype, at, command, payload in events:
        p = json.loads(payload)
        if etype == "thread.outcome-recorded":
            if p.get("outcome") in VERDICTS:
                first_verdict.setdefault(stream, (at, p["outcome"]))
            finished.setdefault(stream, at)
            if p.get("synthesised"):
                synthesised.add(stream)
        elif p.get("outcome") == "cancelled":
            canceller = (
                "cascade" if p.get("cause") == "cascade"
                else "parent (mcp)" if (command or "").startswith("command:mcp:")
                else "server" if (command or "").startswith("server:")
                else "ui"
            )
            cancels.append({"thread": stream, "at": at, "reason": p.get("reason") or "none", "cause": p.get("cause") or "none", "canceller": canceller})

    first_user, human = set(), []
    for tid, at, _mid, authored, text in messages:
        first = tid not in first_user
        first_user.add(tid)
        if authored == 1:
            human.append({"thread": tid, "at": at, "first": first, "text": text or "", "root": is_root(tid)})
    root_human = [m for m in human if m["root"] and not m["first"]]
    human_by_root = defaultdict(list)
    for m in human:
        if m["root"]:
            human_by_root[m["thread"]].append(ts(m["at"]))
    quote = lambda m: "t3-citation://" in m["text"] and "?" in m["text"]

    by_parent = defaultdict(list)
    for t, w in ws.items():
        if w["parent"]:
            by_parent[w["parent"]].append(t)
    for c in cancels:
        t, at = c["thread"], ts(c["at"])
        parent = ws.get(t, {}).get("parent")
        sibs = [s for s in by_parent.get(parent, []) if s != t and abs(ts(ws[s]["created_at"]) - at) <= HOUR]
        c["restart"] = any(ws[s]["role"] == role(t) and ws[s]["created_at"] > ws[t]["created_at"] for s in sibs)
        human_times = human_by_root.get(root_of(t), [])
        c["replace"] = any(
            title_key(threads.get(s, {}).get("title")) == title_key(threads.get(t, {}).get("title"))
            and any(timedelta(0) <= ts(ws[s]["created_at"]) - h <= HOUR for h in human_times)
            for s in sibs
        )

    ledger = defaultdict(lambda: [0.0, 0.0])
    for tid, total, before_prev in q(
        "usage ledger",
        "select thread_id, sum(cost_usd), sum(case when created_at < ? then cost_usd else 0 end) "
        "from loom_usage_ledger where created_at < ? and thread_id not in (:excluded) group by thread_id",
        iso(prev_end), iso(to),
    ):
        ledger[tid] = [total, before_prev]
    cost = lambda t, end: ledger[t][0 if end == to else 1]
    goal_threads = defaultdict(list)
    for t, w in ws.items():
        if w["goal"]:
            goal_threads[w["goal"]].append(t)

    asked = []
    for tid, at, answers, questions in asks:
        opts = {
            qq.get("id"): {
                s for o in qq.get("options") or [] for s in (o.get("label"), o.get("value"), re.sub(r"\s*\(Recommended\)$", "", o.get("label") or "")) if s
            }
            for qq in json.loads(questions or "[]")
        }
        answered = [
            any(a not in opts.get(qid, set()) for a in (v if isinstance(v, list) else [v]))
            for qid, v in (json.loads(answers) if answers else {}).items()
        ]
        asked.append({"thread": tid, "at": at, "free": answered})

    gates = {t: w for t, w in ws.items() if w["coder"]}
    stamps_exist = q("sqlite_master", "select 1 from sqlite_master where type = 'table' and name = 'loom_thread_launch_stamps'")
    stamps = (
        q("launch stamps", "select thread_id, launched_at, loom_commit from loom_thread_launch_stamps where launched_at < ? and thread_id not in (:excluded)", iso(to))
        if stamps_exist else []
    )
    # The deploy log, not manifest.json: the manifest is pruned to a few entries and marks old ones failed after the fact.
    log = DEPLOY_LOG.read_text(errors="replace") if DEPLOY_LOG.exists() else ""
    bridge = set(re.findall(r"promoting bridge release (\S+)", log))
    releases = [
        (at, promoted or rolled_back)
        for at, promoted, rolled_back in re.findall(r"^(\S+Z) (?:.*promotion of (\S+) SUCCEEDED|rollback \(.*\) -> (\S+))", log, re.M)
        if (promoted or rolled_back) not in bridge
    ]

    for win, (start, end) in wins.items():
        limited_note = None
        if end <= era:
            for m in sorted(ERA_LIMITED - {"first_verdict_rework_rate"}):
                rows.add(m, "all", "all", win, None, None, "n/a before 7 Oct")
        elif start < era:
            limited_note = "from 7 Oct"
        es = iso(max(start, era))
        f, t_ = iso(start), iso(end)
        inw = lambda at: at is not None and f <= at < t_
        inera = lambda at: at is not None and es <= at < t_
        era_ok = end > era

        def emit(metric, items, keyfns, value, note=None):
            """items: list; keyfns: {by: fn(item)->key}; value: fn(list)->(value, n)."""
            groups = defaultdict(list)
            for it in items:
                groups[("all", "all")].append(it)
                for by, fn in keyfns.items():
                    groups[(by, fn(it))].append(it)
            if not items:
                groups[("all", "all")] = []
            for (by, key), its in groups.items():
                v, n = value(its)
                rows.add(metric, by, key, win, v, n, note)

        count = lambda its: (len(its), len(its))
        share = lambda pred: lambda its: ((sum(map(pred, its)) / len(its)) if its else None, len(its))
        mean = lambda fn: lambda its: (statistics.fmean(map(fn, its)) if its else None, len(its))
        median = lambda fn: lambda its: (statistics.median(map(fn, its)) if its else None, len(its))

        cohort = [g for g, at in goals.items() if inw(at)]
        emit("goals_started", cohort, {"root_model": goal_model.get}, count)
        kids = [t for t, w in ws.items() if w["parent"] and inw(w["kickoff_at"])]
        emit("children_started", kids, {"role": role, "model": model}, count)
        emit("gates_per_goal", cohort, {"root_model": goal_model.get},
             mean(lambda g: sum(1 for t in goal_threads[g] if t in gates and ws[t]["created_at"] < t_)))
        emit("cost_per_goal_mean", cohort, {"root_model": goal_model.get}, mean(lambda g: sum(cost(t, end) for t in goal_threads[g])))
        emit("cost_per_goal_median", cohort, {"root_model": goal_model.get}, median(lambda g: sum(cost(t, end) for t in goal_threads[g])))
        resolved = [t for t, w in gates.items() if (w["last_outcome"] or {}).get("decision") == "resolve" and inw(w["last_outcome"].get("at"))]
        emit("cost_per_resolved_gate", resolved, {"reviewer_model": model}, mean(lambda t: cost(t, end) + cost(gates[t]["coder"], end)))

        if era_ok:
            verdicts = [t for t, (at, _) in first_verdict.items() if t in gates and inera(at)]
            emit("first_verdict_rework_rate", verdicts, {"reviewer_model": model, "coder_model": lambda t: model(gates[t]["coder"])},
                 share(lambda t: first_verdict[t][1] == "needs_rework"), limited_note)
        else:
            emit("first_verdict_rework_rate", resolved, {"reviewer_model": model, "coder_model": lambda t: model(gates[t]["coder"])},
                 share(lambda t: (gates[t]["gate_rounds"] or 0) > 0), "proxy before 7 Oct: share of resolved gates with gate_rounds > 0")
        rel = list(dict.fromkeys(
            rid for i, (at, rid) in enumerate(releases)
            if at < t_ and (at >= f or i + 1 == len(releases) or releases[i + 1][0] >= f)
        ))
        rows.add("releases_in_force", "all", "all", win, (", ".join(rel) if len(rel) <= 3 else f"{rel[0]} … {rel[-1]}") if rel else None,
                 len(rel), None if log else f"{DEPLOY_LOG} missing")
        if stamps_exist:
            launched = [c for _, at, c in stamps if inw(at)]
            emit("launches_by_commit", launched, {"commit": lambda c: (c or "unknown")[:10]}, count)
        if not era_ok:
            continue

        era_cohort = [g for g, at in goals.items() if inera(at)]
        def msgs_upto(g, pred=lambda m: True):
            return sum(1 for m in root_human if goal_of_root.get(m["thread"]) == g and m["at"] < t_ and pred(m))

        emit("human_messages_per_goal_mean", era_cohort, {"root_model": goal_model.get}, mean(msgs_upto), limited_note)
        emit("human_messages_per_goal_median", era_cohort, {"root_model": goal_model.get}, median(msgs_upto), limited_note)
        emit("quote_and_ask_per_goal", era_cohort, {"root_model": goal_model.get}, mean(lambda g: msgs_upto(g, quote)), limited_note)
        win_root = [m for m in root_human if inera(m["at"])]
        emit("quote_and_ask", [m for m in win_root if quote(m)], {"root_model": lambda m: model(m["thread"])}, count, limited_note)
        emit("quote_and_ask_share", win_root, {"root_model": lambda m: model(m["thread"])}, share(quote), limited_note)
        child_msgs = [m for m in human if not m["root"] and inera(m["at"])]
        emit("human_messages_into_children", child_msgs, {"role": lambda m: role(m["thread"])}, count, limited_note)
        written = {m["thread"] for m in human if not m["root"] and m["at"] < t_}
        era_kids = [t for t in kids if inera(ws[t]["kickoff_at"])]
        emit("children_with_human_message_rate", era_kids, {"role": role}, share(lambda t: t in written), limited_note)

        win_asks = [a for a in asked if inera(a["at"])]
        emit("asks", win_asks, {"root_model": lambda a: model(root_of(a["thread"]))}, count, limited_note)
        emit("ask_free_text_share", [(a, x) for a in win_asks for x in a["free"]],
             {"root_model": lambda ax: model(root_of(ax[0]["thread"]))}, share(lambda ax: ax[1]), limited_note)

        done = [t for t, at in finished.items() if t in ws and ws[t]["parent"] and inera(at)]
        emit("quiescent_rate", done, {"role": role, "model": model}, share(lambda t: t in synthesised), limited_note)
        win_cancels = [c for c in cancels if inera(c["at"])]
        slices = {
            "role": lambda c: role(c["thread"]), "model": lambda c: model(c["thread"]),
            "reason": lambda c: c["reason"], "canceller": lambda c: c["canceller"],
        }
        emit("cancels", win_cancels, slices, count, limited_note)
        emit("cancel_restarts", win_cancels, {"role": slices["role"]}, lambda its: (sum(c["restart"] for c in its), len(its)), limited_note)
        emit("cancel_and_replace", win_cancels, {"root_model": lambda c: model(root_of(c["thread"])), "role": slices["role"]},
             lambda its: (sum(c["replace"] for c in its), len(its)), limited_note)
        if win == "week":
            for c in sorted(win_cancels, key=lambda c: c["at"]):
                title = threads.get(c["thread"], {}).get("title", c["thread"])
                rows.add("cancel_detail", "thread", f"{c['at'][:16].replace('T', ' ')}Z {title}", win, c["reason"], None,
                         f"{role(c['thread'])}, {model(c['thread'])}, by {c['canceller']}"
                         + (", restarted" if c["restart"] else "") + (", replaced after a human message" if c["replace"] else ""))

        win_tools = [x for x in tools if inera(x[1])]
        emit("tool_failure_rate", win_tools, {"tool": lambda x: x[3] or "unknown", "role": lambda x: role(x[0]), "model": lambda x: model(x[0])},
             share(lambda x: x[2] == "failed"), limited_note)
        mcp = [x for x in win_tools if (x[3] or "").startswith("mcp__t3-code__")]
        emit("protocol_refusals", mcp, {"tool": lambda x: x[3], "role": lambda x: role(x[0])},
             lambda its: (sum(x[2] == "failed" for x in its), len(its)), limited_note)

    return rows


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--week", default=default_week())
    ap.add_argument("--db", default=os.path.join(os.environ.get("T3CODE_HOME") or os.path.expanduser("~/.t3/cockpit"), "userdata", "statev2.sqlite"))
    args = ap.parse_args()
    wins = week_windows(args.week)
    q = Query(connect(args.db))
    rows = compute(q, wins)
    order = {w: i for i, w in enumerate(WINDOWS)}
    rows.sort(key=lambda r: (r["metric"], order[r["window"]], r["by"] != "all", r["by"], str(r["key"])))
    out = EVALS_HOME / "readings" / args.week / "metrics.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    frag = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "window": {"from": iso(wins["week"][0]), "to": iso(wins["week"][1])},
        "source": args.db,
        "rows": rows,
    }
    out.write_text(json.dumps(frag, indent=1, sort_keys=True) + "\n")
    for name, secs, n in q.timings:
        print(f"  {name}: {secs:.2f}s, {n} rows", file=sys.stderr)
    print(out)


if __name__ == "__main__":
    main()
