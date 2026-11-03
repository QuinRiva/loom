## 11. Risks

| Risk | Owner | Mitigation |
| --- | --- | --- |
| The React Compiler sweep changes a Loom component's behaviour (canvas, annotation layer, thread tabs sync, verified chips) | S2b | Row 2's escape hatch; `/preview` screenshots before/after; S4 exercises annotate + chips + tabs |
| `ChatMarkdown.tsx` chip pipeline re-apply drops a scanner or the artefact route | S1 | Gate 1 reads it; the two re-homed scanner tests (§5.4); S4's `.artifacts` viewer and chip journeys |
| `VcsStatusBroadcaster` interleave loses Loom's repository batch or upstream's failure reconciliation | S1 | Gate 1; S2a runs `VcsStatusBroadcaster.test.ts` (union) and `GitManager.test.ts` |
| Planner-stats change regresses a query on the 8.8 GB cockpit DB | S3 | Row 4's timed boot on a copy; Gate 2b compares |
| Upstream's lineage walkers (`pendingSubagentRequestsByThread`, `worktreeOwner`, `shellParentThreadId`) treat Loom children in ways not found here | Gate 2a | The §4.2 table is the checklist; grep `relationshipToParent === "subagent"` and `lineage.parentThreadId` in the merged tree and read each new site |
| Effect 4.0.5 breaks the Slack bridge the way 4.0.2 did (DL-1015) | deploy | `bridge` gate (§9) |
| `tsc-rs` drift (new checker rules since pull 11) | S1/S2 | Typecheck observed in S1; S2 re-planned if a track exceeds a few hundred errors |
| Browser tests are flaky on this host (headless Chromium, port hashing) | S3 | `apps/web/vite.config.ts` hashes the API port per checkout; run once, retry once, record |
| `origin/main` moves before S1 (Loom PRs in flight) | S1 | Merge it in first (DL-901's method); re-run `remeasure.sh` only if a merged PR touches a conflicted path |
