---
manager_sessions:
  - id: 01a12ff8-4a9b-73c8-bb19-a5e145f40994
    name: Pull 10 S0/S1 — runbook and merge
    role: plan
    authored_at: 2026-10-12T11:57:18.000Z
---

# 35 — Cadence pull 10 (base `9bd1d8009a` → v0.0.46-nightly `58d253231d`, 2026-10-12)

**Status: S0 and S1 done — merge commit `09fd6b3e96` (second parent `58d253231d`); awaiting Gate 1.** This is the
runbook for pull 10, written in doc 27's shape from the approved and reviewed
plan `plans/upstream-pull10-strategy/plan.mdx` (Carl signed it off on 12
October). Where this document and the plan disagree, the plan wins unless a
decision-log row below records the departure. Session records append to the
end of this file. The clean-overlap review goes in `35-clean-overlap-review.md`.

---

## 0. Headline

Pull 10 is a **routine single-pass cadence pull** in the shape of pull 8 (doc
27): one branch, one merge commit with `upstream/main` `58d253231d` as its
second parent, sessions with a definition of done each, and a decision log
coders append to. Upstream has shipped 554 commits since pull 9's base
`9bd1d8009a`. The merge produces 104 conflicted paths and 192 conflict markers
(re-measured in S0; §3).

It is more than a textbook pull for two reasons:

1. **One structural move.** Upstream moved every provider, Pi included, into its
   own `packages/provider-*` package, and the shared adapter machinery into
   `packages/provider-core`. Git followed the renames, so the conflicts appear
   at the new paths, but Loom's 23 Loom-only Pi modules still live under
   `apps/server` and must move with it (§3.2). This is a relocation of code that
   is already dependency-inverted, not a redesign.
2. **Four places where upstream now expresses functionality Loom built its own
   way.** Carl took upstream's mechanism for three of them (Pi usage reading,
   thread links, pull-request listing). The fourth, upstream's on-demand tool
   discovery, is prototyped and adopted only if it meets the five criteria in
   §7. S1 keeps today's direct exposure.

## 1. Topology and invariants

- **Branch:** `t3/plan-t3code-upstream-pull` (this worktree's branch; DL-900).
  It already carries the plan commits. The plan's `t3code/upstream-sync-20261012`
  name is not used.
- **First parent of the merge:** the branch tip after S0 (this runbook commit),
  which contains `origin/main` `bf87a2c81d` merged in by a merge commit (DL-901).
- **Second parent:** `upstream/main` pinned at
  `58d253231d83f669a2cdfefa5fe479751d22c582` (DL-902).
- **Never rebased.** The branch carries a merge commit; it is landed with
  `pnpm ship --merge-only`. If `origin/main` moves again, S3 merges it in.
- **Merge command:** `git -c rerere.enabled=false -c merge.renameLimit=30000 merge --no-commit --no-ff upstream/main`.
- **Migration lanes:** `apps/server/src/persistence/Migrations.ts` ends
  byte-identical to upstream's (upstream adds 059–061). Loom's lane is
  1001–1055 in `LoomMigrations.ts`. No contact.
- **Every Loom hunk in an upstream file carries `// loom:`.** The `pnpm ship`
  gate enforces it (`docs/upstream-sync/pull7-tools/unmarkedsweep.sh`).
- **Never `git stash`; never switch branches; never reset another thread's work.**

## 2. Departures from doc 27's shape

- One merge on one branch, as in pull 8 — not pull 9's phases.
- The structural prelude (§3.2) is folded into S1: the Loom-only Pi modules move
  into `packages/provider-pi` in the same merge commit, because a package cannot
  reach back into `apps/server/src` and the merged tree would otherwise carry
  dangling relative imports.
- Typecheck is observed in S1, not gated. Upstream switched to `tsc-rs`, so the
  first count decides whether S2 is re-planned into more tracks.

## 3. Surface sizing, by zone (re-measured in S0)

Measured on this branch at `ae7e817b6d` (`origin/main` `bf87a2c81d` merged in)
against `58d253231d`, merge-base `9bd1d8009a`, with pull 9's `remeasure.sh`
(`THEIRS=58d253231d…`). Captures: `.artifacts/pull10-remeasure-s1/`
(gitignored). The plan's captures are `.artifacts/pull10-measure/`.

| Item                                  | Plan (`0fdf508c3f`) | S0 re-measure (`ae7e817b6d`) | Delta explained                                                                                                |
| ------------------------------------- | ------------------: | ---------------------------: | -------------------------------------------------------------------------------------------------------------- |
| Conflicted paths                      |   104 (99 UU, 5 UD) |            104 (99 UU, 5 UD) | identical path set                                                                                             |
| Conflict markers                      |                 191 |                          192 | +1 in `apps/web/src/components/Sidebar.tsx` (2 → 3): PR #369 (agent-started threads in the sidebar) touched it |
| Files with a dangling relative import |  43 / 97 specifiers |           42 / 95 specifiers | one fewer pre-existing test fixture (`-/-` 4 → 3)                                                              |
| `loom:` lines in conflicted files     |                 644 |                          659 | PR #369's sidebar hunks                                                                                        |

### 3.1 Conflicted paths by zone

| Zone                                                                |   Files | Markers | `loom:` lines |
| ------------------------------------------------------------------- | ------: | ------: | ------------: |
| D — upstream deletions Loom modified                                |       5 |       0 |            12 |
| client-runtime                                                      |       1 |       1 |             9 |
| contracts                                                           |       5 |      11 |            50 |
| lockfile / config                                                   |       6 |      18 |             2 |
| server core (orchestration-v2, ws, server)                          |      16 |      24 |           151 |
| server other (incl. provider-pi / provider-core at their new paths) |      27 |      55 |           141 |
| server provider registry / mcp tests                                |       6 |      22 |            22 |
| shared                                                              |       1 |       1 |             3 |
| web chat                                                            |      10 |      18 |           118 |
| web panels / settings / other                                       |      22 |      34 |           103 |
| web sidebar                                                         |       5 |       8 |            48 |
| **total**                                                           | **104** | **192** |       **659** |

Appendix B lists every path.

### 3.2 Structural prelude: Loom's Pi code moves into `packages/provider-pi`

Upstream extracted Pi into `@t3tools/provider-pi` (exports `./server`,
`./server/usage`, `./settings`, `./client`) and the shared adapter machinery into
`@t3tools/provider-core` (one export per module). Loom's Pi integration is
already dependency-inverted: the adapter reads a `LoomPiAdapterHooks` Context tag
with a passthrough default, and `apps/server/src/loom/serverLayers.ts` provides
the live implementation. The move:

| Path                                                                 | Change   | Note                                                                                                                                                       |
| -------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/provider-pi/src/server/loomAdapterHooks.loom.ts`           | renamed  | from `apps/server/src/provider/Drivers/Pi/` — the hooks tag, shape and passthrough; `makeProviderFailure` now from `@t3tools/provider-core/server/failure` |
| `packages/provider-pi/src/server/piThreadForkCut.loom.ts`            | renamed  | from `orchestration-v2/Adapters/`                                                                                                                          |
| `packages/provider-pi/src/server/bundledPi.loom.ts`                  | renamed  | resolves the bundled patched pi; `@earendil-works/pi-coding-agent` becomes a provider-pi dependency (+ catalog entry)                                      |
| `packages/provider-pi/src/server/SessionIdSanitiser.loom.ts`         | renamed  | its test moves with it                                                                                                                                     |
| `packages/provider-pi/src/server/provenance.loom.ts`                 | added    | `labelledForModel` from `apps/server/src/loom/prompt/provenance.ts` — or the whole module moves if nothing else in `apps/server` needs it                  |
| `packages/provider-pi/src/settings.ts`                               | modified | the two Pi hunks from `contracts/settings.ts`: enabled defaults on (DL-84); bundled-binary description (DT-49)                                             |
| `packages/provider-pi/package.json`                                  | modified | subpath exports for `apps/server`'s Loom consumers (`consult.ts`, `piOneShot.ts`, `consultTracker.ts`, `loomExtension.ts`, `serverLayers.ts`)              |
| `packages/contracts/src/orchestrationV2.loom.ts`                     | modified | `LoomOpenSessionFields` moves here so provider-core's `ProviderAdapter` and provider-pi's `mcpInjection` can name it                                       |
| `apps/server/src/provider/Drivers/Pi/piQuotaClassifier.loom.ts`      | modified | stays in `apps/server`; only its result types are referenced by the hooks shape — move the types, not the classifier                                       |
| `apps/server/src/provider/Drivers/Pi/loomExtension.ts`               | modified | stays; imports the extension-source helpers from `@t3tools/provider-pi/server/mcpExtensionSource`                                                          |
| `apps/server/src/loom/serverLayers.ts`                               | modified | imports the hooks tag from `@t3tools/provider-pi`                                                                                                          |
| `apps/server/src/orchestration-v2/Adapters/PiAdapterV2.loom.test.ts` | renamed  | to `packages/provider-pi/src/server/adapter.loom.test.ts`, with the other Pi tests                                                                         |

The Loom-only files in `apps/server/src/loom/` and `orchestration-v2/*.loom.test.ts`
that import `IdAllocator.ts`, `ProviderAdapter.ts`, `RandomUuid.ts`,
`Notification.ts`, `ProviderFailure.ts` or `TextGenerationPrompts.ts` by relative
path become `@t3tools/provider-core/server/<module>` imports. `dangling.py`
reports zero outside `quarantine/` when it is done. (Pull 9's `zones.py` labels
these files "X-detach seed / Q"; in pull 10 they are re-pointed, not
quarantined.)

## 4. Upstream change digest

The full table is the plan's "What upstream shipped, and where it meets Loom".
In brief: provider packages and Effect service conventions (structural
re-home); twelve Pi adapter fixes (take all); usage readers per driver
(**supersedes** Loom's Pi parser — ruled); thread links `t3-thread://v1/<id>`
(**supersedes** — ruled); source-control packages and the GitHub API
(**supersedes the mechanism** of Loom's repo-wide PR listing — ruled); auth
scopes and hosted MCP agents (re-apply seams; Loom's hand-registered toolkit
keeps its own authorisation); find in thread and the Markdown pipeline move to
`packages/shared/src/markdownLinks.ts` (textual re-apply); thread lifecycle and
capped continuations (take upstream, drop Loom's redundant default flip); PR UX,
web UX, settings per provider package, `tsc-rs` and Effect 4.0.2, mobile,
desktop and Muse (take verbatim; registry stays Pi-only).

## 5. Per-zone resolution doctrine

Doctrine §4.3 (`docs/upstream-sync/05-strategy.md`): where upstream now expresses
the same functionality, upstream's mechanism is the baseline and Loom's variant
is deleted. Otherwise upstream wins verbatim and Loom's seam is re-applied on top
behind `// loom:`.

**Protected — Loom must win or be hand-interleaved:** the Pi driver's Loom hooks
(quota classification, session-id sanitising, steer stash, thread-fork cut,
per-turn spend, the bundled patched `pi`); the workstream MCP toolkit's
registration on the bridge; `builtInDrivers.ts` (Pi-only registry); Loom's
thread-mention chips (until S2b's switch); the file-chip and artefact viewer in
previews; the Pi-first settings defaults; the sidebar seams; `Orchestrator.ts`'s
Loom hunks; `RestartContinuation.ts`'s steer-stash hunk; `model-manifest.json`.

**Upstream wins verbatim:** `Migrations.ts`, `pnpm-lock.yaml` (regenerated),
mobile, desktop, marketing, the new `packages/provider-*` and
`packages/source-control-*` beyond Loom's seams, and the three supersessions'
upstream sides.

## 6. Pre-rulings

### 6.1 Carl's rulings (12 October)

Carl answered the six questions this plan put to him on 12 October. They are
pre-rulings for the runbook: coders resolve against them without stopping.

| Decision                                | Ruling                                                                                                                                                                             | What it means for S1 and S2                                                                                                                                                                                                                          |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape of the pull                       | Single pass on one branch, one merge commit (accepted as recommended)                                                                                                              | The five sessions and two reviewer gates below; no separate relocation pull                                                                                                                                                                          |
| Pi usage on the Usage page              | Upstream's Pi usage reader replaces Loom's parser (accepted as recommended)                                                                                                        | `apps/server/src/usage/usageTranscripts.ts` (+test), `piSessionIdFromPath` and Loom's hunks in `usageTranscriptReader.ts` / `UsageService.ts` go. Loom's cli-proxy account source and last-good-reading carry-forward stay                           |
| Thread links                            | Adopt `t3-thread://v1/<id>` outright; old `thread://` text becomes a plain link (accepted as recommended)                                                                          | S2b switches the composer @-mention, the `ChatMarkdown` chip and `verifiedFileChips.tsx` to upstream's `threadLinks.ts` and `MarkdownThreadLink.tsx`; S2a switches tool prose (`consult_thread`, the addendum) to the new form. No legacy parser arm |
| Repo-wide pull-request listing          | Port it onto the GitHub API client in `packages/source-control-github` (accepted as recommended)                                                                                   | S2a adds one Effect method beside upstream's per-branch listing; `VcsStatusBroadcaster.ts` and `GitVcsDriverCore.ts` consume it                                                                                                                      |
| How Loom's tools are shown to Pi agents | Prototype upstream's on-demand discovery and adopt it only if it performs well; Carl expects role prompts to need little change, because an agent can search for the tool it needs | Interim pre-ruling for S1: every tool Loom lists stays **direct**, so the merge compiles and behaves as today. The section "Tool exposure: prototype, then adopt or reject" holds the experiment and its criteria                                    |
| Landing                                 | Merge as soon as the gates are green; Carl verifies on the deployed instance — annotated "dependent on the tool-exposure outcome"                                                  | No human pairing gate. The shipper merges once every automated gate is green, the agent-run smoke included, and only after the tool-exposure verdict is in. Interpretation in "Landing" below                                                        |

### 6.2 Pre-rulings the runbook carries (not questions)

These follow from doctrine, pull 9's rulings or Carl's rulings above; the runbook lists them so S1 resolves without stopping.

- **Tool exposure (interim):** in `packages/provider-pi/src/server/mcpExtensionSource.ts`, every tool the bridge registers under the `mcp__t3-code__` prefix gets `exposure: "direct"` — one `// loom:` line on the `exposure` expression next to upstream's `directTools`. Loom's role profile and `enable_toolset` keep deciding which tools are active, exactly as today. Upstream's `hidden` arm for the `mcp__t3_code__` alias stays. The prototype may replace this line later; S1 does not wait for it.

- **Lockfile:** take upstream's `pnpm-lock.yaml`, re-add Loom's dependencies, regenerate; never hand-merge the 12 hunks.
- **`builtInDrivers.ts`:** registry stays Pi-only (standing ruling since pull 7; Muse joins the other dormant drivers). `ProviderRegistry.test.ts` expectations follow.
- **Continuations:** upstream's cap-and-default-on replaces Loom's default flip in `contracts/settings.ts`; Loom's rule-0 veto in `Orchestrator.loom.ts` stays because it expresses a workflow rule upstream has no equivalent for.
- **Settings seam:** `settings.loom.ts` and its re-exports stay exactly as they are; only the two Pi hunks move to the provider package.
- **`Migrations.ts`:** upstream's side verbatim; it must not conflict (it does not).
- **Keybindings:** the two "lost" exports are re-exports from `@t3tools/shared/keybindings`; no action beyond confirming the re-export line survives.
- **`AGENTS.md`:** auto-merged; S1 reads the merged result once for the known Loom-supersedes-upstream bullets (repo-wide checks, PRs).
- **Quarantine:** untouched; its deletion remains pull 9's open tail and is not folded into this pull.
- **Model manifest:** Loom's rollover is ahead of upstream's; keep Loom's `model-manifest.json` (allow-listed).

## 7. Tool exposure: prototype, then adopt or reject

The prototype (node P) runs after Gate 1 in its own throwaway worktree
`/tmp/pull10-exposure` and compares three arms (direct baseline, all deferred,
role-resident direct) on six journeys. The brief, arms, journeys and run counts
are the plan's section "Tool exposure: prototype, then adopt or reject". The
adopt criteria and the text-change path are carried here verbatim.

### 7.1 Adopt or reject

An arm is **adopted** only if it meets all five:

1. **No missed submit.** Every run of the submit journey succeeds, on Opus and on Sonnet.
2. **No forbidden reach.** No run of any journey calls a withheld tool, or calls `ask_user_question` on a thread nobody has written to.
3. **Reliability no worse.** Each other journey succeeds in at least four of five runs, and never below the baseline's count. No failure leaves wrong state behind, such as a side-effecting wrong tool or a child spawned without a brief.
4. **Cost no worse.** Median extra turns per journey is at most one over the baseline. Median total tokens per journey is at most 10% over the baseline; the expected direction is lower.
5. **Prompts barely change.** Role prompts pass unchanged, or need one small text change that a re-run of the failing journeys then passes. Who may author that text is set out below.

### 7.2 The text-change path

**The text-change path.** If an arm meets criteria 1–4 except for failures caused by prompt text, P returns a **conditional verdict** naming the failures and the text at fault. The Fable prose child then writes the change in P's worktree. Next, P, or a fresh researcher child if P has finished, re-runs every failing journey five times on the changed text. Failure modes caused by text that still names `enable_toolset` are the likely case. A re-run that meets all five criteria turns the verdict into an adoption. A failed re-run, or no Fable quota to write the change, means **reject**. Nothing is adopted on text that nobody measured.

If both deferred arms qualify, **all deferred** wins: it leaves less Loom machinery and matches upstream. Otherwise the qualifying arm wins. If neither qualifies, the verdict is **reject** and direct exposure ships. An inconclusive result counts as reject, so the merge is never held for a judgement call. The journey table and failure log go to the runbook's decision log either way, and a rejected result becomes a follow-on task carrying its evidence.

Model-read text (role files, the addendum and tool prose) is authored only by a
Fable child started after the 07:00 / 08:00 weekly resets; Opus sessions never
author it (plan, "Who may write the text models read").

## 8. Sequencing — sessions, order, definition of done

| Session                                | Delivers                                                                                                                                                                                                                                                                                           | Definition of done                                                                                                                                                                                                            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S0 — substrate                         | This runbook; re-measure; DL-900 onward                                                                                                                                                                                                                                                            | Counts match the plan or the deltas are explained; the runbook is signed                                                                                                                                                      |
| S1 — the merge (one coder, whole tree) | `git -c rerere.enabled=false -c merge.renameLimit=30000 merge --no-commit --no-ff upstream/main`; every conflicted path resolved per its pre-ruling using pull-7 `hx.py`/`sideresolve.py`; `pnpm-lock.yaml` regenerated with `vp i`; the Pi relocation (§3.2); `dangling.py` = 0; one merge commit | `git diff --check` clean, 0 markers, `parsesweep.mjs` clean, `unmarkedsweep.sh` clean vs `main`, every resolution that departed from a pre-ruling is a DL row. Typecheck is observed and recorded, not gated                  |
| Gate 1 — reviewer                      | Read-only review of the merge                                                                                                                                                                                                                                                                      | `clean` / `fixed_inline` / `needs_rework`; includes the `hosted` check                                                                                                                                                        |
| S2a — server track                     | `apps/server`, `packages/provider-*`, `packages/contracts`, `packages/shared`, `packages/source-control-*` typecheck under `tsc-rs`; the usage supersession; the GitHub repo-wide listing on the API; `McpToolAccess` conformance; ws scope rows; the hooks-binding test                           | Owned packages typecheck 0; named Loom tests pass: `LoomMigrations.test.ts`, `PiCwdOverride.contract.test.ts`, `adapter.loom.test.ts`, `registration.test.ts`, `LoomV1WorkstreamImporter.test.ts`, and the hooks-binding test |
| S2b — web track                        | `apps/web`, `packages/client-runtime` typecheck; thread-link scheme switch; file-chip gate re-applied onto `@t3tools/shared/markdownLinks`; `ChatMarkdown` image block re-homed; preview fixtures                                                                                                  | Owned packages typecheck 0; `vp test run` on touched files; a `/preview` screenshot of each re-applied surface                                                                                                                |
| P — tool-exposure prototype            | §7, in `/tmp/pull10-exposure`                                                                                                                                                                                                                                                                      | A verdict with the journey table and failure log; `exposure.patch` on adoption                                                                                                                                                |
| S3 — integrate                         | Fresh install, `vp run typecheck` (33 packages), `vp check`, full tests for server/shared/contracts/provider-core/provider-pi, audits, `UPSTREAM_BASE` = `58d253231d`                                                                                                                              | All green from a fresh install; §9 filled; the clean-overlap list handed to Gate 2                                                                                                                                            |
| Gate 2 ×3                              | Clean-overlap semantic review by zone                                                                                                                                                                                                                                                              | Disposition table per file                                                                                                                                                                                                    |
| Overlap fixes                          | Gate 2 DEFECTs, plus `exposure.patch` if adopted                                                                                                                                                                                                                                                   | Fixes committed                                                                                                                                                                                                               |
| S4 — agent-run smoke                   | The plan's S4 smoke list on a seeded dev-verify instance                                                                                                                                                                                                                                           | Passes on the exposure that will ship                                                                                                                                                                                         |
| Shipper                                | `pnpm ship --merge-only`                                                                                                                                                                                                                                                                           | PR merged, branch deleted                                                                                                                                                                                                     |

## 9. Gate and audit checklist for the end state

- [ ] **markers** — S1: 0 conflict markers, `parsesweep.mjs` clean, `dangling.py` reports 0 outside `quarantine/`
- [ ] **hooks** — S2a writes, S3 runs: a hooks-binding test resolves `LoomPiAdapterHooks` through the layer the server actually gives the Pi driver (`apps/server/src/loom/serverLayers.ts` composed with `PiAdapterV2Driver.create`), and asserts it is not `passthroughLoomPiAdapterHooks`. Today no test does this: `PiAdapterV2.loom.test.ts` passes its own hooks straight to `makePiAdapterV2`
- [ ] **hosted** — Gate 1 checks, S2a tests: a hosted MCP caller with no thread credential is refused by `requireWorkstreamCaller` before any workstream tool runs; S2a adds the test if none exists
- [ ] **typecheck** — S3: `vp run typecheck` green from a fresh install under `tsc-rs` (the new checker is itself a risk — see Risks)
- [ ] **check** — S3: `vp check` 0 errors
- [ ] **tests** — S3: full `vp test` for apps/server, packages/shared, packages/contracts, packages/provider-core, packages/provider-pi; targeted tests in S2a/S2b
- [ ] **sweep** — S1 and S3: `unmarkedsweep.sh` gate clean vs main; `--report` audit recorded for the whole fork vs the new base
- [ ] **lost** — S3: lost-feature audit — `lostdecls.py` and `whatismissing.sh` against the base, every hit adjudicated as a DL row
- [ ] **ledger** — S3: migration ledger — `Migrations.ts` byte-identical to upstream's, `LoomMigrations.test.ts` 25/25, a boot on a copy of the live DB runs 059–061 in `effect_sql_migrations` and nothing in `loom_sql_migrations`
- [ ] **overlap** — Gate 2: clean-overlap semantic review of the 135 silently merged files, doc 29 method (three read-only reviewers by zone), every DEFECT fixed before S4
- [ ] **exposure** — P: the tool-exposure verdict is recorded in the runbook's decision log; if adopted, its journey table meets every adopt criterion on the tree that ships
- [ ] **boot** — S4: boot smoke — a Pi turn completes through the relocated adapter and resumes after a server restart
- [ ] **live** — S4: agent-run smoke on the seeded dev-verify instance (below), on the exposure that will ship; no human pairing

### 9.1 Landing

> **How "dependent on the tool-exposure outcome" is read.** The merge waits for the prototype's verdict. It does not wait for Carl.
>
> - **Adopted:** the adopted arm's journey table, its failure log, and a pass of the S4 smoke on the adopted configuration are part of the green gates. The shipper does not run until they are in the runbook.
> - **Rejected or inconclusive:** direct exposure from S1 ships unchanged. The prototype's evidence is recorded as a follow-on task, and it does not block the merge.
>
> There is another way to read the annotation: Carl wants to see an adopted change himself before it merges. This plan does not take that reading, for two reasons. Carl said he would adopt upstream's approach _if it performs well_, and the adopt criteria are that test written down, so a human pairing step on top would repeat it. And merging is not deploying. Deploying stays a human-initiated act, so Carl still sees an adopted change before it reaches the instance he works on. If the reviewer reads the annotation as a human gate, the fix is one edge: the shipper also waits on Carl's go, but only when the verdict is "adopted".

## 10. Decision log (coders append here)

Numbering starts at DL-900 (pull 9 used DL-80–DL-581 and DL-600–DL-810).

| #      | Area / file                                                      | Situation                                                                                                                                                                                                                                                        | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Why                                                                                                                                                   | Ruling                                                      | Blast radius                                                                                      |
| ------ | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| DL-900 | branch                                                           | The plan names `t3code/upstream-sync-20261012`; the orchestrator's worktree is on `t3/plan-t3code-upstream-pull`, which already carries the plan commits                                                                                                         | Pull 10 runs on `t3/plan-t3code-upstream-pull`; never rebased; landed with `pnpm ship --merge-only`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | One branch per worktree; switching branches in a shared `.git` is forbidden; the plan commits ride along harmlessly                                   | S1 brief                                                    | trivial                                                                                           |
| DL-901 | branch                                                           | `origin/main` moved `0fdf508c3f` → `bf87a2c81d` (PR #369, agent-started threads in the sidebar, migration 1055) after the plan was measured                                                                                                                      | Merged `origin/main` into the branch (merge commit `ae7e817b6d`, not a rebase) before the runbook commit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Doctrine: the sync branch absorbs `main` by merge so the upstream merge sees current Loom                                                             | S1 brief                                                    | trivial                                                                                           |
| DL-902 | target                                                           | `upstream/main` moved one commit past the pin (`5753207d53`, desktop-only Hyprland startup fix, 4 files)                                                                                                                                                         | Target held at `58d253231d`; the next pull takes `5753207d53`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | The plan, its measurements and `UPSTREAM_BASE` all name `58d253231d`; the delta touches nothing Loom carries and adds no value worth re-measuring for | S1 brief                                                    | trivial                                                                                           |
| DL-903 | lockfile / patches                                               | Loom's `@effect/platform-node-shared@4.0.1` patch (stdin `error` listener, #298) vs upstream's bump to 4.0.2 with its own taskkill patch. The 4.0.2 tarball does not carry Loom's fix (checked)                                                                  | Loom's hunk folded into upstream's `patches/@effect__platform-node-shared@4.0.2.patch` (dist + src, `loom:` comment in the patched code); the 4.0.1 patch deleted                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | pnpm takes one patch per version; dropping the hunk would bring back the EPIPE crash                                                                  | S1 judgement (doctrine: keep Loom behaviour upstream lacks) | local                                                                                             |
| DL-904 | provider / `builtInDrivers.ts`                                   | Upstream adds `BUILT_IN_USAGE_DRIVERS` (seven drivers' usage readers) beside the registry                                                                                                                                                                        | Registry stays `[PiDriver]`; the usage-reader list keeps upstream's seven, typed `AnyProviderDriver<unknown, BuiltInUsageReadersEnv>` so the reader-only drivers add no registry env                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Loom's Usage page already read Claude, Codex and Grok transcripts; the Pi-only ruling covers instances, not history readers                           | standing Pi-only ruling                                     | local                                                                                             |
| DL-905 | provider-pi / `mcpExtensionSource.ts`                            | Upstream dropped the generic `promptSnippet`/`promptGuidelines` fallback and added exposure (`direct`/`deferred`/`hidden`)                                                                                                                                       | Interim pre-ruling applied as one `// loom:` line (`"direct"` for every `mcp__t3-code__` tool; the `mcp__t3_code__` alias stays `hidden`). Loom's `_meta` snippet/guidelines re-applied as conditional spreads; tools without `_meta` follow upstream (no generic fallback). The `node:http` import's marker moved to its own line so upstream's `^import .*;$` test strip still matches                                                                                                                                                                                                                                                                      | Pre-ruling; doctrine §4.3 for the fallback                                                                                                            | pre-ruling + doctrine                                       | local                                                                                             |
| DL-906 | provider-pi / `adapter.ts`                                       | `makePiAdapterV2` became an `Effect.fn` that yields its services; upstream dropped the adapter's `$skill` expansion                                                                                                                                              | Hooks resolve as `options.loom ?? (yield* LoomPiAdapterHooks)` inside the adapter, so the driver and layer call sites carry no Loom hunk; Loom's citation expansion now applies to the raw prompt text at the top of `resolvePromptPayload`                                                                                                                                                                                                                                                                                                                                                                                                                   | Smallest re-application on upstream's new shape; the hooks test can still pass hooks directly                                                         | S1 judgement                                                | local — Gate 2: check pi does not read a `$name` inside an expanded citation as a skill           |
| DL-907 | orchestration-v2 / `Orchestrator.ts`                             | Upstream added `readShellSnapshot` (two-phase read that feeds the shell stream) beside `getShellSnapshot`                                                                                                                                                        | Both join `shell.workstream` (`joinLoomShellFields`); on `readShellSnapshot` the join runs in the returned decode step, after the read transaction                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Without it the streamed shell snapshot would carry no workstream fields and the sidebar's workstream seams would go blank                             | S1 judgement                                                | **Gate 1 look**                                                                                   |
| DL-908 | auth / `RpcAuthorization.ts`                                     | Upstream split file reads into `AuthFilesystemReadScope`/`WriteScope`                                                                                                                                                                                            | Loom's out-of-workspace file RPCs (`projectsReadAbsoluteFile`, `projectsListAbsoluteDirectory`, `projectsStatPaths`, `projectsLocateFiles`) take `AuthFilesystemReadScope` beside `projectsReadFile`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Same capability as the workspace read upstream re-scoped                                                                                              | S1 judgement                                                | trivial                                                                                           |
| DL-909 | server / `serverSettings.ts`                                     | Upstream redacts secrets through schema-declared `mapSettingsSecrets`                                                                                                                                                                                            | Loom's embedder-key redaction wraps upstream's result; the key is not declared as a schema secret (so not moved into the secret store)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Smallest re-application; declaring it is S2a's call                                                                                                   | S1 judgement                                                | local                                                                                             |
| DL-910 | assets / `AssetAccess.ts`                                        | Upstream routes favicons through `projectFaviconAsset`                                                                                                                                                                                                           | Its `file` arm carries Loom's `mutable: true`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Loom's `ResolvedAsset` requires `mutable`                                                                                                             | marker convention                                           | trivial                                                                                           |
| DL-911 | checkpointing / `CheckpointService.ts`, `CheckpointDiffQuery.ts` | Upstream adds `listAuthoredPaths` filtering, both over one `refs`/`comparison` object, and moved its ref hash to Effect `Crypto`                                                                                                                                 | Loom's baseline ref feeds the shared object, so the authored-path filter also measures from the Loom baseline; `node:crypto` import restored for `loomBaselineRef`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Keeps the P3-17 baseline semantics on every read of the diff                                                                                          | S1 judgement                                                | local — `nodeBuiltinImport` is now an error (S2a)                                                 |
| DL-912 | contracts+shared / keybindings                                   | Upstream binds `mod+shift+t` to its new `view.reopenClosed` and keeps `mod+w` on `rightPanel.close`; Loom binds them to thread tabs                                                                                                                              | Loom's bindings kept; upstream's `view.reopenClosed` command is registered but unbound by default                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Loom's thread tabs are protected; two defaults on one key would collide                                                                               | S1 judgement                                                | **flag for S2b/Gate 2**: upstream's reopen-closed-view overlaps Loom's tab reopen (doctrine §4.3) |
| DL-913 | contracts / `settings.ts`                                        | Upstream moved model favourites/hidden/order to server settings with granular patch commands                                                                                                                                                                     | Loom's allow-list fields (`selectedModels`, `showOnlySelectedModels`) added to upstream's `ProviderModelPreferences`; the web writes them through the whole-map `providerModelPreferences` patch                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Keeps Loom's model-picker allow-list alive on upstream's storage                                                                                      | S1 judgement                                                | S2b: may want a granular command; tests in shared/server need the fields                          |
| DL-914 | web / `contextMenuFallback.ts`                                   | Upstream adopted the viewport-capped menu height Loom carried, with `100vh` (Loom: `100dvh`)                                                                                                                                                                     | Upstream's                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Doctrine §4.3                                                                                                                                         | doctrine                                                    | trivial                                                                                           |
| DL-915 | terminal / `Manager.test.ts`                                     | Loom deleted upstream's legacy-default terminal-env tests; upstream rewrote them on explicit `providerInstances`                                                                                                                                                 | Upstream's tests taken                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | They resolve through settings, not the Pi-only registry                                                                                               | S1 judgement                                                | trivial                                                                                           |
| DL-916 | provider / `ProviderRegistry.test.ts`                            | Upstream dropped the legacy `providers` settings map                                                                                                                                                                                                             | Loom's retired codex tests stay retired; Loom's ghost-driver and pi-disabled tests move to `providerInstances`/`disabledDefaultSlots`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Legacy map no longer decodes                                                                                                                          | standing Pi-only ruling                                     | trivial                                                                                           |
| DL-917 | provider / `model-manifest.json`                                 | Pre-ruling says keep Loom's; git auto-merged it (Loom's rollover lines plus upstream's restructure: codex `providers` models, muse compatibility)                                                                                                                | Auto-merge kept                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Upstream code reads the new structure; Loom's changed lines survive                                                                                   | departs from the literal pre-ruling                         | **Gate 2**                                                                                        |
| DL-918 | web+mobile / `usageProviders.ts`                                 | Silent merge left duplicate `pi` keys (Loom's first-and-saturated entry and upstream's trailing one)                                                                                                                                                             | Loom's entries kept, upstream's duplicates removed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Duplicate keys are a type error; Loom's presentation is the existing behaviour                                                                        | S1 judgement                                                | trivial                                                                                           |
| DL-919 | provider-pi relocation                                           | The plan's file tree moves `PiAdapterV2.loom.test.ts` into the package                                                                                                                                                                                           | It stays in apps/server (imports `serverLayers`, `pendingSteering`, `controlMessage`, the classifier fixtures — a package cannot reach back). The pure Pi tests moved as `*.loom.test.ts` (rpc, mcpExtensionSource, status, textGeneration, maintenance, provenance, SessionIdSanitiser, piThreadForkCut). Exports: one `./server/loom` barrel (bundled pi, hooks tag, author labels, sanitiser) plus `./server/adapter` (for `PI_PROVIDER`), `./server/rpc`, `./server/mcpInjection`, `./server/mcpExtensionSource`. The classifier's result types moved into `loomAdapterHooks.loom.ts`; only provenance's author-label block moved (the digest lines stay) | Package boundary                                                                                                                                      | departs from the plan's file tree                           | local                                                                                             |
| DL-920 | manifests                                                        | `@earendil-works/pi-coding-agent` now needed by apps/server and provider-pi                                                                                                                                                                                      | Catalog entry `1.1.0`, both use `catalog:`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | One version, one patch                                                                                                                                | plan                                                        | trivial                                                                                           |
| DL-921 | gate / `unmarkedsweep.sh`                                        | The committed `UPSTREAM_BASE` (`9bd1d8009a`) is S3's to advance; against it every upstream change reads as unmarked                                                                                                                                              | Gate evaluated with the base this merge establishes (`58d253231d`, temp copy of the script): clean after marking 8 pre-existing unmarked Loom hunks that crossed the 15-line threshold (mobile `ThreadFilesRouteScreen.tsx`, `SourceControlProviderRegistry.ts`, `SessionStore.ts`, `connection/presentation.ts`, `AnnotatableCodeView.tsx`, `editorPreferences.ts`, `PullRequestDetailPanel.test.tsx`, `filePreviewMode.ts`) and allow-listing three JSON manifests (`apps/server`, `apps/web`, `packages/provider-pi` `package.json`)                                                                                                                       | Same evaluation pull 8 used after its base advance                                                                                                    | S1 judgement                                                | trivial                                                                                           |
| DL-922 | gate / `dangling.py`                                             | Three hits exist identically at the base, on main and upstream: two test files whose fixture strings look like imports (`bundledDev.test.ts`, `pullRequestFileOrder.logic.test.ts`) and a generated-file import in `effect-codex-app-server/scripts/generate.ts` | Excluded as false positives; 0 otherwise                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Not dangling                                                                                                                                          | S1 judgement                                                | trivial                                                                                           |
| DL-923 | gate / `git diff --check`                                        | `.patch` files carry context-line whitespace by format (upstream's `ff-labs`/`pierre` patches too)                                                                                                                                                               | Check run excluding `patches/`: clean                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Patch format                                                                                                                                          | S1 judgement                                                | trivial                                                                                           |
| DL-924 | web / `ChatMarkdown.tsx`                                         | The sanitize schema moved to `shared/markdownPipeline.ts`, which allows upstream's `t3-thread` protocol                                                                                                                                                          | Loom's `thread` href allow not re-added                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Carl's ruling: adopt `t3-thread://v1` with no legacy arm; Loom's `thread://` chips render as plain links until S2b's switch                           | Carl's ruling                                               | S2b                                                                                               |
| DL-925 | web / `FilePreviewPanel.tsx`                                     | Upstream's browser preview can now run on the environment server (`previewAvailable`)                                                                                                                                                                            | Loom's artefact-viewer gate (`!isPreviewSupportedInRuntime()`) kept as is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Textual re-apply                                                                                                                                      | S1 judgement                                                | **flag for S2b/Gate 2**: on web both "Open in browser" and Loom's viewer may now show             |
| DL-926 | web / markdown links                                             | Upstream moved `client-runtime/markdown-links` to `shared/markdownLinks` and `resolvePathLinkTarget` to `shared/fileLinks`                                                                                                                                       | Loom's file-chip gate keeps its own `resolveInlineCodeFileLinkMeta` and adopts upstream's `inlineCodePathNamesFromWorkspaceRoot` base choice; `planDocument.ts` repointed; `loom/unanchoredFileReferences.ts` still imports the old module                                                                                                                                                                                                                                                                                                                                                                                                                    | Textual re-apply                                                                                                                                      | S1 judgement                                                | S2b                                                                                               |
| DL-927 | source control                                                   | `GitHubSourceControlProvider.ts` (+test) deleted per Carl's ruling                                                                                                                                                                                               | Consumers of `listRepositoryChangeRequests` (`VcsStatusBroadcaster`, `GitVcsDriverCore`, `SourceControlProviderRegistry`) left referencing it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | S2a re-expresses the listing on `GitHubPullRequestApi`                                                                                                | Carl's ruling                                               | S2a                                                                                               |
| DL-928 | usage                                                            | Loom's Pi usage parser and hunks                                                                                                                                                                                                                                 | Removed per ruling (`usageTranscripts.ts` +test, `piSessionIdFromPath`, the Pi walk in `UsageService.ts`, the `pi` admission in `usageScanCache.ts`, the Pi tests); `provider/piSessionFiles.ts` stays (`LoomV1WorkstreamImporter` uses it)                                                                                                                                                                                                                                                                                                                                                                                                                   | Carl's ruling                                                                                                                                         | Carl's ruling                                               | trivial                                                                                           |
| DL-929 | provider / `ProviderInstanceRegistryHydration.ts`                | Upstream's env adds `BackgroundPolicy`/`ServerConfig`                                                                                                                                                                                                            | Loom's `Crypto`/`ProviderEventLoggers` additions kept beside them; `ProviderEventLoggers` now from provider-core                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Pi-only registry env                                                                                                                                  | standing ruling                                             | trivial                                                                                           |
| DL-930 | server / `ws.ts`                                                 | Upstream dropped `observeRpcEffect` from `RpcInstrumentation.ts`                                                                                                                                                                                                 | Loom's ws handlers and `loom/wsMethods.ts` still call it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | API drift                                                                                                                                             | —                                                           | S2a                                                                                               |

## 11. Risks

The plan's "Risks" table is authoritative. The ones S1 owns: the Pi relocation
mis-wiring a hook that silently falls back to the passthrough (the hooks gate
catches it later; S1 keeps `serverLayers.ts` providing the live tag); upstream's
deferred exposure hiding Loom's role tools (S1's interim `direct` line); and
`tsc-rs` drift (observed once, below).

## 12. Tooling notes

- Tools: `docs/upstream-sync/pull7-tools/` (`hx.py`, `sideresolve.py`,
  `union.py`, `parsesweep.mjs`, `unmarkedsweep.sh`, `lostdecls.py`,
  `whatismissing.sh`) and `docs/upstream-sync/pull9-tools/` (`remeasure.sh`,
  `classify.py`, `automerged.py`, `dangling.py`, `zones.py`).
- `remeasure.sh` takes `THEIRS=<oid>` to hold the target.
- `pnpm-lock.yaml`: `git checkout --theirs pnpm-lock.yaml`, then `vp i`.
- git 2.56 has `merge-tree --write-tree` for non-mutating sizing.

## Appendix A — reproduce the sizing

```sh
git fetch origin && git fetch upstream
git merge-base HEAD 58d253231d                                  # 9bd1d8009a6b7c50f9dd9458e2bf27d481ff3b43
git rev-list --count 9bd1d8009a..58d253231d                     # 554
THEIRS=58d253231d83f669a2cdfefa5fe479751d22c582 \
  bash docs/upstream-sync/pull9-tools/remeasure.sh .artifacts/pull10-remeasure-s1
#   -> conflicted: 104; by kind: 5 UD 99 UU; markers: 192; dangling: 42 files / 95 specifiers
```

## Appendix B — exact file-to-zone partition (104 files)

Generated by `zones.py` into `.artifacts/pull10-remeasure-s1/zones.md`
(`m` = markers, `L` = `loom:` lines).

### D-upstream-deletion (5)

- `apps/server/src/orchestration-v2/Adapters/piT3McpExtensionSource.test.ts` · 0m · 1L · 58 lines
- `apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts` · 0m · 1L · 518 lines
- `apps/server/src/sourceControl/GitHubSourceControlProvider.ts` · 0m · 4L · 433 lines
- `apps/server/src/usage/usageTranscripts.test.ts` · 0m · 3L · 665 lines
- `apps/server/src/usage/usageTranscripts.ts` · 0m · 3L · 614 lines

### T-client-runtime (1)

- `packages/client-runtime/src/state/shell.ts` · 1m · 9L · 466 lines

### T-contracts (5)

- `packages/contracts/src/composerContext.ts` · 2m · 5L · 310 lines
- `packages/contracts/src/keybindings.ts` · 1m · 3L · 245 lines
- `packages/contracts/src/orchestrationV2.ts` · 1m · 20L · 3610 lines
- `packages/contracts/src/settings.test.ts` · 1m · 7L · 1280 lines
- `packages/contracts/src/settings.ts` · 6m · 15L · 1863 lines

### T-lock/config (6)

- `apps/server/package.json` · 1m · 0L · 71 lines
- `apps/web/package.json` · 2m · 0L · 97 lines
- `packages/client-runtime/package.json` · 1m · 0L · 436 lines
- `packages/shared/package.json` · 1m · 0L · 457 lines
- `pnpm-lock.yaml` · 12m · 0L · 23923 lines
- `scripts/lib/cli-external-packages.test.ts` · 1m · 2L · 361 lines

### T-server-core (16)

- `apps/server/src/auth/RpcAuthorization.ts` · 1m · 5L · 259 lines
- `apps/server/src/cli/project.test.ts` · 1m · 3L · 464 lines
- `apps/server/src/cli/project.ts` · 2m · 3L · 570 lines
- `apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts` · 1m · 2L · 741 lines
- `apps/server/src/orchestration-v2/CheckpointService.ts` · 3m · 8L · 609 lines
- `apps/server/src/orchestration-v2/EffectWorker.ts` · 1m · 2L · 860 lines
- `apps/server/src/orchestration-v2/Orchestrator.ts` · 5m · 53L · 11107 lines
- `apps/server/src/orchestration-v2/ProviderSessionManager.ts` · 1m · 7L · 2149 lines
- `apps/server/src/orchestration-v2/RestartContinuation.ts` · 1m · 2L · 191 lines
- `apps/server/src/orchestration-v2/ThreadSettlementService.ts` · 1m · 9L · 620 lines
- `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts` · 1m · 17L · 904 lines
- `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts` · 1m · 3L · 528 lines
- `apps/server/src/orchestration-v2/testkit/fixtures/provider_thread_resume/pi_transcript.ndjson` · 1m · 0L · 124 lines
- `apps/server/src/orchestration-v2/testkit/fixtures/thread_rollback_after_stop/pi_transcript.ndjson` · 1m · 0L · 274 lines
- `apps/server/src/server.ts` · 2m · 11L · 1095 lines
- `apps/server/src/ws.ts` · 1m · 26L · 4029 lines

### T-server-other (27)

- `apps/server/src/assets/AssetAccess.ts` · 2m · 1L · 970 lines
- `apps/server/src/checkpointing/CheckpointDiffQuery.ts` · 1m · 3L · 276 lines
- `apps/server/src/checkpointing/CheckpointStore.ts` · 1m · 2L · 204 lines
- `apps/server/src/keybindings.test.ts` · 2m · 1L · 735 lines
- `apps/server/src/project/ProjectService.deletion.test.ts` · 1m · 4L · 490 lines
- `apps/server/src/project/ProjectService.test.ts` · 1m · 7L · 851 lines
- `apps/server/src/project/ProjectService.ts` · 2m · 13L · 618 lines
- `apps/server/src/serverSettings.ts` · 1m · 2L · 1324 lines
- `apps/server/src/terminal/Manager.test.ts` · 2m · 4L · 2820 lines
- `apps/server/src/terminal/Manager.ts` · 1m · 5L · 3183 lines
- `apps/server/src/usage/UsageService.ts` · 2m · 4L · 998 lines
- `apps/server/src/usage/usageScanCache.ts` · 1m · 1L · 416 lines
- `apps/server/src/usage/usageTranscriptReader.test.ts` · 1m · 1L · 820 lines
- `apps/server/src/usage/usageTranscriptReader.ts` · 3m · 3L · 469 lines
- `apps/server/src/vcs/GitVcsDriver.ts` · 1m · 2L · 1362 lines
- `apps/server/src/vcs/GitVcsDriverCore.ts` · 1m · 10L · 4620 lines
- `apps/server/src/workspace/WorkspaceFileSystem.ts` · 3m · 1L · 641 lines
- `packages/provider-core/src/server/IdAllocator.ts` · 1m · 5L · 400 lines
- `packages/provider-core/src/server/managedProvider.ts` · 3m · 6L · 383 lines
- `packages/provider-core/src/server/usageLimits.test.ts` · 1m · 2L · 138 lines
- `packages/provider-pi/src/server/adapter.ts` · 11m · 34L · 3140 lines
- `packages/provider-pi/src/server/driver.ts` · 1m · 4L · 202 lines
- `packages/provider-pi/src/server/mcpExtensionSource.ts` · 4m · 10L · 363 lines
- `packages/provider-pi/src/server/mcpInjection.ts` · 2m · 7L · 333 lines
- `packages/provider-pi/src/server/rpc.ts` · 1m · 2L · 490 lines
- `packages/provider-pi/src/server/status.ts` · 2m · 2L · 444 lines
- `pnpm-workspace.yaml` · 3m · 5L · 325 lines

### T-server-provider/mcp (6)

- `apps/server/src/mcp/toolkits/worktree/registration.test.ts` · 2m · 2L · 160 lines
- `apps/server/src/provider/ClaudeCapabilitiesProbe.test.ts` · 1m · 2L · 504 lines
- `apps/server/src/provider/ProviderInstanceRegistryHydration.ts` · 1m · 5L · 200 lines
- `apps/server/src/provider/ProviderRegistry.test.ts` · 12m · 7L · 3385 lines
- `apps/server/src/provider/builtInDrivers.ts` · 3m · 3L · 39 lines
- `apps/server/src/provider/providerInstallation.test.ts` · 3m · 3L · 241 lines

### T-shared (1)

- `packages/shared/src/keybindings.ts` · 1m · 3L · 376 lines

### T-web-chat (10)

- `apps/web/src/components/ChatMarkdown.test.tsx` · 1m · 1L · 975 lines
- `apps/web/src/components/ChatMarkdown.tsx` · 3m · 33L · 3798 lines
- `apps/web/src/components/ChatView.tsx` · 6m · 32L · 11841 lines
- `apps/web/src/components/chat/ChatHeader.tsx` · 1m · 2L · 341 lines
- `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx` · 1m · 9L · 322 lines
- `apps/web/src/components/chat/FileTagChip.tsx` · 1m · 1L · 33 lines
- `apps/web/src/components/chat/MessagesTimeline.logic.ts` · 1m · 6L · 2116 lines
- `apps/web/src/components/chat/MessagesTimeline.tsx` · 1m · 30L · 5562 lines
- `apps/web/src/components/chat/SkillInlineText.tsx` · 1m · 2L · 98 lines
- `apps/web/src/session-logic.ts` · 2m · 2L · 1064 lines

### T-web-panels/other (22)

- `apps/web/src/components/RightPanelTabs.tsx` · 1m · 24L · 1464 lines
- `apps/web/src/components/files/FileMarkdownPreview.tsx` · 1m · 1L · 28 lines
- `apps/web/src/components/files/FilePreviewPanel.tsx` · 4m · 35L · 1502 lines
- `apps/web/src/components/files/filePreviewMode.ts` · 1m · 1L · 41 lines
- `apps/web/src/components/files/projectFilesQueryState.ts` · 1m · 2L · 296 lines
- `apps/web/src/components/pullRequest/PullRequestDetailPanel.test.tsx` · 1m · 0L · 340 lines
- `apps/web/src/components/settings/ProviderInstanceCard.tsx` · 1m · 2L · 1173 lines
- `apps/web/src/components/settings/ProviderModelsSection.tsx` · 2m · 1L · 701 lines
- `apps/web/src/components/settings/ProviderSettingsPanel.environment.test.tsx` · 1m · 4L · 647 lines
- `apps/web/src/components/settings/ProviderSettingsPanel.tsx` · 2m · 2L · 1419 lines
- `apps/web/src/components/settings/providerDriverMeta.ts` · 2m · 1L · 121 lines
- `apps/web/src/components/sidebar/SidebarChrome.tsx` · 1m · 2L · 251 lines
- `apps/web/src/components/usage/UsagePage.tsx` · 1m · 2L · 1304 lines
- `apps/web/src/composer-logic.ts` · 1m · 5L · 354 lines
- `apps/web/src/contextMenuFallback.ts` · 1m · 2L · 516 lines
- `apps/web/src/editorPreferences.ts` · 1m · 0L · 122 lines
- `apps/web/src/index.css` · 2m · 9L · 3005 lines
- `apps/web/src/lib/composerContextRecords.test.ts` · 2m · 3L · 817 lines
- `apps/web/src/markdown-links.test.ts` · 2m · 1L · 552 lines
- `apps/web/src/markdown-links.ts` · 4m · 2L · 472 lines
- `apps/web/src/terminal-links.ts` · 1m · 3L · 259 lines
- `apps/web/vite.config.ts` · 1m · 1L · 325 lines

### T-web-sidebar (5)

- `apps/web/src/components/CommandPalette.tsx` · 1m · 4L · 3572 lines
- `apps/web/src/components/Sidebar.logic.ts` · 1m · 6L · 1448 lines
- `apps/web/src/components/Sidebar.tsx` · 3m · 33L · 5490 lines
- `apps/web/src/routes/__root.tsx` · 2m · 3L · 652 lines
- `apps/web/src/routes/_chat.tsx` · 1m · 2L · 239 lines

---

## Session 1 — merge resolved and committed

**Merge commit `09fd6b3e96`** — first parent `68aa665516` (this runbook), second
parent `58d253231d83f669a2cdfefa5fe479751d22c582`. Run as
`git -c rerere.enabled=false -c merge.renameLimit=30000 merge --no-commit --no-ff 58d253231d…`
(the SHA, because `upstream/main` had moved one commit; DL-902). Committed with
`--no-verify` so lint-staged could not reformat upstream's files; the resolved
files were `vp fmt`-ed first.

### Definition of done

| Check                                    | Result                                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Conflicted paths                         | 104/104 resolved (99 content, 5 modify/delete taken as upstream's deletion)                               |
| Conflict markers                         | 0 (`parsesweep.mjs` over 5,596 tracked `.ts/.tsx`: 0 damaged, 0 conflicted)                               |
| `git diff --check` vs first parent       | clean outside `patches/` (DL-923)                                                                         |
| `dangling.py`                            | 0 outside `quarantine/` (three base-identical false positives excluded, DL-922)                           |
| `unmarkedsweep.sh` gate vs `origin/main` | clean, evaluated against the new base (DL-921)                                                            |
| `Migrations.ts`                          | byte-identical to upstream                                                                                |
| `pnpm-lock.yaml`                         | upstream's, regenerated with `vp i` (40 s); Loom's deps and patches apply                                 |
| Pi relocation                            | done (§3.2, DL-919/920); `serverLayers.ts` provides the hooks tag from `@t3tools/provider-pi/server/loom` |
| Interim tool exposure                    | every `mcp__t3-code__` tool `direct` — one `// loom:` line in `mcpExtensionSource.ts` (DL-905)            |

### Typecheck (observed, not gated)

`vp run typecheck` (`vp run -r … typecheck`) stops at the first failing package, so
each package was checked with `tsc-rs --noEmit` directly. Logs:
`.artifacts/pull10-s1-typecheck/` (gitignored).

| Package                                                                                                                                                                          | Errors | Dominant kinds                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| apps/server                                                                                                                                                                      |    355 | 131 TS377030 (any/unknown in an Effect requirements channel), 52 TS2375 + 30 TS2379 (exact-optional / layer assignability), 51 TS377004 + 30 TS377034 (missing Effect/Layer context — mostly `McpProviderSessions` absent from Loom test layers), 9 TS7006, 9 TS2339, 6 TS377057 (`nodeBuiltinImport` on `node:crypto`), 5 TS2724 (`ProviderAdapterV2Shape` gone), 4 TS2304 (`observeRpcEffect` gone) |
| apps/web                                                                                                                                                                         |     16 | 7 TS2322 / 6 TS2345 (closed-view and right-panel surface kinds vs Loom's surfaces, model-preferences shape, goal menu ids), 1 each TS2307/TS2305/TS2304 (old `client-runtime/markdown-links`, `getDriverOption`, `isPreviewSupportedInRuntime` in `ChatMarkdown.tsx`)                                                                                                                                 |
| packages/shared                                                                                                                                                                  |     10 | TS2345/TS2322 — `serverSettings.test.ts` fixtures lack Loom's allow-list fields (DL-913)                                                                                                                                                                                                                                                                                                              |
| packages/provider-core                                                                                                                                                           |      1 | TS377057 — Loom's `node:crypto` in `IdAllocator.ts`                                                                                                                                                                                                                                                                                                                                                   |
| packages/provider-pi                                                                                                                                                             |      1 | TS2307 — `@t3tools/shared/hostProcess` renamed `HostProcess` (`rpc.loom.test.ts`)                                                                                                                                                                                                                                                                                                                     |
| apps/mobile                                                                                                                                                                      |      0 | (two silent-merge duplicate keys fixed in the merge, DL-918)                                                                                                                                                                                                                                                                                                                                          |
| every other package (desktop, client-runtime, contracts, effect-_, provider-acp/-acp-registry/-cursor/-grok/-muse/-opencode/-testing, source-control-_, ssh, tailscale, scripts) |      0 | —                                                                                                                                                                                                                                                                                                                                                                                                     |

**383 errors in total**, 311 of apps/server's 355 in test files or testkits. Concentrated in
apps/server, and most are a handful of root causes (test layers missing
`McpProviderSessions`, removed upstream exports, the `nodeBuiltinImport`
severity, Loom settings fields), not `tsc-rs` behaviour. Well under the "few
hundred per track" re-plan line for S2b; S2a's 355 is at that line but mostly
mechanical.

### What Gate 1 should look at hardest

1. `packages/provider-pi/src/server/adapter.ts` — the hooks now resolve inside
   `makePiAdapterV2` (DL-906), and the quota classifier, steer stash, sanitiser,
   fork cut, spend and author-label hunks were re-applied by hand onto upstream's
   rewritten adapter.
2. `Orchestrator.ts` `readShellSnapshot` (DL-907) — a Loom join added on a path
   upstream introduced.
3. `mcpExtensionSource.ts` — the interim exposure line and the dropped generic
   snippet fallback (DL-905).
4. The DL-912 and DL-925 overlaps (reopen-closed vs Loom's tab reopen; server-side
   browser preview vs the artefact viewer), and DL-917 (manifest auto-merge).
5. Hosted-MCP check: `requireWorkstreamCaller`
   (`apps/server/src/mcp/toolkits/workstream/authorisation.ts`) refuses any
   invocation scope with no `thread`; confirm upstream's OAuth-signed hosted
   sessions reach the Loom toolkit only through that path.
