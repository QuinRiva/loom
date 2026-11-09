## For deploy

Written in S0 from the SQL and the trees; S3 and S4 amend the timings and
findings. The mechanism is `~/loom-releases/RUNBOOK.md` (`deployctl deploy`),
a human-initiated act after the merge.

1. **First cockpit boot.** The live database is at 76 / 1069. The first boot
   runs upstream 077–080 (077 updates 0 rows; 078 drops
   `idx_orch_events_correlation_id`; 079 builds two partial indexes over
   6,576 threads and 6,397 runs; 080 adds `thread_mode` and marks the two
   thread-bound tasks `continue`) and **no Loom migration**. 078 is the one
   irreversible step and nothing reads that index. S3 (DL-1898): on a
   `VACUUM INTO` copy the four ran inside the first 5.5 s of the boot and the
   server listened 8.0 s after spawn (a warm boot: 4.3 s); 077 matches 0 rows
   on the live database.
2. **Pruning starts a minute after boot and bites a day later.** The cockpit's
   `compacted-at` breadcrumb (`~/.t3/cockpit/userdata/compacted-at`) was last
   written on 6 Nov 06:27 UTC although the server has run since 5 Nov with a
   6 h interval. S3 read the system journal: neither. The VM was suspended
   (`PM: suspend entry (deep)`) from 6 Nov 20:30 to 9 Nov 09:00 AEDT; Node's
   6 h timer does not count suspended time, so the next pass started at 11:56 on
   9 Nov, ran 12.5 min (7,462 events) and wrote the breadcrumb at 12:09. The
   breadcrumb is current again, so the first pass after the deploy waits for its
   six hours unless the deploy lands more than 6 h after the last pass. A
   stale breadcrumb makes the new prune pass due at once: one minute after
   boot. The first
   `pruneEventStore` pass writes the prune mark and runs the legacy pass
   (which, with the §4 guard, deletes nothing on the cockpit: the only V1
   rows left on imported threads are Loom's history). The next due pass, 24 h
   after the first, deletes every V2 event older than the mark that is not a
   stream head, a `thread.created`, a running run update or a Loom history
   row: about 1.3 M of today's 1,448,632 rows, at 50 rows a page under the 10 %
   duty cycle, each page's `prunable` CASE running a correlated
   `MAX(sequence)` subquery per row; reads unaffected. How long that takes is
   S3's forced-pass measurement on the copy (no estimate here: pull 14's old
   compaction did 164k rows in an hour, and this is a different query). Incremental vacuum
   (`auto_vacuum = 2`) returns the pages over later passes; the 6.7 GB file
   shrinks gradually. **After that pass the event log is a day deep**: a
   pre-promotion snapshot (`deployctl … --restore-snapshot`) is the only way
   back to the full log, and a Loom migration that backfills from old events
   cannot be written afterwards (§4.4). **Carl's call:** keep that snapshot
   beyond the usual rotation as the one archive of the full event log (he does
   research over agent behaviour, and the log is the only record of event
   timing older than the projections), or let it rotate. **S3's forced pass on
   the copy (DL-1898):** 23 min 31 s under the duty cycle (an upper bound: the
   server test suite ran beside it), 1,391,225 events deleted (1,459,197 →
   68,022), 3.45 GB reclaimable; the server stayed responsive (event-loop p99
   22–120 ms per minute, worst stall 0.6 s). The first pass after the deploy
   takes about 13 s and deletes nothing.
3. **Loom's workstream history survives** (§4.3's guard): on the copy all
   41,920 rows (33,696 V1, 8,224 V2) were there after the first pass and after
   the forced pass, and the weekly dashboard's 2026-W45 readings matched the
   live database row for row (DL-1898). If it did not, the Timeline tab of every workstream older
   than a day would lose its outcomes, flags and routes.
4. **The Slack bridge runs on Effect 4.1.2 from the flip.** Its
   `node_modules/effect` symlinks to the release's `packages/contracts/node_modules/effect`
   (RUNBOOK.md §"Every bridge release resolves the running release's
   contracts"); `promote` restarts the bridge. The bridge imports only
   modules 4.1 did not rename (§5.1); the deploy job's root Slack message is
   the proof it came back. If it did not, `rollbackTo` restarts it on the
   previous release's 4.0.5.
5. **The build.** `pnpm build` on the VM installs `@effect/tsgo` with the
   rest of the lockfile (a native optional dependency, `linux-x64`); no VM
   change. S3 ran `pnpm build` from a fresh install (51 s, 7/7 tasks) and the
   built `dist/bin.mjs` served a fresh home (DL-1899's typecheck note
   aside: the ship waits for the host upgrade, DL-1926).
6. **Three undeployed Loom PRs ride along:** #534 (false needs-attention
   flags), #535 (graph drag no longer selects text), #536 (prose width
   narrowing). Nothing in them needs a migration or a setting.
7. **What Carl will notice** (§0's list; S4 confirms live): `/clear` and the
   New session marker; scheduled tasks movable between threads and runnable
   in fresh sessions; Copy thread copies an `https://app.t3.codes/threads/…`
   link; thread tags and a Labs hide-while-recording switch (off); a Labs
   tool-call visibility setting (showing everything); a thread with an open
   question can be snoozed; PR composers complete `#123` and `@user`;
   dictation in the composer on every client; the event log shrinking over
   the days after the deploy.
8. **Restarted turns resume.** A pi turn cut by the promotion resumes, and a
   steer stashed at shutdown is delivered (§10 `boot`); a steer held during a
   compaction at the moment of SIGTERM is dropped, as upstream's own steers
   are (§6.1, §12).
