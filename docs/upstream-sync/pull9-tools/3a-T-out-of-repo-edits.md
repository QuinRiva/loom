# 3a-T — edits outside this repository (listed, not made)

Produced by session 3a-T (pull 9, Phase 3, track 3a). Every Loom tool a model
reads is now named in its prefixed form (`mcp__t3-code__<name>`); the text
below lists what still names one bare **outside** this worktree, and the memory
entries that should be rewritten. Nothing here has been applied — Carl vetoes
or applies each item.

## A. `~/pi-craft/plugins/pi-craft/skills/`

Swept read-only with the sweep regex over every file. The skills the plan
named as likely hits (`handoff`, `authored-document`, `seek-manager-guidance`)
contain **no** Loom tool name. The only hits are in `platform-update`, and
they are all `workstream_list`, used as Carl's post-deploy check.

File: `/home/Carl/pi-craft/plugins/pi-craft/skills/platform-update/SKILL.md`

| Line | Old                                                                                                                                                                                                                                                                                                                                                                                          | New                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 75   | ``The cockpit-side check is **Carl's post-deploy check**, not a skill step: `workstream_list` shows the preset block with no `[INVALID]` markers, while the negative control `cliproxy/claude-opus-9-9` is still flagged. The deployed cockpit cannot list `cliproxy/<new Claude model>` until Carl deploys. Until then the new preset slug shows `[INVALID]` there; say so in the report.`` | ``The cockpit-side check is **Carl's post-deploy check**, not a skill step: `mcp__t3-code__workstream_list` shows the preset block with no `[INVALID]` markers, while the negative control `cliproxy/claude-opus-9-9` is still flagged. The deployed cockpit cannot list `cliproxy/<new Claude model>` until Carl deploys. Until then the new preset slug shows `[INVALID]` there; say so in the report.`` |
| 84   | ``3. **Verify** per step 6 of the run, then run the runbook §7 `workstream_list` check with a negative control. Nothing needs a restart or a deploy.``                                                                                                                                                                                                                                       | ``3. **Verify** per step 6 of the run, then run the runbook §7 `mcp__t3-code__workstream_list` check with a negative control. Nothing needs a restart or a deploy.``                                                                                                                                                                                                                                       |
| 114  | ``- Deploy PR #<n> per `~/loom-releases/RUNBOOK.md`. Post-deploy check: `grep '"version"' "$(readlink -f ~/loom-releases/current/apps/server/node_modules/@earendil-works/pi-coding-agent)/package.json"` → <new>, and `workstream_list` preset block clean with `cliproxy/claude-opus-9-9` still flagged.``                                                                                 | ``- Deploy PR #<n> per `~/loom-releases/RUNBOOK.md`. Post-deploy check: `grep '"version"' "$(readlink -f ~/loom-releases/current/apps/server/node_modules/@earendil-works/pi-coding-agent)/package.json"` → <new>, and `mcp__t3-code__workstream_list` preset block clean with `cliproxy/claude-opus-9-9` still flagged.``                                                                                 |

Also swept, no hits: `~/pi-craft/AGENTS.md`, `~/.pi/agent/AGENTS.md`,
`~/pi-craft/plugins/pi-craft/*.md`, `~/pi-craft/plugins/pi-craft/extensions/`,
`~/loom-releases/RUNBOOK.md`. `~/pi-craft/docs/` has hits in historical
audit/backup documents (`audit-2026-07-loom-transition.md`,
`memory-purge-2026-07-26-backup.sql`, `review-2026-07-26-loom-transition.html`)
— history, left alone.

## B. Persistent memory

`memory_search` was run for every bare name (the 23 tools plus
`workstream_set_lane` and `workstream_release`) and `memory_lessons` read in
full. Nine entries name a Loom tool bare or assert a V1 fact that pull 9
removes (per-child worktree isolation, fan-in, the `isolation` spawn
parameter, `T3_WORKSTREAM_AUTHORIZATION`, the plan lane). The proposed
`memory_remember` calls follow verbatim; `memory_forget` is proposed where the
fact is dead rather than renamed. None has been executed.

### B1. Facts

1. **Forget** `workstream.model_overrides.coder_reviewer` — a July 2026 routing
   override (`anthropic/claude-opus-4-8`, option id `thinkingLevel`) superseded
   by the cliproxy routing lessons (`fe05a1fe`, `a68f6ebf`, `2efa1e1a`); pull 9
   also renames the option id to `thinking`.

   ```
   memory_forget({ type: "fact", key: "workstream.model_overrides.coder_reviewer" })
   ```

2. **Forget** `tool.codex_quota.status_2026_08_19` — a dated quota status
   whose only durable content ("pin Anthropic when codex is exhausted") the
   routing lessons already carry; it names `workstream_prompt` bare and the
   dead "Workstream credential" error text.

   ```
   memory_forget({ type: "fact", key: "tool.codex_quota.status_2026_08_19" })
   ```

### B2. Lessons (rewrite = forget the id, remember the new text)

3. `3b4e15f8` (orchestration — isolated child's gitignored files wiped at
   fan-in). The mechanism is gone; the durable half is where to put evidence.

   ```
   memory_forget({ type: "lesson", id: "3b4e15f8" })
   memory_remember({ type: "lesson", category: "orchestration", rule: "In T3 workstreams every child runs in its parent's worktree (no per-child worktree, no fan-in since pull 9), so a child's .artifacts/, screenshots and logs persist in the shared tree. Still brief children to write evidence that must outlive the goal under a stable path (e.g. ~/.t3/cockpit/userdata/workstream-reports/<id>-evidence/) and copy what the human needs into .artifacts/ before writing the recap — the tree is shared and other threads may clean it." })
   ```

4. `137e55fe` (loom-orchestration — shipper/reviewer default SHARED isolation;
   spawn shippers `isolation: "isolated"`). The parameter no longer exists;
   the hazard is now universal.

   ```
   memory_forget({ type: "lesson", id: "137e55fe" })
   memory_remember({ type: "lesson", category: "loom-orchestration", rule: "In T3 workstreams (pull 9 onward) EVERY child shares the orchestrator's worktree; there is no isolation parameter and no per-child branch. Never switch branches, stash, reset or rebase in the orchestrator worktree while any child is active (check `git branch --show-current` and the board first), give concurrent coders disjoint files or sequence them with blockedBy, and expect a shipper child to move the shared tree's branch while it ships." })
   ```

5. `99c049a4` (loom-slack-bridge — children spawned `isolation: "isolated"`
   from a production-cwd root fall back to the production cwd).

   ```
   memory_forget({ type: "lesson", id: "99c049a4" })
   memory_remember({ type: "lesson", category: "loom-slack-bridge", rule: "/home/Carl/loom-slack-bridge is the PRODUCTION checkout: the live systemd daemon runs from it and deploy agents fast-forward it to origin/master and restart. A thread whose cwd is that directory (e.g. a goal-handoff root) must never edit it, and since pull 9 every child it spawns shares that same cwd — so before any code work there, move the whole workstream onto a git worktree (e.g. /home/Carl/loom-slack-bridge-worktrees/<branch>) on a feature branch, or hand the work off with mcp__t3-code__goal_handoff so it gets its own worktree." })
   ```

6. `7d900851` (orchestration — rotate long-running workers; names
   `consult_thread`).

   ```
   memory_forget({ type: "lesson", id: "7d900851" })
   memory_remember({ type: "lesson", category: "orchestration", rule: "Rotate long-running worker threads before they approach context limits: after ~6-8 substantial rounds in one coder/reviewer session, retire it (its on-disk record is the handover) and spawn a fresh thread, rather than forcing more rounds in. Signals: mcp__t3-code__consult_thread forks timing out, very long session. Keep per-round records (BUILD.md, ledgers) precisely so rotation is cheap." })
   ```

7. `edc58581` (loom-operations — recovering a thread whose workstream calls
   401; names `notify_thread`, `request_attention`,
   `T3_WORKSTREAM_AUTHORIZATION`, `state.sqlite`, `provider_session_runtime`).
   Every mechanism it names is V1's. Pull 9 issues the credential through
   upstream's MCP registry (`T3_MCP_BEARER_TOKEN`), the database is
   `statev2.sqlite`, and the process/session tables are upstream's. The
   procedure is unverified on V2 — propose **forget**, and let a V2 incident
   write the new one.

   ```
   memory_forget({ type: "lesson", id: "edc58581" })
   ```

8. `5ea51165` (workflow — walked-through example before a product decision;
   names `ask_user_question`).

   ```
   memory_forget({ type: "lesson", id: "5ea51165" })
   memory_remember({ type: "lesson", category: "workflow", rule: "Before putting a product/UI-surface decision to Carl (mcp__t3-code__ask_user_question or prose options), first produce a walked-through example document (MDX/HTML) that names each surface for a reader who doesn't know it (e.g. \"DI = Document Intelligence tenants grid\") and shows one real tenant's data before/after per option. Dense option lists without that context get bounced." })
   ```

9. `d37f8791` (workstream — codex first-turn deaths; "gate.rework is
   spawn-time only"). No bare name; the mechanism statement still holds under
   pull 9 (a gate is declared at spawn/scaffold). **No change.** Listed so the
   parent knows it was checked.

Checked and unchanged (no Loom tool named, no V1-only fact): `52a2fb22`,
`ef12b741`, `f283e05f`, `a68f6ebf`, `fe05a1fe`, `2efa1e1a`, `0f4cb41c`,
`166746b0`, `511cb499`, `79d6070c`, the three `git stash` lessons.
