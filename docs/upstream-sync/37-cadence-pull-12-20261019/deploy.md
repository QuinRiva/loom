## For deploy

1. **Compact offline first (Carl's ruling, DL-1295, Gate 2b option b).** Back up, stop the cockpit, and run the Loom build's `t3 doctor --fix` before the first boot of this release. It needs about 12 GB free disk and 10–20 min. Compaction and `VACUUM` happen offline, the file shrinks about 6.5 GB, and incremental auto-vacuum turns on.
2. Revoke the 133 stale `t3 cli (local)` admin sessions and delete `secrets/cli-token.bin` (DL-1250).
3. Check the Slack bridge against Effect 4.0.5 before promoting (runbook §9 `bridge`).
4. Telemetry: upstream's default destination is now `ingest.t3.codes` (#15028). It was already on by default (PostHog). `T3CODE_TELEMETRY_ENABLED=false` in the cockpit's environment turns it off; Carl's call.
