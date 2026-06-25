import type { ModelSelection } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePresetSelection } from "./WorkstreamSpawnHttp.ts";

const sel = (instanceId: string, model: string): ModelSelection =>
  ({ instanceId, model }) as ModelSelection;

const parent = sel("pi", "parent-model");
const reviewerPreset = sel("codex", "gpt-5.4");
const coderPreset = sel("pi", "coder-model");
const presets: Record<string, ModelSelection> = {
  reviewer: reviewerPreset,
  coder: coderPreset,
};

describe("resolvePresetSelection (spawn precedence steps 2-4)", () => {
  it("uses a named modelPreset when it exists", () => {
    const r = resolvePresetSelection({
      presets,
      modelPreset: "reviewer",
      role: "coder",
      parentSelection: parent,
    });
    expect(r).toEqual({ kind: "selection", selection: reviewerPreset });
  });

  it("reports unknown-preset with the available names when the name is missing", () => {
    const r = resolvePresetSelection({
      presets,
      modelPreset: "nope",
      role: "coder",
      parentSelection: parent,
    });
    expect(r).toEqual({
      kind: "unknown-preset",
      modelPreset: "nope",
      available: ["reviewer", "coder"],
    });
  });

  it("reports an empty available list when no presets are configured", () => {
    const r = resolvePresetSelection({
      presets: {},
      modelPreset: "nope",
      role: "coder",
      parentSelection: parent,
    });
    expect(r).toEqual({ kind: "unknown-preset", modelPreset: "nope", available: [] });
  });

  it("falls back to a preset keyed by role when no modelPreset is given", () => {
    const r = resolvePresetSelection({
      presets,
      modelPreset: undefined,
      role: "reviewer",
      parentSelection: parent,
    });
    expect(r).toEqual({ kind: "selection", selection: reviewerPreset });
  });

  it("inherits the parent's selection when neither a modelPreset nor a role preset matches", () => {
    const r = resolvePresetSelection({
      presets,
      modelPreset: undefined,
      role: "researcher",
      parentSelection: parent,
    });
    expect(r).toEqual({ kind: "selection", selection: parent });
  });
});
