import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  AccountUsageRegistry,
  AccountUsageRegistryLive,
} from "../../provider/Services/AccountUsageRegistry.ts";
import { UsageBreakdownQueryLive } from "./UsageBreakdownQuery.ts";
import { UsageBreakdownQuery } from "../Services/UsageBreakdownQuery.ts";

const layer = it.layer(
  UsageBreakdownQueryLive.pipe(
    Layer.provideMerge(AccountUsageRegistryLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

layer("UsageBreakdownQuery.verify", (it) => {
  it.effect("aggregates ledger over the provider window with scope filtering", () =>
    Effect.gen(function* () {
      const query = yield* UsageBreakdownQuery;
      const registry = yield* AccountUsageRegistry;
      const sql = yield* SqlClient.SqlClient;

      // @effect/vitest's it.effect runs on a TestClock (starts at epoch 0);
      // advance it to a realistic "now" so window/projection maths is exercised.
      const now = Date.parse("2027-01-15T12:00:00.000Z");
      yield* TestClock.adjust(Duration.millis(now));

      // Threads: root R (orchestrator), child C (coder), independent codex root X.
      const insertThread = (id: string, parent: string | null, role: string) => sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, parent_thread_id, role, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan, created_at, updated_at
        ) VALUES (
          ${id}, 'project-1', ${"title-" + id}, '{"provider":"pi","model":"m"}', 'full-access',
          'default', ${parent}, ${role}, 0, 0, 0, ${iso(now)}, ${iso(now)}
        )
      `;
      yield* insertThread("thread-R", null, "orchestrator");
      yield* insertThread("thread-C", "thread-R", "coder");
      yield* insertThread("thread-X", null, "orchestrator");

      const insertLedger = (
        eventId: string,
        threadId: string,
        turnId: string,
        provider: string,
        model: string | null,
        atMs: number,
        cost: number,
      ) => sql`
        INSERT INTO projection_usage_ledger (
          event_id, thread_id, turn_id, provider_name, provider_instance_id,
          requested_model, resolved_model, input_tokens, cache_read_tokens,
          cache_write_tokens, output_tokens, cost_usd, created_at
        ) VALUES (
          ${eventId}, ${threadId}, ${turnId}, ${provider}, ${provider},
          ${model}, NULL, 100, 20, 30, 50, ${cost}, ${iso(atMs)}
        )
      `;
      // pi rows (Anthropic meter): child C two turns/models, root R one; one old
      // row 20 min ago so the cost projection guard (>=15 min elapsed) passes.
      yield* insertLedger("e1", "thread-C", "t1", "pi", "claude-fable-5", now - 20 * 60_000, 1.0);
      yield* insertLedger("e2", "thread-C", "t2", "pi", "claude-opus", now - 5 * 60_000, 2.0);
      yield* insertLedger("e3", "thread-R", "t3", "pi", "claude-fable-5", now - 3 * 60_000, 0.5);
      // codex row (Codex meter), independent root X.
      yield* insertLedger("e4", "thread-X", "t4", "codex", "gpt-5", now - 4 * 60_000, 0.0);

      // ── Trailing mode: registry empty ⇒ no provider boundaries, no gauges ──
      const trailing = yield* query.getBreakdown({ window: "primary" });
      assert.strictEqual(trailing.boundarySource, "trailing");
      assert.deepStrictEqual(trailing.gauges, []);
      // Trailing mode has no reset to project to ⇒ null, even with ≥15 min of rows.
      assert.strictEqual(trailing.projectedCostAtReset, null);
      assert.strictEqual(trailing.bucketMinutes, 5);
      assert.strictEqual(trailing.windowEnd, trailing.windowEnd); // present

      // Feed the Anthropic gauge with a single sample first (projection guard: <3).
      const resetsAt = iso(now + 2 * 60 * 60_000);
      yield* registry.update({
        providerName: "claudeAgent",
        providerInstanceId: null,
        windows: [{ kind: "primary", usedPercent: 30, resetsAt, windowDurationMins: 300 }],
        planType: "max",
        observedAt: iso(now - 15 * 60_000),
      });

      const oneSample = yield* query.getBreakdown({ window: "primary", scope: "claudeAgent" });
      assert.strictEqual(oneSample.boundarySource, "provider");
      assert.strictEqual(oneSample.scope, "claudeAgent");
      assert.strictEqual(oneSample.gauges.length, 1);
      // Guard unmet (only 1 sample) ⇒ null projection.
      assert.strictEqual(oneSample.gauges[0]!.projectedExhaustionAt, null);
      // window boundaries from provider reset.
      assert.strictEqual(oneSample.windowEnd, resetsAt);
      assert.strictEqual(oneSample.windowStart, iso(now + 2 * 60 * 60_000 - 300 * 60_000));

      // scope=claudeAgent excludes the codex row: models are pi-only.
      assert.deepStrictEqual([...new Set(oneSample.models.map((m) => m.providerName))].sort(), [
        "pi",
      ]);
      const modelNames = oneSample.models.map((m) => m.model).sort();
      assert.deepStrictEqual(modelNames, ["claude-fable-5", "claude-opus"]);
      // costShare sums ~1 over the scoped window.
      const shareSum = oneSample.models.reduce((s, m) => s + m.costShare, 0);
      assert.isTrue(Math.abs(shareSum - 1) < 1e-9);
      // consumers: C and R both roll up to root R; X (codex) excluded.
      const roots = new Set(oneSample.consumers.map((c) => c.rootThreadId));
      assert.deepStrictEqual([...roots], ["thread-R"]);
      const cRow = oneSample.consumers.find((c) => c.threadId === "thread-C");
      assert.strictEqual(cRow?.rootThreadId, "thread-R");
      assert.strictEqual(cRow?.role, "coder");
      assert.strictEqual(cRow?.turnCount, 2);
      // cost projection: an old (20 min) row ⇒ elapsed>=15 ⇒ non-null.
      assert.isNotNull(oneSample.projectedCostAtReset);

      // Add two more samples over a >=10 min span with rising % ⇒ positive slope.
      yield* registry.update({
        providerName: "claudeAgent",
        providerInstanceId: null,
        windows: [{ kind: "primary", usedPercent: 35, resetsAt, windowDurationMins: 300 }],
        planType: "max",
        observedAt: iso(now - 8 * 60_000),
      });
      yield* registry.update({
        providerName: "claudeAgent",
        providerInstanceId: null,
        windows: [{ kind: "primary", usedPercent: 40, resetsAt, windowDurationMins: 300 }],
        planType: "max",
        observedAt: iso(now),
      });
      const projected = yield* query.getBreakdown({ window: "primary", scope: "claudeAgent" });
      const exhaustion = projected.gauges[0]!.projectedExhaustionAt;
      assert.isNotNull(exhaustion);
      // Lands before the reset (guard).
      assert.isTrue(Date.parse(exhaustion!) < now + 2 * 60 * 60_000);

      // ── scope="all" includes the codex row ────────────────────────────────
      const all = yield* query.getBreakdown({ window: "primary", scope: "all" });
      assert.isTrue(all.models.some((m) => m.providerName === "codex"));
      assert.isTrue(all.consumers.some((c) => c.rootThreadId === "thread-X"));

      // ── scope="codex" excludes pi rows ────────────────────────────────────
      const codex = yield* query.getBreakdown({ window: "primary", scope: "codex" });
      assert.deepStrictEqual([...new Set(codex.models.map((m) => m.providerName))], ["codex"]);

      // Series buckets are contiguous 5-min from windowStart up to now.
      const startMs = Date.parse(all.windowStart);
      all.series.forEach((bucket, i) => {
        assert.strictEqual(bucket.bucketStart, iso(startMs + i * 5 * 60_000));
      });
      // Total series cost equals window cost (scope=all).
      const seriesCost = all.series.reduce(
        (sum, b) => sum + Object.values(b.byModel).reduce((s, v) => s + v, 0),
        0,
      );
      const modelCost = all.models.reduce((s, m) => s + m.costUsd, 0);
      assert.isTrue(Math.abs(seriesCost - modelCost) < 1e-9);

      // ── Second-misaligned reset (codex-style epoch seconds): no series loss ─
      // Weekly reset 47 s past the minute ⇒ windowStart inherits the offset;
      // rows in the first partial minute/hour used to fall off the bucket grid
      // and mid-window rows shifted one bucket early.
      const misalignedReset = iso(now + 61 * 60_000 + 47_000);
      yield* registry.update({
        providerName: "codex",
        providerInstanceId: null,
        windows: [
          {
            kind: "secondary",
            usedPercent: 10,
            resetsAt: misalignedReset,
            windowDurationMins: 7 * 24 * 60,
          },
        ],
        planType: null,
        observedAt: iso(now),
      });
      const weekStartMs = Date.parse(misalignedReset) - 7 * 24 * 60 * 60_000;
      // 10 s into the window: minute prefix precedes windowStart (clamps to bucket 0).
      yield* insertLedger("e5", "thread-X", "t5", "codex", "gpt-5", weekStartMs + 10_000, 3.0);
      // Within-hour offset (5 min) precedes the boundary offset (61 min 47 s % hour):
      // hour-prefix bucketing rendered this at index 71 instead of 72.
      yield* insertLedger(
        "e6",
        "thread-X",
        "t6",
        "codex",
        "gpt-5",
        weekStartMs + 72 * 60 * 60_000 + 5 * 60_000,
        4.0,
      );

      const weekly = yield* query.getBreakdown({ window: "secondary", scope: "codex" });
      assert.strictEqual(weekly.boundarySource, "provider");
      assert.strictEqual(weekly.windowStart, iso(weekStartMs));
      // No negative-index loss: series total equals model total.
      const weeklySeriesCost = weekly.series.reduce(
        (sum, b) => sum + Object.values(b.byModel).reduce((s, v) => s + v, 0),
        0,
      );
      const weeklyModelCost = weekly.models.reduce((s, m) => s + m.costUsd, 0);
      assert.isTrue(Math.abs(weeklySeriesCost - weeklyModelCost) < 1e-9);
      // First-partial-minute row clamps into bucket 0…
      assert.strictEqual(weekly.series[0]!.byModel["gpt-5"], 3.0);
      // …and the mid-window row sits in its true bucket (72 h → index 72, not 71).
      assert.strictEqual(weekly.series[72]!.byModel["gpt-5"], 4.0);

      // ── Stale registry reset (resetsAt in the past) ⇒ trailing fallback ────
      yield* registry.update({
        providerName: "claudeAgent",
        providerInstanceId: null,
        windows: [
          {
            kind: "primary",
            usedPercent: 90,
            resetsAt: iso(now - 60_000),
            windowDurationMins: 300,
          },
        ],
        planType: "max",
        observedAt: iso(now - 30 * 60_000),
      });
      const stale = yield* query.getBreakdown({ window: "primary", scope: "claudeAgent" });
      assert.strictEqual(stale.boundarySource, "trailing");
      assert.strictEqual(stale.windowEnd, iso(now));
      assert.strictEqual(stale.projectedCostAtReset, null);
    }),
  );
});
