## 8. Pre-rulings

### 8.1 Questions for Carl

**No row.** Nothing this week changes a host, a Carl rule, a product default
or a tool a Loom role sees; the one structural seam (§4) has one sound answer
(keep upstream's pruning, carry Loom's guard) and the toolchain change needs
nothing from him. Two product changes that upstream ships and Loom takes as
shipped are listed in §8.3 so he can rule on them after S4 has shown them;
neither blocks S1 and a different ruling on either is one marked line.

| # | Decision | Options and what Carl experiences | Recommendation | Ruling |
| --- | --- | --- | --- | --- |
| | (none) | | | |

### 8.2 Pre-rulings the runbook carries (not questions)

- **Loom's history guard moves into upstream's two prune passes** (§4.3):
  one marked `WHEN` in `pruneEvents`'s `prunable` CASE and one marked `NOT IN`
  in `pruneImportedLegacyHistory`'s `imported` expression, both over
  `LOOM_HISTORY_EVENT_TYPES`. S1 writes them while resolving
  `ProjectionMaintenance.ts`; Gate 1 reads them; S2a re-points
  `ProjectionMaintenance.loom.test.ts` and adds the V2 case; S3 counts the
  41,855 rows before and after the cockpit copy's first pass. The projection
  table that retires the guard is a follow-up (§8.3), not merge work.
- **Typecheck is `@effect/tsgo` with `tsconfig.effect.json`'s diagnostics**
  (§5): S2a/S2b/S3 pass `vp run typecheck` (exit 0) under it; a diagnostic
  whose Loom hits exceed a day gets a reasoned per-site off-switch, a DL row
  and a follow-up; the two stale `preferSchemaOverJson:off` switches are
  renamed or removed. `AGENTS.md`'s typecheck sentence is upstream's new one
  (§6.9).
- **Effect 4.1 names in Loom code** (§5.2): `effect/Crypto` → `SecureRandom`/`Digest`
  in the 8 Loom-only files (S2a) and the 4 hunks (S1, Rule E); `NodeCrypto.layer`
  in Loom test layers that need it; `process.env` inside Effect code →
  `HostProcess.Environment` (3 sites); `Data.TaggedError` → `Schema.TaggedError`
  (2); `Effect.succeed(undefined)` → `Effect.void` (4).
- **The snooze guard takes upstream's rule** (§6.2): a pending question no
  longer blocks snoozing; Loom's `hasBlockingPendingRequest` call at that one
  site is superseded and deleted (DL row); its other six sites stay.
- **Lockfile:** take upstream's `pnpm-lock.yaml`, keep Loom's catalog and patch
  lines in `pnpm-workspace.yaml` (hunks 1 and 3) and `minimumReleaseAge: 0`
  (hunk 2, the list copy dropped), regenerate with `vp i` until a pass leaves
  it unchanged (DL-1220). Never hand-merge the 17 hunks. A
  `strictPeerDependencies` refusal is a DL row with its `peerDependencyRules`
  entry.
- **`.repos/effect/.envrc`:** `git rm`; Loom's tree has never carried it
  (§5.1).
- **`builtInDrivers.ts`:** Pi-only (standing); upstream's Kiro, fx and ACP
  registry drivers are not registered; a `knip:check` complaint about
  `provider-kiro` gets a marked workspace entry as `provider-fx` did (DL-1692).
- **`Migrations.ts`:** upstream verbatim (auto-merges). No fork migration this
  pull. 077–080 are additive or drop an index nothing reads (§6.7).
- **Standing settings defaults:** `contextWindowMeterEnabled: true`,
  `autoResumeLimitedThreads: true`, pi enabled by default (DL-84/DL-934; the
  disabled-by-default list gains `kiro`, never `pi`), allow-list model fields
  (DL-913), `followUpBehavior: steer` (DL-1463). New upstream fields
  (`toolCallVisibility: showAll`, `hideTaggedThreads: false`, `hiddenThreadTags: []`,
  the dictation settings) take upstream's defaults.
- **`textGeneration.ts`:** `disableExtensions: false` stays (cliproxy) beside
  upstream's `shortLived: true`; `--offline` is taken (§6.1). DL-1514's
  message stays.
- **Pi orchestration instructions:** still none (DL-905); `mcpExtensionSource.ts`
  is silent this week, `mcpExtensionSource.loom.test.ts` keeps proving it.
- **Tool exposure:** unchanged (DL-990); no tool was renamed or added in the
  withheld toolkits this week (§6.3); `schedule_task`'s new `freshSession`
  input rides the existing SCHEDULING carve-out.
- **Linked-environment and delegated callers cannot reach Loom tools** (pull
  14 §5.2): unchanged; the thread-less scope refusal is the proof.
- **`PreviewView` annotation survives unmount:** Loom's side of hunk 4 over
  upstream's restored cancel effect (DL-1214); upstream's annotation-voice
  state at the other three sites is taken.
- **React Compiler:** no `useMemo`/`useCallback` in web files, no exemptions
  (DL-1273).
- **Effect reasons:** every Loom `useEffect` carries its per-site
  `oxlint-disable-next-line t3code/no-unreasoned-state-sync -- <reason>`
  (DL-1605); no budget file; nothing new this week (Loom's PRs since pull 14
  were linted under the rule).
- **jsdom tests:** Loom's 12-entry `DOM_TEST_ENVIRONMENT_ALLOWLIST` and the
  two `excludeFiles` lines survived the silent merge of `vite.config.ts`
  (verified); `jsdom` stays in `apps/web/package.json` (DL-1301); converting
  the MDX tests to browser tests remains the follow-up (DL-1474).
- **The V1 Loom-history guard** (DL-1300) is this pull's §4; the ruling
  stands in its new form.
- **Rollup ruling** (pull 12 §7.1 row 1, narrowed by DL-1715): upstream's
  indicator for approvals; a Loom child's `ask_user_question` shows in the
  root's chat banner, not the sidebar pill; Loom's badge for Loom-only
  reasons. Unchanged. Loom-flagged children stay in the cold shell via the
  index join (DL-1650; `ShellStream.ts` is untouched this week).
- **Thread search** keeps Loom's index with upstream's surfaces (1065);
  `ThreadSearch.ts` is silent (7 `loom` lines); the new index tests are
  dropped with marked notes (Rule T).
- **Mid-turn messages steer rather than queue** (DL-1463); a `/clear` send
  queues by upstream's design (`freshContext` never steers) and is the one
  exception, upstream's own.
- **Side chats** taken as shipped; Loom children cannot start them (pull 14
  §8.1 row 1). **"Star on GitHub" toast** hidden (DL-1718/DL-1725):
  `useComposerSend.ts` merged silently (8 `loom` lines); Gate 2c confirms the
  marked removal survived. **The cockpit worktrees directory is trusted via
  host config** (DL-1726), not code.
- **Node 26 / pnpm 12** (DL-1509): unchanged.
- **`AGENTS.md` and `README.md` are Loom's files** (§6.9); only rules that bind
  Loom code after this pull are ported from upstream's `AGENTS.md` (the tsgo
  sentence this week; not "Do not run repo-wide checks").
- **Comment-prune collateral:** as before: S1 may delete a Loom narration
  comment whose neighbours upstream deleted; it must not restore anything
  upstream removed.
- **Model-read text:** no role file, addendum or Loom tool prose changes in
  this pull. Upstream's own tool descriptions (`schedule_task`, `request_secret`)
  change as upstream wrote them. `t3-thread://v1/` links still resolve (§6.5
  (b)). Anything found later is a DL row and a Fable follow-up.
- **Files that cannot carry a `// loom:` marker, carried forward** (amended):
  `package.json` (root; Loom scripts), `apps/server/package.json`,
  `apps/web/package.json` (incl. `jsdom`, `zod`), `packages/{shared,client-runtime,provider-pi}/package.json`,
  `evals/package.json`, `third-party-licenses.config.json`,
  `apps/server/src/provider/model-manifest.json`, `apps/web/src/routeTree.gen.ts`
  (regenerate if a route changes; none this week), the three Pi replay
  transcripts, `apps/server/src/provider/agentContextBudget.json` (DL-1654; in
  `unmarkedsweep.allow`). **Added:** `tsconfig.effect.json` only if Loom ever
  edits it (it does not this pull).
- **Quarantine:** untouched.
- **`UPSTREAM_BASE`:** S3 sets it to `3fa57b92a238cdd8e079af925b673b2f99618b98`.

### 8.3 Findings that need no ruling now (recorded so Gate 2 and Carl read them once)

- **Loom's workstream history should become a projection** (§4.4): a
  `loom_thread_history` sidecar written at commit time, backfilled once by a
  fork migration from the rows the guard keeps, every reader moved onto it
  (`LoomStore.history` for the Timeline tab and `/retro`; `scripts/loom-evals/dashboard.py`
  and `gate_escapes.py`, the weekly dashboard's outcome metrics), the guard
  then deleted. A Fable plan after this pull lands and before
  the next; cheaper now than after any pull that loses the guard.
- **No future Loom migration may backfill from old events** (§4.4): the log
  holds a day from the first due pass on the cockpit. The pre-promotion
  snapshot of that deploy is the last full copy of the log; Carl's call
  whether to keep it beyond the usual rotation (For deploy).
- **Copy thread's clipboard text is now a hosted-app URL** (§6.5 (b)):
  `https://app.t3.codes/threads/<env>/<id>`, which pastes as the chip inside
  Loom and opens T3's site outside it (the `t3-thread://v2/` URI it replaced
  was equally inert outside the app). Carl's call after using it: keep, or one
  marked line in the sidebar's copy action to write the `t3-thread://` form.
- **Thread tags hide threads from upstream's lists, not Loom's sections**
  (§6.2): matters only if Carl turns the Labs switch on; a follow-up to read
  `visibleThreadShellsAtom` in `Sidebar.logic.loom.ts` and the graph.
- **The Labs tool-call filter and Loom's cards** (§6.5 (c)): consult cards
  and spliced control rows survive by construction; S4 looks once with
  `hideAll`; a DL row if a Loom card disappears.
- **The compaction hold engages on pi 1.3.0** (§6.1): `sendPrompt` holds every
  `turn_start` and `steer` while `nativeCompacting`, which `compaction_start`
  sets and 1.3.0 emits; only the re-hold of a prompt pi rejected with
  "Cannot submit a prompt while compaction is in progress" waits for pi 1.4.0.
  A held prompt whose turn ended, was interrupted or is stopping is dropped at
  `compaction_end`, and a SIGTERM during a compaction drops the hold: Gate 2b
  reads both against `pendingSteering.ts`. pi 1.5.0 is out; a bump is the
  monthly platform update.
- **The Slack bridge runs on Effect 4.1.2 after the flip** (§5.1); its
  modules are the stable ones; the deploy's bridge restart is the check.
- **Pull 14's open follow-ups did not become merge work:** consult cards
  folding in runs over 150 tool calls (Gate 2c B1), `link_pull_request(s)`
  prose for Loom children (Gate 2a B1), the composer model picker's fixed
  height (DL-1716; `ProviderModelPicker.tsx` changed upstream, Loom's
  `ModelPickerContent.tsx` did not), the fast-mode draft-pick edge (DL-1720;
  `composerDraftStore.ts` and `shared/model.ts` both changed and merged
  silently, Gate 2c reads them), jsdom MDX tests → browser tests (DL-1474),
  `scripts/build-npm-launcher.ts`'s migration head (untouched by both sides).
- **`loom-migrate` copies, not replays** (§4.2), so a pruned tree still
  moves; its per-thread event counts are smaller and still equal across
  `verify`.
- The three scheduled tasks on the cockpit and their 080 modes are in §6.3.
