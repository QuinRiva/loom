import { assert, it } from "@effect/vitest";
import { IsoDateTime, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { makeGateLegComposer } from "../../loom/orchestration/dispatcher/gateLegs.ts";
import { planReDrive } from "../../loom/orchestration/redrive.ts";
import { readWorkstream } from "../../loom/projection/LoomStore.ts";
import { runAllMigrations } from "../LoomMigrations.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));
const at = "2026-10-14T11:01:12.123Z";
const route = (to: string, round: number, kind: string, eventId: string) =>
  JSON.stringify({ to, round, kind, eventId });

layer("1067_LoomMultiSiblingGate", (it) => {
  it.effect(
    "moves last_route into last_routes and re-keys gate receipts to the planner's ids",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runAllMigrations({ toLoomMigrationInclusive: 1066 });
        const workstream = (
          id: string,
          fields: {
            outcome?: string;
            routes?: string;
            lastRoute?: string;
            pendingRework?: number;
            gateRounds?: number;
          },
        ) => sql`
        INSERT INTO loom_thread_workstream (
          thread_id, project_id, root_thread_id, outcome, routes, last_route, pending_rework,
          gate_rounds, created_at, updated_at
        ) VALUES (
          ${id}, 'p', 'root', ${fields.outcome ?? null}, ${fields.routes ?? "[]"},
          ${fields.lastRoute ?? null}, ${fields.pendingRework ?? 0}, ${fields.gateRounds ?? 0},
          ${at}, ${at}
        )`;
        const gate = (to: string) =>
          JSON.stringify([
            { on: ["needs_rework"], kind: "loop", to },
            { on: ["clean"], kind: "resolve" },
          ]);
        // A finished gate whose coder was reopened later, and a gate mid-round.
        yield* workstream("rev", {
          outcome: "done",
          routes: gate("cod"),
          lastRoute: route("cod", 1, "resolve", "e-resolve"),
          gateRounds: 1,
        });
        yield* workstream("cod", { lastRoute: route("rev", 1, "loop-back", "e-back") });
        yield* workstream("rev2", {
          routes: gate("cod2"),
          lastRoute: route("cod2", 2, "loop", "e-loop"),
          gateRounds: 2,
        });
        yield* workstream("cod2", { pendingRework: 1 });
        const receipt = (commandId: string, aggregateId: string) => sql`
        INSERT INTO orchestration_command_receipts (
          command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status
        ) VALUES (${commandId}, 'thread', ${aggregateId}, ${at}, 1, 'accepted')`;
        yield* receipt("server:workstream-gate:rev:1:rework", "cod");
        yield* receipt("server:workstream-gate:rev:1:reverify", "rev");
        yield* receipt("server:workstream-gate:rev:1:resolve", "cod");
        yield* receipt("server:workstream-gate:rev2:2:rework", "cod2");
        yield* receipt("server:loom:goal-attach:cod:goal", "cod");

        yield* runAllMigrations();
        const lastRoutes = yield* sql<{ readonly thread_id: string; readonly last_routes: string }>`
        SELECT thread_id, last_routes FROM loom_thread_workstream ORDER BY thread_id`;
        assert.deepStrictEqual(
          lastRoutes.map((row) => [row.thread_id, JSON.parse(row.last_routes).length]),
          [
            ["cod", 1],
            ["cod2", 0],
            ["rev", 1],
            ["rev2", 1],
          ],
        );
        const receipts = new Set(
          (yield* sql<{ readonly command_id: string }>`
          SELECT command_id FROM orchestration_command_receipts`).map((row) => row.command_id),
        );
        assert.deepStrictEqual([...receipts].toSorted(), [
          "server:loom:goal-attach:cod:goal",
          "server:workstream-gate:rev2:2:rework:cod2",
          "server:workstream-gate:rev:1:resolve:cod",
          "server:workstream-gate:rev:1:reverify",
          "server:workstream-gate:rev:1:rework:cod",
        ]);

        // The safety argument: every gate leg the planner derives from these rows is receipted, so a
        // finished or mid-round gate re-sends nothing (the reopened coder gets no second resolve).
        const rows = yield* Effect.forEach(["rev", "cod", "rev2", "cod2"], (id) =>
          readWorkstream(sql, ThreadId.make(id)).pipe(Effect.map((row) => row!)),
        );
        const planned = planReDrive({
          rows,
          now: IsoDateTime.make(at),
          gateLeg: makeGateLegComposer(new Map()),
        }).map((command) => command.commandId);
        assert.deepStrictEqual(planned, [
          "server:workstream-gate:rev:1:resolve:cod",
          "server:workstream-gate:rev2:2:rework:cod2",
        ]);
        assert.isTrue(planned.every((id) => receipts.has(id)));
      }),
  );
});
