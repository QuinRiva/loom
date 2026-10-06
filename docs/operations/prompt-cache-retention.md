# Prompt-cache retention (1h cache for root threads)

Root threads idle while their children work, so on Anthropic's default 5-minute
prompt cache they keep re-writing a cache the 1-hour cache would have kept.
Children are short bursts and pay more on 1h (a 1h write costs 2× base input,
a 5-minute write 1.25×). So the 1h cache is chosen **per thread**, never globally,
and only a root can get it. The case for it is in
`/home/Carl/cli-proxy/docs/predictive-routing/usage-baseline.md` §6.

## The knob

`rootCacheRetention` in the server's `settings.json` (the cockpit:
`~/.t3/cockpit/userdata/settings.json`). Hand-edit the file; the server watches
it, so no restart and no code change. The value is read at a thread's FIRST pi
launch and then fixed for that thread (see below).

| value          | roots                                   | children |
| -------------- | --------------------------------------- | -------- |
| `ab` (default) | 50/50 by a stable hash of the thread id | short    |
| `long`         | all 1h                                  | short    |
| `short`        | all 5 min (revert)                      | short    |

A **root** is a thread with no parent (`parent_thread_id IS NULL`). That includes
`mcp__t3-code__thread_fork` forks, goal handoff/continue successors, and the `/handoff` and
`/retro` fork threads. The read-only `mcp__t3-code__consult_thread` fork, pi text generation
(titles, commit messages) and every child are always short.

The value applies to threads launched after the change. A thread's arm is part
of its launch identity: the session composer records it with the thread's
prompt in the write-once sidecar `<stateDir>/workstream-launch-identity/<threadId>.json`
at the first launch, and every relaunch (restart, resume, idle reap) replays it.
So each root keeps one arm for life, and a revert to `short` reaches only roots
launched after it.

The hash is `sha256(threadId)[0] < 128` → long. To recompute it in Python:
`hashlib.sha256(tid.encode()).digest()[0] < 128`.

Mechanism: the session composer (`apps/server/src/loom/prompt/sessionComposerLive.ts`)
picks the arm (`apps/server/src/provider/cacheRetention.loom.ts`; a root is a
thread whose V2 lineage has no parent) and returns it as the `env` of the Loom
open-session fields, which `buildPiRpcLaunch` merges into the pi process env on
every launch. pi then marks every cache breakpoint `ttl: "1h"`. The variable is
set every time, so a server started from a shell that exported
`PI_CACHE_RETENTION=long` cannot hand it to children.

**Leak to know about:** anything a long-arm root's pi process spawns itself
inherits its env, so it runs long too. That covers `consult_manager`, pi-subagents
runs, and `pi` run from its bash. Neither readout below attributes that spend to
the root.

## Plain pi CLI

For Carl's interactive `pi` sessions (the same idle pattern), put this in the
shell profile:

```sh
export PI_CACHE_RETENTION=long
```

This is safe for loom threads, because the composer overrides the variable for each
thread. A loom server started from that shell still keeps children short.

## Where the arm is recorded

The server appends one line per pi launch to
`<stateDir>/cache-retention-launches.jsonl` (the cockpit:
`~/.t3/cockpit/userdata/cache-retention-launches.jsonl`):

```json
{ "threadId": "…", "cacheRetention": "long", "launchedAt": "2026-09-29T01:22:30.224Z" }
```

This is the retention pi actually got, including relaunches, which replay the
thread's recorded arm. The
pi session id is the thread id (`piSessionIdForThread`), so the pi transcript is
`~/.pi/agent/sessions/*/*_<threadId>.jsonl`.

To list `(thread_id, arm, first_launch_at)`, run this from the state dir against
a snapshot or read-only (`sqlite3` CLI: `readfile` and JSON1):

```sql
CREATE TEMP TABLE arms AS
  SELECT json_extract(value, '$.threadId') AS thread_id,
         json_extract(value, '$.cacheRetention') AS arm,
         json_extract(value, '$.launchedAt') AS launched_at
  FROM json_each('[' || rtrim(replace(readfile('cache-retention-launches.jsonl'), char(10), ','), ',') || ']');
SELECT thread_id, arm, MIN(launched_at) AS first_launch_at FROM arms GROUP BY thread_id, arm;
```

A thread has one arm for life (it is in its launch identity), so more than one
arm row means its launch-identity sidecar was deleted. Drop it from the A/B.

## Reading the A/B (after a week, at least 100 roots per arm)

Population: roots (`parent_thread_id IS NULL` in `projection_threads`) with
exactly one arm in the launch log. Per-root spend is heavy-tailed, so compare
medians and bootstrapped means, not raw sums. The treatment only reaches Claude
models (and OpenAI Responses-API models, which get `prompt_cache_retention:
"24h"`). The Codex provider ignores it, so restrict the readout to Claude
messages. A long-arm Claude message with `cache_write > 0` should also have
`cache_write_1h > 0`.

**1. Δ cost per root (API-priced).** pi prices a 1h write at 2× base input and a
5-minute write at 1.25× (`calculateCost` in pi-ai). So pi's `usage.cost.total` is
a valid dollar figure for both arms, and so is the ledger's `cost_usd`, which is
that figure verbatim. The ledger has no separate 1h bucket and does not need one.
In the long arm every cache write is a 1h write, and in the short arm none are.
The pi transcript also records the split as `usage.cacheWrite1h`. The ledger has
known gaps, so it is only good for a quick look. For the real readout use the
pi-transcript table `/home/Carl/cli-proxy/analysis/out/messages.parquet` (kind
`loom-root`, `session_id` = thread id, with a `cache_write_1h` column). Compare
cache-read + cache-write cost, and total cost, per root between arms.

**2. Δ utilisation per priced dollar (what the subscription actually charges).**
The saving assumes the subscription weights a 1h write at 2× base input, like the
API. That is unverified. Test it in the utilisation calibration
(`/home/Carl/cli-proxy/analysis/calibrate.py`: bucket utilisation = Σ spend_g / k_g).
Split the long-arm roots' 1h-write dollars out as their own group and fit its k:

- `k_1h ≈ k_rest`: the subscription prices 1h like the API, and the dollar result
  from readout 1 stands.
- `k_1h > k_rest`: 1h writes are cheaper than priced, so the saving is larger.
- `k_1h < k_rest`: 1h writes are dearer than priced, so the root case shrinks.

Traps:

- The proxy's own per-request records (`/home/Carl/cli-proxy/routing/router.sqlite`
  `usage`) carry only the total `cache_creation_tokens`, with no 1h split. Their
  `cost_usd` prices **every** write at 1.25×, so they under-price long-arm writes
  by 37.5%. Take the split from the arm, or from the pi transcript joined per
  `attribute.py`, and re-price at 2×.
- `Anthropic-Ratelimit-Unified-*` utilisation is per account and moves with every
  concurrent session on it. A single record's delta is not that request's cost.
  Only the window-level fit above attributes it.
