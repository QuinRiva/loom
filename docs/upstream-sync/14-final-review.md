---
manager_sessions:
  - id: 994ebf15-8add-4ea6-ad80-ad1562b9c0df
    role: review
    authored_at: 2026-06-30T10:14:45.590Z
---

# 14 — Final review: the upstream merge as a whole

_Independent, critical go/no-go for the complete upstream-nightly merge re-home
(`git diff 777bd20f8..HEAD`, HEAD = `b2b745c54`). Builds on the three prior
reviews (09 client-runtime/web-state/server, 10 web shell, 11 goal-CRUD) — does
not redo their deep audits. Primary new scope: the un-reviewed tail
(`git diff 824a656cc..HEAD`, Phases 2.6 + 2.6b) and a holistic cross-phase
lost-feature/coherence sweep. Read-only audit. Australian English._

---

## Verdict: **SHIP** — with one trivial must-fix before PR

The merge is **coherent, faithful, and substantially complete**. Across the whole
Pi feature set every load-bearing capability traces end-to-end; the un-reviewed
tail (M1 terminal PATH, the desktop/mobile fixtures, the 2.6b lint pass) is
correct and genuinely behaviour-preserving; and there is no compat-shim, dual-shape,
dead-code or conflict-marker cruft anywhere in the merge diff. The three prior
reviews each landed SHIP and their tracked follow-ups (M1 terminal, goal-CRUD,
desktop fixture, doc 08(d) correction) are all now resolved in the tail.

The **one** thing standing between the current tree and a clean green state is a
**cosmetic markdown-formatting failure in `docs/upstream-sync/13-lint-conformance.md`
itself** — the very doc that claims "vp check exits 0". `vp check` therefore
currently exits **1**, not 0. It is a pure prose/table-padding nit
(`*word*`→`_word_` emphasis + Markdown table column alignment), zero code/build/runtime
impact, fixed in one command (`vp check --fix && git commit`). I flag it a
**blocker on the strict "all-green" bar** (because `vp check` green is part of the
done bar in AGENTS.md and the green claim is currently false), but it is the most
trivial blocker possible — a doc reflow, not a code defect.

It is SHIP, not REVISE/RETHINK: the substrate is sound, the Pi-first experience is
intact, code/typecheck/build are green, and the only defect is a one-command doc
format. Fix that, run the owed human live smoke test, and this is ready to PR into
`main`.

---

## Green state — independently verified (not taken on trust)

| Check                     | Claimed (docs 12/13)        | **Measured this review** | Result                                                                         |
| ------------------------- | --------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `vp run typecheck`        | 0 errors / 15 pkgs          | **EXIT 0**               | ✅ green — confirmed                                                           |
| `pnpm build` (production) | exit 0                      | **EXIT 0**               | ✅ green — `apps/server`, `apps/web`, desktop all emit                         |
| `vp check`                | **exit 0** (0 err, 15 warn) | **EXIT 1**               | ❌ **red** — 1 formatting issue in `docs/upstream-sync/13-lint-conformance.md` |

The `vp check` red is solely the doc above; `vp check --fix` resolves it cleanly
(verified: the fix touches only that one file — emphasis markers + table padding —
then re-running exits 0). No code file is implicated. The "exits 0" lines in docs
12 and 13 were evidently written/measured before that doc was finalised and
committed in the same 2.6b commit — the doc claiming green is what broke green.

---

## Tail audit (`git diff 824a656cc..HEAD`) — primary new scope

### M1 — terminal worktree-local `.bin` PATH re-home ✅ byte-faithful

`d0a5b5686` re-applies the fork's `createTerminalSpawnEnv(baseEnv, cwd, platform,
runtimeEnv?)` and wraps the return in `withLocalNodeModulesBin(spawnEnv, cwd,
platform)`. Diffed against the fork ground truth
(`6150362cf:apps/server/src/terminal/Layers/Manager.ts`): the signature and the
final `return withLocalNodeModulesBin(spawnEnv, cwd, platform)` are **identical**.
The call site threads `session.cwd` + `platform` (both already in scope at
`makeWithOptions`); the helper's signature `(env, cwd, platform)` matches. This
closes the one MAJOR from review 09. Correct and behaviour-faithful.

### m2 — desktop `reasoningDisplay` fixture ✅ not masking a gap

`reasoningDisplay: "collapsed"` (= `DEFAULT_REASONING_DISPLAY_MODE`) added to the
desktop settings fixture. The key is genuinely **required** by the schema after the
fork's `settings.ts` addition; this is a fixture filling a real required field, not
masking a type hole.

### Mobile fixtures (4 merge-induced errors) ✅ correct

- `archivedThreadList.test.ts` / `homeThreadList.test.ts`: neutral-default fills of
  the Pi-first additive fields on the thread shell (`goalId`/`parentThreadId`/`role`/
  `purpose`/`brief`/`planLane`/`attention`/`blockedBy`/`spawnGeneration`/`reportPath`/
  `toolUses`/`usedTokens`/`maxTokens`/`lastActivityPreview`) + `goals: []` on the
  snapshot. Values are inert defaults; tests assert elsewhere. Correct.
- `T3ComposerEditor.ios.tsx`: handles the new `thread` mention-token variant
  (`{type:"thread", id, label}`, no `value`) → uses `token.label`, mirroring web
  composer logic. The `iconUri` branch is `type === "mention"`-gated, so it never
  touches `token.value` on a thread token. Correct.

### 2.6b lint conformance — genuinely behaviour-preserving ✅

Spot-checked every category against semantic risk:

- **27 `namespace-node-imports`** (named `node:*` → `import * as NodeX`): all pure
  mechanical renames with every call site updated (`readFileSync`→`NodeFS.readFileSync`,
  `join`→`NodePath.join`, `randomUUID`→`NodeCrypto.randomUUID`, `execFileSync`→
  `NodeChildProcess.execFileSync`, …). A missed call site would be an undefined
  identifier → a typecheck error; **typecheck is green**, so no rename is half-done.
  The `.join`/`resolve` locals and the `.join` calls **inside** the `String.raw`
  extension-source templates were correctly left untouched (they are emitted JS, not
  `node:path`).
- **7 `no-inline-schema-compile` hoists** (mobile `storage.ts`, `catalog-store.ts`):
  `Schema.decodeUnknownResult(X)` / `encodeUnknownResult(X)` lifted to module-scope
  consts. This changes **only when the codec is compiled** (once at module load vs.
  per call) — schema compilation is pure and idempotent; the actual decode/encode
  still runs on the same data at the same call point. No evaluation-timing change, no
  TDZ (typecheck green ⇒ all referenced schemas are declared above the hoist). This
  is upstream's exact idiom. Behaviour-identical.
- **unused `import * as Layer`** dropped from `GoalHandoffHttp.ts` — typecheck green
  confirms it was genuinely unused.
- **test `list[1]?.payload` → `list[1]!.payload`** — the test already asserts the
  2-element event shape immediately above, so the non-null assertion is sound.
- **15 left-as-warnings** are reasonable: the 13 `no-unstable-nested-components` are
  render-prop / inline-renderer closures whose hoist is a non-trivial,
  regression-risky refactor; the 2 `no-array-index-key` are over ephemeral
  `ReadonlyArray<string>` queues with **no stable id and possible duplicates** —
  index _is_ the correct positional key there, and content-keying would introduce
  duplicate-key reconciliation bugs. Leaving these is the behaviour-preserving call.

### Remaining tail changes ✅ inert

`ChatHeader.tsx` (b97c93736) is a single-line import reflow; `vcs/http.ts` is the
`execFileSync` namespace rename above. No behavioural content.

---

## Holistic lost-feature & coherence sweep

Confirmed at HEAD (the lint pass touched server files, so re-verified the wiring
still stands):

- **6 runtime layers** — all imported, merged into the live layer graph in
  `server.ts`, and the two reactor-scoped ones (`WorkstreamLivenessSweep`,
  `SubscriptionUsagePoller`) are `.start()`'d in `serverRuntimeStartup.ts:350–351`.
  `AccountUsageRegistryLive` merged at `server.ts:316`. (Deep invocation tracing done
  in review 09; re-confirmed present.)
- **Workstream/goal command surface, PiDriver `--session-id`, account-usage,
  reasoning tri-state, goals/tasks + re-homed goal-CRUD, multi-session sidebar** —
  all verified end-to-end across reviews 09/10/11; nothing in the tail regressed any
  of them (the tail touched none of those wire shapes — only node imports, fixtures,
  and the terminal env builder).
- **No conflict markers** anywhere in `apps/**`/`packages/**`.
- **No compat-shim / dual-shape / `backward-compat` / `legacy` / TODO / FIXME**
  introduced in the merge code diff (the only matches are a `ListTodo` Lucide icon and
  legitimate `LegacyStored*`/`migrateLegacy` mobile cache-migration code that
  pre-exists). Clean.

---

## Findings by severity

### BLOCKER (must fix before PR)

**B1 — `vp check` is red (formatting) — the green claim is currently false.**
`docs/upstream-sync/13-lint-conformance.md` fails the formatter (emphasis `*x*`→`_x_`
and Markdown table column padding). Fix: `vp check --fix && git add -A && git commit`.
One command, doc-only, zero code/build/runtime impact — but `vp check` green is part
of the AGENTS.md done bar, so it must be true before PR. _The only blocker._

### MAJOR — none

### MINOR

- **m-A — docs 12 & 13 assert "vp check exits 0" while the tree's `vp check` exits 1.**
  Self-referential miss (the doc finalised after the green run). Will be true once B1
  is fixed; correct the wording in the same commit if desired. Cosmetic.
- **m-B — `/api/vcs/diff` server endpoint retained, unused by the web client.**
  Accepted in review 10 (DiffPanel ACCEPT-DROP). Harmless dead-ish endpoint; optional
  cleanup, explicitly left per brief.

---

## Definitive list of intentional losses / deferrals

1. **DiffPanel working-tree HEAD-diff (web)** — **ACCEPT-DROP**. Upstream's DiffPanel
   subsumes it (working-tree source + branch-range base-ref selector). The fork's
   generic single-mode diff is a strict subset. Server `/api/vcs/diff` left in place
   (harmless, m-B). _Confirmed the genuine, deliberate web-feature drop._
2. **`pinnedCollapsedThread` sidebar pin** — **intentional drop / known minor**.
   Upstream-only convenience the fork never had; dropping it restores fork behaviour
   exactly. Restoring onto the Pi goal-grouping model has ambiguous semantics for a
   minor visual anchor. Recorded, not re-homed.
3. **Driver registry Pi-only (`BUILT_IN_DRIVERS = [PiDriver]`)** — **faithful to the
   fork** (the pre-merge fork was already Pi-only). Deliberate, not a lost fork
   feature; future pulls should not re-litigate it.
4. **Non-Pi harnesses restore (registry restore + non-Pi driver re-home)** — **Phase
   2.8, deferred/optional, out of scope** of the merge per the parent's task tree.

These four are the complete set of conscious losses/deferrals. No _unintended_ lost
feature surfaced in this sweep or the three prior reviews.

---

## Readiness — must-fix-before-PR list

**Must fix (1):**

1. **B1** — `vp check --fix` on `docs/upstream-sync/13-lint-conformance.md`, commit,
   re-confirm `vp check` exits 0. (One command.)

**Owed, not blocking the PR mechanics but required before declaring the merge truly
done (per AGENTS.md canonical-entrypoint bar):**

- **Human live Pi-session smoke test** (owed since 12; cannot be run from this
  worktree without a live server + provider creds). Checklist in doc 12: goal-scoped
  new thread + Sidebar goal-CRUD menus, `@thread` mention/workstream-ask, in-app
  terminal resolving worktree-local `vp` (M1), reasoning tri-state + spawn cards,
  multi-session sidebar + account-usage pill.

**Acceptable follow-ups (non-gating):** m-A (doc wording), m-B (`/api/vcs/diff`
cleanup), Phase 2.8 (non-Pi harnesses).

Once B1 is fixed and the human smoke test passes, this merge is ready to PR into
`main`. Code, typecheck and build are green; the merge is coherent as a whole.
