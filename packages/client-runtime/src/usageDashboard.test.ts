import { describe, expect, it } from "vite-plus/test";

import {
  buildUsageBurnChartGeometry,
  gaugeProjectionSentence,
  usageChartModelOrder,
} from "./usageDashboard.ts";

const models = [
  {
    model: "claude-opus",
    providerName: "pi",
    inputTokens: 1,
    cacheReadTokens: 2,
    cacheWriteTokens: 3,
    outputTokens: 4,
    costUsd: 3,
    costShare: 0.75,
  },
  {
    model: "gpt-5",
    providerName: "codex",
    inputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 1,
    costUsd: 1,
    costShare: 0.25,
  },
] as const;

const series = [
  { bucketStart: "2026-07-03T10:00:00.000Z", byModel: { "claude-opus": 1 } },
  { bucketStart: "2026-07-03T10:05:00.000Z", byModel: { "gpt-5": 1 } },
  { bucketStart: "2026-07-03T10:10:00.000Z", byModel: { "claude-opus": 2 } },
] as const;

describe("usageChartModelOrder", () => {
  it("orders stacked chart models by window cost", () => {
    expect(usageChartModelOrder(models, series)).toEqual(["claude-opus", "gpt-5"]);
  });
});

describe("gaugeProjectionSentence", () => {
  it("hides gauge projection copy when WP2 slope guards returned null", () => {
    expect(
      gaugeProjectionSentence(
        {
          providerName: "pi",
          providerInstanceId: null,
          planType: null,
          usedPercent: 42,
          resetsAt: "2026-07-03T15:00:00.000Z",
          windowDurationMins: 300,
          observedAt: "2026-07-03T10:00:00.000Z",
          projectedExhaustionAt: null,
        },
        Date.parse("2026-07-03T10:00:00.000Z"),
      ),
    ).toBeNull();
  });
});

describe("buildUsageBurnChartGeometry", () => {
  it("stacks bucket costs cumulatively and keeps the chart total aligned with the model table", () => {
    const chart = buildUsageBurnChartGeometry({
      series,
      models,
      windowStart: "2026-07-03T10:00:00.000Z",
      windowEnd: "2026-07-03T15:00:00.000Z",
      now: "2026-07-03T10:20:00.000Z",
      bucketMinutes: 5,
      projectedCostAtReset: 40,
      width: 760,
      height: 260,
    });

    expect(chart.currentCostUsd).toBe(4);
    expect(chart.layers.map((layer) => [layer.model, layer.costUsd])).toEqual([
      ["claude-opus", 3],
      ["gpt-5", 1],
    ]);
    expect(chart.projectionPath).toMatch(/^M /);
  });

  it("draws late bucket cost as a vertical step, not a diagonal ramp from window start", () => {
    const chart = buildUsageBurnChartGeometry({
      series: [{ bucketStart: "2026-07-03T10:10:00.000Z", byModel: { "claude-opus": 2 } }],
      models: [models[0]],
      windowStart: "2026-07-03T10:00:00.000Z",
      windowEnd: "2026-07-03T15:00:00.000Z",
      now: "2026-07-03T10:20:00.000Z",
      bucketMinutes: 5,
      projectedCostAtReset: null,
      width: 760,
      height: 260,
    });

    expect(chart.layers[0]?.path).toContain("L 67.5 232.0 L 67.5 12.0");
  });

  it("omits the dashed projection when the server-side projection guards returned null", () => {
    const chart = buildUsageBurnChartGeometry({
      series,
      models,
      windowStart: "2026-07-03T10:00:00.000Z",
      windowEnd: "2026-07-03T15:00:00.000Z",
      now: "2026-07-03T10:20:00.000Z",
      bucketMinutes: 5,
      projectedCostAtReset: null,
      width: 760,
      height: 260,
    });

    expect(chart.projectionPath).toBeNull();
  });
});
