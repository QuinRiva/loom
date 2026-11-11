# Loom evals: the weekly dashboard

A weekly table of how Loom's agents behave, computed from data Loom already keeps: the outcome dashboard (Eval 2), the trace checks over session files (Eval 3) and the gate escape proxy (Eval 5, tier A). The intent and the metric list are in `plans/loom-evals/intent.mdx` §3.2 and `plans/loom-evals/plan.mdx` §1.3. Everything here is read-only: the database is opened as `file:…?mode=ro` with `PRAGMA query_only = 1`, never copied, and session files are only read.

## Run

```bash
bash scripts/loom-evals/run.sh                  # the previous complete ISO week
bash scripts/loom-evals/run.sh --week 2026-W44  # any week; past weeks reproduce
vp run loom-evals                               # the same, from the repository root
```

It prints the dashboard path. The database is `${T3CODE_HOME:-~/.t3/cockpit}/userdata/statev2.sqlite` (`dashboard.py --db PATH` overrides it). Python 3 standard library only; no `vp i` needed.

`run.sh` runs, in order, `dashboard.py` (writes `metrics.json`), `trace_corpus.py` (`trace.json`), `gate_escapes.py` (`escapes.json`), each with `--week`, then `render.py`. It deletes the week's fragment before each script runs, so a script that fails or is absent leaves no fragment rather than last run's, and the run carries on. `render.py` then prints `fragment missing: <script> failed` at the top of the dashboard and in place of that table: a missing number is never shown as zero.

## Output

Under `~/loom-evals/`, outside the repository, as `/retro` keeps `~/loom-retro/`:

- `dashboard.md`: rewritten each run.
- `readings/<ISO week>/`: `metrics.json`, `trace.json`, `escapes.json`, a copy of that week's `dashboard.md`, and `hits/<check>.jsonl` (one line per hit, newest first, so a review's first 20 are current behaviour), kept.
- `reviews/<check>.json`: the first-20 review of a trace check (`{reviewed: 20, true_positive: n, notes: [...]}`, plan §3.4), and `reviews/escapes.json` for the escape proxy. `render.py` reads `true_positive / reviewed` from it. With no file the check is marked `Unreviewed`. Under 50% it is marked `low precision n/20`, its count moves from the value cell to a footnote, and its slices are hidden, until a new review of the narrowed check replaces the file. At 50% or more the number shows, with the precision in a footnote. Either mark adds `narrowed <date>` (the date from `signals.yaml`, or from `escapes.json` for the proxy) only while the review file is older than that date, read from its modification time: a review written on the day of the narrowing or later counts as a review of the narrowed check. A check with `status: retired` in `skills/retro/signals.yaml` is not run and does not appear.

A forked session carries a copy of its source's history. The trace checks skip events stamped before the session file began, so a fork does not count its source's hits again.

The dashboard prints the reading rule under its header: a week-to-week move under about 15 points in a rate is noise; read the four-week windows.

## Fragment contract

Each script writes `~/loom-evals/readings/<ISO week>/<name>.json`:

```json
{
  "generated_at": "2026-11-02T01:19:00+00:00",
  "window": { "from": "2026-10-25T13:00:00.000Z", "to": "2026-11-01T13:00:00.000Z" },
  "source": "/home/Carl/.t3/cockpit/userdata/statev2.sqlite",
  "rows": [
    {
      "metric": "cancels",
      "by": "role",
      "key": "coder",
      "window": "4w",
      "value": 8,
      "n": 37,
      "note": "from 7 Oct"
    }
  ]
}
```

`window` on a row is one of `week`, `4w`, `prev4w`, `since-2026-10-07`. Weeks are ISO weeks in the machine's local time: `week` is Monday 00:00 to the next Monday 00:00; `4w` is the four weeks ending with that week; `prev4w` the four before those; `since-2026-10-07` runs from 7 October 00:00 to the week's end. Every query is bounded above by its window's end, so a re-run of a past week gives the same rows apart from `generated_at` (a thread renamed or switched model since is the exception). `by` is `all` or a slice (`role`, `model`, `root_model`, `reviewer_model`, `coder_model`, `reason`, `canceller`, `tool`, `commit`), `n` is the denominator or the population, and a non-empty `note` is printed as a footnote. `render.py` groups rows by `metric`. `trace.json` also carries `checks`, the active trace checks with the date each was last narrowed (`{"sleep-poll": {"narrowed": "2026-11-02"}}`), and `escapes.json` carries `narrowed`, the proxy's. A metric outside its `METRICS` table (every `trace.json` and `escapes.json` metric) renders a float of 1 or less as a percentage and an integer as `value / n`, so such a fragment carries rates as floats and counts as integers. `dashboard.py` exports `week_windows()` and `default_week()` for the other two scripts.

## Era caveats

The orchestration was re-platformed on 7 October 2026, and rows imported from before it carry less: no `loom.humanAuthored` mark on messages, no `ask_user_question` request rows, no `cause` on an outcome and no `thread.outcome-recorded` events. A metric that needs one of those prints `n/a before 7 Oct` for a window that ends by then, and is computed from 7 October (footnoted `from 7 Oct`) for a window that straddles it. First-verdict rework before 7 October falls back to the share of resolved gates with `gate_rounds > 0`, footnoted as a proxy. Goals started, children started, gates per goal and cost are available in every window.

Other definitions worth knowing before reading a number:

- The August runaway coder `9d1afa3a-43e9-4807-9f3a-286313c6d341` (13,582 attention raises) is excluded from every query (`EXCLUDED_THREADS`).
- A thread's role is `loom_thread_workstream.role`; a thread with no parent, or no workstream row, is `root`. Its model is `modelSelection.model` past the provider prefix (`cliproxy/claude-opus-5-5` reads `opus-5-5`); a goal's root model is that of its first root.
- Per-goal metrics (gates, human messages, quote-and-ask per goal, cost) take the goals created in the window and count their activity up to the window's end, so the latest week's goals are young.
- Cancel reason reads `$.reason` on the `thread.outcome-set` event in `loom_thread_history` and is `none` until the reason parameter deploys. The canceller is `parent (mcp)` when the event's `command_id` starts `command:mcp:`, `cascade` for a cascade, otherwise `ui`. A cancel counts as restarted when a sibling with the same role, created after the cancelled thread, was created within 60 minutes of the cancel; cancel-and-replace counts a sibling with the same title (ignoring `fresh`, `retry`, `v2`), created within 60 minutes of the cancel and within the hour after a human message to the root.
- Releases in force come from `~/loom-releases/deploy.log` (successful cockpit promotions and rollbacks), not `manifest.json`, which is pruned to a handful of entries and marks older releases `failed` after the fact. Once `loom_thread_launch_stamps` exists, launches are also counted per `loom_commit`; the script checks `sqlite_master` and runs unchanged without it.
- Costs are the ledger's list price; most calls ran on subscriptions, so they measure effort, not cash.

## The weekly scheduled task

Recreate it with `mcp__t3-code__schedule_task` from a thread in the loom project:

```json
{
  "title": "Loom evals: weekly dashboard",
  "schedule": { "type": "fixed_time", "timeOfDay": "06:00", "weekdays": [1] },
  "bindToCurrentThread": false,
  "prompt": "Run `bash scripts/loom-evals/run.sh`. Then reply with the dashboard path it printed and the three metrics that moved most against the previous four weeks, and nothing else."
}
```

`bindToCurrentThread: false` gives each run a fresh thread in a new worktree from `origin/main` (`startFromOrigin`), so it always runs the current scripts. The tool takes the model from the thread that creates the task: create it from a Sonnet thread, or set the model to Sonnet on the task afterwards. A run costs about $0.30 to $0.50.

## Files

- `run.sh`: the entrypoint.
- `dashboard.py`: the §1.3 metrics, one query per source table, printing each query's time to stderr; writes `metrics.json`.
- `render.py`: the fragments into `dashboard.md`; metric labels and their source columns are its `METRICS` table.
- `trace_corpus.py`, `gate_escapes.py`: the trace checks and the escape proxy (plan §3, §4).
