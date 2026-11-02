#!/usr/bin/env python3
"""Trace checks (Eval 3) over every pi session file a Loom thread owns, as trace.json and hits/<check>.jsonl.

Usage: trace_corpus.py [--week 2026-W44] [--since 2026-10-07] [--full] [--db PATH] [--jobs N]
The checks are the retro scanner's (skills/retro/scripts/retro_scan.py, declared in signals.yaml); this
driver builds the thread list from the database instead of a /retro manifest. Each session's hits are cached
under ~/loom-evals/scan-cache/ keyed by the file's size and mtime, the check code and the thread's context,
so a weekly run parses only sessions that changed; --full rebuilds. Writes, under
~/loom-evals/readings/<week>/: trace.json in the fragment shape of plans/loom-evals/plan.mdx §5 (metric =
check id, value = sessions hit, n = sessions scanned) and hits/<check>.jsonl, oldest first.
"""
import argparse, hashlib, json, os, sys, time
from collections import defaultdict
from datetime import datetime, timezone
from multiprocessing import Pool
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parents[1] / "skills/retro/scripts")]
from dashboard import ERA, EVALS_HOME, EXCLUDED_THREADS, WINDOWS, connect, default_week, iso, local_midnight, short_model, ts, week_windows  # noqa: E402
import retro_scan  # noqa: E402

CORPUS = """
select pt.thread_id, json_extract(pt.payload_json, '$.nativeThreadRef.nativeId'), w.role, w.parent_thread_id, w.report_path,
       json_extract(t.payload_json, '$.modelSelection.model'), p.workspace_root
from orchestration_v2_projection_provider_threads pt
join orchestration_v2_projection_threads t using (thread_id)
left join loom_thread_workstream w using (thread_id)
left join projection_projects p on p.project_id = t.project_id
where pt.driver = 'pi' and t.created_at >= ? and t.created_at < ?
  and json_extract(pt.payload_json, '$.nativeThreadRef.nativeId') like '%/.pi/agent/sessions/%'
  and pt.thread_id not in ({})
""".format(",".join("?" * len(EXCLUDED_THREADS)))
CODE = hashlib.sha256(Path(retro_scan.__file__).read_bytes() + retro_scan.CATALOGUE.read_bytes()).hexdigest()[:16]


def scan_one(job):
    """Parse one session and run every check; returns the cache record."""
    path, ctx, key = job
    s = retro_scan.parse_session(path, ctx["role"] == "root")
    hits = {sid: fn(s, ctx) for sid, fn in retro_scan.trace_checks().items()}
    return dict(key=key, first=s["first"], model=s["model"], hits={k: v for k, v in hits.items() if v})


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--week", default=default_week())
    ap.add_argument("--since", default=ERA.isoformat(), help="first thread creation date scanned (local time)")
    ap.add_argument("--full", action="store_true", help="ignore the scan cache and parse every session again")
    ap.add_argument("--db", default=os.path.join(os.environ.get("T3CODE_HOME") or os.path.expanduser("~/.t3/cockpit"), "userdata", "statev2.sqlite"))
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) // 2))
    a = ap.parse_args()
    started, wins = time.monotonic(), week_windows(a.week)
    since, to = local_midnight(datetime.fromisoformat(a.since).date()), wins["week"][1]
    con = connect(a.db)
    rows = con.execute(CORPUS, (iso(since), iso(to), *EXCLUDED_THREADS)).fetchall()
    gated = retro_scan.loop_targets(a.db)
    con.close()

    cache_dir = EVALS_HOME / "scan-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    sessions, todo, missing = [], [], 0
    for tid, path, role, parent, report, model, project_root in sorted(rows, key=lambda r: r[1]):
        if not Path(path).exists():
            missing += 1
            continue
        ctx = dict(role=role or ("child" if parent else "root"), report=retro_scan.read_report(report), gated=tid in gated, project_root=project_root)
        st = Path(path).stat()
        key = hashlib.sha256(json.dumps([st.st_size, st.st_mtime_ns, CODE, ctx], sort_keys=True).encode()).hexdigest()
        cache = cache_dir / (Path(path).stem.split("_", 1)[-1] + ".json")
        rec = json.loads(cache.read_text()) if cache.exists() and not a.full else None
        sessions.append(dict(thread_id=tid, session_path=path, role=ctx["role"], db_model=model, cache=cache))
        if not rec or rec.get("key") != key:
            todo.append((path, ctx, key))
    by_path = {x["session_path"]: x for x in sessions}
    with Pool(a.jobs) as pool:
        for (path, _, _), rec in zip(todo, pool.imap(scan_one, todo, chunksize=4)):
            by_path[path]["cache"].write_text(json.dumps(rec))
    print(f"{len(sessions)} sessions ({missing} session files missing): {len(todo)} parsed, {len(sessions) - len(todo)} from cache, "
          f"{time.monotonic() - started:.0f}s", file=sys.stderr)

    checks = list(retro_scan.trace_checks())
    hits, scanned = defaultdict(list), []
    for x in sessions:
        rec = json.loads(x["cache"].read_text())
        x["model"] = short_model(x["db_model"] or rec["model"])
        scanned.append((x, rec["first"]))
        for sid, hs in rec["hits"].items():
            hits[sid] += [dict(check=sid, thread_id=x["thread_id"], session_path=x["session_path"], role=x["role"], model=x["model"],
                               at=at, tool=tool, variant=var, count=n, excerpt=ex) for at, tool, ex, var, n in hs]

    out_dir = EVALS_HOME / "readings" / a.week
    (out_dir / "hits").mkdir(parents=True, exist_ok=True)
    for sid in checks:
        with open(out_dir / "hits" / f"{sid}.jsonl", "w") as f:
            f.writelines(json.dumps(h, sort_keys=True) + "\n" for h in sorted(hits[sid], key=lambda h: (h["at"] or "", h["session_path"], h["variant"] or "")))

    # A session belongs to a window by its first message; by=variant rows share the window's all-sessions n.
    out = []
    for w in WINDOWS:
        lo, hi = wins[w]
        inside = [x for x, first in scanned if first and lo <= ts(first) < hi]
        keys = {"all": {"all"}, "role": {x["role"] for x in inside}, "model": {x["model"] for x in inside}}
        n = {(by, k): sum(by == "all" or x[by] == k for x in inside) for by, ks in keys.items() for k in ks}
        paths = {x["session_path"] for x in inside}
        for sid in checks:
            hit = [h for h in hits[sid] if h["session_path"] in paths]
            sess = lambda pred: len({h["session_path"] for h in hit if pred(h)})
            out += [dict(metric=sid, by=by, key=k, window=w, value=sess(lambda h: by == "all" or h[by] == k), n=n[by, k], note=None)
                    for by, ks in keys.items() for k in sorted(ks)]
            out += [dict(metric=sid, by="variant", key=v, window=w, value=sess(lambda h: h["variant"] == v), n=len(inside), note=None)
                    for v in sorted({h["variant"] for h in hit if h["variant"]})]
    (out_dir / "trace.json").write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "window": {"from": iso(wins["week"][0]), "to": iso(to)},
        "source": f"{a.db} (read-only) and {len(sessions)} pi session files of threads created {a.since} to {iso(to)}",
        "rows": out,
    }, indent=1, sort_keys=True) + "\n")
    for sid in checks:
        print(f"  {sid}: {len({h['session_path'] for h in hits[sid]})} sessions", file=sys.stderr)
    print(out_dir / "trace.json")


if __name__ == "__main__":
    main()
