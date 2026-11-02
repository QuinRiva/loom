#!/usr/bin/env python3
"""Gate escape proxy (Eval 5 tier A): how often a file a review gate passed is fixed again within 14 days.

Usage: gate_escapes.py [--week 2026-W44] [--db PATH]
Gates are reviewers with a loop route whose last outcome resolved clean or fixed_inline since 7 Oct. A gate's
files are the union of its coder's commits (Loom-Thread trailer read from %B) and report paths, with the source
kept per file; checkpoints are not a source, since siblings share a worktree and a checkpoint diff carries their
edits. Repositories are walked with `git log --branches --remotes` (never --all: refs/t3 holds thousands of
checkpoint commits) and nothing is fetched. Candidates: kind 1, a later fix/revert commit by another thread that
changes lines `git blame` at its parent attributes to a commit carrying the gated coder's Loom-Thread; kind 2, a
later gate whose first verdict was needs_rework with must-fix findings over an overlapping file set; kind 3, a
later fix/retry sibling (reading material, in no rate). A candidate is tagged same-tree, other-tree, or unknown
when its commit has no trailer. Writes ~/loom-evals/readings/<week>/escapes.json (fragment shape of
plans/loom-evals/plan.mdx §5, plus `narrowed`, the date of the last narrowing) and hits/escapes.jsonl, newest first.
"""
import argparse, bisect, functools, json, os, re, subprocess, sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path[:0] = [str(HERE), str(HERE.parents[1] / "skills/retro/scripts")]
from dashboard import ERA, EVALS_HOME, EXCLUDED_THREADS, WINDOWS, connect, default_week, iso, local_midnight, short_model, ts, week_windows  # noqa: E402
from retro_scan import read_report  # noqa: E402

HORIZON = timedelta(days=14)
FIX = re.compile(r"\b(?:fix|revert|hotfix|regression)\b", re.I)
RETRY = re.compile(r"\b(?:fix|retry|regression|fresh)\b", re.I)
TRAILER = re.compile(r"^Loom-Thread:\s*(\S+)", re.M)
NARROWED = "2026-11-02"  # line provenance, no checkpoint files, `unknown` tag: after the first-20 review found 0 of 20
ABS_PATH = re.compile(r"(?<![\w.~])/(?:home|tmp)/[^\s`'\"()<>\[\]{},;*|]+")


def git(d, *args):
    return subprocess.run(["git", "--git-dir", d, *args], capture_output=True, text=True, check=True).stdout


def walk(d, since):
    """Every commit on a branch or remote-tracking ref since `since`, with its files; trailers parsed from the raw body.
    Commits an `upstream` remote holds are the fork's upstream's work, not Loom's (15k of 16k in loom). A rebased copy
    keeps its author date and subject, so the oldest sha of each (date, subject) stands for all of them."""
    out = git(d, "log", "--branches", "--remotes", "--not", "--remotes=upstream", f"--since={since.isoformat()}", "--name-only",
              "--format=%x1e%H%x1f%aI%x1f%an%x1f%B%x1f")
    commits = {}
    for rec in out.split("\x1e")[1:]:
        sha, at, author, body, files = rec.split("\x1f")
        trailer = TRAILER.findall(body)
        commits[at, body.split("\n", 1)[0]] = dict(sha=sha, repo=d, at=ts(at), author=author, subject=body.split("\n", 1)[0], thread=trailer[-1] if trailer else None,
                            files=[f for f in files.split("\n") if f])
    return sorted(commits.values(), key=lambda c: (c["at"], c["sha"]))


@functools.lru_cache(maxsize=None)
def trailer_of(d, sha):
    return (TRAILER.findall(git(d, "log", "-1", "--format=%B", sha)) or [None])[-1]


def blamed_threads(d, sha, path):
    """Loom-Thread trailers of the commits that, at sha's parent, wrote the lines of path that sha changes or deletes."""
    try:
        hunks = re.findall(r"^@@ -(\d+)(?:,(\d+))? ", git(d, "diff", "-U0", "--no-color", "--no-ext-diff", f"{sha}^", sha, "--", path), re.M)
        ranges = [x for a, b in hunks if b != "0" for x in ("-L", f"{a},+{b or 1}")]
        blamed = set(re.findall(r"^([0-9a-f]{40}) \d+ \d+", git(d, "blame", "--porcelain", *ranges, f"{sha}^", "--", path), re.M)) if ranges else set()
    except subprocess.CalledProcessError:
        return set()
    return {trailer_of(d, b) for b in blamed} - {None}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--week", default=default_week())
    ap.add_argument("--db", default=os.path.join(os.environ.get("T3CODE_HOME") or os.path.expanduser("~/.t3/cockpit"), "userdata", "statev2.sqlite"))
    a = ap.parse_args()
    wins = week_windows(a.week)
    era, to = local_midnight(ERA), wins["week"][1]
    con = connect(a.db)
    q = lambda sql, *p: con.execute(sql, p).fetchall()
    excluded = set(EXCLUDED_THREADS)
    ws = {r[0]: dict(zip(("id", "project", "parent", "root", "role", "routes", "last", "outcome_at", "created_at", "report", "brief"), r))
          for r in q("select thread_id, project_id, parent_thread_id, root_thread_id, role, routes, last_outcome, outcome_at, created_at, report_path, "
                     "kickoff_brief_path from loom_thread_workstream where thread_id not in (%s)" % ",".join("?" * len(excluded)), *excluded)}
    threads = {r[0]: dict(title=r[1], model=short_model(r[2]), worktree=r[3])
               for r in q("select thread_id, title, json_extract(payload_json, '$.modelSelection.model'), json_extract(payload_json, '$.worktreePath') "
                          "from orchestration_v2_projection_threads")}
    projects = {r[0]: dict(title=r[1], root=r[2]) for r in q("select project_id, title, workspace_root from projection_projects")}
    snapshot_dirs = q("select distinct t.project_id, s.git_common_dir from loom_review_snapshots s join orchestration_v2_projection_threads t using (thread_id)")
    first_verdict = {}
    for stream, at, payload in q("select stream_id, occurred_at, payload_json from orchestration_events where event_type = 'thread.outcome-recorded' "
                                 "and application_event_version = 2 order by sequence"):
        p = json.loads(payload)
        if p.get("outcome") in ("clean", "fixed_inline", "needs_rework"):
            first_verdict.setdefault(stream, (ts(at), p["outcome"], (p.get("counts") or {}).get("mustFix") or 0))

    loop_to = lambda w: next((r["to"] for r in json.loads(w["routes"] or "[]") if r.get("kind") == "loop"), None)
    gates = sorted(([w, loop_to(w), ts(w["outcome_at"])] for w in ws.values()
                    if loop_to(w) and w["outcome_at"] and (json.loads(w["last"] or "{}").get("decision"), json.loads(w["last"] or "{}").get("outcome")) in
                    (("resolve", "clean"), ("resolve", "fixed_inline")) and era <= ts(w["outcome_at"]) < to), key=lambda g: (g[2], g[0]["id"]))
    reworks = sorted((fv[0], w["id"], loop_to(w)) for w in ws.values() if loop_to(w) and (fv := first_verdict.get(w["id"])) and fv[1] == "needs_rework" and fv[2] > 0)

    # Repositories per project: the workspace's common directory plus the nested ones its review snapshots name.
    dirs = defaultdict(set)
    for pid in {w["project"] for w, *_ in gates}:
        try:
            dirs[pid].add(subprocess.run(["git", "-C", projects[pid]["root"], "rev-parse", "--path-format=absolute", "--git-common-dir"],
                                         capture_output=True, text=True, check=True).stdout.strip())
        except (subprocess.CalledProcessError, KeyError, FileNotFoundError):
            pass
    for pid, d in snapshot_dirs:
        if pid in dirs or pid in {w["project"] for w, *_ in gates}:
            dirs[pid].add(d)
    repos = sorted({d for ds in dirs.values() for d in ds})
    commits, known = {}, {}
    for d in repos:
        commits[d] = walk(d, era - timedelta(days=1))
        known[d] = {f for c in commits[d] for f in c["files"]} | set(git(d, "ls-tree", "-r", "--name-only", "HEAD").split("\n"))
        print(f"  {d}: {len(commits[d])} commits since {(era - timedelta(days=1)).date()}", file=sys.stderr)
    dates = {d: [c["at"] for c in commits[d]] for d in repos}
    by_thread = defaultdict(list)
    for d in repos:
        for c in commits[d]:
            if c["thread"]:
                by_thread[c["thread"]].append(c)

    def normalise(pid, rel):
        """(repo, repo-relative path) for a worktree-relative path, longest suffix first (a nested repo's files sit under its directory)."""
        parts = rel.strip("/").split("/")
        return next(((d, "/".join(parts[i:])) for i in range(len(parts)) for d in sorted(dirs[pid]) if "/".join(parts[i:]) in known[d]), None)

    file_cache = {}

    def files_of(tid, pid):
        """{(repo, path): source} from the thread's commits, then absolute paths in its report."""
        if (tid, pid) in file_cache:
            return file_cache[tid, pid]
        out = {}
        for c in by_thread.get(tid, []):
            if c["repo"] in dirs[pid]:
                out.update({(c["repo"], f): "commit" for f in c["files"] if (c["repo"], f) not in out})
        roots = [x.rstrip("/") + "/" for x in (threads.get(tid, {}).get("worktree"), projects.get(pid, {}).get("root")) if x]
        for p in ABS_PATH.findall(read_report((ws.get(tid) or {}).get("report"))):
            p = re.sub(r"(?::\d+(?:-\d+)?)?[.:]*$", "", p)
            rel = next((p[len(r):] for r in roots if p.startswith(r)), None) or (m.group(1) if (m := re.search(r"/worktrees/[^/]+/[^/]+/(.+)", p)) else None)
            if rel and (k := normalise(pid, rel)) and k not in out:
                out[k] = "report"
        file_cache[tid, pid] = out
        return out

    tag_of = lambda gate, other: "unknown" if not other else "same-tree" if (ws.get(other) or {}).get("root") == gate["root"] else "other-tree"
    hits, per_gate = [], []
    for g, coder, at in gates:
        pid, end = g["project"], min(at + HORIZON, to)
        F = files_of(coder, pid)
        found = []
        for d in dirs[pid]:
            cs = commits[d]
            for c in cs[bisect.bisect_right(dates[d], at):]:
                if c["at"] > end:
                    break
                common = [f for f in c["files"] if (d, f) in F] if FIX.search(c["subject"]) and c["thread"] not in (coder, g["id"]) and by_thread.get(coder) else []
                common = sorted(f for f in common if coder in blamed_threads(d, c["sha"], f))
                if common:
                    found.append(dict(kind=1, tag=tag_of(g, c["thread"]), at=c["at"], commit=c["sha"], repo=d, subject=c["subject"], loom_thread=c["thread"],
                                      files=[dict(path=f, source=F[d, f]) for f in common]))
        for rat, rid, rcoder in reworks[bisect.bisect_right(reworks, (at, "\uffff")):]:
            if rat > end:
                break
            if rcoder and rcoder != coder and ws[rid]["project"] == pid and (common := sorted(set(F) & set(files_of(rcoder, pid)))):
                found.append(dict(kind=2, tag=tag_of(g, rid), at=rat, child=rid, coder=rcoder, subject=threads.get(rid, {}).get("title"),
                                  files=[dict(path=f, repo=d, source=F[d, f]) for d, f in common]))
        for s in ws.values():
            if s["parent"] == g["parent"] and s["id"] not in (coder, g["id"]) and s["created_at"] and at < ts(s["created_at"]) <= end:
                brief = Path(s["brief"]).read_text(errors="replace") if s["brief"] and Path(s["brief"]).exists() else ""
                if RETRY.search(threads.get(s["id"], {}).get("title") or "") or RETRY.search(brief):
                    if common := sorted(set(F) & set(files_of(s["id"], pid))):
                        found.append(dict(kind=3, tag=tag_of(g, s["id"]), at=ts(s["created_at"]), child=s["id"], subject=threads.get(s["id"], {}).get("title"),
                                          files=[dict(path=f, repo=d, source=F[d, f]) for d, f in common]))
        base = dict(gate=g["id"], coder=coder, project=projects.get(pid, {}).get("title"), resolved_at=iso(at),
                    reviewer_model=threads.get(g["id"], {}).get("model", "unknown"), coder_model=threads.get(coder, {}).get("model", "unknown"))
        hits += [base | h | dict(at=iso(h["at"])) for h in found]
        per_gate.append(dict(base, at=at, files=len(F), sources=Counter(F.values()), partial=at + HORIZON > to,
                             kinds={(h["kind"], h["tag"]) for h in found}))

    rows = []
    for w in WINDOWS:
        lo, hi = wins[w]
        inside = [p for p in per_gate if lo <= p["at"] < hi]
        partial = sum(p["partial"] for p in inside)
        for kind in ("1", "2", "union"):
            for tag in ("other-tree", "unknown", "same-tree"):
                esc = lambda p: any((kind == "union" and k in (1, 2) or str(k) == kind) and t == tag for k, t in p["kinds"])
                for by in ("all", "reviewer_model", "coder_model"):
                    for key in sorted({"all" if by == "all" else p[by] for p in inside}) or (["all"] if by == "all" else []):
                        sel = [p for p in inside if by == "all" or p[by] == key]
                        e = sum(map(esc, sel))
                        rows.append(dict(metric=f"escape_rate:kind-{kind}:{tag}", by=by, key=key, window=w, value=round(e / len(sel), 4) if sel else None,
                                         n=len(sel), note=f"{e} of {len(sel)} gates" + (f"; {partial} with under 14 days of follow-up" if partial and by == "all" else "")))
    out_dir = EVALS_HOME / "readings" / a.week
    (out_dir / "hits").mkdir(parents=True, exist_ok=True)
    with open(out_dir / "hits" / "escapes.jsonl", "w") as f:
        f.writelines(json.dumps(h, sort_keys=True) + "\n" for h in sorted(hits, key=lambda h: (h["at"], h["gate"], h["kind"], h.get("commit") or h.get("child")), reverse=True))
    (out_dir / "escapes.json").write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "window": {"from": iso(wins["week"][0]), "to": iso(to)},
        "source": f"{a.db} (read-only); git log --branches --remotes over {', '.join(repos)}",
        "narrowed": NARROWED,
        "rows": rows,
    }, indent=1, sort_keys=True) + "\n")

    src = Counter()
    for p in per_gate:
        src.update(p["sources"])
    print(f"{len(gates)} gates resolved clean or fixed_inline {ERA} to {iso(to)}: "
          + ", ".join(f"{k} {n}" for k, n in Counter(p["project"] for p in per_gate).most_common()), file=sys.stderr)
    print(f"  gates with no files found: {sum(not p['files'] for p in per_gate)}; files by source: {dict(src)}", file=sys.stderr)
    for kind in (1, 2, 3):
        for tag in ("other-tree", "unknown", "same-tree"):
            n = sum(any(k == kind and t == tag for k, t in p["kinds"]) for p in per_gate)
            print(f"  kind {kind} {tag}: {n} of {len(per_gate)} gates" + (" (reading material, in no rate)" if kind == 3 else ""), file=sys.stderr)
    for tag in ("other-tree", "unknown", "same-tree"):
        n = sum(any(k in (1, 2) and t == tag for k, t in p["kinds"]) for p in per_gate)
        print(f"  kind 1+2 {tag}{' (headline)' * (tag == 'other-tree')}: {n} of {len(per_gate)} gates ({n / max(1, len(per_gate)):.1%})", file=sys.stderr)
    print(out_dir / "escapes.json")


if __name__ == "__main__":
    main()
