/**
 * Dev fixture verifier — API-level proof that the seeded workstream is
 * correct. Reads the same read model the server's HTTP snapshot handler serves
 * (`ProjectionSnapshotQuery`) and resolves a per-turn checkpoint diff the same
 * way DiffPanel does (`CheckpointDiffQuery`), asserting a non-empty patch.
 *
 * Run: `T3CODE_HOME=<scratch> node apps/server/src/dev/verifySeed.ts`
 *
 * @module dev/verifySeed
 */
// Dev-only fixture tooling (not shipped); see seedWorkstream.ts.
// @effect-diagnostics globalErrorInEffectFailure:off preferSchemaOverJson:off
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "../orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { buildSeedConfig } from "./seedConfig.ts";

const ORCHESTRATOR_ID = ThreadId.make("seed-thread-orchestrator");
const REWORK_ID = ThreadId.make("seed-thread-coder-rework");

const verifyProgram = Effect.gen(function* () {
  const snapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const diffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;
  const snapshot = yield* snapshotQuery.getSnapshot();

  const coders = snapshot.threads.filter(
    (thread) => thread.parentThreadId === ORCHESTRATOR_ID && thread.role === "coder",
  );
  if (coders.length < 3) {
    return yield* Effect.fail(new Error(`Expected >=3 coder descendants, found ${coders.length}.`));
  }

  const report: Array<Record<string, unknown>> = [];
  let firstDiffSample: string | null = null;

  for (const coder of coders) {
    const context = yield* snapshotQuery.getThreadCheckpointContext(coder.id);
    const checkpoints = Option.isSome(context) ? context.value.checkpoints : [];
    report.push({
      threadId: coder.id,
      title: coder.title,
      isolation: coder.isolation,
      planLane: coder.planLane,
      attention: coder.attention,
      checkpointTurnCounts: checkpoints.map((cp) => cp.checkpointTurnCount),
    });

    // Prove the first coder's turn-1 diff resolves to a real, non-empty patch —
    // exactly the range DiffPanel requests (fromTurnCount = n-1, toTurnCount = n).
    if (firstDiffSample === null && checkpoints.length > 0) {
      const diff = yield* diffQuery.getTurnDiff({
        threadId: coder.id,
        fromTurnCount: 0,
        toTurnCount: 1,
        ignoreWhitespace: true,
      });
      if (diff.diff.trim().length === 0) {
        return yield* Effect.fail(
          new Error(`Turn-1 diff for coder '${coder.id}' was empty; fixture is not usable.`),
        );
      }
      firstDiffSample = diff.diff;
    }
  }

  if (firstDiffSample === null) {
    return yield* Effect.fail(new Error("No coder produced a non-empty per-turn diff."));
  }

  const reworkContext = yield* snapshotQuery.getThreadCheckpointContext(REWORK_ID);
  const reworkTurns = Option.isSome(reworkContext) ? reworkContext.value.checkpoints.length : 0;

  yield* Console.log(
    JSON.stringify(
      {
        ok: true,
        orchestrator: ORCHESTRATOR_ID,
        coderCount: coders.length,
        multiTurnReworkCoderTurns: reworkTurns,
        sharedCoder: coders.some((c) => c.isolation === "shared"),
        cancelledCoder: coders.some((c) => c.planLane === "cancelled"),
        coders: report,
      },
      null,
      2,
    ),
  );
  yield* Console.log("\n--- sample turn-1 diff (first coder) ---\n" + firstDiffSample);
});

const main = Effect.gen(function* () {
  const config = yield* buildSeedConfig;
  const orchestrationLayer = OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  );
  const checkpointStoreLayer = CheckpointStore.layer.pipe(
    Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  );
  const layer = Layer.mergeAll(
    orchestrationLayer,
    CheckpointDiffQuery.layer.pipe(
      Layer.provide(Layer.mergeAll(orchestrationLayer, checkpointStoreLayer)),
    ),
  ).pipe(
    Layer.provideMerge(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error")),
  );

  yield* verifyProgram.pipe(Effect.provide(layer));
}).pipe(Effect.provide(NodeServices.layer));

if (import.meta.main) {
  NodeRuntime.runMain(main);
}
