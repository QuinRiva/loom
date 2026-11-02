#!/usr/bin/env python3
"""Join the week's fragments (metrics.json, trace.json, escapes.json) into ~/loom-evals/dashboard.md.

Usage: render.py --week 2026-W44
Reads whichever fragments exist; an absent one prints `fragment missing: <script> failed`, never a zero.
Writes ~/loom-evals/dashboard.md and a copy in ~/loom-evals/readings/<week>/, and prints the dashboard path.
"""
import argparse
import json
from collections import defaultdict
from datetime import timedelta

from dashboard import EVALS_HOME, WINDOWS, default_week, week_windows

FRAGMENTS = {"metrics.json": "dashboard.py", "trace.json": "trace_corpus.py", "escapes.json": "gate_escapes.py"}
WINDOW_LABELS = {"week": "Week", "4w": "4 weeks", "prev4w": "Previous 4", "since-2026-10-07": "Since 7 Oct"}
SLICE_LIMIT = 6

# metric: (group, label, kind, source). Kinds: count, part (value of n), rate, mean, usd, text.
METRICS = {
    "goals_started": ("Volume", "Goals started", "count", "`loom_goals.created_at`"),
    "children_started": ("Volume", "Children started", "count", "`loom_thread_workstream.kickoff_at`, `parent_thread_id` not null"),
    "first_verdict_rework_rate": ("Gates", "First-verdict rework rate", "rate", "first `thread.outcome-recorded` per reviewer with a `loop` route; outcome `needs_rework`"),
    "gates_per_goal": ("Gates", "Gates per goal", "mean", "reviewer rows with a `loop` route by `goal_id`, goals created in the window"),
    "human_messages_per_goal_mean": ("Steering", "Human messages per goal, mean", "mean", "`orchestration_v2_projection_messages`, `loom.humanAuthored`, root threads, first message excluded"),
    "human_messages_per_goal_median": ("Steering", "Human messages per goal, median", "mean", "as above"),
    "children_with_human_message_rate": ("Steering", "Children Carl wrote into", "rate", "children kicked off in the window with a `humanAuthored` message"),
    "human_messages_into_children": ("Steering", "Human messages into children", "count", "`humanAuthored` messages on child threads"),
    "asks": ("Steering", "ask_user_question asks", "count", "`orchestration_v2_projection_runtime_requests` `loom-ask:`"),
    "ask_free_text_share": ("Steering", "Asks answered in free text", "rate", "answers matching no option of the `user_input_request` turn item"),
    "quote_and_ask": ("Steering", "Quote-and-ask messages (proxy)", "count", "root `humanAuthored` messages with `t3-citation://` and `?`"),
    "quote_and_ask_share": ("Steering", "Quote-and-ask share of root messages", "rate", "as above, over root human messages"),
    "quote_and_ask_per_goal": ("Steering", "Quote-and-ask per goal", "mean", "as above, goals created in the window"),
    "quiescent_rate": ("Children", "Quiescent rate", "rate", "`thread.outcome-recorded` `synthesised = true` over children that finished"),
    "cancels": ("Children", "Cancels", "count", "`thread.outcome-set` `outcome = cancelled`; reason from `$.reason`"),
    "cancel_restarts": ("Children", "Cancels restarted", "part", "same parent and role, created within 60 min of the cancel"),
    "cancel_and_replace": ("Children", "Cancel and replace (proxy)", "part", "same-title sibling within 60 min of the cancel and of a human message to the root"),
    "tool_failure_rate": ("Tools", "Tool failure rate", "rate", "`orchestration_v2_projection_turn_items` `dynamic_tool`, `command_execution`, `status = failed`"),
    "protocol_refusals": ("Tools", "Protocol refusals", "part", "failed `mcp__t3-code__*` items, of all such calls"),
    "cost_per_goal_median": ("Cost (list price)", "Cost per goal, median", "usd", "`loom_usage_ledger.cost_usd` by `goal_id`, goals created in the window, cost to window end"),
    "cost_per_goal_mean": ("Cost (list price)", "Cost per goal, mean", "usd", "as above"),
    "cost_per_resolved_gate": ("Cost (list price)", "Cost per resolved gate", "usd", "reviewer plus coder ledger cost, gates resolved in the window"),
    "releases_in_force": ("Instruction surface", "Releases in force", "text", "`~/loom-releases/deploy.log`: successful cockpit promotions and rollbacks"),
    "launches_by_commit": ("Instruction surface", "Launches by loom commit", "count", "`loom_thread_launch_stamps.loom_commit`"),
}
READING_RULE = (
    "Reading rule: a week-to-week move under about 15 points in a rate is noise; read the four-week windows. "
    "Every number is observational and confounded by project mix, model rollovers and Carl's own habits: it detects, never attributes."
)


def fmt(v, kind):
    if v is None:
        return "–"
    if kind == "text" or isinstance(v, str):
        return str(v)
    if kind == "rate" or (kind is None and isinstance(v, float) and v <= 1):
        return f"{v * 100:.1f}%" if v < 0.1 else f"{v * 100:.0f}%"
    if kind == "usd":
        return f"${v:,.2f}"
    return f"{v:,.2f}".rstrip("0").rstrip(".") if isinstance(v, float) else f"{v:,}"


def cell(r, kind, notes):
    if r is None:
        return ""
    if r["value"] is None and (r["note"] or "").startswith("n/a"):
        return r["note"]
    text = fmt(r["value"], kind)
    if r["value"] is not None and r["n"] is not None and kind != "count":
        text += f" / {r['n']:,}" if kind in ("part", None) and isinstance(r["value"], int) else f" ({r['n']:,})"
    if r["note"]:
        notes.setdefault(r["note"], len(notes) + 1)
        text += f" [{notes[r['note']]}]"
    return text


def table(rows, metrics, label_of, kind_of, slices, totals=True):
    """One markdown table: a row per (metric, by, key), the four windows as columns."""
    idx = defaultdict(dict)
    for r in rows:
        idx[(r["metric"], r["by"], str(r["key"]))][r["window"]] = r
    windows = [w for w in WINDOWS if any(w in v for v in idx.values())] + sorted({w for v in idx.values() for w in v} - set(WINDOWS))
    notes, out, hidden = {}, [], 0
    out.append("| Metric | Slice | " + " | ".join(WINDOW_LABELS.get(w, w) for w in windows) + " |")
    out.append("|---|---|" + "---|" * len(windows))
    for m in metrics:
        keys = [k for k in idx if k[0] == m]
        ordered = [k for k in keys if k[1] == "all" and totals]
        if slices:
            by_dim = defaultdict(list)
            for k in keys:
                if k[1] != "all":
                    by_dim[k[1]].append(k)
            for dim in sorted(by_dim):
                ranked = sorted(by_dim[dim], key=lambda k: (-max((r["n"] or 0) for r in idx[k].values()), k[2]))
                ordered += ranked[:SLICE_LIMIT]
                hidden += max(0, len(ranked) - SLICE_LIMIT)
        for k in ordered:
            slice_ = "all" if k[1] == "all" else f"{k[1]}: {k[2]}"
            out.append(f"| {label_of(m)} | {slice_} | " + " | ".join(cell(idx[k].get(w), kind_of(m), notes) for w in windows) + " |")
    out.append("")
    out += [f"[{i}] {n}" for n, i in sorted(notes.items(), key=lambda kv: kv[1])]
    if hidden:
        out.append(f"{hidden} smaller slices are in the JSON fragment, not shown.")
    return "\n".join(out).rstrip() + "\n"


def missing(script):
    return f"**fragment missing: {script} failed**\n"


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--week", default=default_week())
    args = ap.parse_args()
    readings = EVALS_HOME / "readings" / args.week
    frags = {name: json.loads((readings / name).read_text()) for name in FRAGMENTS if (readings / name).exists()}
    start, end = week_windows(args.week)["week"]
    out = [f"# Loom outcome dashboard, {args.week}", ""]
    out.append(f"Week {start:%a %d %b} to {end - timedelta(days=1):%a %d %b %Y} (local time); windows: the week, the four weeks ending with it, the four before those, since 7 Oct. Readings: `{readings}`.")
    out.append("")
    out += [f"> {missing(s).strip()}" for name, s in FRAGMENTS.items() if name not in frags]
    out += ["", READING_RULE, ""]

    if "metrics.json" in frags:
        m = frags["metrics.json"]
        out.append(f"Database `{m['source']}`, generated {m['generated_at']}. Cells read `value (n)` for rates and means, `count / of` for parts. Before 7 Oct the orchestration recorded less: those cells say `n/a before 7 Oct`.")
        out.append("")
        rows = [r for r in m["rows"] if r["metric"] != "cancel_detail"]
        label_of, kind_of = (lambda k: METRICS.get(k, (None, k))[1]), (lambda k: METRICS.get(k, (None, None, None))[2])
        groups = defaultdict(list)
        for metric in dict.fromkeys(list(METRICS) + sorted({r["metric"] for r in rows} - set(METRICS))):
            if any(r["metric"] == metric for r in rows):
                groups[METRICS.get(metric, ("Other",))[0]].append(metric)
        out += ["## Headline", "", table([r for r in rows if r["by"] == "all"], [x for ms in groups.values() for x in ms], label_of, kind_of, False)]
        for group, ms in groups.items():
            out += [f"## {group}", "", table(rows, ms, label_of, kind_of, True), "Sources:", ""]
            out += [f"- {label_of(x)}: {METRICS[x][3]}" for x in ms if x in METRICS] + [""]
        cancels = [r for r in m["rows"] if r["metric"] == "cancel_detail"]
        out += ["## Cancels this week", ""]
        out += [f"- {r['key']}: reason `{r['value']}`; {r['note']}" for r in cancels] or ["None."]
        out.append("")
    else:
        out += ["## Outcome metrics", "", missing(FRAGMENTS["metrics.json"])]

    reviews = EVALS_HOME / "reviews"
    out += ["## Trace checks (Eval 3)", ""]
    if "trace.json" in frags:
        rows = frags["trace.json"]["rows"]
        checks = sorted({r["metric"] for r in rows})
        unreviewed = [c for c in checks if not (reviews / f"{c}.json").exists()]
        label = lambda c: f"{c} (Unreviewed)" if c in unreviewed else c
        out.append(f"Sessions hit / sessions scanned. A check marked Unreviewed has no `{reviews}/<check>.json`: its count is a first pass of unknown precision.")
        out += ["", table(rows, checks, label, lambda c: None, False), "### By slice", "", table(rows, checks, label, lambda c: None, True, False)]
    else:
        out.append(missing(FRAGMENTS["trace.json"]))
    out += ["## Gate escapes (Eval 5 proxy)", ""]
    if "escapes.json" in frags:
        rows = frags["escapes.json"]["rows"]
        mark = "" if (reviews / "escapes.json").exists() else f" Unreviewed: no `{reviews}/escapes.json` yet, so this is a lower bound of unknown precision."
        out.append(f"Escapes / gates resolved clean or fixed_inline.{mark}")
        metrics = sorted({r["metric"] for r in rows})
        out += ["", table(rows, metrics, str, lambda c: None, False), "### By slice", "", table(rows, metrics, str, lambda c: None, True, False)]
    else:
        out.append(missing(FRAGMENTS["escapes.json"]))

    text = "\n".join(out).rstrip() + "\n"
    readings.mkdir(parents=True, exist_ok=True)
    (readings / "dashboard.md").write_text(text)
    dash = EVALS_HOME / "dashboard.md"
    dash.write_text(text)
    print(dash)


if __name__ == "__main__":
    main()
