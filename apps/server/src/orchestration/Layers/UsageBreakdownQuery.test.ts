import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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
        providerId: string,
        model: string | null,
        atMs: number,
        cost: number,
      ) => sql`
        INSERT INTO projection_usage_ledger (
          event_id, thread_id, turn_id, provider_instance_id,
          provider_id, requested_model, resolved_model, input_tokens, cache_read_tokens,
          cache_write_tokens, output_tokens, cost_usd, created_at
        ) VALUES (
          ${eventId}, ${threadId}, ${turnId}, ${provider},
          ${providerId}, ${model}, NULL, 100, 20, 30, 50, ${cost}, ${iso(atMs)}
        )
      `;
      // pi rows: all run via the pi driver kind but attribute to their real
      // backend — Anthropic-direct (metered by the claudeAgent subscription) and
      // Vertex-Claude (billed by Google ⇒ meterless). One old row 20 min ago so
      // the cost projection guard (>=15 min elapsed) passes.
      yield* insertLedger(
        "e1",
        "thread-C",
        "t1",
        "pi",
        "anthropic",
        "claude-fable-5",
        now - 20 * 60_000,
        1.0,
      );
      yield* insertLedger(
        "e2",
        "thread-C",
        "t2",
        "pi",
        "google-vertex-claude",
        "claude-opus",
        now - 5 * 60_000,
        2.0,
      );
      yield* insertLedger(
        "e3",
        "thread-R",
        "t3",
        "pi",
        "anthropic",
        "claude-fable-5",
        now - 3 * 60_000,
        0.5,
      );
      // codex row (Codex meter) via the pi driver: real backend is OpenAI, so it
      // lands in the codex scope — this is the Codex-tab fix in miniature.
      yield* insertLedger("e4", "thread-X", "t4", "pi", "openai", "gpt-5", now - 4 * 60_000, 0.0);

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

      // scope=claudeAgent is the Anthropic OAuth subscription meter, which
      // officially meters only the anthropic backend — the Vertex-Claude row is
      // meterless and excluded here (it surfaces under "all" / its own tab).
      assert.deepStrictEqual([...new Set(oneSample.models.map((m) => m.providerId))].sort(), [
        "anthropic",
      ]);
      const modelNames = oneSample.models.map((m) => m.model).sort();
      assert.deepStrictEqual(modelNames, ["claude-fable-5"]);
      // costShare sums ~1 over the scoped window.
      const shareSum = oneSample.models.reduce((s, m) => s + m.costShare, 0);
      assert.isTrue(Math.abs(shareSum - 1) < 1e-9);
      // consumers: C and R both roll up to root R; X (codex) excluded.
      const roots = new Set(oneSample.consumers.map((c) => c.rootThreadId));
      assert.deepStrictEqual([...roots], ["thread-R"]);
      const cRow = oneSample.consumers.find((c) => c.threadId === "thread-C");
      assert.strictEqual(cRow?.rootThreadId, "thread-R");
      assert.strictEqual(cRow?.role, "coder");
      // Only the anthropic row (t1) counts under the claudeAgent meter; the
      // Vertex row (t2) is meterless and excluded.
      assert.strictEqual(cRow?.turnCount, 1);
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
      assert.isTrue(all.models.some((m) => m.providerId === "openai"));
      assert.isTrue(all.consumers.some((c) => c.rootThreadId === "thread-X"));
      // The backend inventory (scope-independent) lists every real backend in
      // the window — including meterless Vertex — so the client can auto-derive a
      // per-backend tab for it. Cost-descending.
      assert.deepStrictEqual(
        all.providers.map((p) => p.providerId),
        ["google-vertex-claude", "anthropic", "openai"],
      );

      // ── A meterless backend scope isolates just its rows ──────────────────
      const vertex = yield* query.getBreakdown({
        window: "primary",
        scope: "google-vertex-claude",
      });
      assert.deepStrictEqual(
        [...new Set(vertex.models.map((m) => m.providerId))],
        ["google-vertex-claude"],
      );

      // ── scope="codex" matches the OpenAI backend, excludes Claude rows ─────
      const codex = yield* query.getBreakdown({ window: "primary", scope: "codex" });
      assert.deepStrictEqual([...new Set(codex.models.map((m) => m.providerId))], ["openai"]);

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
      yield* insertLedger(
        "e5",
        "thread-X",
        "t5",
        "pi",
        "openai",
        "gpt-5",
        weekStartMs + 10_000,
        3.0,
      );
      // Within-hour offset (5 min) precedes the boundary offset (61 min 47 s % hour):
      // hour-prefix bucketing rendered this at index 71 instead of 72.
      yield* insertLedger(
        "e6",
        "thread-X",
        "t6",
        "pi",
        "openai",
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

  it.effect("scopes boundaries and rows via backend ids and declared pooled meters", () =>
    Effect.gen(function* () {
      const query = yield* UsageBreakdownQuery;
      const registry = yield* AccountUsageRegistry;
      const sql = yield* SqlClient.SqlClient;

      // The layer (and its TestClock) is shared across tests in this file, so
      // step the clock forward and read the resulting "now" rather than
      // assuming it starts at epoch 0.
      yield* TestClock.adjust(Duration.hours(24));
      const now = yield* Clock.currentTimeMillis;

      yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, runtime_mode,
          interaction_mode, parent_thread_id, role, pending_approval_count,
          pending_user_input_count, has_actionable_proposed_plan, created_at, updated_at
        ) VALUES (
          'thread-P', 'project-1', 'title-P', '{"provider":"pi","model":"m"}', 'full-access',
          'default', NULL, 'orchestrator', 0, 0, 0, ${iso(now)}, ${iso(now)}
        )
      `;
      const insertLedger = (eventId: string, providerId: string, cost: number) => sql`
        INSERT INTO projection_usage_ledger (
          event_id, thread_id, turn_id, provider_instance_id,
          provider_id, requested_model, resolved_model, input_tokens, cache_read_tokens,
          cache_write_tokens, output_tokens, cost_usd, created_at
        ) VALUES (
          ${eventId}, 'thread-P', ${"turn-" + eventId}, 'pi',
          ${providerId}, 'claude-fable-5', NULL, 100, 20, 30, 50, ${cost}, ${iso(now - 5 * 60_000)}
        )
      `;
      yield* insertLedger("p1", "cliproxy", 2.0);
      yield* insertLedger("p2", "anthropic", 1.0);
      yield* insertLedger("p3", "google-vertex-claude", 4.0);

      // Direct Anthropic meter resets in 1 h; a pooled cliproxy account
      // (declared meteredProviderIds) resets in 2 h. The pooled snapshot is
      // observed later, so a slot-name/freshest fallback would wrongly hand the
      // anthropic tab the pooled boundary — backend-id matching must not.
      const anthropicReset = iso(now + 60 * 60_000);
      const pooledReset = iso(now + 2 * 60 * 60_000);
      yield* registry.update({
        providerName: "claudeAgent",
        providerInstanceId: null,
        windows: [
          { kind: "primary", usedPercent: 50, resetsAt: anthropicReset, windowDurationMins: 300 },
        ],
        planType: "max",
        observedAt: iso(now - 2 * 60_000),
      });
      yield* registry.update({
        providerName: "pi",
        providerInstanceId: ProviderInstanceId.make("pi"),
        accountLabel: "carl@",
        windows: [
          { kind: "primary", usedPercent: 20, resetsAt: pooledReset, windowDurationMins: 300 },
        ],
        planType: "max",
        observedAt: iso(now - 60_000),
        meteredProviderIds: ["cliproxy"],
      });

      // Backend-id scope "anthropic" → the claudeAgent meter's boundary + rows.
      const anthropic = yield* query.getBreakdown({ window: "primary", scope: "anthropic" });
      assert.strictEqual(anthropic.boundarySource, "provider");
      assert.strictEqual(anthropic.windowEnd, anthropicReset);
      assert.deepStrictEqual(
        [...new Set(anthropic.models.map((m) => m.providerId))],
        ["anthropic"],
      );

      // Backend-id scope "cliproxy" → the pooled meter's boundary + rows; the
      // pooled gauge carries its declared coverage to the client.
      const cliproxy = yield* query.getBreakdown({ window: "primary", scope: "cliproxy" });
      assert.strictEqual(cliproxy.boundarySource, "provider");
      assert.strictEqual(cliproxy.windowEnd, pooledReset);
      assert.deepStrictEqual([...new Set(cliproxy.models.map((m) => m.providerId))], ["cliproxy"]);
      const pooledGauge = cliproxy.gauges.find((g) => g.accountLabel === "carl@");
      assert.deepStrictEqual(pooledGauge?.meteredProviderIds, ["cliproxy"]);

      // Pooled-account storage-key scope (pill deep-link "pi\0carl@") resolves
      // rows through the declared coverage instead of matching nothing.
      const pill = yield* query.getBreakdown({ window: "primary", scope: "pi\u0000carl@" });
      assert.strictEqual(pill.windowEnd, pooledReset);
      assert.deepStrictEqual([...new Set(pill.models.map((m) => m.providerId))], ["cliproxy"]);
    }),
  );
});
