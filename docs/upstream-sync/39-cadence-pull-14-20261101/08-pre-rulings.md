## 8. Pre-rulings

### 8.1 Questions for Carl

**No row has to be answered before S1 starts.** The one row below is a product
choice whose recommended answer is doctrine (take upstream's feature as
shipped); S1 and S2 proceed on it, and a different ruling changes a handful of
marked lines in S2b.

| # | Decision | Options and what Carl experiences | Recommendation | Ruling |
| --- | --- | --- | --- | --- |
| 1 | **Upstream's side chats arrive beside Loom's query threads and `/handoff` drafters** (§5.3) | **(a) Take side chats as shipped.** The composer gains `/side` and `/btw`, the right panel's **+** menu gains **Side chat** (a tab with its own composer and **Bring back**), thread details list a thread's side chats, mobile lists them above the composer. Loom's **Query** on a plan block, **Promote**, `/handoff`, `/retro` and the side-thread sub-rows are unchanged. Two ways to talk beside a thread, with different return paths (into the thread vs onto the document). Zero merge cost; the sidebar nesting stays Loom's. **(b) Hide the side-chat entry points** (the two slash items, the + menu entry, the details row, the mobile row): marked exclusions in five upstream files that change weekly; nothing new for him; permanent fork surface. **(c) Converge in a follow-up:** mark Loom's query threads `lineage.sideChat` so they inherit the pane, bring-back and list hiding; not merge work, a Fable plan | **(a)**, and record (c) as a follow-up to assess once he has used side chats for a week | |

### 8.2 Pre-rulings the runbook carries (not questions)

- **The cold-shell index carries Loom's keep rule** (§4.3): `listActiveShellIndex`
  gains a marked `LEFT JOIN loom_thread_workstream` with `loom_keep` and
  `loom_goal_id`; `shellSubscriberThreadIds` gains `keepsLoomEntryInColdShell`;
  the two `…With` filters keep pull 13's clauses. S2a; Gate 2a; S3 timing; S4
  journey. If the join measurably slows the index read on the cockpit copy
  (S3 compares before and after), the fallback is a second read of the
  sidecar's keep set inside the same transaction, unioned into the id list.
- **Effect reasons, not budgets:** every Loom `useEffect` in lint scope gets a
  per-site `oxlint-disable-next-line t3code/no-unreasoned-state-sync --
  <reason>` (56 sites, §6.8); no file-level disable, no allowlist; an effect
  the rule's alternatives cover in a line or two is removed instead. S2b.
  `scripts/effect-budget.json` is deleted with upstream (UD) and its
  `unmarkedsweep.allow` entry goes.
- **`ask_user_question` answers keep their one Loom rule** (§6.1): upstream's
  hoisted validation (multi-select included) replaces `loomAskAnswer`;
  `loomAskTakesAnswer`'s single marked line is re-homed into the message
  branch so a live waiter still takes the answer as its tool result and no
  duplicate chat message posts. S1; Gate 1 reads; S4 journey.
- **`SCHEDULING` loses `update_scheduled_task`** (§5.1); Loom's
  `writesWithCapability` moves to `schedule_task`'s update arm and
  `delete_scheduled_task`; `registration.test.ts` follows. S1 for the handler
  conflict, S2a for the lists and tests.
- **Lockfile:** take upstream's `pnpm-lock.yaml`, keep Loom's catalog and patch
  lines in `pnpm-workspace.yaml`, regenerate with `vp i` until a pass leaves
  it unchanged (DL-1220). Never hand-merge the 31 hunks.
- **`builtInDrivers.ts`:** Pi-only (standing); upstream's `fx` and ACP
  registry drivers are not registered.
- **`Migrations.ts`:** upstream verbatim (auto-merges). No fork migration this
  pull. 074 no-ops on the cockpit and is undone by 1065 on a fresh home (§6.6);
  S3 proves both.
- **Standing settings defaults:** `contextWindowMeterEnabled: true`,
  `autoResumeLimitedThreads: true`, pi enabled by default (DL-84/DL-934),
  allow-list model fields (DL-913), `followUpBehavior: steer` (DL-1463, now
  upstream's own default). New upstream fields (`snoozePresets`,
  `linkedEnvironmentsEnabled: false`, `managedPolicy`) take upstream's
  defaults.
- **`textGeneration.ts`:** `disableExtensions: false` stays (cliproxy); DL-1514's
  message stays.
- **Pi orchestration instructions:** still none (DL-905); `mcpExtensionSource.ts`
  silently merged (17 `loom` lines), `mcpExtensionSource.loom.test.ts` keeps
  proving it.
- **Tool exposure:** unchanged (DL-990); the three `t3_environment_*` tools,
  `preview_act`, `t3_queue`, `t3_pending_request`, `t3_thread_transfer` are
  withheld by construction; `link_pull_requests`/`unlink_pull_requests` are
  resident for orchestrator and shipper by construction. `capabilities.test.ts`
  and `families.test.ts` name the new tools where they enumerate (S2a).
- **Linked-environment callers cannot reach Loom tools** (§5.2): the thread-less
  scope refusal is the proof; no new check.
- **`PreviewView` annotation survives unmount:** Loom's side of hunk 5 over
  upstream's restored cancel effect (pull 12 §5.3, DL-1214).
- **React Compiler:** no `useMemo`/`useCallback` in web files, no exemptions
  (DL-1273).
- **jsdom tests:** Loom's 12-entry `DOM_TEST_ENVIRONMENT_ALLOWLIST` stays in
  `vite.config.ts` with the two `excludeFiles` lines re-added, marked
  (DL-1474); `jsdom` stays in `apps/web/package.json` (DL-1301); converting
  the MDX tests to browser tests remains the follow-up.
- **`serverSettings.ts` memo:** upstream's `materialized`/`secretWriteGeneration`
  replaces Loom's memo (doctrine §4.3); Loom's embedder-key redaction stays.
- **The V1 Loom-history guard in `ProjectionMaintenance.ts`** (DL-1300)
  survives (Rule A); S3 counts history rows before and after the first
  compaction.
- **Rollup ruling** (pull 12 §7.1 row 1): upstream's indicator for approvals
  and questions, Loom's badge for Loom-only reasons. Unchanged; §4 exists to
  keep it true on a cold connect.
- **Comment-prune collateral:** as before: S1 may delete a Loom narration
  comment whose neighbours upstream deleted; it must not restore anything
  upstream removed.
- **Model-read text:** no role file, addendum or tool prose changes in this
  pull. Nothing this week requires one (§5.1); `t3-thread://v1/` links still
  resolve (§6.4). Anything found later is a DL row and a Fable follow-up.
- **`AGENTS.md` and `README.md` are Loom's files** (§6.10); only rules that
  bind Loom code after this pull are ported from upstream's `AGENTS.md`.
- **Files that cannot carry a `// loom:` marker, carried forward** (amended):
  `package.json` (root; Loom scripts), `apps/server/package.json`,
  `apps/web/package.json` (incl. `jsdom`, `mermaid` DL-1470, `zod`),
  `packages/{shared,client-runtime,provider-pi}/package.json`,
  `third-party-licenses.config.json`, `apps/server/src/provider/model-manifest.json`,
  `apps/web/src/routeTree.gen.ts` (regenerate if a route changes; none this
  week), the three Pi replay transcripts, `apps/server/src/provider/agentContextBudget.json`
  (DL-1654; added to `unmarkedsweep.allow` by S3). **Removed:** `scripts/effect-budget.json`
  (gone upstream; its entry leaves `unmarkedsweep.allow`).
- **Quarantine:** untouched.
- **`UPSTREAM_BASE`:** S3 sets it to `fa31b66bbb2ae5234205a8628a78e038d917202f`.

### 8.3 Findings that need no ruling (recorded so Gate 2 reads them once)

- Side chats and Loom side threads are different features (§5.3). Follow-up
  candidate: make a query thread a `lineage.sideChat` fork so it gets
  upstream's pane and bring-back; or leave Loom's document anchoring as is.
  Not merge work.
- The delegated-task reactor and the linked-environment work are inert for
  Loom children (§5.2); a linked caller is refused by `requireWorkstreamCaller`.
- `t3 service`/self-update's downgrade preflight reads only upstream's ledger
  (§6.1); Loom's 1001+ ids cannot trip it.
- Managed policy is absent on the cockpit; Loom's defaults sit where
  upstream's do (§6.1).
- `thread.interrupt.unresponsive` and Force stop reach Pi through upstream's
  adapter interface; Gate 2b reads `adapter.ts`'s interrupt path, S4 stops a
  running pi child via `workstream_stop` (§6.1).
- Bounded history pages may show Loom's spliced rows above the first loaded
  page (§6.1); S4 opens a long root and looks; a DL row if it does.
- Upstream's `v2` thread-link form (`t3-thread://v2/<env>/<id>`) exists; Loom's
  addendum still says `v1`, which resolves to the message's environment and
  is right for a one-environment cockpit. No change.
- `providerClients.ts` is the one place both clients read the driver list now;
  Loom's "pi leads" moves there once (Appendix D).
- The `micromark`/`mdast-util-to-hast` patches are performance-only; S2b's
  `/preview` MDX pass covers Loom's pipeline.
- Upstream's `vite.config.ts` lint-staged hook now lints and runs `knip:check`
  on commit; Loom already runs knip in CI (#50e93ca7's fix).
