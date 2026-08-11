/**
 * Dev benchmark: cost of one projection snapshot pass, full vs lean.
 *
 * Point it at a COPY of a realistic store (never the live one):
 *
 *   sqlite3 "file:$T3CODE_HOME/userdata/state.sqlite?mode=ro" .schema \
 *     | grep -v sqlite_sequence > /tmp/snap-schema.sql
 *   sqlite3 /tmp/snapbench.sqlite < /tmp/snap-schema.sql
 *   # then INSERT INTO main.<table> SELECT * FROM live.<table> for the
 *   # projection_* tables plus effect_sql_migrations / loom_sql_migrations
 *
 *   BENCH_DB=/tmp/snapbench.sqlite node apps/server/src/dev/benchShellSnapshot.ts
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { layerTest as serverConfigLayerTest } from "../config.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";

const DB = process.env.BENCH_DB ?? "/tmp/snapbench.sqlite";
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 7);

const layer = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(makeSqlitePersistenceLive(DB)),
  Layer.provideMerge(
    serverConfigLayerTest(process.cwd(), { prefix: "snapbench" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const measure = <A extends { readonly threads: ReadonlyArray<unknown> }, E>(
  label: string,
  pass: Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const samples: Array<number> = [];
    let rows = 0;
    for (let round = 0; round <= ROUNDS; round += 1) {
      const start = performance.now();
      const snapshot = yield* pass.pipe(Effect.orDie);
      const elapsed = performance.now() - start;
      rows = snapshot.threads.length;
      // Round 0 is the warm-up (page cache, JIT) and is not a sample.
      if (round > 0) samples.push(elapsed);
    }
    const sorted = samples.toSorted((a, b) => a - b);
    yield* Effect.log(
      `${label}: ${rows} rows · median ${(sorted[Math.floor(sorted.length / 2)] ?? 0).toFixed(1)}ms · min ${(sorted[0] ?? 0).toFixed(1)}ms · max ${(sorted.at(-1) ?? 0).toFixed(1)}ms`,
    );
  });

const program = Effect.gen(function* () {
  const query = yield* ProjectionSnapshotQuery;
  yield* measure("getShellSnapshot        ", query.getShellSnapshot());
  yield* measure("getLeanShellSnapshot    ", query.getLeanShellSnapshot());
  yield* measure(
    "getLeanShellSnapshot(role)",
    query.getLeanShellSnapshot({ role: "handoff-drafter" }),
  );
});

await Effect.runPromise(program.pipe(Effect.provide(layer), Effect.scoped));
process.exit(0);
