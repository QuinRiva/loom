import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import {
  loomMigrationEntries,
  loomMigrationsTable,
  reconcileMigrationLedgers,
  runAllMigrations,
  runLoomMigrations,
} from "./LoomMigrations.ts";
import { migrationEntries } from "./Migrations.ts";
import * as NodeSqliteClient from "./NodeSqliteClient.ts";
import * as NodeSqliteWorkerClient from "./NodeSqliteWorkerClient.ts";

/**
 * Each test gets its own in-memory database: these tests rewrite ledgers, so a
 * database shared across a block would let one test's migrations leak into the
 * next one's "historical" starting state.
 */
const onFreshDb = <A, E>(effect: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.provide(effect, NodeSqliteClient.layerMemory());

/**
 * The lane split reconciled fork ids up to `1032`; anything above that was added
 * afterwards and was never in the shared ledger. A FROZEN historical fact — it
 * must never grow when a new fork migration is added.
 */
const LAST_RECONCILED_LOOM_ID = 1032;

/**
 * The last id the fork lane currently ships, which legitimately grows with every
 * new fork migration — unlike `LAST_RECONCILED_LOOM_ID`, which is frozen.
 *
 * Derived, deliberately: the property being asserted is DENSITY (no holes, or a
 * future upstream migration can never run again), not a specific final id, and
 * pinning a literal here would mean every new fork migration edits an unrelated
 * assertion. The historical tail keeps its independent oracle
 * (`PRODUCTION_FORK_TAIL`), so the drift this test guards against is still caught
 * there rather than here.
 */
const CURRENT_LOOM_LANE_END = loomMigrationEntries.at(-1)![0];

/**
 * The last id the UPSTREAM lane currently ships. Derived for the same reason as
 * `CURRENT_LOOM_LANE_END`: every cadence pull adds upstream migrations, and the
 * property under test is DENSITY, not a particular head. The reconciled
 * historical head stays the literal `34` where that frozen fact is the subject.
 */
const CURRENT_UPSTREAM_LANE_END = migrationEntries.at(-1)![0];

/** One past the shipped lane: a stand-in for "the next fork migration". */
const SYNTHETIC_FORK_ID = CURRENT_LOOM_LANE_END + 1;

/** One past the shipped upstream lane: "the next upstream migration". */
const SYNTHETIC_UPSTREAM_ID = CURRENT_UPSTREAM_LANE_END + 1;

/**
 * INDEPENDENT ORACLE for the historical fork tail: ids `33..64` of the shared
 * ledger, transcribed from the real production database
 * (`SELECT migration_id, name FROM effect_sql_migrations`), **not** derived from
 * `loomMigrationEntries`.
 *
 * This exists because deriving the fixture from the same list the production code
 * derives from makes the test drift with the code: a rename or a bad filter
 * changes both sides and the assertion still passes. That is precisely how the
 * live-list-derived-tail defect reached a production smoke run. Any edit that
 * changes what reconciliation expects of a pre-split database must break here.
 */
const PRODUCTION_FORK_TAIL: ReadonlyArray<readonly [id: number, name: string]> = [
  [33, "ProjectionThreadsGoalSlug"],
  [34, "ProjectionThreadMessageReasoning"],
  [35, "GoalsAndTasks"],
  [36, "CanonicalizeReasoningEvents"],
  [37, "ProjectionThreadWorkstreamFields"],
  [38, "ProjectionThreadStatusAndDependencies"],
  [39, "ProjectionThreadBrief"],
  [40, "ProjectionThreadNotifyFields"],
  [41, "ProjectionThreadCumulativeCost"],
  [42, "ProjectionThreadPlanLaneAndAttention"],
  [43, "ProjectionThreadHeartbeats"],
  [44, "ProjectionThreadContextMetrics"],
  [45, "ProjectionThreadReviewGates"],
  [46, "UsageLedger"],
  [47, "ProjectionThreadWorktreeIsolation"],
  [48, "ProjectionThreadConsults"],
  [49, "ProjectionThreadDiffMetrics"],
  [50, "ProjectionProjectsUniqueActiveWorkspaceRoot"],
  [51, "UsageLedgerProviderId"],
  [52, "ProjectionThreadSessionLastErrorClass"],
  [53, "ProviderSessionRuntimeLastSeenIndex"],
  [54, "ProjectionThreadMessageOrigin"],
  [55, "ProjectionThreadForkSource"],
  [56, "ProjectionThreadMessageControlPayload"],
  [57, "ProjectionTitleProvenance"],
  [58, "ProjectionThreadScaffoldFields"],
  [59, "ProjectionThreadPlanLaneSince"],
  [60, "ProjectionThreadDependenciesSince"],
  [61, "ProjectionThreadFaninSince"],
  [62, "ProjectionThreadHandoffCount"],
  [63, "ProjectionProjectsDefaultStartFromOrigin"],
  [64, "ProjectionThreadPeerMessages"],
];

/**
 * The single-ledger layout loom shipped before the lane split: upstream `1..32`,
 * fork `33..64`, then upstream's own `033`/`034` re-homed to `65`/`66`.
 *
 * Deliberately capped at fork `1032`: this is a historical fact, and it must not
 * grow when a new fork migration is added.
 */
const historicalLedger: ReadonlyArray<
  readonly [id: number, name: string, body: Effect.Effect<void, SqlError, SqlClient.SqlClient>]
> = [
  ...migrationEntries.filter(([id]) => id <= 32),
  ...loomMigrationEntries
    .filter(([id]) => id <= LAST_RECONCILED_LOOM_ID)
    .map(([id, name, body]) => [id - 968, name, body] as const),
  ...migrationEntries
    .filter(([id]) => id === 33 || id === 34)
    .map(([id, name, body]) => [id + 32, name, body] as const),
];

/**
 * Run the upstream lane only up to `throughId`. The equivalence claim below is
 * about the SHARED history, so both lanes are capped at the reconciliation
 * point; upstream migrations landed by later cadence pulls extend the schema
 * beyond that history exactly as post-split fork migrations do.
 */
const runUpstreamThrough = (throughId: number) =>
  Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        migrationEntries
          .filter(([id]) => id <= throughId)
          .map(([id, name, body]) => [`${id}_${name}`, body]),
      ),
    ),
  });

/** Replay the historical single-ledger order onto a fresh database. */
const runHistoricalOrder = (throughId: number) =>
  Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries(
        historicalLedger.slice(0, throughId).map(([id, name, body]) => [`${id}_${name}`, body]),
      ),
    ),
  });

const ledgerIds = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly migration_id: number;
    }>`SELECT migration_id FROM ${sql(table)} ORDER BY migration_id`.withoutTransform;
    return rows.map((row) => row.migration_id);
  });

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * Normalised schema fingerprint.
 *
 * Tables are compared by their **column set** (name, type, nullability,
 * default, primary-key membership) and their **indexes/constraints**, not by
 * the raw `sqlite_master` text — because the raw text preserves the *ordinal
 * position* in which `ADD COLUMN` appended each column, which necessarily
 * differs between the two orderings and is the one difference we do not care
 * about. Nothing in the server depends on ordinal position: there are no
 * positional `INSERT`s (every insert names its columns), and the single
 * `SELECT *` (`ProjectionSnapshotQuery.ts`) is a subquery whose outer query
 * names every column it projects. Views, triggers and explicit indexes are
 * still compared verbatim, where the text genuinely is the contract.
 */
const schemaFingerprint = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const objects = yield* sql<{
    readonly type: string;
    readonly name: string;
    readonly sql: string | null;
  }>`SELECT type, name, sql FROM sqlite_master
     WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       AND name NOT IN ('effect_sql_migrations', ${loomMigrationsTable})
     ORDER BY type, name`.withoutTransform;

  const columns: Array<string> = [];
  const constraints: Array<string> = [];
  for (const object of objects) {
    if (object.type !== "table") continue;
    const info = yield* sql<{
      readonly name: string;
      readonly type: string;
      readonly notnull: number;
      readonly dflt_value: string | null;
      readonly pk: number;
    }>`SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(${object.name})
       ORDER BY name`.withoutTransform;
    for (const column of info) {
      columns.push(
        `${object.name}.${column.name}:${column.type}:${column.notnull}:${column.dflt_value ?? ""}:${column.pk}`,
      );
    }

    const indexes = yield* sql<{
      readonly name: string;
      readonly unique: number;
      readonly origin: string;
    }>`SELECT name, "unique", origin FROM pragma_index_list(${object.name})
       ORDER BY name`.withoutTransform;
    for (const index of indexes) {
      const indexColumns = yield* sql<{
        readonly name: string | null;
      }>`SELECT name FROM pragma_index_info(${index.name}) ORDER BY seqno`.withoutTransform;
      constraints.push(
        `${object.name} ${index.origin}${index.unique ? " unique" : ""} (${indexColumns
          .map((column) => column.name ?? "?")
          .join(", ")})`,
      );
    }
  }

  return {
    columns,
    constraints: constraints.sort(),
    nonTables: objects
      .filter((object) => object.type !== "table")
      .map((object) => `${object.type} ${object.name} ${object.sql ?? ""}`),
    tableNames: objects.filter((object) => object.type === "table").map((object) => object.name),
  };
});

// §6(1) + §6(7): reconciliation across every reachable historical stop, including
// the intermediate states the rejected upstream-first ordering corrupted.
describe.each([0, 1, 32, 33, 34, 48, 64, 65, 66])(
  "reconciliation from historical ledger stopped at %i",
  (stoppedAt) => {
    it.effect("both lanes end dense and correct, and upstream 033/034 really ran", () =>
      onFreshDb(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          if (stoppedAt > 0) yield* runHistoricalOrder(stoppedAt);

          yield* runAllMigrations();

          assert.deepStrictEqual(
            yield* ledgerIds("effect_sql_migrations"),
            range(1, CURRENT_UPSTREAM_LANE_END),
            `upstream ledger must be dense 1..${CURRENT_UPSTREAM_LANE_END} — a hole means an upstream migration can never run again`,
          );
          assert.deepStrictEqual(
            yield* ledgerIds(loomMigrationsTable),
            range(1001, CURRENT_LOOM_LANE_END),
          );

          // Ledger rows are not enough: the bodies must have executed too.
          const info = yield* sql<{
            readonly name: string;
          }>`SELECT name FROM pragma_table_info('projection_threads')`.withoutTransform;
          const names = new Set(info.map((column) => column.name));
          for (const column of ["settled_override", "settled_at", "snoozed_until", "snoozed_at"]) {
            assert.isTrue(names.has(column), `projection_threads.${column} missing`);
          }
        }),
      ),
    );
  },
);

describe("reconciliation is idempotent", () => {
  it.effect("a second run executes nothing and leaves both ledgers unchanged", () =>
    onFreshDb(
      Effect.gen(function* () {
        yield* runHistoricalOrder(66);
        yield* runAllMigrations();
        const before = {
          upstream: yield* ledgerIds("effect_sql_migrations"),
          loom: yield* ledgerIds(loomMigrationsTable),
        };

        const second = yield* runAllMigrations();

        assert.deepStrictEqual(second.upstream, []);
        assert.deepStrictEqual(second.loom, []);
        assert.deepStrictEqual(yield* ledgerIds("effect_sql_migrations"), before.upstream);
        assert.deepStrictEqual(yield* ledgerIds(loomMigrationsTable), before.loom);
      }),
    ),
  );

  it.effect("moved fork rows keep their original names and created_at timestamps", () =>
    onFreshDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runHistoricalOrder(66);
        const before = yield* sql<{
          readonly name: string;
          readonly created_at: string;
        }>`SELECT name, created_at FROM effect_sql_migrations WHERE migration_id BETWEEN 33 AND 64
           ORDER BY migration_id`.withoutTransform;

        yield* runAllMigrations();

        // Scoped to the RECONCILED range: the claim is that the moved rows keep
        // their identity, not that the lane has no rows above them. Fork
        // migrations added after the split legitimately extend the lane.
        const after = yield* sql<{
          readonly name: string;
          readonly created_at: string;
        }>`SELECT name, created_at FROM ${sql(loomMigrationsTable)}
           WHERE migration_id <= ${LAST_RECONCILED_LOOM_ID}
           ORDER BY migration_id`.withoutTransform;
        assert.deepStrictEqual(after, before);
      }),
    ),
  );
});

// §6(2): the plan's §5 audit claims all-upstream-then-all-fork yields the same
// schema as the historical interleaving. Make that executable rather than prose.
describe("lane ordering does not change the resulting schema", () => {
  it.effect("two-lane fresh install matches the historical interleaved order", () =>
    Effect.gen(function* () {
      const twoLane = yield* onFreshDb(
        Effect.gen(function* () {
          // Cap BOTH lanes at the reconciliation point: the equivalence claim
          // is split-reconstruction == historical interleave for the SHARED
          // history. Migrations added after the split — fork ids 1033+ and every
          // upstream id a later cadence pull lands — legitimately EXTEND the
          // schema beyond that history (same principle the row-identity test
          // above scopes to `<= LAST_RECONCILED_LOOM_ID`), so comparing the full
          // current schema to the frozen historical one would spuriously fail
          // the moment any post-split migration adds a column.
          yield* runUpstreamThrough(34);
          yield* runLoomMigrations({ toMigrationInclusive: LAST_RECONCILED_LOOM_ID });
          return yield* schemaFingerprint;
        }),
      );
      const historical = yield* onFreshDb(
        Effect.gen(function* () {
          yield* runHistoricalOrder(66);
          return yield* schemaFingerprint;
        }),
      );

      assert.deepStrictEqual(twoLane.tableNames, historical.tableNames);
      assert.deepStrictEqual(twoLane.columns, historical.columns);
      assert.deepStrictEqual(twoLane.constraints, historical.constraints);
      assert.deepStrictEqual(twoLane.nonTables, historical.nonTables);
    }),
  );
});

// §6(6): the regression test this whole change exists for. With a shared ledger
// these are silently skipped on a migrated database while passing on a fresh one.
const withSyntheticUpstream = (ids: ReadonlyArray<number>) =>
  Migrator.make({})({
    loader: Migrator.fromRecord(
      Object.fromEntries([
        ...migrationEntries.map(([id, name, body]) => [`${id}_${name}`, body] as const),
        ...ids.map((id) => [`${id}_SyntheticUpstream${id}`, Effect.void] as const),
      ]),
    ),
  });

const withSyntheticFork = () =>
  Migrator.make({})({
    table: loomMigrationsTable,
    loader: Migrator.fromRecord(
      Object.fromEntries([
        ...loomMigrationEntries.map(([id, name, body]) => [`${id}_${name}`, body] as const),
        [`${SYNTHETIC_FORK_ID}_SyntheticFork`, Effect.void],
      ]),
    ),
  });

describe.each([0, 66])(
  "future migrations still run on a reconciled database (historical stop %i)",
  (stoppedAt) => {
    it.effect("a synthetic next-upstream id and 067 plus a new fork migration all execute", () =>
      onFreshDb(
        Effect.gen(function* () {
          if (stoppedAt > 0) yield* runHistoricalOrder(stoppedAt);
          yield* runAllMigrations();

          const upstream = yield* withSyntheticUpstream([SYNTHETIC_UPSTREAM_ID, 67]);
          assert.deepStrictEqual(
            upstream.map(([id]) => id),
            [SYNTHETIC_UPSTREAM_ID, 67],
            "upstream migrations were skipped — a lane is masking the other's high-water mark",
          );
          assert.deepStrictEqual(yield* ledgerIds("effect_sql_migrations"), [
            ...range(1, SYNTHETIC_UPSTREAM_ID),
            67,
          ]);

          const fork = yield* withSyntheticFork();
          assert.deepStrictEqual(
            fork.map(([id]) => id),
            [SYNTHETIC_FORK_ID],
          );
          assert.deepStrictEqual(
            yield* ledgerIds(loomMigrationsTable),
            range(1001, SYNTHETIC_FORK_ID),
          );
        }),
      ),
    );

    it.effect("reconciliation stays a no-op once upstream has advanced past 66", () =>
      onFreshDb(
        Effect.gen(function* () {
          if (stoppedAt > 0) yield* runHistoricalOrder(stoppedAt);
          yield* runAllMigrations();
          yield* withSyntheticUpstream([SYNTHETIC_UPSTREAM_ID, 67]);

          // The marker must not expire: a healthy, advanced database must not be
          // re-validated against the historical 0..66 layout.
          const again = yield* runAllMigrations();

          assert.deepStrictEqual(again.upstream, []);
          assert.deepStrictEqual(again.loom, []);
          assert.deepStrictEqual(yield* ledgerIds("effect_sql_migrations"), [
            ...range(1, SYNTHETIC_UPSTREAM_ID),
            67,
          ]);
        }),
      ),
    );
  },
);

// §9: an unrecognised ledger must stop the server, not be guessed at.
const seedLedger = (rows: ReadonlyArray<readonly [id: number, name: string]>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE effect_sql_migrations (
  migration_id integer PRIMARY KEY NOT NULL,
  created_at datetime NOT NULL DEFAULT current_timestamp,
  name VARCHAR(255) NOT NULL
)`;
    for (const [id, name] of rows) {
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
    }
  });

const historicalRows = historicalLedger.map(([id, name]) => [id, name] as const);

const unexpectedLedgers: ReadonlyArray<
  readonly [description: string, rows: ReadonlyArray<readonly [number, string]>]
> = [
  ["a gap in the fork range", historicalRows.slice(0, 48).filter(([id]) => id !== 40)],
  [
    "an unrecognised migration name",
    historicalRows
      .slice(0, 48)
      .map((row) => (row[0] === 40 ? ([40, "SomethingNobodyShipped"] as const) : row)),
  ],
  ["an id above the last one loom shipped", [...historicalRows, [67, "UnexpectedFutureRow"]]],
  [
    "fork rows applied out of order",
    historicalRows
      .slice(0, 48)
      .map((row) =>
        row[0] === 40
          ? ([40, historicalRows[40]![1]] as const)
          : row[0] === 41
            ? ([41, historicalRows[39]![1]] as const)
            : row,
      ),
  ],
  [
    "an upstream row re-homed to 65 that is not upstream's 033",
    [...historicalRows.slice(0, 64), [65, "ProjectionThreadsSnoozed"]],
  ],
];

describe.each(unexpectedLedgers)("unexpected ledger state: %s", (_description, rows) => {
  it.effect("refuses to migrate and leaves the database untouched", () =>
    onFreshDb(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedLedger(rows);

        const failure = yield* Effect.flip(runAllMigrations());

        assert.strictEqual(
          failure._tag,
          "LoomLedgerReconciliationError",
          `expected LoomLedgerReconciliationError, got ${String(failure)}`,
        );

        const marker = yield* sql<{
          readonly name: string;
        }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${loomMigrationsTable}`
          .withoutTransform;
        assert.deepStrictEqual(
          marker,
          [],
          "marker table must not survive a refused reconciliation",
        );
        assert.deepStrictEqual(
          yield* ledgerIds("effect_sql_migrations"),
          rows.map(([id]) => id),
          "historical ledger must be untouched",
        );
      }),
    ),
  );
});

// §6(9): atomicity, on the worker-backed file path the real server uses (not the
// in-process memory client the tests above use). The transaction must open
// *before* the marker check, so a failure after the marker's CREATE TABLE leaves
// no marker behind — a surviving marker would be a false "done" that strands
// every fork migration as unapplied.
it.live(
  "reconciliation is atomic on the worker-backed path: a failure after marker creation leaves no marker",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-loom-recon-atomic-" });
      const dbPath = path.join(dir, "state.sqlite");

      // A ledger the reconciliation must reject — so it fails *after* creating
      // the marker table, which is exactly the interruption window in question.
      yield* Effect.gen(function* () {
        yield* seedLedger([...historicalRows.slice(0, 40), [41, "SomethingNobodyShipped"]]);
        const failure = yield* Effect.flip(runAllMigrations());
        assert.strictEqual(failure._tag, "LoomLedgerReconciliationError");
      }).pipe(Effect.provide(NodeSqliteWorkerClient.layer({ filename: dbPath })));

      // Reopen the file in a second connection: the rollback must be durable on
      // disk, not merely absent from the failed connection's view.
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const marker = yield* sql<{
          readonly name: string;
        }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${loomMigrationsTable}`
          .withoutTransform;
        assert.deepStrictEqual(marker, [], "marker table survived a rolled-back reconciliation");
        assert.deepStrictEqual(
          yield* ledgerIds("effect_sql_migrations"),
          [...historicalRows.slice(0, 40).map(([id]) => id), 41],
          "historical ledger was mutated by a rolled-back reconciliation",
        );
      }).pipe(Effect.provide(NodeSqliteWorkerClient.layer({ filename: dbPath })));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// The successful path on the same worker-backed file client, across two separate
// client lifetimes — the closest unit-level analogue of two server launches.
it.live("both lanes migrate and are idempotent on the worker-backed file path", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-loom-recon-worker-" });
    const dbPath = path.join(dir, "state.sqlite");

    yield* Effect.gen(function* () {
      yield* runHistoricalOrder(66);
      yield* runAllMigrations();
      assert.deepStrictEqual(
        yield* ledgerIds("effect_sql_migrations"),
        range(1, CURRENT_UPSTREAM_LANE_END),
      );
      assert.deepStrictEqual(
        yield* ledgerIds(loomMigrationsTable),
        range(1001, CURRENT_LOOM_LANE_END),
      );
    }).pipe(Effect.provide(NodeSqliteWorkerClient.layer({ filename: dbPath })));

    yield* Effect.gen(function* () {
      const second = yield* runAllMigrations();
      assert.deepStrictEqual(second.upstream, []);
      assert.deepStrictEqual(second.loom, []);

      // And a future upstream migration still runs against the reopened file.
      const executed = yield* withSyntheticUpstream([SYNTHETIC_UPSTREAM_ID]);
      assert.deepStrictEqual(
        executed.map(([id]) => id),
        [SYNTHETIC_UPSTREAM_ID],
      );
    }).pipe(Effect.provide(NodeSqliteWorkerClient.layer({ filename: dbPath })));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

// Regression guard for a defect found during the production smoke: the expected
// historical ledger tail is a FROZEN FACT. Deriving it from the live fork-entry
// list made adding fork migration 1033 shift the tail, so an unreconciled
// production database was rejected as corrupt. Adding fork migrations must never
// affect reconciliation of a database that predates the lane split.
describe("adding future fork migrations does not break reconciliation", () => {
  it.effect("an unreconciled ledger still reconciles once the fork lane has grown", () =>
    onFreshDb(
      Effect.gen(function* () {
        // The historical tail is defined by loom's shipped ids 33..66 only, and
        // is unaffected by fork entries added after the split.
        assert.strictEqual(
          historicalLedger.length,
          66,
          "the historical single-ledger tail must stay fixed at 66 rows — it is a historical fact, " +
            "not a function of the current fork-entry list",
        );

        yield* runHistoricalOrder(66);

        // The tail the production code will compare against must match the real
        // production ledger, independently of how loomMigrationEntries is
        // filtered or renamed. Checked against a transcription of the live DB.
        assert.deepStrictEqual(
          historicalLedger.slice(32, 64).map(([id, name]) => [id, name] as const),
          PRODUCTION_FORK_TAIL,
          "the historical fork tail must equal the real production ledger's rows 33..64",
        );

        // Reconcile an UNRECONCILED ledger while the fork lane has already grown
        // past 1032. Order is the whole point: the original defect derived the
        // expected tail from the live fork-entry list, so a grown list shifted
        // the expectation and rejected an unreconciled database as corrupt.
        // Reconciling before growing the list (as this test first did) cannot
        // catch it — the marker short-circuits before the tail is consulted.
        // Asserting the frozen length above is also not enough on its own: it
        // pins the constant but never exercises the comparison that used it.
        yield* reconcileMigrationLedgers();

        assert.deepStrictEqual(
          yield* ledgerIds(loomMigrationsTable),
          range(1001, 1032),
          "reconciliation must map the historical tail to 1001..1032 regardless of how many " +
            "fork entries the current build ships",
        );
        assert.deepStrictEqual(yield* ledgerIds("effect_sql_migrations"), range(1, 34));

        // The grown fork lane then applies its new migration on top.
        yield* withSyntheticFork();
        assert.deepStrictEqual(
          yield* ledgerIds(loomMigrationsTable),
          range(1001, SYNTHETIC_FORK_ID),
        );
      }),
    ),
  );
});

// A ledger longer than the 34-row historical tail must be rejected outright: the
// `slice` in the validator truncates the expectation to the observed length, so
// an over-long ledger must be caught by the length comparison, not silently
// accepted as a prefix.
describe("a ledger longer than loom ever shipped", () => {
  it.effect("is refused rather than truncated to a matching prefix", () =>
    onFreshDb(
      Effect.gen(function* () {
        yield* seedLedger([...historicalRows, [67, "Extra67"], [68, "Extra68"]]);

        const failure = yield* Effect.flip(runAllMigrations());

        assert.strictEqual(failure._tag, "LoomLedgerReconciliationError");
      }),
    ),
  );
});
