## 2. Departures from pull 12's shape

- **A thread-search integration track.** Under the recommended row 1 answer
  the thread-search files need real integration work, not conflict resolution:
  S1 resolves them mechanically (upstream's files verbatim, Loom's `.loom.ts`
  files kept), and a dedicated **S2c** session wires Loom's index into
  upstream's new service shape and surfaces (§4.5, §9). S2a and S2b do not
  touch the search files.
- **A lint-conformance sweep inside S2a/S2b** (§6.9), sized per rule, with the
  model-read exemption decided by Carl (§8.1 row 2).
- **Rule D (re-apply onto upstream's shape)** is named and given a method
  (§7.1), because it decides more markers than Rules A, B and C together this
  time. Appendix D is new: the per-hunk re-homing map for the split web files.
- **Rule T (test prune)** replaces pull 12's one-by-one §5.4 re-homing.
- Gate 2 keeps four reviewers; the orchestration reviewer's set gains
  `ShellStream.ts`, `olderSettledThreads.ts`, `threadFamilies.ts`, the guest
  decider and the `t3_background_wait` tool (§6.1).
- No React Compiler sweep: Loom's web files passed it in pull 12 and upstream
  changed no exposure code. The compiler coverage test still runs in S3.
