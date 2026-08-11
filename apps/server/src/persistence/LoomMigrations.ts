/**
 * LoomMigrations — the fork's migration lane.
 *
 * Loom keeps its migrations in a **second, independent ledger table**
 * (`loom_sql_migrations`) at ids `1001+`, while
 * `Migrations.ts` stays byte-identical to upstream and owns
 * `effect_sql_migrations` at upstream's own `1..N`. Two stock `Migrator` runs,
 * one per lane, so every cadence pull can take upstream's `Migrations.ts` and
 * migration files verbatim — no renumbering, no conflict.
 *
 * **Why two tables and not just a high id band.** `Migrator.make` decides what
 * to run with a *high-water mark*, not set membership:
 * `if (currentId <= latestMigrationId) continue`. With both lanes in one
 * ledger the mark would sit at `1032`, so upstream's next `035` would be
 * silently skipped on every existing database — while still passing every
 * fresh-install test, because a fresh run ascends `1..34` then `1001..` and
 * the mark never overtakes anything. Separate tables give each lane its own
 * mark, so neither can ever mask the other.
 *
 * **Adding a fork migration:** create `Migrations/<id>_<Name>.ts` with the
 * next id at `1033+` and append it to `loomMigrationEntries`. Never number a
 * fork migration below `1000`.
 *
 * @module LoomMigrations
 */

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "./Migrations.ts";

import Migration1001 from "./Migrations/1001_ProjectionThreadsGoalSlug.ts";
import Migration1002 from "./Migrations/1002_ProjectionThreadMessageReasoning.ts";
import Migration1003 from "./Migrations/1003_GoalsAndTasks.ts";
import Migration1004 from "./Migrations/1004_CanonicalizeReasoningEvents.ts";
import Migration1005 from "./Migrations/1005_ProjectionThreadWorkstreamFields.ts";
import Migration1006 from "./Migrations/1006_ProjectionThreadStatusAndDependencies.ts";
import Migration1007 from "./Migrations/1007_ProjectionThreadBrief.ts";
import Migration1008 from "./Migrations/1008_ProjectionThreadNotifyFields.ts";
import Migration1009 from "./Migrations/1009_ProjectionThreadCumulativeCost.ts";
import Migration1010 from "./Migrations/1010_ProjectionThreadPlanLaneAndAttention.ts";
import Migration1011 from "./Migrations/1011_ProjectionThreadHeartbeats.ts";
import Migration1012 from "./Migrations/1012_ProjectionThreadContextMetrics.ts";
import Migration1013 from "./Migrations/1013_ProjectionThreadReviewGates.ts";
import Migration1014 from "./Migrations/1014_UsageLedger.ts";
import Migration1015 from "./Migrations/1015_ProjectionThreadWorktreeIsolation.ts";
import Migration1016 from "./Migrations/1016_ProjectionThreadConsults.ts";
import Migration1017 from "./Migrations/1017_ProjectionThreadDiffMetrics.ts";
import Migration1018 from "./Migrations/1018_ProjectionProjectsUniqueActiveWorkspaceRoot.ts";
import Migration1019 from "./Migrations/1019_UsageLedgerProviderId.ts";
import Migration1020 from "./Migrations/1020_ProjectionThreadSessionLastErrorClass.ts";
import Migration1021 from "./Migrations/1021_ProviderSessionRuntimeLastSeenIndex.ts";
import Migration1022 from "./Migrations/1022_ProjectionThreadMessageOrigin.ts";
import Migration1023 from "./Migrations/1023_ProjectionThreadForkSource.ts";
import Migration1024 from "./Migrations/1024_ProjectionThreadMessageControlPayload.ts";
import Migration1025 from "./Migrations/1025_ProjectionTitleProvenance.ts";
import Migration1026 from "./Migrations/1026_ProjectionThreadScaffoldFields.ts";
import Migration1027 from "./Migrations/1027_ProjectionThreadPlanLaneSince.ts";
import Migration1028 from "./Migrations/1028_ProjectionThreadDependenciesSince.ts";
import Migration1029 from "./Migrations/1029_ProjectionThreadFaninSince.ts";
import Migration1030 from "./Migrations/1030_ProjectionThreadHandoffCount.ts";
import Migration1031 from "./Migrations/1031_ProjectionProjectsDefaultStartFromOrigin.ts";
import Migration1032 from "./Migrations/1032_ProjectionThreadPeerMessages.ts";
import Migration1033 from "./Migrations/1033_RefoldPendingUserInputCount.ts";
import Migration1034 from "./Migrations/1034_ProjectionThreadFinalCommitSha.ts";
import Migration1035 from "./Migrations/1035_ThreadHandoffChain.ts";
import Migration1036 from "./Migrations/1036_ProjectionThreadActivitySummaryIndex.ts";

/** Ledger table for the fork lane. Its existence is also the reconciliation marker. */
export const loomMigrationsTable = "loom_sql_migrations";

export const loomMigrationEntries = [
  [1001, "ProjectionThreadsGoalSlug", Migration1001],
  [1002, "ProjectionThreadMessageReasoning", Migration1002],
  [1003, "GoalsAndTasks", Migration1003],
  [1004, "CanonicalizeReasoningEvents", Migration1004],
  [1005, "ProjectionThreadWorkstreamFields", Migration1005],
  [1006, "ProjectionThreadStatusAndDependencies", Migration1006],
  [1007, "ProjectionThreadBrief", Migration1007],
  [1008, "ProjectionThreadNotifyFields", Migration1008],
  [1009, "ProjectionThreadCumulativeCost", Migration1009],
  [1010, "ProjectionThreadPlanLaneAndAttention", Migration1010],
  [1011, "ProjectionThreadHeartbeats", Migration1011],
  [1012, "ProjectionThreadContextMetrics", Migration1012],
  [1013, "ProjectionThreadReviewGates", Migration1013],
  [1014, "UsageLedger", Migration1014],
  [1015, "ProjectionThreadWorktreeIsolation", Migration1015],
  [1016, "ProjectionThreadConsults", Migration1016],
  [1017, "ProjectionThreadDiffMetrics", Migration1017],
  [1018, "ProjectionProjectsUniqueActiveWorkspaceRoot", Migration1018],
  [1019, "UsageLedgerProviderId", Migration1019],
  [1020, "ProjectionThreadSessionLastErrorClass", Migration1020],
  [1021, "ProviderSessionRuntimeLastSeenIndex", Migration1021],
  [1022, "ProjectionThreadMessageOrigin", Migration1022],
  [1023, "ProjectionThreadForkSource", Migration1023],
  [1024, "ProjectionThreadMessageControlPayload", Migration1024],
  [1025, "ProjectionTitleProvenance", Migration1025],
  [1026, "ProjectionThreadScaffoldFields", Migration1026],
  [1027, "ProjectionThreadPlanLaneSince", Migration1027],
  [1028, "ProjectionThreadDependenciesSince", Migration1028],
  [1029, "ProjectionThreadFaninSince", Migration1029],
  [1030, "ProjectionThreadHandoffCount", Migration1030],
  [1031, "ProjectionProjectsDefaultStartFromOrigin", Migration1031],
  [1032, "ProjectionThreadPeerMessages", Migration1032],
  [1033, "RefoldPendingUserInputCount", Migration1033],
  [1034, "ProjectionThreadFinalCommitSha", Migration1034],
  [1035, "ThreadHandoffChain", Migration1035],
  [1036, "ProjectionThreadActivitySummaryIndex", Migration1036],
] as const;

export const makeLoomMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      loomMigrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const run = Migrator.make({});

/** Fixed historical→fork id offset: old `33` → `1001`, old `64` → `1032`. */
const loomIdOffset = 968;

/** Last fork id that ever lived in the shared ledger, as historical loom `064`. */
const lastReconciledLoomId = 1032;

/**
 * The single-ledger history this reconciliation knows how to unpick: rows
 * `33..66` of `effect_sql_migrations` as loom shipped them, in order.
 *
 * `33..64` are fork migrations (→ `loom_sql_migrations` at `id + 968`);
 * `65`/`66` are upstream's own `033`/`034`, re-homed by the 2026-07-25 pull
 * (→ back to `33`/`34` in `effect_sql_migrations`).
 *
 * This is a **frozen historical fact**, hence the `<= 1032` cut: fork
 * migrations added after the lane split (`1033+`) were never in the shared
 * ledger, so including them would shift the expected tail and make an
 * unreconciled database look corrupt.
 */
const historicalLedgerTail: ReadonlyArray<readonly [id: number, name: string]> = [
  ...loomMigrationEntries
    .filter(([id]) => id <= lastReconciledLoomId)
    .map(([id, name]) => [id - loomIdOffset, name] as const),
  [65, "ProjectionThreadsSettled"],
  [66, "ProjectionThreadsSnoozed"],
];

export class LoomLedgerReconciliationError extends Data.TaggedError(
  "LoomLedgerReconciliationError",
)<{
  readonly message: string;
}> {}

/**
 * One-time move of already-applied fork migrations out of the shared ledger.
 *
 * Runs **before either lane's migrator**, in a single transaction that opens
 * *before* the marker check, so an interrupted run can never leave a marker
 * behind with the rows unmoved (which would read as a false "done" and strand
 * every fork migration as unapplied).
 *
 * The marker is the **existence of `loom_sql_migrations` and nothing else** —
 * it never inspects upstream ids, so it stays valid for arbitrary future
 * upstream numbering. Every historical-layout check below therefore runs only
 * on the pre-marker path, and never again once the marker is committed.
 *
 * On any ledger shape it does not recognise it **fails rather than guesses**:
 * refusing to start is recoverable, mis-reconciling a live database is not.
 */
export const reconcileMigrationLedgers = Effect.fn("reconcileMigrationLedgers")(function* () {
  const sql = yield* SqlClient.SqlClient;

  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const marker = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${loomMigrationsTable}`;
      if (marker.length > 0) return "already-reconciled" as const;

      const shared = yield* sql<{
        readonly name: string;
      }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;

      // Same DDL the migrator itself would emit, so its CREATE TABLE IF NOT
      // EXISTS is a no-op when the fork lane runs immediately after.
      yield* sql`CREATE TABLE ${sql(loomMigrationsTable)} (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
)`;

      if (shared.length === 0) return "fresh" as const;

      const rows = yield* sql<{
        readonly migration_id: number;
        readonly name: string;
      }>`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id > 32 ORDER BY migration_id`
        .withoutTransform;

      // Dense-prefix validation. The stock migrator only ever produces a dense
      // prefix, so this rejects nothing legitimate — it just refuses to guess
      // at a ledger with a gap, an unknown name, or an id past the last one
      // loom ever shipped (66).
      const expected = historicalLedgerTail.slice(0, rows.length);
      const actual = rows.map((row) => [row.migration_id, row.name] as const);
      if (
        actual.length !== expected.length ||
        actual.some(([id, name], i) => id !== expected[i]![0] || name !== expected[i]![1])
      ) {
        return yield* new LoomLedgerReconciliationError({
          message:
            `Refusing to migrate: effect_sql_migrations does not match the single-ledger history ` +
            `this reconciliation knows how to unpick. Expected rows above id 32 to be a dense prefix of ` +
            `${expected.map(([id, name]) => `${id}_${name}`).join(", ") || "(nothing)"}, ` +
            `found ${actual.map(([id, name]) => `${id}_${name}`).join(", ") || "(nothing)"}. ` +
            `Restore from backup or reconcile the ledger by hand — this database must not be migrated automatically.`,
        });
      }

      // Order matters: vacate 33..64 before renumbering 65/66 down onto them.
      yield* sql`INSERT INTO ${sql(loomMigrationsTable)} (migration_id, created_at, name)
  SELECT migration_id + ${loomIdOffset}, created_at, name
  FROM effect_sql_migrations
  WHERE migration_id BETWEEN 33 AND 64`;
      yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id BETWEEN 33 AND 64`;
      yield* sql`UPDATE effect_sql_migrations SET migration_id = migration_id - 32 WHERE migration_id IN (65, 66)`;

      return "reconciled" as const;
    }),
  );
});

export interface RunLoomMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/** Run pending fork-lane migrations against `loom_sql_migrations`. */
export const runLoomMigrations = Effect.fn("runLoomMigrations")(function* ({
  toMigrationInclusive,
}: RunLoomMigrationsOptions = {}) {
  const executedMigrations = yield* run({
    loader: makeLoomMigrationLoader(toMigrationInclusive),
    table: loomMigrationsTable,
  });
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Loom database schema is current")
    : Effect.log("Loom migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));
  return executedMigrations;
});

export interface RunAllMigrationsOptions {
  /** Stop the fork lane at this id (fork-lane migration tests only). */
  readonly toLoomMigrationInclusive?: number | undefined;
}

/**
 * Both lanes, in the only safe order: reconciliation, then upstream, then fork.
 *
 * Reconciliation must precede the upstream lane. Running upstream first against
 * an unreconciled ledger sees a high-water mark of `33..66` and skips upstream's
 * `033`/`034` outright, leaving a ledger that looks migrated while missing
 * columns — and unrecoverable, because the mark can never go back down.
 */
export const runAllMigrations = Effect.fn("runAllMigrations")(function* ({
  toLoomMigrationInclusive,
}: RunAllMigrationsOptions = {}) {
  yield* reconcileMigrationLedgers();
  const upstream = yield* runMigrations();
  const loom = yield* runLoomMigrations({ toMigrationInclusive: toLoomMigrationInclusive });
  return { upstream, loom };
});
