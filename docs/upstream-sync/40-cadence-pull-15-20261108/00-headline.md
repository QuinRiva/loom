## 0. Headline

Pull 15 is **half the size of pull 14 in the tree and bigger than it in the
toolchain.** Upstream has shipped **725 commits** since pull 14's target
`fa31b66bbb` (2,503 app files, +151k/−54k; 413 added, 37 deleted, 41 renamed,
counted without `.repos/`, which upstream renamed from `effect-smol` to
`effect` and re-synced: 24k entries of vendored churn that git merges without
a conflict). The trial merge gives **74 conflicted paths / 138 conflict
markers** (73 content conflicts, 1 upstream-renamed file Loom has never
carried), **701 `loom:` lines** in conflicted files and **187** both-modified
files that merged silently. 128 of the 138 markers are "content" hunks where
both sides edited the same lines; only three are Rule A, two Rule B, five
Loom-side-only (four of them lockfile). Loom's `origin/main` moved 20 PRs
(#515–#536) since pull 14 landed (353 files, +21k/−8.6k), and three of them
(#534–#536) are not yet on the cockpit (`20261105-132859-30ec64c`, PR #533).

What makes it more than routine, in order of how much it costs:

1. **Upstream now prunes the event log, and Loom's workstream timeline reads
   the event log (§4).** #29806 "prune events the projections already cover"
   replaced compaction: every event older than a day that is not a stream head,
   a `thread.created` or a `running` run update is **deleted**, and every V1
   event of an imported legacy thread is deleted on every pass. Upstream's own
   doc now says "projections cannot be rebuilt from the log". Loom's
   `LoomStore.history` (the workstream panel's Timeline tab: outcomes with
   their reports, flags, routes, gate rounds; and `/retro`'s "flags ever
   raised") reads those rows back from `orchestration_events`. On the cockpit
   that is **41,855 rows** (33,696 V1, 8,159 V2); without a guard the V1 rows go
   a minute after the first boot (the cockpit's prune breadcrumb is stale, so
   the first pass is due at once) and the V2 rows a day after that pass. Pull 13's guard
   (DL-1300) is on the old compaction loop, which upstream deleted. The fix is
   pre-ruled (§8.2): the same guard as two marked clauses in upstream's two new
   SQL passes, in S1 (it must be in place before S3 boots a cockpit copy), with
   the test in S2a. The proper end state, a Loom history projection table so
   Loom stops reading the log as truth, is a follow-up (§8.3).
2. **The toolchain moves (§5).** Effect **4.0.5 → 4.1.2** (352 files; `effect/Crypto`
   is gone, replaced by `effect/crypto/SecureRandom` and `Digest`, and crypto is
   no longer inside the `NodeServices` bundle: 8 Loom-only server files and 4
   Loom hunks import the old module). Typecheck moves from the `@tsc-rs/typescript`
   drop-in to **`@effect/tsgo` 0.67.1** (`effect-tsgo tsrs --noEmit` per
   package; the `typescript` catalog entry is gone), with **39 more Effect
   diagnostics at `error`** (40 new names in `tsconfig.effect.json`, one of
   them replacing `preferSchemaOverJson`), three of which upstream
   enforced with mechanical refactors (#31216 `Schema.TaggedError`, #31217
   `Effect.try` with a catch, #31218 `HostProcess.Environment` for env reads).
   Grep puts Loom's exposure at 2 + 1 + 3 sites plus 4 `Effect.succeed(undefined)`;
   the un-greppable suggestion rules (`flatMapToMap`, `syncToSucceed`,
   `unnecessaryPipe`, …) are counted by the first `vp run typecheck`. The host
   and VM need nothing new (Node 26.12.1 and pnpm 12.14.0 are unchanged; tsgo
   is a native npm binary `vp i` installs), but the **Slack bridge** symlinks
   its `effect` to the cockpit release's copy, so the bridge runs on 4.1.2 the
   moment the release flips (For deploy).
3. **A new upstream session mode and a new upstream filter reach Loom's
   files, as unions (§6.1, §6.2).** `/clear` (#30325) starts a fresh provider
   session in the same thread (`freshContext` on the send; scheduled tasks gain
   `freshSession`, migration 080); Loom reads "the latest pi provider thread"
   for `$PI_SESSION_FILE`, context-viz and consults, so it follows a `/clear`
   without a change. Thread tags (#29053) hide tagged threads while recording;
   off by default; Loom's sidebar sections keep showing them when it is on
   (a follow-up, §8.3).
4. **The usage hub seam is Rule D again (§6.4).** Upstream reads the CLIProxy
   management key from a secret provider and passes a `hub` value instead of
   the settings config; Loom's hub login, carry-forward and one-year-token
   rules (29 + 30 `loom` lines in `UsageLimitSources.ts`/`cliproxyApi.ts`)
   re-apply onto the new shape.
5. **Scheduled tasks keep their tools (§6.3).** No tool was renamed this week
   (every `Tool.make` name is the same on both sides), `bindToCurrentThread`
   survives, `schedule_task` gains an optional `freshSession`, and migration 080
   marks the cockpit's two thread-bound tasks `continue` (today's behaviour).
   The brief's "Monday-summary task" is not on the cockpit; the three tasks
   there are named in §6.3.

**What Carl will see change on deploy** (no ruling needed, but he should know
before approving):

- **The event log shrinks.** One minute after the first boot the first prune
  pass marks the head; a day later the next pass deletes about 1.3 million
  V2 events older than a day (1,448,632 rows today; stream heads, creation
  events, running run updates and Loom's guarded history stay), at a 10 %
  duty cycle, reads unaffected; S3 measures how long on a copy. Incremental vacuum then
  returns the space over the following passes. Projections are the truth
  afterwards; a Loom migration that backfills from old events cannot be
  written after that day (§4.4), and the deploy's pre-promotion snapshot is
  the last full copy of the log (For deploy asks whether to keep it).
- **`/clear`** in the composer and the slash menu; a **New session** marker in
  the timeline; scheduled tasks can run each time in a fresh session of one
  thread, and can be moved to another thread.
- **Copy thread** now copies an `https://app.t3.codes/threads/<env>/<id>` link
  (pasted into a composer it is still the thread chip; opened elsewhere it
  sends the environment and thread ids to `app.t3.codes`, which does not
  know the cockpit); Loom's thread
  mentions and the addendum's `t3-thread://v1/` links still resolve (§6.5).
- **Thread tags** on a thread's details and a Labs "hide tagged threads"
  switch, off (§6.2).
- **A Labs setting hides tool calls** ("final answer only", "zen"); default
  shows everything (§6.5).
- **Snoozing a thread with an open question** is allowed (upstream #20058);
  approvals still block it.
- **PR composers complete `#123` and `@user`** and the reviewer menu searches
  past the first page (§6.6).
- **Dictation** appears in the composer on web, desktop and mobile
  (device, environment and cloud transcription); Loom-clean (§6.8).
- **The Slack bridge runs on Effect 4.1.2** after the flip (For deploy).

Carl decides nothing before S1 starts: §8.1 is empty. Everything is pre-ruled
here (§8.2) or follows doctrine, and the two product changes he might want to
revisit (Copy thread's hosted link; the Labs tool-call filter against Loom's
cards) are findings he can rule on after S4 has shown them (§8.3).
