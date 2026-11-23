## For deploy

Written in S0 from the SQL, the trees and read-only queries of the live
database; S3 and S4 amend the timings and findings. The mechanism is
`loom-deploy` (`deploy/README.md`), a human-initiated act after the merge.
Nothing here is run by a session of this pull.

In the order Carl would act:

1. **Before this pull lands: deploy `main` on its own** (§8.1, recommended).
   The cockpit runs `20261120-015646-6be88bb` (#589). `main` adds #590
   (typing into the whole-file comparison) and #591 (Query author on any
   line): 43 files, no migration; #591 removes the `loom.review.lineBlame`
   RPC. Then the pull 16 deploy is upstream-only and `loom-deploy back`
   returns to a release that has both.
2. **Before S3: Node 26.13.1 on this host** (§8.1, recommended): `n 26.13.1`
   (user-level, prefix `~/.n`; `n 26.12.1` reverses it). This host is the
   cockpit machine, and the deploy config, the cockpit unit and the bridge
   unit all put `~/.n/bin` first, so the live cockpit and the Slack bridge
   run on it from their next restart. Nothing enforces the exact version at
   install or boot.
3. **The build.** Nothing new to install by hand: `vp i` brings Effect 4.1.5
   and the new packages. Two things to watch. Playwright moves to 1.64.1; if
   it wants a Chromium revision other than the two on this host, the
   server's headless browser needs `playwright install chromium` once.
   **The phone app is rebuilt from scratch**: React Native 0.88.1, Expo
   58.0.23, two new native modules and a new config plugin change the native
   fingerprint, so the release's APK step runs `expo prebuild --clean` and a
   full `gradlew assembleRelease`. Whether this machine's Android SDK, NDK
   and Gradle cache meet the new modules' needs cannot be known without a
   build: watch `build.log` and the six post-build checks. The old APK keeps
   working against the new server.
4. **The switch: an ordinary `loom-deploy deploy`.** Upstream raised the
   service-launcher protocol from 3 to 4 and made the new release accept an
   installed protocol-3 launcher, so the hand procedure in
   `deploy/README.md` ("A launcher protocol change") is not needed (§6.7).
   If the new runner refuses the context, the launcher puts back the old
   release and the old database by itself. S3 ran the seam test at protocol
   4 (12/12) and once with the running release's launcher, adopt and
   runner as the release being left (12/12, DL-2321). The old
   protocol-3 launcher process keeps running after the switch; the
   protocol-4 launcher starts at the next `loom-cockpit` restart, and the
   unit file is not rewritten.
5. **First boot runs upstream migrations 081 to 108** (the live database is
   at 80 / 1072) and no Loom migration. **Measured by S3** on a `VACUUM INTO`
   copy of the cockpit database (4.86 GB), with the built server on Node
   26.13.1 and the host's load average between 28 and 41: the server
   answered **52 s** after spawn with the copy out of the page cache and
   **46 s** with it cached; the migrations themselves took 39 s and 27 s,
   most of it 082 (16 s, an index over the turn items) and 081 (1 to 11 s).
   Every later boot takes 5 to 7 s. During the first boot every client shows
   "reconnecting". The deploy's limit is 240 s (`deploy.json`
   `startTimeoutSeconds`), so nothing needs raising; the "checking" trial
   start runs on a slice of the database and does not time the migrations.
   The file grows about 160 MB (4.86 → 5.02 GB on the copy). Nothing a Loom
   migration created is touched; 083 drops one upstream index nothing in
   Loom reads (DL-2324).
6. **At first boot Carl is asked nothing.** Browsers, the phone app and the
   Slack bridge stay signed in: device approval (#36419) covers only T3
   Connect devices, the cockpit has no `cloud-connect` session or pairing
   link among its 197 and 387, and the gate is off by default. If he were
   ever locked out, `node apps/server/src/bin.ts pair` still mints a token
   for the running server, and a token-paired device never waits for
   approval. The Slack bridge restarts by itself on the new release's
   contracts and Effect 4.1.5; all 11 names it imports and all 6 RPCs it
   calls are unchanged. Its root message for the deploy job is the proof it
   came back.
7. **What starts happening without anyone asking:** the server holds a sleep
   inhibitor (`systemd-inhibit`) while agents work (harmless on a VM;
   `keepAwakeWhileAgentsWork`); about five Loom children under settled roots
   settle on the first sweep (§6.5); one-time scheduled tasks delete
   themselves after their run, and the cockpit's "Deploy redesign:
   readings…" task is due **24 Nov 23:00 UTC**, so it fires on whichever
   build is live then; the Usage page reads 92 days back; three upstream
   GitHub workflows become active on the fork at merge (`pr-limits.yml` has a
   daily cron and is dry-run unless a repository variable is set).
8. **After:** Carl installs the rebuilt APK from the in-app notice.
   Settings' database Reclaim button refuses on the cockpit (the database
   already shrinks incrementally) and does nothing.
9. **Rollback.** Both the launcher's automatic put-back and `loom-deploy
   back` restore the pre-switch database copy, so old code never meets the
   new schema through the deploy tools; the cost is Loom writes since the
   switch. If old code were started by hand on the migrated database it
   runs: S3 started release `6be88bb` on its migrated copy, which listened
   in 14 s, logged one warning that 081 to 108 are unknown to it and served
   the thread list. It also warns once that it ignores the `mod+f`
   `preview.find` key binding the new build adds to `keybindings.json`,
   which `back` does not restore; harmless (DL-2325).
10. **What Carl will notice:** §0's list. S4 confirms it live and amends
    this file.
