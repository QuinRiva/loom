import { EventId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlError from "effect/unstable/sql/SqlError";

import * as ServerConfig from "../../config.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { LoomPersistenceLive } from "../../loom/serverLayers.ts";
import { ProjectionUsageLedgerRepository } from "../Services/ProjectionUsageLedger.ts";
import { ProjectionUsageLedgerRepositoryLive } from "./ProjectionUsageLedger.ts";
import * as Sqlite from "./Sqlite.ts";
import { OrchestrationLayerOnSqlReadClient, ProjectionUsageLedgerReader } from "./SqliteLanes.ts";

// The usage ledger is the one repository built on both lanes, so it is where a
// layer-memo collision shows: one shared instance would make both inserts land
// on the same connection. It happened once — ingestion's inserts silently ran on
// the `query_only` reader from 2026-09-23.
it.live("keeps the ledger writer on the write lane and the ledger reader on the read lane", () =>
  Effect.gen(function* () {
    const configLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-sqlite-lanes-",
    }).pipe(Layer.provide(NodeServices.layer));
    const layer = Layer.mergeAll(
      ProjectionUsageLedgerRepositoryLive,
      OrchestrationLayerOnSqlReadClient,
    ).pipe(
      Layer.provideMerge(LoomPersistenceLive),
      Layer.provideMerge(RepositoryIdentityResolver.layer),
      // loom: thread search's embedder off — this test is about SQL lanes.
      Layer.provideMerge(ServerSettings.layerTest({ threadSearchEmbedding: { provider: "none" } })),
      Layer.provideMerge(Sqlite.layerConfig),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(configLayer),
    );

    yield* Effect.gen(function* () {
      const row = (eventId: string) => ({
        eventId: EventId.make(eventId),
        threadId: ThreadId.make("thread-ledger-lane"),
        turnId: null,
        providerInstanceId: "pi",
        providerId: null,
        requestedModel: null,
        resolvedModel: null,
        inputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        costUsd: 0.5,
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      yield* (yield* ProjectionUsageLedgerRepository).insert(row("evt-writer"));
      const { cause } = yield* (yield* ProjectionUsageLedgerReader)
        .insert(row("evt-reader"))
        .pipe(Effect.flip);
      assert.match(
        String(SqlError.isSqlError(cause) && cause.reason.cause),
        /attempt to write a readonly database/,
      );
    }).pipe(Effect.provide(layer));
  }),
);
