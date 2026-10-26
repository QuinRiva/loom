/**
 * The fork's migration lane: its own ledger `loom_sql_migrations` at ids `1001+`, since `Migrator`
 * skips by high-water mark and one shared ledger would silently skip upstream's next migration on
 * existing databases. Add `Migrations/<id>_<Name>.ts` at the next id; never below `1000`.
 *
 * @module LoomMigrations
 */

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

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
import Migration1037 from "./Migrations/1037_ProjectionThreadMessageReasoningMs.ts";
import Migration1038 from "./Migrations/1038_ReasoningTextToReasoningMessages.ts";
import Migration1039 from "./Migrations/1039_DropTitleProvenance.ts";
import Migration1040 from "./Migrations/1040_DropProjectDefaultStartFromOrigin.ts";
import Migration1041 from "./Migrations/1041_DropLegacyReasoningStorage.ts";
import Migration1042 from "./Migrations/1042_ProjectionThreadAnchorTask.ts";
import Migration1043 from "./Migrations/1043_BackfillUsageLedgerFromActivities.ts";
import Migration1044 from "./Migrations/1044_ProjectionThreadPendingUserInputHeader.ts";
import Migration1045 from "./Migrations/1045_ThreadSearchIndex.ts";
import Migration1046 from "./Migrations/1046_LoomThreadWorkstream.ts";
import Migration1047 from "./Migrations/1047_LoomGoalTables.ts";
import Migration1048 from "./Migrations/1048_LoomConsultAndPeerMessageTables.ts";
import Migration1049 from "./Migrations/1049_LoomUsageLedger.ts";
import Migration1050 from "./Migrations/1050_LoomThreadReroute.ts";
import Migration1051 from "./Migrations/1051_LoomLegacyImports.ts";
import Migration1052 from "./Migrations/1052_LoomControlMessageRows.ts";
import Migration1053 from "./Migrations/1053_LoomCardMetrics.ts";
import Migration1054 from "./Migrations/1054_LoomImportedConsultItems.ts";
import Migration1055 from "./Migrations/1055_LoomHandoffOrigin.ts";
import Migration1056 from "./Migrations/1056_LoomThreadCache.ts";
import Migration1057 from "./Migrations/1057_LoomThreadCacheWarming.ts";
import Migration1058 from "./Migrations/1058_LoomKickoffOrigin.ts";
import Migration1059 from "./Migrations/1059_LoomThreadSnoozeRequests.ts";
import Migration1060 from "./Migrations/1060_DropThreadSearchMessageTriggers.ts";
import Migration1061 from "./Migrations/1061_LoomReviewSnapshots.ts";
import Migration1062 from "./Migrations/1062_ThreadSearchIndexV2.ts";
import Migration1063 from "./Migrations/1063_LoomThreadDocumentQuery.ts";
import Migration1064 from "./Migrations/1064_ThreadSearchTextGuard.ts";
import Migration1065 from "./Migrations/1065_DropUpstreamMessageSearch.ts";
import Migration1066 from "./Migrations/1066_DropHumanMessageDigestItems.ts";

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
  [1037, "ProjectionThreadMessageReasoningMs", Migration1037],
  [1038, "ReasoningTextToReasoningMessages", Migration1038],
  [1039, "DropTitleProvenance", Migration1039],
  [1040, "DropProjectDefaultStartFromOrigin", Migration1040],
  [1041, "DropLegacyReasoningStorage", Migration1041],
  [1042, "ProjectionThreadAnchorTask", Migration1042],
  [1043, "BackfillUsageLedgerFromActivities", Migration1043],
  [1044, "ProjectionThreadPendingUserInputHeader", Migration1044],
  [1045, "ThreadSearchIndex", Migration1045],
  [1046, "LoomThreadWorkstream", Migration1046],
  [1047, "LoomGoalTables", Migration1047],
  [1048, "LoomConsultAndPeerMessageTables", Migration1048],
  [1049, "LoomUsageLedger", Migration1049],
  [1050, "LoomThreadReroute", Migration1050],
  [1051, "LoomLegacyImports", Migration1051],
  [1052, "LoomControlMessageRows", Migration1052],
  [1053, "LoomCardMetrics", Migration1053],
  [1054, "LoomImportedConsultItems", Migration1054],
  [1055, "LoomHandoffOrigin", Migration1055],
  [1056, "LoomThreadCache", Migration1056],
  [1057, "LoomThreadCacheWarming", Migration1057],
  [1058, "LoomKickoffOrigin", Migration1058],
  [1059, "LoomThreadSnoozeRequests", Migration1059],
  [1060, "DropThreadSearchMessageTriggers", Migration1060],
  [1061, "LoomReviewSnapshots", Migration1061],
  [1062, "ThreadSearchIndexV2", Migration1062],
  [1063, "LoomThreadDocumentQuery", Migration1063],
  [1064, "ThreadSearchTextGuard", Migration1064],
  [1065, "DropUpstreamMessageSearch", Migration1065],
  [1066, "DropHumanMessageDigestItems", Migration1066],
] as const;

const makeLoomMigrationLoader = (throughId?: number) =>
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
 * The single-ledger history reconciliation unpicks: `effect_sql_migrations` rows `33..66`,
 * `33..64` fork (to `id + 968`), `65`/`66` upstream's `033`/`034` (to `33`/`34`). Frozen, hence
 * `<= 1032`: later fork migrations were never shared and would make old databases look corrupt.
 */
const historicalLedgerTail: ReadonlyArray<readonly [id: number, name: string]> = [
  ...loomMigrationEntries
    .filter(([id]) => id <= lastReconciledLoomId)
    .map(([id, name]) => [id - loomIdOffset, name] as const),
  [65, "ProjectionThreadsSettled"],
  [66, "ProjectionThreadsSnoozed"],
];

class LoomLedgerReconciliationError extends Data.TaggedError("LoomLedgerReconciliationError")<{
  readonly message: string;
}> {}

/**
 * One-time move of applied fork migrations out of the shared ledger, before either lane, in one
 * transaction opened before the marker check. The marker is only that `loom_sql_migrations` exists,
 * so layout checks run pre-marker only. An unrecognised ledger fails: refusing to start is
 * recoverable, mis-reconciling a live database is not.
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
            `Restore from backup or reconcile the ledger by hand: this database must not be migrated automatically.`,
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
 * Both lanes, in the only safe order: reconciliation, upstream, fork. Upstream first on an
 * unreconciled ledger sees a high-water mark of `33..66`, skips `033`/`034`, and can never recover.
 */
export const runAllMigrations = Effect.fn("runAllMigrations")(function* ({
  toLoomMigrationInclusive,
}: RunAllMigrationsOptions = {}) {
  yield* reconcileMigrationLedgers();
  const upstream = yield* runMigrations();
  const loom = yield* runLoomMigrations({ toMigrationInclusive: toLoomMigrationInclusive });
  return { upstream, loom };
});
