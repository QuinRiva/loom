import type { ModelSelection, ThreadId, ThreadIsolation, ThreadPlanLane } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hasThreadStarted,
  invalidModelSelectionMessage,
  modelCatalogueOf,
  presetCatalogueOf,
  resolvePresetSelection,
  validateModelSelection,
  validateSpawnGraph,
  type ModelCatalogueEntry,
} from "./WorkstreamSpawnHttp.ts";

const sel = (instanceId: string, model: string): ModelSelection =>
  ({ instanceId, model }) as ModelSelection;

const parent = sel("pi", "parent-model");
const reviewerPreset = sel("codex", "gpt-5.4");
const coderPreset = sel("pi", "coder-model");
const presets: Record<string, ModelSelection> = {
  reviewer: reviewerPreset,
  coder: coderPreset,
};

const id = (value: string): ThreadId => value as ThreadId;

const sibling = (
  value: string,
  overrides: {
    readonly title?: string;
    readonly role?: string | null;
    readonly parentThreadId?: ThreadId | null;
    readonly planLane?: ThreadPlanLane;
    readonly blockedBy?: ReadonlyArray<ThreadId>;
    readonly isolation?: ThreadIsolation;
    readonly session?: unknown | null;
    readonly latestUserMessageAt?: string | null;
  } = {},
) => ({
  id: id(value),
  title: overrides.title ?? value,
  role: overrides.role ?? "coder",
  parentThreadId: overrides.parentThreadId === undefined ? id("parent") : overrides.parentThreadId,
  planLane: overrides.planLane ?? "ready",
  blockedBy: overrides.blockedBy ?? [],
  session: overrides.session ?? null,
  latestUserMessageAt: overrides.latestUserMessageAt ?? null,
});

const ok = (result: ReturnType<typeof validateSpawnGraph>) => {
  expect(result.kind).toBe("ok");
  return result as Extract<ReturnType<typeof validateSpawnGraph>, { readonly kind: "ok" }>;
};

const rejected = (result: ReturnType<typeof validateSpawnGraph>) => {
  expect(result.kind).toBe("rejected");
  return result as Extract<ReturnType<typeof validateSpawnGraph>, { readonly kind: "rejected" }>;
};

describe("resolvePresetSelection (spawn precedence steps 2-4)", () => {
  it("uses a named modelPreset when it exists", () => {
    const r = resolvePresetSelection({
      presets,
      modelPreset: "reviewer",
      role: "coder",
      parentSelection: parent,
    });
    expect(r).toEqual({
      kind: "selection",
      selection: reviewerPreset,
      source: { kind: "preset", name: "reviewer" },
    });
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
    expect(r).toEqual({
      kind: "selection",
      selection: reviewerPreset,
      source: { kind: "role-preset", role: "reviewer" },
    });
  });

  it("inherits the parent's selection when neither a modelPreset nor a role preset matches", () => {
    const r = resolvePresetSelection({
      presets,
      modelPreset: undefined,
      role: "researcher",
      parentSelection: parent,
    });
    expect(r).toEqual({ kind: "selection", selection: parent, source: { kind: "inherited" } });
  });
});

describe("validateSpawnGraph", () => {
  it("rejects a dangling blockedBy id and names the known siblings", () => {
    const result = rejected(
      validateSpawnGraph({
        siblings: [sibling("coder-a", { title: "Build it" })],
        blockedBy: [id("typo")],
        gateRework: undefined,
        isolationOverride: undefined,
        role: "reviewer",
      }),
    );
    expect(result.message).toContain("typo");
    expect(result.message).toContain("coder-a");
    expect(result.message).toContain("Use the exact childThreadId");
  });

  it("rejects non-sibling and archived ids but accepts active siblings", () => {
    const active = sibling("active");
    const crossParent = sibling("cousin", { parentThreadId: id("other-parent") });
    const archived = sibling("archived", { title: "Old child" });

    expect(
      validateSpawnGraph({
        siblings: [active],
        blockedBy: [crossParent.id],
        gateRework: undefined,
        isolationOverride: undefined,
        role: "coder",
      }).kind,
    ).toBe("rejected");
    const archivedResult = rejected(
      validateSpawnGraph({
        siblings: [active],
        archivedSiblings: [archived],
        blockedBy: [archived.id],
        gateRework: undefined,
        isolationOverride: undefined,
        role: "coder",
      }),
    );
    expect(archivedResult.message).toContain("archived and no longer active");
    expect(
      ok(
        validateSpawnGraph({
          siblings: [active],
          blockedBy: [active.id],
          gateRework: undefined,
          isolationOverride: undefined,
          role: "coder",
        }),
      ).blockedBy,
    ).toEqual([active.id]);
  });

  it("accepts and dedupes duplicate sibling ids", () => {
    const active = sibling("active");
    expect(
      ok(
        validateSpawnGraph({
          siblings: [active],
          blockedBy: [active.id, active.id],
          gateRework: undefined,
          isolationOverride: undefined,
          role: "coder",
        }),
      ).blockedBy,
    ).toEqual([active.id]);
  });

  it("auto-injects gate.rework into blockedBy and still rejects divergent typos", () => {
    const coder = sibling("coder");
    const injected = ok(
      validateSpawnGraph({
        siblings: [coder],
        blockedBy: undefined,
        gateRework: coder.id,
        isolationOverride: undefined,
        role: "reviewer",
      }),
    );
    expect(injected.blockedBy).toEqual([coder.id]);
    expect(injected.warnings.join("\n")).toContain("added to blockedBy automatically");

    const divergent = rejected(
      validateSpawnGraph({
        siblings: [coder],
        blockedBy: [id("typo")],
        gateRework: coder.id,
        isolationOverride: undefined,
        role: "reviewer",
      }),
    );
    expect(divergent.message).toContain("typo");
  });

  it("forces attached isolation for gated reviewers while honouring non-gate overrides", () => {
    const coder = sibling("coder");
    const gated = ok(
      validateSpawnGraph({
        siblings: [coder],
        blockedBy: [coder.id],
        gateRework: coder.id,
        isolationOverride: "shared",
        role: "reviewer",
      }),
    );
    expect(gated.forceAttached).toBe(true);
    expect(gated.warnings.join("\n")).toContain('isolation "shared" was ignored');

    expect(
      ok(
        validateSpawnGraph({
          siblings: [coder],
          blockedBy: [coder.id],
          gateRework: undefined,
          isolationOverride: "shared",
          role: "reviewer",
        }),
      ).forceAttached,
    ).toBe(false);
  });

  it("warns on cancelled dependencies", () => {
    const cancelled = sibling("cancelled", { planLane: "cancelled" });
    expect(
      ok(
        validateSpawnGraph({
          siblings: [cancelled],
          blockedBy: [cancelled.id],
          gateRework: undefined,
          isolationOverride: undefined,
          role: "coder",
        }),
      ).warnings.join("\n"),
    ).toContain("cancelled dependency never releases");
  });

  it("warns when gate.rework targets a reader-style role", () => {
    const reviewer = sibling("reviewer", { role: "reviewer" });
    const coder = sibling("coder", { role: "coder" });
    expect(
      ok(
        validateSpawnGraph({
          siblings: [reviewer],
          blockedBy: [reviewer.id],
          gateRework: reviewer.id,
          isolationOverride: undefined,
          role: "reviewer",
        }),
      ).warnings.join("\n"),
    ).toContain("reader-style role");
    expect(
      ok(
        validateSpawnGraph({
          siblings: [coder],
          blockedBy: [coder.id],
          gateRework: coder.id,
          isolationOverride: undefined,
          role: "reviewer",
        }),
      ).warnings.join("\n"),
    ).not.toContain("reader-style role");
  });

  it("bounds maxRounds at 10", () => {
    const coder = sibling("coder");
    expect(
      validateSpawnGraph({
        siblings: [coder],
        blockedBy: [coder.id],
        gateRework: coder.id,
        gateMaxRounds: 10,
        isolationOverride: undefined,
        role: "reviewer",
      }).kind,
    ).toBe("ok");
    const overLimit = rejected(
      validateSpawnGraph({
        siblings: [coder],
        blockedBy: [coder.id],
        gateRework: coder.id,
        gateMaxRounds: 11,
        isolationOverride: undefined,
        role: "reviewer",
      }),
    );
    expect(overLimit.message).toContain("between 1 and 10");
  });

  it("rejects spawning behind an existing dependency cycle", () => {
    const a = sibling("a", { blockedBy: [id("b")] });
    const b = sibling("b", { blockedBy: [id("a")] });
    const cycle = rejected(
      validateSpawnGraph({
        siblings: [a, b],
        blockedBy: [a.id],
        gateRework: undefined,
        isolationOverride: undefined,
        role: "coder",
      }),
    );
    expect(cycle.message).toContain("dependency cycle");

    expect(
      validateSpawnGraph({
        siblings: [sibling("a", { blockedBy: [id("b")] }), sibling("b")],
        blockedBy: [id("a")],
        gateRework: undefined,
        isolationOverride: undefined,
        role: "coder",
      }).kind,
    ).toBe("ok");
  });

  it("validates set_dependencies root/self/cycle and started-target warnings", () => {
    const target = sibling("target");
    const dep = sibling("dep", { planLane: "cancelled" });
    expect(
      validateSpawnGraph({
        operation: "set-dependencies",
        siblings: [sibling("root", { parentThreadId: null })],
        blockedBy: [],
        gateRework: undefined,
        isolationOverride: undefined,
        role: "coder",
        target: sibling("root", { parentThreadId: null }),
      }).kind,
    ).toBe("rejected");
    expect(
      rejected(
        validateSpawnGraph({
          operation: "set-dependencies",
          siblings: [target, dep],
          blockedBy: [target.id],
          gateRework: undefined,
          isolationOverride: undefined,
          role: "coder",
          target,
        }),
      ).message,
    ).toContain("cannot block on itself");
    expect(
      rejected(
        validateSpawnGraph({
          operation: "set-dependencies",
          siblings: [target, sibling("a", { blockedBy: [target.id] })],
          blockedBy: [id("a")],
          gateRework: undefined,
          isolationOverride: undefined,
          role: "coder",
          target,
        }),
      ).message,
    ).toContain("create a cycle");
    expect(
      ok(
        validateSpawnGraph({
          operation: "set-dependencies",
          siblings: [sibling("started", { latestUserMessageAt: "2026-01-01T00:00:00.000Z" }), dep],
          blockedBy: [dep.id],
          gateRework: undefined,
          isolationOverride: undefined,
          role: "coder",
          target: sibling("started", { latestUserMessageAt: "2026-01-01T00:00:00.000Z" }),
        }),
      ).warnings.join("\n"),
    ).toContain("DISPLAY ONLY");
  });
});

const provider = (
  instanceId: string,
  models: ReadonlyArray<string>,
  overrides: { readonly availability?: "available" | "unavailable" } = {},
) =>
  ({
    instanceId,
    driver: "pi",
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { state: "unknown" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    ...(overrides.availability !== undefined ? { availability: overrides.availability } : {}),
    models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  }) as unknown as Parameters<typeof modelCatalogueOf>[0][number];

describe("modelCatalogueOf / validateModelSelection", () => {
  const catalogue = modelCatalogueOf([
    provider("pi", ["anthropic/claude-opus-4-8", "openai-codex/gpt-5.5"]),
    provider("empty-instance", []),
    provider("shadow", ["x"], { availability: "unavailable" }),
  ]);

  it("lists only available instances with their slugs", () => {
    expect(catalogue).toEqual([
      { instanceId: "pi", models: ["anthropic/claude-opus-4-8", "openai-codex/gpt-5.5"] },
      { instanceId: "empty-instance", models: [] },
    ] satisfies ReadonlyArray<ModelCatalogueEntry>);
  });

  it("accepts a known instance + slug", () => {
    expect(validateModelSelection(sel("pi", "anthropic/claude-opus-4-8"), catalogue).kind).toBe(
      "ok",
    );
  });

  it("rejects an unknown instance id with a source-aware, actionable message", () => {
    const v = validateModelSelection(sel("google-vertex-claude", "claude-opus-4-8"), catalogue);
    expect(v).toEqual({ kind: "unknown-instance", instanceId: "google-vertex-claude" });
    const explicit = invalidModelSelectionMessage(
      v as Exclude<typeof v, { readonly kind: "ok" }>,
      catalogue,
      ["coder", "reviewer"],
      { kind: "explicit" },
    );
    expect(explicit).toContain("This modelSelection");
    expect(explicit).toContain('instanceId "google-vertex-claude"');
    expect(explicit).toContain("is not a configured provider instance");
    expect(explicit).toContain("anthropic/claude-opus-4-8");
    expect(explicit).toContain("coder, reviewer");
    expect(explicit).toContain("Nothing was spawned.");
    // A stale configured preset names the preset in the error.
    const preset = invalidModelSelectionMessage(
      v as Exclude<typeof v, { readonly kind: "ok" }>,
      catalogue,
      ["coder"],
      { kind: "preset", name: "coder" },
    );
    expect(preset).toContain('modelPreset "coder"');
    expect(preset).toContain("fix the preset in server settings");
  });

  it("rejects an unknown model slug when the catalogue is populated", () => {
    const v = validateModelSelection(sel("pi", "claude-opus-4-8"), catalogue);
    expect(v.kind).toBe("unknown-model");
    expect(
      invalidModelSelectionMessage(v as Exclude<typeof v, { readonly kind: "ok" }>, catalogue, [], {
        kind: "role-preset",
        role: "coder",
      }),
    ).toContain('is not a known model for instance "pi"');
  });

  it("accepts any slug best-effort when the instance catalogue is empty", () => {
    expect(validateModelSelection(sel("empty-instance", "whatever"), catalogue).kind).toBe("ok");
  });

  it("resolves configured presets with a validity flag for discovery", () => {
    const resolved = presetCatalogueOf(
      {
        good: sel("pi", "anthropic/claude-opus-4-8"),
        stale: sel("google-vertex-claude", "claude-opus-4-8"),
        emptyOk: sel("empty-instance", "anything"),
      },
      catalogue,
    );
    expect(resolved).toEqual([
      { name: "good", instanceId: "pi", model: "anthropic/claude-opus-4-8", valid: true },
      { name: "stale", instanceId: "google-vertex-claude", model: "claude-opus-4-8", valid: false },
      { name: "emptyOk", instanceId: "empty-instance", model: "anything", valid: true },
    ]);
  });
});

describe("hasThreadStarted", () => {
  it("matches the dispatcher start predicate", () => {
    expect(hasThreadStarted({ session: null, latestUserMessageAt: null })).toBe(false);
    expect(hasThreadStarted({ session: {}, latestUserMessageAt: null })).toBe(true);
    expect(
      hasThreadStarted({ session: null, latestUserMessageAt: "2026-01-01T00:00:00.000Z" }),
    ).toBe(true);
    expect(hasThreadStarted({ session: {}, latestUserMessageAt: "2026-01-01T00:00:00.000Z" })).toBe(
      true,
    );
  });
});
