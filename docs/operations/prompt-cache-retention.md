# Prompt-cache retention and keep-alive

Root threads idle while their children work, so on Anthropic's default 5-minute
prompt cache they keep re-writing a cache the 1-hour cache would have kept.
Children are short bursts and pay more on 1h (a 1h write costs 2× base input,
a 5-minute write 1.25×). So the 1h cache is chosen **per thread**, never globally,
and only a root can get it. The case for it is in
`/home/Carl/cli-proxy/docs/predictive-routing/usage-baseline.md` §6; the idle-gap
measurements behind the share and the keep-alive are in
`/home/Carl/scratch/prompt-cache-idle-gap/`.

## The knob: `rootCacheLongShare`

The share of **new** root threads that get the 1-hour cache: a number from 0
to 1, default `0.5`. Set it in the server's `settings.json` (the cockpit:
`~/.t3/cockpit/userdata/settings.json`), e.g. `"rootCacheLongShare": 0.8`.
Hand-edit the file; the server watches it, so no restart and no code change.
`0` puts every new root on the 5-minute cache, `1` every new root on 1h.
Children are always 5-minute.

A **root** is a thread with no parent (`parent_thread_id IS NULL`). That includes
`mcp__t3-code__thread_fork` forks, goal handoff/continue successors, and the `/handoff` and
`/retro` fork threads. The read-only `mcp__t3-code__consult_thread` fork, pi text generation
(titles, commit messages) and every child are always short.

**It applies only to roots launched after the change.** A root's arm is decided
at its first pi launch and recorded in its write-once launch-identity sidecar
(`<stateDir>/workstream-launch-identity/<threadId>.json`); every relaunch
(restart, resume, idle reap) replays it. So each root keeps one arm for life,
and lowering the share never moves an existing root back to 5 minutes.

A root is long when `sha256(threadId)[0] < 256 × share`. In Python:
`hashlib.sha256(tid.encode()).digest()[0] < 256 * share`. Raising the share only
moves hash bytes that were 5-minute to 1h, so a root's arm never depends on the
share's history.

The session composer (`apps/server/src/loom/prompt/sessionComposerLive.ts`,
arm from `apps/server/src/provider/cacheRetention.loom.ts`) sets
`PI_CACHE_RETENTION` in the pi process env on every launch, and pi then marks
every cache breakpoint `ttl: "1h"` for `long`. Because it is set every time, a
server started from a shell that exported `PI_CACHE_RETENTION=long` cannot hand
it to children.

## Keeping caches warm

### pi idle warming, every thread

`"cacheWarming": "idle"` in `~/.pi/agent/settings.json` turns it on. pi reads
the mode from global settings only, so it applies to every pi on the machine,
Loom-launched and terminal alike. After a turn settles, pi re-sends the last
request with a one-token cap at 90% of the cache lifetime, for up to 30 minutes
after the last request started, and only when its economics say the ping pays
(`0.15 × miss cost − ping cost ≥ $0.05`). Each ping is a `usage` entry of kind
`cache_warm` in the pi transcript.

**A child stops warming once it has submitted.** After a successful
`mcp__t3-code__workstream_submit`, Loom's pi extension
(`apps/server/src/provider/Drivers/Pi/loomExtensionParts/cacheWarmingGate.ts`)
vetoes the child's idle pings. A new prompt, steer or follow-up re-opens it until
it submits again. Warming during a run is never vetoed.

### 1-hour roots: one keep-alive ping at about 54 minutes

Stock pi never idle-warms a 1h cache: its first ping is due at 54 minutes, past
the 30-minute horizon. For 1-hour roots only, the composer sets
`PI_CACHE_WARMING_IDLE_MAX_MS=5400000` (90 minutes; pi patch 0003 makes the
horizon read it). That admits exactly one ping, about 54 minutes after the last
request started, so the cache lives to about 114 minutes. Loom's extension
answers `warm` to that ping, because pi prices a miss at the 5-minute write rate
and would skip it below roughly 138k tokens of context on Opus 5.5.

The process has to be alive to ping, so a 1-hour root's pi is released after
**2 hours** idle instead of the usual 30 minutes. Past about 114 minutes its
cache is dead anyway.

Both values are constants in `apps/server/src/provider/cacheRetention.loom.ts`,
not settings, and neither is part of the launch identity: a deploy that changes
them reaches existing 1-hour roots at their next launch. The ping arithmetic
(why 90 minutes gives exactly one ping) is in
[`infra/pi-patches/README.md`](../../infra/pi-patches/README.md) § 0003.

## Cache table and sidebar ring

`loom_thread_cache` in `statev2.sqlite` has one row per thread that has been
launched on pi: its `retention` (the arm) and `touched_at`, the end of its last
cache refresh, whether a real request or an idle ping. It is the quickest
read-only way to see a thread's arm and when its cache dies; a thread with no
row has never run on pi and shows no ring.

The sidebar ring and the hover card's "Prompt cache" block show only on rows
where it is your move. Their dollar figures come from the price table in
`packages/client-runtime/src/state/loom/cacheLiveness.ts`; a model missing from
it shows the ring without dollars, so add new models there at each model
rollover.

## Where the arm is recorded

The server appends one line per pi launch to
`<stateDir>/cache-retention-launches.jsonl` (the cockpit:
`~/.t3/cockpit/userdata/cache-retention-launches.jsonl`):

```json
{
  "threadId": "…",
  "cacheRetention": "long",
  "longShare": 0.8,
  "launchedAt": "2026-10-13T01:22:30.224Z"
}
```

This is the retention pi actually got, including relaunches, and the share in
force at that launch. The pi session id is the thread id
(`piSessionIdForThread`), so the pi transcript is
`~/.pi/agent/sessions/*/*_<threadId>.jsonl`.

To list `(thread_id, arm, period, first_launch_at)`, run this from the state dir
against a snapshot or read-only (`sqlite3` CLI: `readfile` and JSON1). A root's
**allocation period** is the share in force at its first launch (lines written
before the share existed have none; those roots ran at 0.5):

```sql
CREATE TEMP TABLE launches AS
  SELECT json_extract(value, '$.threadId') AS thread_id,
         json_extract(value, '$.cacheRetention') AS arm,
         coalesce(json_extract(value, '$.longShare'), 0.5) AS long_share,
         json_extract(value, '$.launchedAt') AS launched_at
  FROM json_each('[' || rtrim(replace(readfile('cache-retention-launches.jsonl'), char(10), ','), ',') || ']');
SELECT thread_id, arm,
       (SELECT long_share FROM launches f WHERE f.thread_id = l.thread_id ORDER BY launched_at LIMIT 1) AS period,
       MIN(launched_at) AS first_launch_at
FROM launches l GROUP BY thread_id, arm;
```

More than one arm row for a thread means its launch-identity sidecar was
deleted. Drop it from the A/B.

## Reading the A/B

Population: Claude-model roots (`parent_thread_id IS NULL`) with exactly one arm
in the launch log. Codex ignores the retention variable, so leave its messages
out. A long-arm Claude message with `cache_write > 0` should also have
`cache_write_1h > 0`. Per-root spend is heavy-tailed, so compare medians and
bootstrapped means, not raw sums. The readouts are
`/home/Carl/scratch/prompt-cache-idle-gap/abtest/readout1.py` (API-priced cost
per root) and `readout2.py` (whether the subscription weights a 1h write like
the API), over the transcript dataset built by
`/home/Carl/scratch/prompt-cache-idle-gap/dataset/run_all.sh`. That dataset
prices every row, including `cache_warm` pings, so each arm is charged for its
own warming.

**Stratify by allocation period.** Within a period the arms are randomised
against each other, so model rollovers and busier weeks hit both alike. Compute
the ratio within each period, then pool. Separately, the **pure A/B** is
period-0.5 roots using only turns from before idle warming actually started:
the deploy of pi patch 0004, not the 12 October settings change, because stock
pi dropped every idle ping. From then on the arms measure policies: "5-minute
cache plus idle warming" against "1-hour cache plus the keep-alive ping". A
period estimate well outside the pure A/B's interval reflects that change, not
a flaw.

**Stopping rule.** The primary measure is cost per prompt token with the model
mix removed, median root, 1-hour ÷ 5-minute. If the pooled, period-stratified
95% interval sits entirely below 1.0, set `rootCacheLongShare` to `1`. If it
includes 1.0, hold the share for two more weeks and re-run once, then decide on
the point estimate.

## Plain pi CLI

For Carl's interactive `pi` sessions (the same idle pattern), put this in the
shell profile:

```sh
export PI_CACHE_RETENTION=long
```

This is safe for Loom threads, because the composer overrides the variable for
each thread. Terminal pi runs the global install, not Loom's bundled copy, so
it idle-warms only once `infra/pi-patches/apply.sh` has applied 0004 there, and a
1h terminal session gets its keep-alive ping only if `PI_CACHE_WARMING_IDLE_MAX_MS`
is exported too (with 0003 applied).

## Traps

- **An out-of-range share resets every setting.** A `rootCacheLongShare` outside
  0–1 fails the whole `settings.json` decode, and the server falls back to
  defaults for everything. A leftover `rootCacheRetention` key is silently
  ignored.
- **Idle warming fails silently.** Stock pi 1.1.0 drops every idle ping as
  "conversation context changed" once any extension handles `turn_end`, which
  Carl's global pi packages do; pi patch 0004 fixes it. A pi bump that loses 0004 goes
  back to no idle pings with no error. Check that `cache_warm` entries, and
  `loom_thread_cache.touched_at`, still move after a run has settled.
- **The env leaks to what a root spawns.** Anything a 1-hour root's pi process
  starts itself inherits `PI_CACHE_RETENTION=long` and the 90-minute horizon:
  `consult_manager`, pi-subagents runs, `pi` run from its bash. The readouts do
  not attribute that spend to the root.
- **The proxy under-prices 1h writes.** cli-proxy's per-request records
  (`/home/Carl/cli-proxy/routing/router.sqlite` `usage`) carry only the total
  `cache_creation_tokens`, and their `cost_usd` prices every write at 1.25×, so
  long-arm writes are 37.5% too cheap there. Take the split from the pi
  transcript and re-price at 2×.
- **Utilisation headers are per account.** `Anthropic-Ratelimit-Unified-*`
  moves with every concurrent session on the account, so one record's delta is
  not that request's cost. Only a window-level fit such as `readout2.py`
  attributes it.
