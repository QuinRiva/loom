#!/usr/bin/env python3
"""Per-signal precision across every retro run.

  retro_signal_stats.py [--runs ~/loom-retro/runs]

Reads <run>/scan.json (hits per signal per thread, written by retro_scan.py) and, where the
retro recorded it, <run>/signal-review.json: {"<signal-id>": <how many of this run's units fed a
proposal>}. The unit is a hit for phrase signals and a flagged thread for structural ones (a
structural "hit" is a raw count, e.g. 55 repeated calls in one thread). Precision = useful units /
units, over reviewed runs only.
"""
import argparse, json
from collections import defaultdict
from pathlib import Path

import yaml

CATALOGUE = Path(__file__).resolve().parent.parent / "signals.yaml"

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--runs", type=Path, default=Path.home() / "loom-retro" / "runs")
runs = sorted(p.parent for p in ap.parse_args().runs.glob("*/scan.json"))
status = {s["id"]: s["status"] for s in yaml.safe_load(CATALOGUE.read_text())["signals"]}
agg = defaultdict(lambda: defaultdict(int))
for run in runs:
    scan = json.loads((run / "scan.json").read_text())
    review_path = run / "signal-review.json"
    review = json.loads(review_path.read_text()) if review_path.exists() else None
    for sid, sig in scan["signals"].items():
        a = agg[sid]
        a["runs"] += 1
        a["fired"] += sig["hits"] > 0
        a["hits"] += sig["hits"]
        a["threads"] += len(sig["threads"])
        if review is not None:
            a["reviewed"] += sig["hits"] if sig["kind"] == "phrase" else len(sig["threads"])
            a["useful"] += review.get(sid, 0)

print(f"{len(runs)} run(s) under {ap.parse_args().runs}\n")
print("| Signal | Status | Runs fired | Hits | Threads | Reviewed units | Fed a proposal | Precision |")
print("|---|---|---|---|---|---|---|---|")
for sid, a in sorted(agg.items(), key=lambda kv: -kv[1]["hits"]):
    precision = f"{a['useful'] / a['reviewed']:.0%}" if a["reviewed"] else "–"
    print(f"| {sid} | {status.get(sid, 'not in catalogue')} | {a['fired']}/{a['runs']} | {a['hits']} | {a['threads']} | {a['reviewed']} | {a['useful']} | {precision} |")
