## 12. Risks

| Risk | Owner | Mitigation |
| --- | --- | --- |
| A Rule D re-apply drops a Loom hunk in one of the split web files or the `Effect.fn`-reshaped server files | S1 | The per-file `loom`-line check (§10 `rule-d`); Appendix D; Gate 1 reads the named files; `lostdecls.py` and `whatismissing.sh` in S3 |
| The thread-search integration (S2c) takes longer than two days, or Loom's hits do not fit upstream's `rankMessageMatches` (which reads `quality`/`hits`) | S2c | Loom's layer supplies `quality` from coverage and `hits` from the per-root document count, or the client keeps server order for Loom hits; the eval harness decides; a DL row if the palette's ranking of Loom hits is changed |
| Upstream's older-settled omission interacts with Loom's sidebar sections or goal grouping in a way §6.2 did not predict | Gate 2a | S4's cold-connect journey on a seeded instance with 30+ settled roots; `GoalThreadsSection` reads the older-settled shelf like any other row |
| The lint conformance sweep is larger than estimated (`prefer-effect-fn`, the test rules) | S2a/S2b | Counts recorded after the first `vp lint`; if a rule's hits exceed a day, a marked, reasoned `oxlint-disable` per site as upstream's own files do, with a DL row and a follow-up |
| Node 26 or pnpm 12 changes behaviour on the cockpit (native modules: `better-sqlite3`? no, Node's own SQLite; `@huggingface/transformers` onnx runtime) | S3 | S3's fresh install and the cockpit-copy boot run on 26; the embedder's local provider is exercised once (`threadSearchEval`); the deploy note records the versions |
| `@pierre/diffs` 1.6.1 / `@pierre/highlights` changed an API Loom's #424 diff view calls | S2b | Typecheck; the `/preview` diff fixtures |
| The design-overhaul beta changes `components/ui` variants Loom's chips and panels use | S4 | Off by default; one toggled pass with screenshots |
| `origin/main` moves before S1 (Loom PRs in flight) | S1 | Merge it in first (DL-901's method); re-run `remeasure.sh` only if a merged PR touches a conflicted path |
