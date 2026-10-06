// loom: DL-74 on V2 — deleting a thread leaves no provider-session binding rows, even for a
// session idle release already recorded as stopped (driver plan §5b, DR-10).
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapterV2Shape;
const database = SqlitePersistenceMemory;
const testLayer = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  makeOrchestratorV2ReplayLayerWithRegistry(
    { name: "loom-thread-deletion" },
    ProviderAdapterRegistry.makeLayer([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

it.effect("thread.delete unbinds stopped sessions and detaches only live ones", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:loom-delete");
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-loom-delete"),
      threadId,
      projectId: ProjectId.make("project:loom-delete"),
      title: "Delete me",
      modelSelection: { instanceId, model: "gpt-5.5" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const session = (id: string, status: "ready" | "stopped") => ({
      id: ProviderSessionId.make(id),
      driver: adapter.driver,
      providerInstanceId: instanceId,
      status,
      cwd: "/repo",
      model: "gpt-5.5",
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    });
    // An idle-released session: attached, then recorded stopped without a detach.
    yield* projections.apply({
      id: EventId.make("attach-stopped"),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: session("session:stopped", "ready"),
    });
    yield* projections.apply({
      id: EventId.make("stop-stopped"),
      type: "provider-session.updated",
      threadId,
      occurredAt: now,
      payload: session("session:stopped", "stopped"),
    });
    yield* projections.apply({
      id: EventId.make("attach-live"),
      type: "provider-session.attached",
      threadId,
      occurredAt: now,
      payload: session("session:live", "ready"),
    });

    yield* orchestrator.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete-loom-delete"),
      threadId,
    });

    const bindings = yield* sql<{ readonly n: number }>`
      SELECT count(*) AS n FROM orchestration_v2_projection_provider_session_bindings
      WHERE thread_id = ${threadId}`;
    assert.equal(bindings[0]!.n, 0);
    const detaches = yield* sql<{ readonly id: string }>`
      SELECT effect_id AS id FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId} AND effect_type = 'provider-session.detach'`;
    assert.deepEqual(
      detaches.map((row) => row.id),
      ["effect:delete-loom-delete:provider-session.detach:session:live"],
    );
  }).pipe(Effect.provide(testLayer)),
);
