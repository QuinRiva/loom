## 0. Headline

Pull 12 is a **routine single-pass cadence pull** at pull 10's scale: upstream
has shipped **850 commits** since pull 11's target `737192594f` (3,969 files,
+208k/−126k), and the trial merge gives **101 conflicted paths / 178 conflict
markers** (96 content, 5 modify/delete). The base is a real merge-base, so this
is an ordinary three-way merge.

What makes it more than a textbook pull — in order of how much work each costs:

1. **Upstream rewrote its web shell for the React Compiler and now forbids
   manual memoisation.** 284 `perf(web)` commits (106 titled "compiles without
   manual memoization"), a lint rule `t3code/no-manual-memo: error` over all of
   `apps/web/src/**`, and a test (`apps/web/src/reactCompilerCoverage.test.ts`)
   that fails if _any_ web source file bails out of the compiler. Upstream's
   tree has **zero** `useMemo`/`useCallback` under `apps/web/src`; Loom's
   fork-only web files carry **113 in 47 files**, and Loom's hunks inside the
   hot shared files (`ChatView`, `Sidebar`, `ChatComposer`, `MessagesTimeline`,
   `ChatMarkdown`) sit inside callbacks upstream has since unwrapped. This is
   S2b's main job (§5.3) and Carl's second question (§7.1 row 2).
2. **Upstream pruned ~50k lines of comments in one commit** (#19559, 3,139
   files). 63 of the 101 conflicted files are touched by it, and 51 of the 178
   markers are nothing but a Loom comment or `// loom:` hunk sitting next to a
   comment upstream deleted. These resolve as "keep Loom's lines, take
   upstream's deletion" (§5.1 rule A) without judgement.
3. **Upstream moved 134 web tests into a real headless Chromium** (`*.browser.test.tsx`,
   Vitest browser mode over Playwright). The five modify/delete conflicts are
   Loom-edited tests upstream moved there; Loom's assertions need re-homing
   (§5.4). The host has no Playwright Chromium (pull 10's DL-975), so S3's web
   test gate needs one installed — Carl's third question (§7.1 row 3).
4. **Two semantic overlaps with Loom's workstream model**, found by reading the
   orchestration changes seam by seam (§4): upstream's parent-row roll-up of a
   subagent's pending question/approval (#19630) duplicates Loom's workstream
   attention rollup; and upstream's storage cleanup now treats a worktree
   shared by a subagent chain as one unit (#19748). Everything else in the
   delegation/subagent stream — the question-to-parent reactor, worktree
   isolation, `t3_thread_send` refusals, background subagents keeping tools —
   keys on upstream's `app_owned` delegated-task records, which Loom's
   `workstream_spawn` never creates, so it is inert for Loom children. There is
   **no structural conflict** with Loom's orchestrator: the eleven conflicts in
   `orchestration-v2/`, `mcp/` and `contracts/orchestrationV2.ts` are all
   comment-adjacent or one-line import unions.

Carl decides four things before S1 starts (§7.1). Everything else is
pre-ruled here (§7.2) or follows doctrine.
