import { describe, expect, it } from "vite-plus/test";

import {
  buildUsageBurnChartGeometry,
  deriveUsageScopeTabs,
  gaugeAppliesToScope,
  gaugeProjectionSentence,
  isMeterlessProvider,
  normalizeUsageScope,
  usageChartModelOrder,
} from "./usageDashboard.ts";

const gauge = (providerName: string) => ({
  providerName,
  providerInstanceId: null,
  planType: null,
  usedPercent: 30,
  resetsAt: "2026-07-03T15:00:00.000Z",
  windowDurationMins: 300,
  observedAt: "2026-07-03T10:00:00.000Z",
  projectedExhaustionAt: null,
});

const models = [
  {
    model: "claude-opus",
    providerId: "google-vertex-claude",
    inputTokens: 1,
    cacheReadTokens: 2,
    cacheWriteTokens: 3,
    outputTokens: 4,
    costUsd: 3,
    costShare: 0.75,
  },
  {
    model: "gpt-5",
    providerId: "openai",
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

describe("deriveUsageScopeTabs", () => {
  it("auto-derives one tab per backend seen in usage (cost order) plus All, with a gauge flag", () => {
    const tabs = deriveUsageScopeTabs(
      [
        { providerId: "google-vertex-claude", costUsd: 1000 },
        { providerId: "openai-codex", costUsd: 62 },
        { providerId: "anthropic", costUsd: 5 },
      ],
      [gauge("claudeAgent"), gauge("codex")],
    );
    expect(tabs.map((t) => [t.key, t.label, t.hasGauge])).toEqual([
      ["google-vertex-claude", "Vertex", false], // meterless pay-per-use backend
      ["openai-codex", "Codex", true],
      ["anthropic", "Anthropic", true],
      ["all", "All providers", false],
    ]);
  });

  it("unions a gauge-backed backend that has no tracked rows yet", () => {
    const tabs = deriveUsageScopeTabs([], [gauge("claudeAgent")]);
    expect(tabs.map((t) => t.key)).toEqual(["anthropic", "all"]);
  });
});

describe("gaugeAppliesToScope / meterless / normalize", () => {
  it("attaches a gauge only to the backend its meter officially covers", () => {
    expect(gaugeAppliesToScope(gauge("claudeAgent"), "anthropic")).toBe(true);
    expect(gaugeAppliesToScope(gauge("claudeAgent"), "google-vertex-claude")).toBe(false);
    expect(gaugeAppliesToScope(gauge("codex"), "openai-codex")).toBe(true);
    expect(gaugeAppliesToScope(gauge("claudeAgent"), "all")).toBe(true);
  });

  it("treats Vertex/Bedrock as meterless and Anthropic/OpenAI as metered", () => {
    expect(isMeterlessProvider("google-vertex-claude")).toBe(true);
    expect(isMeterlessProvider("bedrock")).toBe(true);
    expect(isMeterlessProvider("anthropic")).toBe(false);
    expect(isMeterlessProvider("openai-codex")).toBe(false);
  });

  it("maps a legacy meter-key scope to its primary backend, passing others through", () => {
    expect(normalizeUsageScope("claudeAgent")).toBe("anthropic");
    expect(normalizeUsageScope("codex")).toBe("openai-codex");
    expect(normalizeUsageScope("google-vertex-claude")).toBe("google-vertex-claude");
    expect(normalizeUsageScope("all")).toBe("all");
  });
});

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
