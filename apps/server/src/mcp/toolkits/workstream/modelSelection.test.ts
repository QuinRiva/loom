import { describe, expect, it } from "@effect/vitest";
import {
  type ModelSelection,
  ProviderInstanceId,
  type WorkstreamModelProfile,
} from "@t3tools/contracts";

import {
  headroomBucketFor,
  resolveSpawnModelSelection,
  type SpawnModelInput,
} from "./modelSelection.ts";

const pi = (model: string, thinking?: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make("pi"),
  model,
  ...(thinking === undefined ? {} : { options: [{ id: "thinkingLevel", value: thinking }] }),
});

const profile = (selection: ModelSelection, thoroughness: number): WorkstreamModelProfile => ({
  selection,
  scores: { horsepower: 7, goalOrientation: 7, thoroughness, endurance: 7 },
  costPerMtok: { input: 1, output: 5 },
  agentic: "full",
});

const base: SpawnModelInput = {
  explicit: undefined,
  modelPreset: undefined,
  taskShape: undefined,
  sensitive: undefined,
  presets: { coder: pi("anthropic/claude-opus-5", "high") },
  profiles: {},
  catalogue: [{ instanceId: "pi", models: [] }],
  role: "coder",
  parentSelection: pi("anthropic/claude-sonnet-5", "low"),
  headroom: { usage: [], isExhausted: () => false, usageSourceInstances: new Set(), nowMs: 0 },
};

describe("resolveSpawnModelSelection", () => {
  it("emits upstream's thinking option id for presets and inherited selections, never thinkingLevel", () => {
    for (const input of [base, { ...base, role: "researcher" }]) {
      const result = resolveSpawnModelSelection(input);
      expect(result.kind).toBe("ok");
      const options = result.kind === "ok" ? result.selection.options : undefined;
      expect(options?.map((option) => option.id)).toEqual(["thinking"]);
    }
  });

  it("taskShape picks the best-ranked profile, and falls through to the role preset with a warning when none match", () => {
    const shaped = resolveSpawnModelSelection({
      ...base,
      taskShape: "thorough",
      profiles: {
        careful: profile(pi("anthropic/claude-fable-5"), 9),
        quick: profile(pi("openai-codex/gpt-6"), 4),
      },
    });
    expect(shaped).toMatchObject({ kind: "ok", selection: { model: "anthropic/claude-fable-5" } });

    const fallThrough = resolveSpawnModelSelection({ ...base, taskShape: "explore" });
    expect(fallThrough).toMatchObject({
      kind: "ok",
      selection: { model: "anthropic/claude-opus-5" },
    });
    expect(fallThrough.kind === "ok" ? fallThrough.warnings.join("\n") : "").toContain(
      "falling through to the role preset",
    );
  });

  it("refuses an unknown preset and an unconfigured instance", () => {
    expect(resolveSpawnModelSelection({ ...base, modelPreset: "nope" })).toMatchObject({
      kind: "error",
      message: expect.stringContaining('Unknown modelPreset "nope"'),
    });
    expect(
      resolveSpawnModelSelection({
        ...base,
        explicit: { instanceId: ProviderInstanceId.make("ghost"), model: "x" },
      }),
    ).toMatchObject({ kind: "error", message: expect.stringContaining('instanceId "ghost"') });
  });
});

describe("headroomBucketFor", () => {
  it("is healthy on unknown data and skipped on an exhaustion mark", () => {
    const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
    expect(headroomBucketFor(selection, base.headroom)).toBe("healthy");
    expect(headroomBucketFor(selection, { ...base.headroom, isExhausted: () => true })).toBe(
      "skipped",
    );
  });
});
