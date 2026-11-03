## 0. Headline

Pull 13 is **the largest cadence pull since the V2 cut-over, and the first one
where Loom and upstream built the same feature in the same week.** Upstream has
shipped **1,238 commits** since pull 12's target `07d38b8d17` (4,932 files,
+415k/−381k; 708 added, 510 deleted, 37 renamed), and the trial merge gives
**173 conflicted paths / 418 conflict markers** (161 content, 11 upstream
deleted a Loom-edited test, 1 Loom deleted a test upstream rewrote). The base
is a real merge-base, so this is an ordinary three-way merge; the branch starts
from the build that is live on the cockpit (`origin/main` `b487d4319b`).

What makes it more than routine, in order of how much work each costs:

1. **Thread search collided (§4).** Carl said on 19 Oct "I intend to reimplement
   thread search as a high priority"; Loom's #436 landed on 23 Oct (hybrid FTS5
   - embeddings over every thread, children and archived roots included, the
     `thread_search` agent tool, migration 1062). Upstream's #24343 landed on
     24 Oct (a contentless trigram FTS5 over finished messages of top-level
     threads, migration 069, palette ranking that remembers picks, mobile message
     jump, `t3_thread_search` rewritten). Same files, same feature, different
     index, and the two indexes **do not cover the same data**: upstream's skips
     every subagent thread, which on the cockpit is 4,703 of 5,555 threads (every
     Loom child), plus archived roots, briefs, reports, goals and tasks. The
     resolution is Carl's (§8.1 row 1); the runbook recommends keeping Loom's
     index as the one content index and adopting upstream's new surfaces and
     title ranking around it.
2. **Upstream deleted 11k low-signal tests (#22557, 1,895 files; four "second
   pass" prunes; #24058 "dead test-only exports") and halved its comments again
   (#21514, 1,782 files).** 80 of the 173 conflicted paths are touched by the
   test prune and 101 by the comment prune; 37 conflicted files are tests whose
   Loom side is a block of tests upstream deleted. §5 gives the one rule that
   decides them, dispositions the 11 upstream-deleted Loom-edited tests one by
   one, and clears the 24-file `lost-ours` list (every lost name is an upstream
   de-export whose only consumer was a test upstream also deleted; two Loom
   files still import one and are fixed in S2).
3. **Upstream split its hot web files into ~190 new modules** (74
   `refactor(web)` commits on 21 Oct: `ChatView.tsx` 8,706 → 3,953 lines,
   `MessagesTimeline.tsx` 5,690 → 1,457, `ChatMarkdown.tsx` 3,387 → 1,661,
   `Sidebar.tsx` 5,084 → 3,262, `ChatComposer.tsx` 7,335 → 3,971,
   `SettingsPanels.tsx` 3,558 → 1,957) and turned every reusable server
   `Effect.gen` wrapper into `Effect.fn` (#21999 and siblings), which
   re-indents whole function bodies. Git's diff3 collapses these into giant
   "ours" regions (`MessagesTimeline.tsx` has one of 3,076 lines against 0;
   `Orchestrator.ts` one of 568 against 0). The rule is pull 12's DL-1222
   method, now named Rule D (§7.1): take upstream's shape and re-apply Loom's
   `base..main` delta inside it. Appendix D maps every Loom hunk in the seven
   split web files to the module that now owns its surrounding code.
4. **Twelve new lint rules are errors on Loom's files** (§6.9): an em-dash ban
   in product strings (277 lines in 87 Loom files, many of them control-plane
   notices agents read, which meets Carl's standing "no model-read text changes
   in a pull" rule: §8.1 row 2), a per-file React effect budget (38 Loom-only
   files with 61 effects need entries in `scripts/effect-budget.json`), a ban on
   per-file jsdom pragmas (18 Loom tests), `prefer-effect-fn`, and five test
   hygiene rules (no real-time waits, polling loops, wall clock, timeouts,
   unreasoned skips) over Loom's 620 test files. This is the S2 conformance
   sweep that pull 12's React Compiler sweep was.
5. **Two upstream changes reach Loom's workstream model in files that did not
   conflict (§6.2, §6.3).** Cold connects now omit idle subagent threads
   (#24648) and settled threads older than the 25th newest (#24723): a Loom
   child that finished its turn holding `needs_guidance` or `awaiting_acceptance`
   is "idle", so its root's Loom badge would be missing until the family is
   loaded. One marked predicate in `ShellStream.ts` keeps Loom-flagged children
   in the cold shell (pre-ruled, §8.2). Guest sharing (#24104) is a signed-token
   HTTP surface with no ws session, no auth scope and no MCP access, off by
   default; Loom's tools are unreachable to a guest by construction.
6. **The toolchain moved**: Node pinned at **26.12.1** (host and cockpit run
   24.21 via `n`), `packageManager` **pnpm 12.14.0** (host has 11.10),
   `typescript` is now the `@tsc-rs/typescript` drop-in, Vite+ 1.4.0, and the
   web typecheck moved from `apps/web/package.json` into its `vite.config.ts`.
   Effect stays 4.0.5 and React 19.3.0, so no bridge check is forced. Node is
   Carl's call (§8.1 row 3) because it is a host and VM change.

Carl decides three things before S1 starts (§8.1). Everything else is pre-ruled
here (§8.2) or follows doctrine.
