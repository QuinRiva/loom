# Pull 9 — fixes from Carl's QA pass

Bugs Carl found pairing with the Phase 4 QA instance (`http://localhost:13940`,
`docs/upstream-sync/33-pull9-phase4-qa-guide.md`), and what was done about each. Decision
numbering continues from DL-600. The PR is the rollback boundary; nothing here is merged or
deployed.

## Decision log

- **DL-600 — PR retargeted.** A GitHub PR's head branch cannot be changed, so #332
  (head `ws/t3code/plan-next-upstream-merge/orchestrator-05cb7527` @ `bcee87ca65`) was
  closed with a pointer and replaced by **#333**, head `t3code/plan-next-upstream-merge`
  (= `bcee87ca65` + the Phase 4 fan-in merge `580362746c`). History is unchanged; every QA
  fix lands on this branch. Not merged.
- **DL-601 — Goal task tree accidentally wiped and restored (2026-10-06 21:40Z).** Adding the
  verification subtree with `goal_tasks_rewrite` from the unanchored goal owner replaced the
  whole tree, soft-deleting 54 tasks. They were read back read-only from
  `projection_goal_tasks` (`deleted_at = 2026-10-06T21:40:33.870Z`) and re-added with the same
  text, done-state, nesting and order. Deleted ids cannot be revived, so **every restored
  task has a new id** (e.g. the QA-fix task `c47fd0ab` is now `ef2e3d0d`); old ids quoted in
  earlier docs and reports no longer resolve. The two "PR #332" task texts now say #333.
- **DL-602 — "Bootstrap worktree: pnpm requires Node ≥ 22.13, current 22.12" is QA-sandbox
  only.** The sandbox mounts an empty `/home/Carl`, so the login shell that resolves the
  worktree environment never reads Carl's `~/.bashrc` (which puts `~/.n/bin` first), and
  `/etc/profile.d/env.sh` puts `/opt/conda/bin` (conda's Node 22.12.0) ahead of `/usr/bin`
  (24.12). Reproduced on the host: `env -i HOME=/tmp/emptyhome bash -lc 'node --version'` →
  v22.12.0, `HOME=/home/Carl` → v24.21.0 (`~/.n/bin/node`). Production boots with the real
  home, so not a cut-over defect; and setup would fail in QA anyway (no npm registry, guide
  §4). No change.
- **DL-603 — The restored goal tasks have new ids, and ticks wait for QA.** A task under the
  QA-fix parent is ticked only when its fix is in PR #333 **and** in the rebuilt QA instance.
  A coder ticking its own task when it submits is reopened until then.
- **DL-634 — Consult forks keep the target's own tool set (Carl's direction).** Carl, on the
  QA plan `plans/consult-thread-fork-failure/plan.mdx` (written in QA worktree `t3-9e9fa432`):
  "I never liked the way that we limited which tools a consult thread could use … it caused
  problems where … that thread … would try to do something that it needed to do in order to
  answer the question but couldn't." So the `--tools read,grep,find,ls` narrowing and the
  appended read-only system prompt go; read-only becomes an instruction in the consult turn.
  The one kept limit is control-plane identity: the fork has no MCP credential, so it cannot
  submit, spawn or flag as the target. Side effect: no renamed core tool is removed
  mid-conversation, so the provider 400 (`tool_removal references unknown tool 'bash'`)
  cannot occur on the consult path. Coder's first cut (`ba10ec368c`) fixed it instead by
  patching the third-party `pi-anthropic-messages` bridge (which renames `bash`→`Bash` in the
  tool list but not in `tool_removal` blocks); that patch stays for QA agent dirs as a
  defence for other tool-shrinking paths, but the consult no longer depends on it. The plan's
  stub-and-block alternative was not taken. Sent back via the review gate.
- **DL-670 — Task-tree deletions are restorable by resubmitting the deleted line with its
  id; the removal echo lists the removed lines; `goal_update` is owner-only.** No
  confirmation flag, so normal prunes cost nothing extra. (Verifier F1/F2; DL-601 was this
  bug.)
- **DL-680 — The quiescence grace runs from the later of the last run's completion and the
  reopen time; a synthesised report never replaces a submitted report's path.** (Verifier
  B2.)
- **DL-604 — Production (V1) stopped launching briefed scaffold nodes after its mid-session
  restart (2026-10-06 ~23:20Z).** Five coders scaffolded and briefed after the restart
  (`776b38eb`, `c87e53ec`, `a46cf508`, `7dfc22d8`, `0cc0b3e8`; also `9a5d1066`, whose kickoff
  the restart ate) showed `in_progress` with no session file; the control plane later flagged
  one "went quiet". Gated reviewers released by a coder's completion did launch. Workaround: a
  `workstream_prompt` pointing at the stored brief
  (`userdata/workstream-briefs/<id>.md`) starts the turn. This is production's V1 control
  plane, not PR #333's code; recorded as a task to re-check after cut-over.
- **DL-671 — A new root's emergent goal is derived when its first message arrives, as in V1**
  (`git show main:` `ProviderCommandReactor.ts`), not after its first run completes. Goal
  tools called before the goal exists create it through the same per-thread-locked
  `EmergentGoals` service (at most once) instead of refusing, so an orchestrator can lay out
  tasks and anchor children in its first turn. Landed with DL-670 in `dd1ca303ab`
  (gate clean).
- **DL-720 — Multi-select `ask_user_question` answers are joined with ", " on Loom's
  `loom-ask:` path only.** Upstream's answer contract already allows arrays and its live
  adapters accept them; the one string-only path is the message-capability answer in
  `Orchestrator.ts`, whose upstream producer (Codex async questions) is never multi-select.
  Loom's asks ride that path, so `loomAskAnswer` joins an array the way upstream's own
  string-only Claude adapter does; upstream validation is unchanged. The agent sees V1's
  outcome rendering. Gate `fixed_inline` (`c53da13f4b`).
- **DL-650–654 — The tab strip is scoped per root again (Phase 3 had deferred it; Carl
  ruled the flat strip unacceptable).** The group key walks `lineage.parentThreadId` across
  `subagent` links only, so a V2 fork is its own root. Every entry point funnels through the
  thread route, the one place tabs are seeded. Archived or deleted threads are pruned from
  the strip, a deliberate change from V1, which left them as raw-id tabs. Gate clean.
- **DL-605 — "`vp check` fails on the base" (DL-655) was a stale install, not the branch.**
  This worktree had `vite-plus` 0.3.0 against a lockfile pinning 1.0.0; its formatter
  flagged an upstream test. After `CI=true vp i --no-frozen-lockfile`, `vp check` on
  `9d2efbf2e8`: 0 errors, 905 warnings. No file changed.
- **DL-680–682 — Quiescence respects reopen and human clears.** The grace runs from the
  later of the last run's end and the sidecar row's last change. After a run ends, only a
  human or the parent touches that row (a reopen, "Clear flags", a re-plan), so both restart
  the grace. A run the agent submitted from is never synthesised over, so a real report path
  stands. Reopening a settled thread emits `thread.unsettled`, so the sidebar row leaves
  Settled. Brief-by-id: `workstream_brief` and scaffold `thread:` references accept the ids
  `workstream_list` prints. Gate clean (`b0759c0c10`).
- **DL-683 — Restart re-stamping `updated_at` is upstream's and stays.** After a restart,
  upstream's `ProviderRuntimeRecoveryService` emits `provider-session.updated` per open
  session, and upstream's `ProjectionStore` re-stamps `updated_at` for it. Both files are
  byte-identical to upstream. Sidebar ordering is unaffected; `workstream_list`'s
  last-activity reads boot time for those threads (cosmetic). Doctrine §4.3: left alone.
- **DL-710 — A `thread_fork` thread replays its source's launch identity** (role overlay,
  skills, appended prompt, cache retention) and is composed as a root, never as an unread
  child. A lineage fork whose source has no V2 identity record (every V1-imported thread not
  yet relaunched) composes fresh as a root. `forkFrom` children are unchanged. Gate clean
  after one rework round (`2a5bd30082`).
- **DL-660–663 — Messages sent in a thread's first seconds are delivered, not bounced.**
  `workstream_prompt` and `notify_thread` drop `deliveryIntent: "auto"` and use Loom's steered
  tier (as `controlMessage()` does): in the window between run start and provider-turn
  start, the message is queued instead of hitting upstream's
  `No running provider turn found` refusal. A Loom dispatcher step (`queuedSteerPromotion`)
  then promotes queued Loom-origin messages into the running turn via upstream's
  `queued-message.promote-to-steer`, in delivery order, never past an earlier queued one
  and never through a human-held queue. No upstream validation changed. The tool result
  names what happened (steered, queued, kickoff, next turn). Gate clean; fan-in conflict
  in `Orchestrator.ts` (an import list, beside DL-720's `loomAskAnswer`) resolved by hand
  in `6513bf8093`, with typecheck, `vp check`, the Orchestrator tests and the
  unmarked-hunk sweep green.
- **DL-700–703 — Quota reroutes stick.** A draft model pick the server thread already holds
  is spent and dropped, so the composer follows `thread.modelSelection`: server-side
  reroutes and move-backs reach what the composer sends, and an unsent human pick still
  wins (web and mobile; closes DL-477b). At boot the reroute sweep restores exhaustion marks
  from `loom_thread_reroute` before its first pass, so a restart no longer moves rerouted
  threads back (closes DL-484); `reset_at` now means "when the intended model's exhaustion
  lapses". One sessions-root resolver, `piSessionsRoot(env)`, serves the importer and the
  Usage page, which now shows real spend under a relocated session dir. DL-477d (live pi
  hides `Retry-After`) remains open. Gate clean (`99b7d1a141`).
- **DL-740 — Forks take their own identity after their first launch (V1's fork-once
  replay).** A `thread_fork` or UI fork, and a `forkFrom` child, replay the source's launch
  identity byte for byte on first launch only (cache prefix intact), then compose their own,
  with their own `You are thread <id>` and root or child framing. Gate clean (`8f7273fc27`).
- **DL-690–694 — Steers survive a server restart (closes DL-561).** The pending-steer stash
  is a durable mirror of pi's own steering queue (the adapter writes pi's
  `queue_update.steering` list on every change), so a steer the model already consumed is
  never redelivered, and shutdown no longer erases an undelivered one. A stashed steer rides
  upstream's restart continuation (one `// loom:` hunk in `RestartContinuation.ts` appends it
  to the continuation prompt), so it reaches the model first and is never parked behind a
  held human queue. Only a restart that cut the stash's own run delivers it, so a steer
  stays dropped after a deliberate Stop. Threads without a Loom sidecar (plain UI threads)
  are covered too. Verified live: the DL-561 scenario's steer reached the model exactly
  once. Gate clean after one rework round (`fbfe4efa9e`).
- **DL-730s — Small web fixes.** `lint-plan.mjs` runs again under vite-plus 1.0; Settings →
  Archive updates live on archive and unarchive (via the shared archived-threads query);
  healthy `/handoff` drafter threads are hidden from the sidebar, palette and mentions per
  V1's rule; the annotation chip label no longer reads "block block". Gate `fixed_inline`
  (`6e05d26853`).
- **DL-606 — Carl's review of the 32 pull-9 drops is the authority for restores.** His
  verdicts: `/home/Carl/.t3/cockpit/worktrees/loom/t3code-8575c5e1/recaps/pull9-agent-drops/carl-decisions.md`
  (from the post-mortem thread `e1aab7f0`). Twelve rows restored on this branch: C1 thread
  references; T3 consult card shows its answer; T4 handoff progress, failure toast and
  `goal_handoff` receipt; T5 the `recovered` digest item; W2 node-timeline flag, yield and
  rework rows; W3 jump-to-message (reversed from DROP); W4 workstream cost total; W5 tool
  count and context on board cards (reversed from DROP); S2 clickable rollup popover; S4
  pending-question topic and age; O3 `thread_fork` includes the calling turn; G3 the right
  panel reopens as the user left it. Q1 (semantic search plus include-archived toggle) is
  agreed, but its timing is Carl's call.
- **DL-750 — Thread references get their own trigger, `!`, not `#`** (Carl: "`@` is
  already searching files, which is heavy … `#` is now used by PRs … the big gap … is that
  spaces are escaped and almost all threads have spaces in their names"). `@` (files) and
  `#` (pull requests) stay upstream's; multi-word queries are the core requirement.
- **DL-607 — Two review gates deadlocked in production (V1) on the re-verify hop.** The
  consult and control-notice coders submitted round-1 rework (10:52 and 11:15 local) and
  were told "routed to the reviewer for re-verification", but neither reviewer was woken.
  Prompting them by hand was refused: "cannot start its first turn: dependency … is not
  done yet (lane: in_progress)". The gate's auto-added `blockedBy` on the coder is still
  enforced on the reviewer's re-verify turn, while a coder in rework stays `in_progress` by
  design. Cleared each reviewer's `blockedBy` (the gate's routing is separate) and prompted
  them with the round-1 report paths; both resumed. Same family as DL-604 (production
  control plane, not PR #333); folded into the after-cut-over check.
- **DL-630–635 — `consult_thread` answers on V2-started threads (closes the consult 400).**
  Consult forks keep the target's own tools (DL-634, Carl's direction); read-only is one
  sentence in the consult turn, and the fork still carries no MCP credential, so it cannot
  act as the target. The only tools a fork now removes are `mcp__t3-code__*`, which the
  `pi-anthropic-messages` bridge never renames, so the provider accepts the request with the
  **unpatched** bridge production has (checked byte for byte: `cmp` against
  `~/.pi/agent/npm/node_modules/@blackbelt-technology/pi-anthropic-messages/dist/transform.js`).
  A failed consult carries the provider's own error text (DL-631). The bridge patch
  (`scripts/pull9-qa/pi-anthropic-messages-tool-changes.patch`, applied by
  `build-pi-agent.sh`) stays for QA agent dirs as insurance against other tool-shrinking
  paths (an extension tool unregistered mid-thread, or a role's `tools:` edited under a
  launched thread); patching production is optional, not a cut-over blocker. The 15:15
  contradiction: Carl's plan was right. That imported fork did declare
  `toolsRemoved=[bash, …]`, but its transcript put pi-ai on the full-tool-list path rather
  than native tool-change blocks, so there was nothing for the bridge to mis-rename. Gate
  clean after one rework round (`edf809a9d7`).
- **DL-608 — The timeline-cards coder (`b02eb3bd`) was released before the control-notice
  gate resolved and was paused,** so it does not build on card code still in review. It
  resumes once that fix merges.
