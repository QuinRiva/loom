## S4 record — agent-run smoke (2026-10-19)

Thread `thread:mcp:5b96cd49-a5b7-4d9a-a689-3194085c8630:workstream-spawn:21ad6c9a-c30d-4151-9cdd-e223ad5c79e3`.
Decision rows DL-1310–DL-1314; journey table and screenshots in `.artifacts/pull12-s4/smoke.md`.

- **Verdict: ship-ready.** Every journey passed except the citation-comment takeover, which the harness could not stage. No must-fix finding.
- **Rollup as ruled (§7.1 row 1):** one indicator per reason on the root, live, for a question and for an approval. The one gap is a restart edge (DL-1312), filed as a follow-up.
- **Timeline guard (DL-1300) holds on cockpit-sized data.** Input for DL-1295: on this copy the first compaction ran ≈ 13.5 min (20:13:25 → 20:27:01), against ≈ 7.5 min in S3's measurement; the host was also running two dev servers and agent turns.
