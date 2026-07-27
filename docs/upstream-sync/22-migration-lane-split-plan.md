# Migration lane split — permanently removing migration renumbering from the cadence

**Status:** IMPLEMENTED and independently verified. Revision 3 of the design; see §10 for the implementation record and §11 for post-verification hardening.
**Branch:** `t3code/migration-lane-split`

> **Revision 2 changes.** An adversarial review found three correctness defects in
> revision 1's reconciliation protocol; all are fixed below and each fix is backed by
> a executed prototype (§4.4). The architecture (§3) was found sound and is unchanged.
> The material change is **ordering**: reconciliation now runs _before_ the upstream
> lane, not between the lanes. Revision 1's ordering permanently holed the upstream
> ledger on intermediate databases.
>
> **Revision 3 (approved — review verdict `clean`, no must-fix remaining).** Folds in
> the reviewer's two implementation watchpoints: the fork mapping is now a **fixed
> `+968` offset with dense-prefix validation** rather than sequential compaction
> (which mis-keyed gapped ledgers — §4.2), the **transaction boundary** for
> reconciliation is spelled out as an explicit implementer obligation the prototype
> does _not_ evidence (§4.3, §6(9)), and rollback now states that the ledger script
> runs **before** reverting code (§8).

## 1. The problem

Loom's migration chain diverged from upstream's at `033`. Loom occupies `033–064`
with fork-added migrations; upstream is at `032` and keeps shipping `033`, `034`, …
Every cadence pull therefore lands upstream migrations on numbers loom already
uses, and the pull has to hand-renumber them — as happened on 2026-07-25, when
upstream's `033_ProjectionThreadsSettled` / `034_ProjectionThreadsSnoozed` were
re-homed to loom `065`/`066` (see `21-cadence-pull-v0.0.29-nightly-20260725.md`).

That is a hand-done, one-way, in-place edit to a ~1.5 GB production database,
performed under merge pressure, on a recurring schedule. It needs to stop being
a step at all.

## 2. The binding constraint (why the obvious fix fails)

The migrator is `Migrator.make({})` from `effect/unstable/sql/Migrator`
(`apps/server/src/persistence/Migrations.ts:178`). Its entire
already-applied test is a **high-water mark**, not set membership:

```ts
const latestMigrationId = /* SELECT migration_id … ORDER BY migration_id DESC → [0] */
for (const resolved of current) {
  const [currentId] = resolved;
  if (currentId <= latestMigrationId) continue;   // ← the whole dedup mechanism
  required.push(/* … */);
}
```

A single integer — `max(migration_id)` — decides what runs. The live ledger is
dense `1–66` (verified on a `.backup` copy of `~/.t3/cockpit/userdata/state.sqlite`),
so that integer is currently `66`.

### 2.1 This kills the sketched "move fork migrations to a 1000+ band" plan

Post-rewrite the single ledger would hold `1–34` (upstream) + `1001–1032` (fork),
so `max(migration_id) = 1032`. Next pull, upstream ships `035`. The migrator asks
`35 <= 1032`? **Yes → `continue`.** Silently skipped. Not an error, not a warning —
the column is never added and the first query against it fails at runtime. The same
applies to every upstream migration up to `999`, forever.

The trap is _where_ it breaks. A **fresh** database is fine: `latestMigrationId`
starts at `0`, so `1…34` then `1001…` all run in ascending order and the
high-water mark never overtakes anything. So the scheme passes every fresh-install
test and all of CI, then silently corrupts exactly the databases we care about.

This was confirmed empirically against the real library, not just by reading it —
a throwaway test reproducing both ledger states:

| database state                         | upstream `035` result                                        |
| -------------------------------------- | ------------------------------------------------------------ |
| existing (ledger `1–34` + `1001–1032`) | `executed: []`, `tables created: []` — **skipped, no error** |
| fresh (identical code and migrations)  | `executed: [[35,…],[1001,…]]` — both run                     |

**Conclusion:** a fork band above upstream's range is only safe if it has a
high-water mark _of its own_. The band alone cannot work.

## 3. Chosen scheme: two-lane ledger

Two independent, stock `Migrator` runs, one per lane. `Migrator.make({})` already
accepts a `table` option, so each lane gets its own high-water mark and both can
grow forever without interacting.

| lane     | ledger table            | ids                               | cadence-pull handling             |
| -------- | ----------------------- | --------------------------------- | --------------------------------- |
| upstream | `effect_sql_migrations` | `1..N` — upstream's own numbering | merged verbatim, zero renumbering |
| fork     | `loom_sql_migrations`   | `1001+`                           | loom appends freely               |

Upstream's `035` is compared only against the upstream lane's max (`34`) → runs.
Loom's `1033` is compared only against the fork lane's max → runs. Neither lane
can ever mask the other. An id also self-documents ownership twice over: `<1000`
= upstream, `≥1000` = fork, and they live in different tables.

### 3.1 Why this over a loom-owned runner

The alternative was keeping one ledger and replacing `Migrator.make` with a small
loom-local runner that skips by set membership (`applied.has(id)`). Rejected:

- **Reordering is not a differentiator.** Both schemes lift fork migrations out of
  upstream's numbering space, so both make a fresh database run all-upstream-then-all-fork.
  The audit in §5 is required either way; it does not favour either option.
- **The recurring tax just moves.** A private copy of migration-execution logic
  against `effect/unstable/sql/Migrator` — a module upstream marks unstable, which
  loom bumps regularly — trades a per-pull renumbering step for a per-bump
  re-validation step. That is relocation, not elimination, and it cuts against the
  fork's standing doctrine of adopting upstream plumbing wholesale.
- **Decisively: only two-lane reaches zero _conflict_, not merely zero renumbering.**
  Today all 66 entries share one `migrationEntries` array, so every upstream append
  collides textually with loom's lines even when the numbers do not clash. Loom's
  `Migrations.ts` currently differs from upstream by _only_ the fork entries plus one
  three-line comment (verified via `git diff upstream/main`), so moving fork entries
  into a separate loom-owned file makes upstream's `Migrations.ts` adoptable
  **byte-identical** — the conflict surface goes to nil, permanently. A single sorted
  array cannot do that.

### 3.2 File organisation

- `apps/server/src/persistence/Migrations.ts` → restored byte-identical to
  upstream's copy (upstream entries only, and the re-homing comment deleted).
  Future pulls take upstream's version wholesale with no merge resolution.
- `apps/server/src/persistence/LoomMigrations.ts` → new, loom-owned: the fork
  entries as `1001+`, the fork lane's loader, and the reconciliation.
- Migration bodies move `033_…`–`064_…` → `1001_…`–`1032_…` (dense, per decision),
  and `065`/`066` revert to upstream's `033`/`034` filenames.
- The composed run (**reconciliation, then upstream lane, then fork lane** — see
  §4.1) is wired where `runMigrations()` is called today, `Layers/Sqlite.ts:64`.

## 4. One-time ledger reconciliation

### 4.1 Ordering: reconciliation runs FIRST (revision 2 correction)

Reconciliation runs **before either lane's migrator invocation**, creating the
fork ledger table itself rather than relying on a migrator run to create it.

Revision 1 put the upstream lane first. That is **wrong and unrecoverable**, and
the failure was reproduced against the real migrator. On a database stopped at
loom `033`, an upstream-first run sees `max = 33`, so it **skips upstream `033`
but inserts upstream `034`**:

| historical stop  | upstream-first result                                                           |
| ---------------- | ------------------------------------------------------------------------------- |
| `33`             | `executed=[[34,"ProjectionThreadsSnoozed"]]`, `033` **skipped**, max stays `34` |
| `34`, `48`, `64` | `executed=[]` — **both** upstream `033`/`034` skipped                           |

The ledger is then permanently holey: max is already `≥34`, so upstream `033`
can never run again, and the database looks migrated while missing columns.
Recovering means manual ledger surgery on live data — precisely the operation this
work exists to abolish.

**This also hits the production database, not only hypothetical intermediates.**
The live cockpit is at `66`, so an upstream-first run would skip `033`/`034`
before reconciliation ever renumbered `65`/`66` down to `33`/`34`.

With reconciliation first, every state tested ends with a dense, correct ledger.

### 4.2 The mapping

Current live ledger → target:

| current `effect_sql_migrations`         | becomes                                           |
| --------------------------------------- | ------------------------------------------------- |
| `1–32` (upstream)                       | unchanged in `effect_sql_migrations`              |
| `33–64` (fork)                          | moved → `loom_sql_migrations` as `1001–1032`      |
| `65`, `66` (upstream's 33/34, re-homed) | rewritten → `33`, `34` in `effect_sql_migrations` |

Rows are classified **by name, never by id alone** — ids cannot distinguish old
loom `033`/`034` from upstream's `033`/`034`. The two re-homed upstream rows are
rewritten to their upstream numbers.

**Fork rows use the fixed offset `new = old + 968`** (so `33→1001`, `64→1032`) —
_not_ sequential compaction over whatever recognised names happen to be present.
Revision 2's prototype used a running `next++` counter, which is subtly wrong: on
a ledger with a gap (say old `034` missing), it assigns old `035→1002` where the
true key is `1003`, silently mis-keying **every subsequent row** and permanently
mislabelling which fork migrations are applied. A fixed offset cannot drift.

Pair it with **dense-prefix validation**: assert the recognised fork rows form an
exact dense id/name prefix of the historical mapping, and fail loudly otherwise
(§9's posture). The stock migrator only ever produces dense prefixes, so this
rejects nothing legitimate — it just refuses to guess at a corrupt ledger.

### 4.3 The completion marker (revision 2 correction)

Revision 1 defined "already reconciled" as \*fork table exists **and upstream max
≤ 34\***. That predicate **expires**: after the first legitimate upstream `035`,
upstream max is `35`, so a healthy database no longer looks reconciled and would
be re-validated against the historical `0–66` layout — where legitimate upstream
`035` is an "unexpected" row and startup fails. The `>66` rejection in §9 would
likewise fail a healthy database at upstream `067`.

**Corrected marker: existence of the `loom_sql_migrations` table, and nothing
else.** It never inspects upstream ids, so it stays valid for arbitrary future
upstream numbering. Reconciliation's first action is to check for that table and
return immediately if present.

Consequently **all historical `0–66` validation — including the fail-loudly
checks of §9 — applies only on the pre-marker path**, and never again once the
marker is committed.

The marker creation and the ledger rewrite must be **atomic** (one transaction),
so an interrupted run cannot leave a fork table present with rows unmoved — which
would be a false "done" and would strand fork migrations as unapplied.

**This is the single most load-bearing line in the plan, and it is an obligation
on the implementer, not a property that falls out of the design.** Specifically:
the transaction must open **before** the marker check, and must span the existence
check, the `CREATE TABLE`, and every historical ledger mutation. SQLite has
transactional DDL, so a crash then exposes either the whole reconciliation or none
of it — but only if the boundary is drawn there.

Note the revision-2 prototype does **not** demonstrate this: it wraps neither
`reconcile` nor the composed startup in `sql.withTransaction`, so it evidences
ordering and idempotency only. Atomicity must be proven separately, on the
**worker-backed SQLite path the real server uses**, including an injected failure
after marker creation that must leave no marker behind after rollback.

### 4.4 Safety properties — verified in prototype

Each is covered by a test. All of the following were **executed** against the real
`Migrator` in a throwaway prototype (kept at `/tmp/recon-fix-prototype.test.ts`;
the implementer should reproduce these as permanent tests, not copy the prototype):

| state                                      | result                                              |
| ------------------------------------------ | --------------------------------------------------- |
| fresh DB (`0`)                             | upstream dense `1–34`, fork dense `1001–1032`       |
| stopped at `33`                            | dense; upstream `033` **runs** (the revision-1 bug) |
| stopped at `34`, `48`, `64`                | dense in all cases                                  |
| production state (`66`)                    | dense; nothing re-executed                          |
| second invocation                          | `executed=[]` on **both** lanes — true no-op        |
| + synthetic upstream `035`                 | runs: `[[35,…]]`                                    |
| + synthetic upstream `067` and fork `1033` | both run — marker survives arbitrary future ids     |

Also required: **concurrent/interrupted starts** — reconciliation plus both lanes
run inside a transaction; the ledger PK makes a double insert a constraint error
rather than a duplicate row. **Pre-033 databases** need no move; upstream max
stays `≤32` and the fork lane runs from scratch.

## 5. Reorder-safety audit (fresh installs)

Existing databases ran upstream and fork migrations interleaved in historical
order. Fresh installs will now run **all upstream, then all fork**. I extracted
every DDL/DML statement from all 68 migration bodies and checked for cross-lane
dependencies. Result: **the reordering is safe**, with the reasoning below.

**No shape-sensitive statements exist.** `SELECT *` appears in zero migrations,
and no migration rebuilds a table via `CREATE TABLE …_new` + copy + `RENAME TO`
(the classic pattern where an unexpected column set silently changes the outcome).
Every fork migration is either a `CREATE TABLE IF NOT EXISTS`, a
`PRAGMA table_info`-guarded `ADD COLUMN`, an index create, or a targeted `UPDATE`.

**`DROP COLUMN` — the only real hazard class.** There are **five statements** in
**four files**, three files in the fork lane. Post-split ids, verified on the
implementation branch with `git grep -n "DROP COLUMN"` (excluding tests):

| migration (post-split id)                      | lane     | drops                                   | verdict                                               |
| ---------------------------------------------- | -------- | --------------------------------------- | ----------------------------------------------------- |
| `016_CanonicalizeModelSelections:58`           | upstream | `projection_projects.default_model`     | upstream-internal; both lanes unaffected              |
| `016_CanonicalizeModelSelections:63`           | upstream | `projection_threads.model`              | upstream-internal; both lanes unaffected              |
| `1003_GoalsAndTasks:66`                        | fork     | `projection_threads.goal_slug`          | column is **created by fork `1001`** — self-contained |
| `1010_ProjectionThreadPlanLaneAndAttention:33` | fork     | `projection_threads.status`             | column is **created by fork `1006`** — self-contained |
| `1019_UsageLedgerProviderId:22`                | fork     | `projection_usage_ledger.provider_name` | table is **created by fork `1014`** — self-contained  |

Every fork-lane drop has its precondition produced inside the fork lane, so it
travels with it. The `provider_name` hits in upstream `004`/`005`/`016`/`027` are
different tables (`provider_session_runtime`, `projection_thread_sessions`) and
are untouched.

**This table has now been miscounted twice** — revision 1 said "two", revision 3
said "five" but listed only four rows by collapsing `016`'s two statements into
one. That is the whole argument for not resting the safety property on a prose
audit: §6(2) is an **executable** schema-equivalence check, and it is the actual
evidence. Treat this table as commentary on that test, not as a substitute for it.

**Fork migrations never reference upstream's newest columns.** No fork migration
mentions `settled` or `snoozed`; upstream's `033`/`034` only add nullable columns
to `projection_threads` behind `PRAGMA` guards, and no index anywhere references
`status`, `settled*`, or `snoozed*` (checked against the live DB's `sqlite_master`).

**Upstream migrations never reference fork tables.** The fork lane introduces
`projection_goals`, `projection_goal_tasks`, `projection_thread_heartbeats`,
`projection_usage_ledger`, `projection_thread_consults`,
`projection_thread_peer_messages`, plus columns on `projection_threads` /
`projection_projects` / `projection_thread_messages`. Upstream `001–034` predate
all of them and touch none.

The one asymmetry worth recording: fork `057_ProjectionTitleProvenance` alters
`projection_goals` (a fork table, fork `035`) **and** `projection_threads` (an
upstream table) — but only via guarded `ADD COLUMN` plus an `UPDATE` scoped to
fork-owned columns, so running it after all upstream migrations is strictly
better-defined than before.

## 6. Verification protocol

Nothing runs against the live database. `state.sqlite` is copied with
`sqlite3 .backup`; the server is smoke-tested on a spare port with an isolated
userdata dir.

1. **Unit tests** for reconciliation across all five states in §4, asserting exact
   final ledger contents in both tables.
2. **Historical-order equivalence** — a test building a fresh DB in the _old_
   interleaved order and one in the _new_ two-lane order, then diffing normalised
   `sqlite_master` output. This turns §5's audit into an executable check and a
   permanent regression guard. (Cheap now that the audit says they should match;
   if they diverge, §5 is wrong and the plan changes.)
3. **Production-copy migration** — restore a `.backup` copy of the 1.5 GB DB,
   run the built server against it on a spare port, confirm: ledger ends
   `effect_sql_migrations` = `1–34` and `loom_sql_migrations` = `1001–1032`, no
   migration re-executed, schema unchanged from pre-run apart from intended
   additions, and the app serves threads.
4. **Idempotency** — second launch on that same copy reports zero migrations run
   and leaves both ledgers byte-identical.
5. **Fresh-install** — empty userdata dir migrates to the same final schema as (3).
6. **Simulated next pull** — add a synthetic upstream `035` and confirm it runs on
   _both_ the production copy and a fresh DB. This is the regression test for the
   exact failure that killed the 1000-band plan. Extend it as revision 2 requires:
   run `035` across a **second full process invocation** (proving the §4.3 marker
   is durable), and include a synthetic upstream id **above `66`** (e.g. `067`)
   plus a new fork migration at `1033`.
7. **Intermediate-state matrix** — seed ledgers stopped at `33`, `34`, `48`, `64`
   and assert, after a single invocation, that both upstream migration bodies ran
   and the upstream ledger is exactly dense `1–34`. This is the direct regression
   test for the revision-1 ordering bug (§4.1).
8. **Rollback refusal** — confirm the inverse script runs on the initial exact
   state and **refuses** once either lane has advanced (§8).
9. **Reconciliation atomicity** — on the worker-backed SQLite path the real server
   uses, inject a failure after marker creation and assert the database is left
   with **no** `loom_sql_migrations` table and an untouched historical ledger
   (§4.3). Ordering/idempotency tests do not cover this.
10. Gates: `pnpm install`, `vp run typecheck`, `pnpm build`, `vp check`.

### 6.1 Known collateral: `toMigrationInclusive`

`runMigrations({ toMigrationInclusive })` is used by **9 existing migration test
files** (23 call sites, ids `15`–`63`). A single global id ceiling stops being
meaningful once ids live in two lanes. **Approved approach:** give it a per-lane
meaning — fork-lane tests target the fork lane's id, and the ids in fork-migration
tests shift with their migrations (`toMigrationInclusive: 62` → the fork id
corresponding to old `62`). Upstream-lane test files (`016`–`031`) keep their
current numbers untouched, so they too stay mergeable with upstream.

## 7. Documentation deliverables

- This document, plus a short outcome note appended once verified.
- A cadence-pull section stating that migrations now need **no special handling**:
  take upstream's `Migrations.ts` and migration files verbatim; only ever add fork
  migrations to `LoomMigrations.ts` at `1001+`.
- `AGENTS.md`: a persistence note covering the two lanes, the `1000+` rule for new
  fork migrations, and the warning that the migrator compares by high-water mark
  per lane — so a fork migration must never be numbered below `1000`.

## 8. Rollback (revision 2 correction)

Revision 1 claimed a generic inverse (`loom_sql_migrations` `1001+` → `33+`,
upstream `33/34` → `65/66`). That is **unsafe once either lane advances**: after a
legitimate upstream `035+` or a new fork `1033+`, the mapping collides with real
upstream ids and cannot reconstruct the historical single-lane order.

**Corrected:** the inverse is scoped **strictly to the initial exact state** —
fork ledger exactly `1001–1032` and upstream exactly dense `1–34`. It verifies
that precondition and **refuses to run otherwise**, with a message saying the
database has advanced past the rollback window and must be restored from backup.
No version-aware rollback is attempted; the honest window is "before the next
cadence pull".

The migration bodies are unchanged in content, so the code side is a `git revert`.
The inverse script ships alongside the forward one and is tested on a production
copy in the same run as §6(3), **including the refusal path**. Databases are copies
throughout, so the real fallback remains simply not deploying.

**Order matters, and must be documented with the script: run the inverse ledger
script BEFORE reverting to old code.** Old code against a reconciled ledger sees
an upstream max of `34` and would re-run old ids `35–66` against a database that
already has those changes.

## 9. Resolved question: no ledger above `066`

**Confirmed by the maintainer:** the current deployment is the most recent state,
and no instance exists whose ledger contains ids **above** `066`. The
reconciliation therefore only has to handle ledgers in the range `0–66`, and may
treat an id above `66` in `effect_sql_migrations` as an unexpected state.

It should still **fail loudly rather than guess** if it encounters one (a row in
`33–66` whose _name_ matches neither the fork mapping nor the two re-homed
upstream migrations, or any id above `66`): refusing to migrate is recoverable,
mis-reconciling a 1.5 GB database is not.

**Scope limit (per §4.3):** these checks run **only on the pre-marker path**.
Once `loom_sql_migrations` exists, reconciliation returns immediately and never
inspects upstream ids again — otherwise legitimate future upstream migrations
(`035`, `067`, …) would be misread as corruption and would block startup.

---

## 10. Outcome — implemented and verified

**Status: implemented.** The architecture in §3 was adopted unchanged, and every
correctness property in §4 held up under test. One defect was found in the plan
(§10.3) and one in the implementation (§10.4); both are fixed and both now have
permanent regression tests.

### 10.1 What shipped

| change                                                                                            | file                                                                            |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Upstream lane, restored **byte-identical to upstream**                                            | `apps/server/src/persistence/Migrations.ts` (`git diff upstream/main` is empty) |
| Fork lane: entries at `1001+`, its loader, the reconciliation, and the composed startup           | `apps/server/src/persistence/LoomMigrations.ts` (new, loom-owned)               |
| Migration bodies re-homed `033–064` → `1001–1032`; `065`/`066` restored to upstream's `033`/`034` | `apps/server/src/persistence/Migrations/` (pure renames — no body edited)       |
| Startup wiring: reconciliation → upstream lane → fork lane                                        | `apps/server/src/persistence/Layers/Sqlite.ts:64`                               |
| Inverse ledger script + its tests                                                                 | `apps/server/scripts/loom-ledger-rollback.{ts,test.ts}`                         |
| Lane tests                                                                                        | `apps/server/src/persistence/LoomMigrations.test.ts` (24 tests)                 |
| Cadence + agent documentation                                                                     | `docs/upstream-sync/05-strategy.md` §4.4, `AGENTS.md`                           |

`toMigrationInclusive` gained its per-lane meaning as approved: the three
fork-lane migration tests call `runAllMigrations({ toLoomMigrationInclusive })`
with ids shifted by `+968`. The six upstream-lane test files were left untouched
and remain byte-identical to upstream.

### 10.2 Verification evidence

All ten §6 items were executed. Gates: `vp run typecheck` **0 errors**,
`pnpm build` **exit 0**, `vp check` **0 errors**. Server runs used the built
`dist/bin.mjs` on spare ports (13971–13980) against `.backup` copies under an
isolated `--base-dir`; the live cockpit database was never opened.

| #   | check                                                           | result                                                                                                                                                                                                                                              |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Reconciliation from historical stops `0/1/32/33/34/48/64/65/66` | both ledgers end dense `1–34` / `1001–1032`, **and** upstream `033`/`034`'s bodies are proven to have run (all four columns present)                                                                                                                |
| 2   | Historical-interleaved vs two-lane schema equivalence           | **identical** column sets, types, defaults, PKs, indexes and constraints. §5's audit is now an executable test                                                                                                                                      |
| 3   | Production copy (1.5 GB, ledger at `66`)                        | ledgers `1–34` + `1001–1032`; **no migration re-executed**; only new object is `loom_sql_migrations`; 1257 threads intact; `GET /` → 200                                                                                                            |
| 4   | Idempotency, second launch on that copy                         | zero migrations; both ledgers **byte-identical** including `created_at`                                                                                                                                                                             |
| 5   | Fresh install                                                   | reaches the **same object set** as the migrated production copy                                                                                                                                                                                     |
| 6   | **Synthetic upstream `035` + `067` + fork `1033`**              | ran on **both** the migrated production copy and a fresh DB, in a _separate process invocation_ after reconciliation: `migrations: [ '35_…', '67_…' ]`, `loom: [ '1033_…' ]`                                                                        |
| 7   | Intermediate-state matrix `33/34/48/64`                         | upstream ledger dense `1–34` in every case — the revision-1 ordering bug is regression-tested                                                                                                                                                       |
| 8   | Rollback                                                        | round-trips a production copy to a ledger **exactly equal** to the original `1–66` (ids _and_ names); pre-change code then starts against it with **zero** migrations and zero errors; refuses once either lane advances, and on an unreconciled DB |
| 9   | **Atomicity on the worker-backed path**                         | a failure after marker creation leaves **no** `loom_sql_migrations` table and an untouched ledger, verified through a _reopened connection_ so the rollback is proven durable on disk                                                               |
| 10  | Gates                                                           | green (above)                                                                                                                                                                                                                                       |

Two **negative controls** were run to confirm the tests have teeth, then discarded:

- Moving the transaction boundary to _after_ the `CREATE TABLE` — the §6(9)
  atomicity test fails with `marker table survived a rolled-back reconciliation`.
  The boundary in §4.3 is therefore load-bearing _and_ guarded.
- Re-creating the rejected single-shared-ledger scheme against the real
  `Migrator` — upstream `035` returns `executed: []` on an existing database
  while a fresh one runs all 66. §2's premise is confirmed independently.

### 10.3 Correction to the plan: §5's `DROP COLUMN` table (now fixed in §5)

**Resolved — §5 has been rewritten.** The finding was correct: §5 said five
statements but listed only four rows, because `016_CanonicalizeModelSelections`
drops **two** columns (`projection_projects.default_model` and
`projection_threads.model`) on the two lines cited. §5 now enumerates all five
statements as separate rows, uses post-split ids, and states plainly that the
table is commentary on the executable §6(2) check rather than the evidence itself.
Both `016` drops are upstream-lane and upstream-internal, so the verdict is
unaffected.

The deeper point stands: the prose audit was wrong twice in a row about its own
exhaustiveness. Verification item 2 is now an executable test, so the property
§5 was _trying_ to establish no longer depends on anyone counting correctly.

### 10.4 Defect found in implementation: the historical tail must be frozen

The first implementation derived the expected historical ledger (`33..66`) from
the _live_ `loomMigrationEntries` list. That is correct only while the fork lane
has exactly 32 entries. Adding fork migration `1033` shifted the expected tail by
one, so an **unreconciled production database was rejected as corrupt** —
startup refused with a `LoomLedgerReconciliationError`.

This was caught by the production smoke run, not by the unit tests, because the
unit tests derived their fixture from the same list and shifted with it. In other
words: the first cadence pull that added a loom migration would have blocked
startup on any database that had not yet been reconciled.

The fix freezes the tail at fork id `1032` (`lastReconciledLoomId`), because it
describes a historical fact rather than the current entry list. Verified by
rebuilding with a synthetic `1033` and reconciling an untouched production copy:
ledgers end `1–34` / `1001–1033`, no error. A permanent test now asserts the
historical tail stays 66 rows and that reconciliation of a pre-split database
still succeeds after the fork lane grows.

### 10.5 Notes for the next pull

- `Migrations.ts` should **never** conflict again. If it does, loom has grown a
  delta it was not supposed to have — take upstream's side and investigate.
- The `+968` offset and `lastReconciledLoomId` are frozen historical constants.
  They describe the one-time `33..66` layout and must not be re-derived from the
  current entry list.
- The reconciliation is now a permanent no-op on every deployed database (the
  marker is committed). It only matters for a database that predates the split.

## 11. Post-verification hardening

Independent verification against copies of the 1.5 GB production database returned
**clean** — no must-fix defect. Full evidence in the reviewer's report; the
headline result is that real upstream `035`/`067` and fork `1033` migrations ran,
and their bodies created proof tables, on both a reconciled production copy and a
fresh database in later process invocations. The shared-ledger failure of §2 is
absent.

Two non-blocking notes were raised and both are now closed.

### 11.1 The future-fork regression guard had no teeth

The reviewer observed that `LoomMigrations.test.ts`'s "adding future fork
migrations does not break reconciliation" added synthetic fork `1033` **after**
reconciliation, so the marker short-circuited before the historical tail was ever
consulted — it could not have caught the live-list-derived-tail defect it was
written for.

Investigating further found the problem was **deeper than the ordering**: the test
derived its `historicalLedger` fixture from `loomMigrationEntries`, the same list
the production code derives `historicalLedgerTail` from. Both sides moved
together, so the assertion could not fail. Reintroducing the defect as a negative
control confirmed this — the suite stayed green.

Compounding it, `filter(([id]) => id <= lastReconciledLoomId)` is a **no-op while
no shipped entry exceeds 1032**, so removing the filter entirely is undetectable
until a fork migration is actually added. The guard was latent, not active.

Fixed with two changes:

1. **An independent oracle** — `PRODUCTION_FORK_TAIL`, the 32 `33..64` rows
   transcribed from the real production ledger rather than derived from the entry
   list. Any change to what reconciliation expects of a pre-split database now
   breaks a hardcoded comparison.
2. **Corrected ordering** — the test grows the fork lane and calls
   `reconcileMigrationLedgers()` on an _unreconciled_ ledger, exercising the tail
   comparison instead of skipping it.

Verified by negative control: with the `<= 1032` filter removed **and** a `1033`
entry shipped (the real future state), reconciliation now fails loudly with
`65_FutureThing` displacing `65_ProjectionThreadsSettled` in the expected prefix.
Production sources were restored byte-identical afterwards; 31 tests pass.

The general lesson, worth carrying into future work here: **a test whose fixture
is derived from the same source as the code under test cannot fail.** Both of this
change's near-misses were that shape.

### 11.2 Stale plan header

The header still read "revision 2 … No code changes yet" while §10 recorded a
completed implementation. Corrected.
