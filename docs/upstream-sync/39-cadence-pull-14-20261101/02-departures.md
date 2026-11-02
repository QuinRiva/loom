## 2. Departures from pull 13's shape

- **No integration track (no S2c).** Thread search did not move this week
  (§6.7): upstream's `ThreadSearch.ts` changed 13 lines, all silently merged
  onto Loom's layer. The one structural change (§4) is a server fix that fits
  S2a.
- **Rule D is small this time.** Pull 13's module split already happened; this
  week upstream grew the same files. 64 content hunks in 49 files have a side
  of 20 lines or more and are read by hand (§7.1); the per-hunk re-homing map
  (Appendix D) has five entries instead of pull 13's 190.
- **Rule A has a caveat that decides more than Rule A itself.** 23 hunks are
  classed A (upstream's side has no code, Loom's side has a `loom` line), and
  seven of them are upstream deletions or hoists (#26238; #19229's hoisted
  answer validation) that git kept because a Loom line sat inside them. The 12
  "Loom-side-only" hunks are 11 lockfile hunks and one `AGENTS.md` line,
  nothing more. §7.1 names the seven; S1 greps upstream's blob before keeping
  anything on Loom's side of **any** A hunk.
- **Rule T is small.** Upstream deleted 19 test files, none Loom-edited; 19
  conflicted test files carry 21 markers, each a Loom case beside an upstream
  rewrite. No mass disposition table this pull.
- **Gate 2 keeps four reviewers;** 2a's read list is the index-based cold
  shell (§4), the linked-environment caller path (§5.2), side-chat lineage in
  `ThreadForkService.ts`/`ProviderTurnStartService.ts`, and the
  interrupt-timeout path (§6.1).
- **A conformance sweep inside S2a/S2b again** (§6.8): effect reasons, the
  promoted oxlint rules, the Effect LSP diagnostics. No em-dash ruling is
  needed (pull 13 ruled (a); new Loom strings are caught by lint).
