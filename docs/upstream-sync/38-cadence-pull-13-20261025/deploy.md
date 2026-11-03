## For deploy

1. **Node 26 and pnpm 12 take effect at this deploy.** `loom-cockpit`, `loom-deployd` and `loom-slack-bridge` still run the Node 24.21.0 binary that S3 replaced on disk (`/proc/<pid>/exe` → `/home/Carl/.n/bin/node (deleted)`). The build (`pnpm install --frozen-lockfile`, then `pnpm build`) and the promoted cockpit and bridge start on Node 26.12.1 with pnpm 12.14.0. The bridge's stage-two `/healthz` gate covers the bridge on Node 26.
2. **First boot runs 065–069 and the Loom migrations 1063 and 1064.** The live database is at 64 / 1062, because the deployed release `7935f6a` predates #442. So both `1063_LoomThreadDocumentQuery` and `1064_ThreadSearchTextGuard` run. 069 builds the trigram message index (≈ 5 s on a copy, 31,898 rows). The production bundle reached Listening in 10 s on a copy (DL-1524). The deployd's smoke boot uses a fresh home and does not exercise these migrations on live data.
3. **Compaction window.** The first online history pass runs at a 10 % duty cycle: 37.5 min on S4's copy, more than 70 min on S3's. Reads stay at their normal latency during it (DL-1507). No offline compaction step is needed this time.
4. **Do not run `t3 doctor --fix` on the cockpit** until task `429ef6ca` lands. It refuses on the 11 threads holding the retired `human-message` kind (DL-1506). This deploy does not need it.
5. **Behaviour Carl will notice.**
   - A message sent mid-turn now steers the running turn instead of queueing (DL-1463, his ruling).
   - Shippers can watch PRs again (DL-1510).
   - Thread search keeps Loom's hybrid ranker with upstream's palette, pick memory and mobile message jump.
   - Guest links stay off, and need T3 Connect even when the beta is turned on (DL-1523).
   - Tabs on older settled or archived threads may show a raw id after a reload (DL-1520).
6. **Restarted turns resume.** A Pi turn interrupted by the promotion resumes, and a steer stashed at shutdown is delivered (§10 `boot`).
