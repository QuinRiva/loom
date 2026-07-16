import type {
  ModelSelection,
  ThreadId,
  ThreadIsolation,
  ThreadPlanLane,
  WorkstreamModelProfile,
} from "@t3tools/contracts";
import type { AccountUsageSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  forkIdentityFieldsRejection,
  forkFromGateConflictMessage,
  hasThreadStarted,
  headroomBucketFor,
  instanceDriverKinds,
  invalidModelSelectionMessage,
  modelCatalogueOf,
  presetCatalogueOf,
  profileSummaryOf,
  rankShapeCandidates,
  resolveForkChains,
  resolveForkSource,
  resolvePresetSelection,
  resolveScaffoldReference,
  resolveShapeSelection,
  resolveSpawnModelSelection,
  validateModelSelection,
  validateSpawnGraph,
  type ForkIdentity,
  type ModelCatalogueEntry,
  type ShapeHeadroomInput,
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

// ---------------------------------------------------------------------------
// Capability-based model selection (taskShape) — plan §3–§4.
// ---------------------------------------------------------------------------

const profile = (
  model: string,
  scores: {
    horsepower: number;
    goalOrientation: number;
    thoroughness: number;
    endurance: number;
  },
  agentic: WorkstreamModelProfile["agentic"],
  costInput: number,
  extra: Partial<WorkstreamModelProfile> = {},
): WorkstreamModelProfile =>
  ({
    selection: { instanceId: "pi", model },
    scores,
    costPerMtok: { input: costInput, output: costInput * 4 },
    agentic,
    ...extra,
  }) as WorkstreamModelProfile;

// The initial matrix from plan §2 (operator-adjusted; Grok dropped). Costs are
// representative — they only exercise the mechanical sort + universal tie-break.
const INITIAL_MATRIX: Record<string, WorkstreamModelProfile> = {
  "Fable 5": profile(
    "anthropic/claude-fable-5",
    { horsepower: 8, goalOrientation: 8, thoroughness: 6, endurance: 7 },
    "full",
    6,
    { unsuitableFor: ["security-sensitive"], usableContext: 200000 },
  ),
  "Opus 4.8": profile(
    "anthropic/claude-opus-4-8",
    { horsepower: 7, goalOrientation: 7, thoroughness: 6, endurance: 7 },
    "full",
    5,
  ),
  "GPT-5.6 Sol": profile(
    "openai-codex/gpt-5.6-sol",
    { horsepower: 8, goalOrientation: 5, thoroughness: 8, endurance: 7 },
    "full",
    4,
  ),
  "GPT-5.6 Terra": profile(
    "openai-codex/gpt-5.6-terra",
    { horsepower: 7, goalOrientation: 5, thoroughness: 7, endurance: 6 },
    "full",
    3,
  ),
  "GPT-5.6 Luna": profile(
    "openai-codex/gpt-5.6-luna",
    { horsepower: 5, goalOrientation: 3, thoroughness: 5, endurance: 5 },
    "bounded",
    1,
  ),
  "Gemini 3.1 Pro": profile(
    "google-vertex/gemini-3-1-pro",
    { horsepower: 7, goalOrientation: 7, thoroughness: 3, endurance: 3 },
    "oracle",
    2,
  ),
  "Gemini 3.0 Flash": profile(
    "google-vertex/gemini-3-0-flash",
    { horsepower: 5, goalOrientation: 5, thoroughness: 2, endurance: 3 },
    "oracle",
    0.5,
  ),
};

const matrixCatalogue = modelCatalogueOf([
  provider(
    "pi",
    Object.values(INITIAL_MATRIX).map((p) => p.selection.model),
  ),
]);

const names = (list: ReadonlyArray<{ readonly name: string }>) => list.map((c) => c.name);

const healthy: ShapeHeadroomInput = {
  usage: [],
  isExhausted: () => false,
  usageSourceInstances: new Set(),
  nowMs: 0,
};

const withHeadroom = (over: Partial<ShapeHeadroomInput>): ShapeHeadroomInput => ({
  ...healthy,
  ...over,
});

describe("rankShapeCandidates (per-shape ranking snapshot over the initial matrix)", () => {
  it("explore ranks by goalOrientation ↓, horsepower ↓, thoroughness ↓ (full, endurance ≥ 5)", () => {
    expect(names(rankShapeCandidates({ shape: "explore", profiles: INITIAL_MATRIX }))).toEqual([
      "Fable 5",
      "Opus 4.8",
      "GPT-5.6 Sol",
      "GPT-5.6 Terra",
    ]);
  });

  it("thorough ranks by thoroughness ↓, horsepower ↓, goalOrientation ↓ (full)", () => {
    expect(names(rankShapeCandidates({ shape: "thorough", profiles: INITIAL_MATRIX }))).toEqual([
      "GPT-5.6 Sol",
      "GPT-5.6 Terra",
      "Fable 5",
      "Opus 4.8",
    ]);
  });

  it("mechanical ranks by cost ↑, horsepower ↓ (full|bounded, horsepower ≥ 5)", () => {
    expect(names(rankShapeCandidates({ shape: "mechanical", profiles: INITIAL_MATRIX }))).toEqual([
      "GPT-5.6 Luna",
      "GPT-5.6 Terra",
      "GPT-5.6 Sol",
      "Opus 4.8",
      "Fable 5",
    ]);
  });

  it("excludes oracle profiles from every shape", () => {
    for (const shape of ["explore", "thorough", "mechanical"] as const) {
      const ranked = names(rankShapeCandidates({ shape, profiles: INITIAL_MATRIX }));
      expect(ranked).not.toContain("Gemini 3.1 Pro");
      expect(ranked).not.toContain("Gemini 3.0 Flash");
    }
  });

  it("applies the universal tie-break (cost ↑ then name ↑) on an all-equal-score tie", () => {
    const scores = { horsepower: 7, goalOrientation: 7, thoroughness: 7, endurance: 7 };
    const tied: Record<string, WorkstreamModelProfile> = {
      Zeta: profile("pi/zeta", scores, "full", 5),
      Alpha: profile("pi/alpha", scores, "full", 5),
      Cheaper: profile("pi/cheaper", scores, "full", 2),
    };
    // Cheaper wins on cost; Alpha before Zeta on the lexicographic name tie-break.
    expect(names(rankShapeCandidates({ shape: "explore", profiles: tied }))).toEqual([
      "Cheaper",
      "Alpha",
      "Zeta",
    ]);
  });

  it("drops profiles carrying the matching unsuitableFor token when sensitive is set", () => {
    const ranked = names(
      rankShapeCandidates({ shape: "explore", sensitive: "security", profiles: INITIAL_MATRIX }),
    );
    expect(ranked).not.toContain("Fable 5");
    expect(ranked[0]).toBe("Opus 4.8");
  });
});

describe("headroomBucketFor", () => {
  const usageSnapshot = (
    key: string,
    windows: ReadonlyArray<{
      kind: "primary" | "secondary";
      usedPercent: number;
      resetsAt: string | null;
      scope?: { displayName: string; modelId?: string | null };
    }>,
    observedAt = "2026-01-01T00:00:00.000Z",
    extra: { accountLabel?: string; limitReached?: boolean } = {},
  ): AccountUsageSnapshot =>
    ({
      providerName: key,
      providerInstanceId: null,
      windows: windows.map((w) => ({ windowDurationMins: null, ...w })),
      planType: null,
      observedAt,
      ...extra,
    }) as AccountUsageSnapshot;

  const nowMs = Date.parse("2026-01-01T00:05:00.000Z");

  it("is healthy for an API-billed selection with no subscription account", () => {
    expect(
      headroomBucketFor({ instanceId: "pi", model: "google-vertex/x" } as ModelSelection, healthy),
    ).toBe("healthy");
  });

  it("skips a selection whose account is hard-exhausted", () => {
    expect(
      headroomBucketFor(
        { instanceId: "pi", model: "anthropic/claude-opus-4-8" } as ModelSelection,
        withHeadroom({ isExhausted: (account) => account === "claudeAgent", nowMs }),
      ),
    ).toBe("skipped");
  });

  it("demotes when the binding window is ≥ 90% and fresh", () => {
    expect(
      headroomBucketFor(
        { instanceId: "pi", model: "anthropic/claude-opus-4-8" } as ModelSelection,
        withHeadroom({
          usage: [
            usageSnapshot("claudeAgent", [{ kind: "primary", usedPercent: 92, resetsAt: null }]),
          ],
          nowMs,
        }),
      ),
    ).toBe("demoted");
  });

  it("stays healthy below the demote threshold", () => {
    expect(
      headroomBucketFor(
        { instanceId: "pi", model: "anthropic/claude-opus-4-8" } as ModelSelection,
        withHeadroom({
          usage: [
            usageSnapshot("claudeAgent", [{ kind: "primary", usedPercent: 70, resetsAt: null }]),
          ],
          nowMs,
        }),
      ),
    ).toBe("healthy");
  });

  it("never demotes on stale data (older than the freshness horizon)", () => {
    expect(
      headroomBucketFor(
        { instanceId: "pi", model: "anthropic/claude-opus-4-8" } as ModelSelection,
        withHeadroom({
          // observedAt is >15 min before nowMs ⇒ unknown ⇒ healthy.
          usage: [
            usageSnapshot(
              "claudeAgent",
              [{ kind: "primary", usedPercent: 95, resetsAt: null }],
              "2025-12-31T23:30:00.000Z",
            ),
          ],
          nowMs,
        }),
      ),
    ).toBe("healthy");
  });

  it("discounts a window resetting within the near-future horizon", () => {
    expect(
      headroomBucketFor(
        { instanceId: "pi", model: "anthropic/claude-opus-4-8" } as ModelSelection,
        withHeadroom({
          usage: [
            usageSnapshot("claudeAgent", [
              // 99% but resets ~10 min out ⇒ not binding.
              { kind: "primary", usedPercent: 99, resetsAt: "2026-01-01T00:15:00.000Z" },
            ]),
          ],
          nowMs,
        }),
      ),
    ).toBe("healthy");
  });

  it("ignores an exhausted window scoped to a different model", () => {
    expect(
      headroomBucketFor(
        { instanceId: "pi", model: "anthropic/claude-opus-4-8" } as ModelSelection,
        withHeadroom({
          usage: [
            usageSnapshot("claudeAgent", [
              {
                kind: "primary",
                usedPercent: 99,
                resetsAt: null,
                scope: { displayName: "Fable", modelId: "claude-fable-5" },
              },
            ]),
          ],
          nowMs,
        }),
      ),
    ).toBe("healthy");
  });

  it("uses the best-remaining account for a pooled instance", () => {
    // Two pooled accounts of one usage-source instance: one nearly spent, one
    // fresh. The router fails over between them, so the instance is only as
    // exhausted as its freshest account ⇒ healthy.
    const bucket = headroomBucketFor(
      { instanceId: "pooled", model: "cliproxy/opus" } as ModelSelection,
      withHeadroom({
        usageSourceInstances: new Set(["pooled"]),
        usage: [
          {
            providerName: "cliproxy",
            providerInstanceId: "pooled",
            accountLabel: "A",
            windows: [
              { kind: "primary", usedPercent: 95, resetsAt: null, windowDurationMins: null },
            ],
            planType: null,
            observedAt: "2026-01-01T00:04:30.000Z",
          },
          {
            providerName: "cliproxy",
            providerInstanceId: "pooled",
            accountLabel: "B",
            windows: [
              { kind: "primary", usedPercent: 20, resetsAt: null, windowDurationMins: null },
            ],
            planType: null,
            observedAt: "2026-01-01T00:04:30.000Z",
          },
        ] as unknown as ReadonlyArray<AccountUsageSnapshot>,
        nowMs,
      }),
    );
    expect(bucket).toBe("healthy");
  });

  it("skips on an explicit limitReached flag even without a health mark", () => {
    // §4: skipped is a hard mark OR limitReached. Guards registry lag when the
    // authoritative usage snapshot already carries the flag.
    expect(
      headroomBucketFor(
        { instanceId: "pi", model: "anthropic/claude-opus-4-8" } as ModelSelection,
        withHeadroom({
          usage: [
            usageSnapshot(
              "claudeAgent",
              [{ kind: "primary", usedPercent: 10, resetsAt: null }],
              "2026-01-01T00:04:30.000Z",
              { limitReached: true },
            ),
          ],
          nowMs,
        }),
      ),
    ).toBe("skipped");
  });

  it("skips a pooled instance only when EVERY account reports limitReached", () => {
    const pooled = (label: string, limitReached: boolean): AccountUsageSnapshot =>
      ({
        providerName: "cliproxy",
        providerInstanceId: "pooled",
        accountLabel: label,
        windows: [{ kind: "primary", usedPercent: 10, resetsAt: null, windowDurationMins: null }],
        planType: null,
        observedAt: "2026-01-01T00:04:30.000Z",
        limitReached,
      }) as unknown as AccountUsageSnapshot;
    const sel = { instanceId: "pooled", model: "cliproxy/opus" } as ModelSelection;
    // One account still has headroom ⇒ best-remaining aggregation does NOT set
    // the flag ⇒ not skipped.
    expect(
      headroomBucketFor(
        sel,
        withHeadroom({
          usageSourceInstances: new Set(["pooled"]),
          usage: [pooled("A", true), pooled("B", false)],
          nowMs,
        }),
      ),
    ).toBe("healthy");
    // Both accounts spent ⇒ aggregation ANDs to limitReached ⇒ skipped.
    expect(
      headroomBucketFor(
        sel,
        withHeadroom({
          usageSourceInstances: new Set(["pooled"]),
          usage: [pooled("A", true), pooled("B", true)],
          nowMs,
        }),
      ),
    ).toBe("skipped");
  });

  it("does NOT skip on a STALE limitReached flag without an active mark (freshness gates it)", () => {
    // A raw snapshot has no TTL; honouring a stale limitReached would keep the
    // model skipped after its mark/reset expired — the stale-state failure §4
    // prevents. Stale ⇒ unknown ⇒ healthy.
    expect(
      headroomBucketFor(
        { instanceId: "pi", model: "anthropic/claude-opus-4-8" } as ModelSelection,
        withHeadroom({
          usage: [
            usageSnapshot(
              "claudeAgent",
              [{ kind: "primary", usedPercent: 10, resetsAt: null }],
              "2025-12-31T23:30:00.000Z",
              { limitReached: true },
            ),
          ],
          nowMs,
        }),
      ),
    ).toBe("healthy");
  });

  it("still skips a stale snapshot when an active health mark is present", () => {
    // The active mark is TTL-bounded and checked before the snapshot, so it
    // survives staleness independently.
    expect(
      headroomBucketFor(
        { instanceId: "pi", model: "anthropic/claude-opus-4-8" } as ModelSelection,
        withHeadroom({
          isExhausted: (account) => account === "claudeAgent",
          usage: [
            usageSnapshot(
              "claudeAgent",
              [{ kind: "primary", usedPercent: 10, resetsAt: null }],
              "2025-12-31T23:30:00.000Z",
              { limitReached: true },
            ),
          ],
          nowMs,
        }),
      ),
    ).toBe("skipped");
  });
});

describe("resolveShapeSelection", () => {
  it("picks the top-ranked healthy profile and renders a categorical rationale", () => {
    const result = resolveShapeSelection({
      shape: "explore",
      sensitive: undefined,
      profiles: INITIAL_MATRIX,
      catalogue: matrixCatalogue,
      headroom: healthy,
    });
    expect(result.kind).toBe("selection");
    if (result.kind !== "selection") return;
    expect(result.profileName).toBe("Fable 5");
    expect(result.bucket).toBe("healthy");
    // Categorical only: the profile name + shape, no usage %, price, or score.
    expect(result.rationale).toBe("Fable 5 (explore)");
    expect(result.rationale).not.toMatch(/%|\$|score|percent/i);
  });

  it("falls through with a warning when no profiles are configured", () => {
    const result = resolveShapeSelection({
      shape: "explore",
      sensitive: undefined,
      profiles: {},
      catalogue: matrixCatalogue,
      headroom: healthy,
    });
    expect(result.kind).toBe("fall-through");
    expect(result.warnings.join("\n")).toContain("no workstreamModelProfiles are configured");
  });

  it("falls through when the shape filter matches nothing (oracle-only set)", () => {
    const result = resolveShapeSelection({
      shape: "explore",
      sensitive: undefined,
      profiles: {
        "Gemini 3.1 Pro": INITIAL_MATRIX["Gemini 3.1 Pro"]!,
        "Gemini 3.0 Flash": INITIAL_MATRIX["Gemini 3.0 Flash"]!,
      },
      catalogue: matrixCatalogue,
      headroom: healthy,
    });
    expect(result.kind).toBe("fall-through");
    expect(result.warnings.join("\n")).toContain("matched no configured profile");
  });

  it("skips a catalogue-invalid top pick and records a per-skip warning", () => {
    // Catalogue without Fable's slug ⇒ the explore top pick is invalid; drop to Opus.
    const catalogue = modelCatalogueOf([
      provider(
        "pi",
        Object.values(INITIAL_MATRIX)
          .map((p) => p.selection.model)
          .filter((m) => m !== "anthropic/claude-fable-5"),
      ),
    ]);
    const result = resolveShapeSelection({
      shape: "explore",
      sensitive: undefined,
      profiles: INITIAL_MATRIX,
      catalogue,
      headroom: healthy,
    });
    expect(result.kind === "selection" && result.profileName).toBe("Opus 4.8");
    expect(result.warnings.join("\n")).toContain('skipped profile "Fable 5"');
  });

  it("prefers a healthy lower-ranked profile over a demoted higher-ranked one", () => {
    const profiles: Record<string, WorkstreamModelProfile> = {
      High: profile(
        "anthropic/high",
        { horsepower: 9, goalOrientation: 9, thoroughness: 9, endurance: 9 },
        "full",
        5,
      ),
      Low: profile(
        "openai-codex/low",
        { horsepower: 8, goalOrientation: 8, thoroughness: 8, endurance: 8 },
        "full",
        4,
      ),
    };
    const catalogue = modelCatalogueOf([provider("pi", ["anthropic/high", "openai-codex/low"])]);
    const nowMs = Date.parse("2026-01-01T00:05:00.000Z");
    const result = resolveShapeSelection({
      shape: "explore",
      sensitive: undefined,
      profiles,
      catalogue,
      headroom: withHeadroom({
        nowMs,
        // High's account (claudeAgent) is demoted; Low's (codex) is fresh.
        usage: [
          {
            providerName: "claudeAgent",
            providerInstanceId: null,
            windows: [
              { kind: "primary", usedPercent: 95, resetsAt: null, windowDurationMins: null },
            ],
            planType: null,
            observedAt: "2026-01-01T00:04:30.000Z",
          },
        ] as unknown as ReadonlyArray<AccountUsageSnapshot>,
      }),
    });
    expect(result.kind === "selection" && result.profileName).toBe("Low");
    expect(result.kind === "selection" && result.bucket).toBe("healthy");
    // The rationale must explain the first choice was passed over for headroom,
    // even though the PICK itself is healthy (finding 1).
    expect(result.kind === "selection" && result.rationale).toBe(
      "Low (explore; first choice on low headroom — substituted)",
    );
  });

  it("picks the top demoted profile when no bucket is healthier, with a truthful rationale", () => {
    const profiles: Record<string, WorkstreamModelProfile> = {
      High: profile(
        "anthropic/high",
        { horsepower: 9, goalOrientation: 9, thoroughness: 9, endurance: 9 },
        "full",
        5,
      ),
      Low: profile(
        "openai-codex/low",
        { horsepower: 8, goalOrientation: 8, thoroughness: 8, endurance: 8 },
        "full",
        4,
      ),
    };
    const catalogue = modelCatalogueOf([provider("pi", ["anthropic/high", "openai-codex/low"])]);
    const nowMs = Date.parse("2026-01-01T00:05:00.000Z");
    const demotedWindow = (key: string): AccountUsageSnapshot =>
      ({
        providerName: key,
        providerInstanceId: null,
        windows: [{ kind: "primary", usedPercent: 95, resetsAt: null, windowDurationMins: null }],
        planType: null,
        observedAt: "2026-01-01T00:04:30.000Z",
      }) as AccountUsageSnapshot;
    const result = resolveShapeSelection({
      shape: "explore",
      sensitive: undefined,
      profiles,
      catalogue,
      headroom: withHeadroom({
        nowMs,
        usage: [demotedWindow("claudeAgent"), demotedWindow("codex")],
      }),
    });
    expect(result.kind === "selection" && result.profileName).toBe("High");
    expect(result.kind === "selection" && result.bucket).toBe("demoted");
    // The pick IS the top choice, so the rationale must NOT claim a higher-ranked
    // choice was passed over; it says every match is on low headroom (finding 1).
    expect(result.kind === "selection" && result.rationale).toBe(
      "High (explore; running on low headroom)",
    );
    expect(result.kind === "selection" && result.rationale).not.toContain("first choice");
  });
});

describe("profileSummaryOf", () => {
  it("summarises name, agentic flag, usableContext, validity, and spawnability", () => {
    const summary = profileSummaryOf(
      {
        "Fable 5": INITIAL_MATRIX["Fable 5"]!,
        "Gemini 3.1 Pro": INITIAL_MATRIX["Gemini 3.1 Pro"]!,
      },
      matrixCatalogue,
    );
    expect(summary).toEqual([
      { name: "Fable 5", agentic: "full", usableContext: 200000, valid: true, spawnable: true },
      { name: "Gemini 3.1 Pro", agentic: "oracle", valid: true, spawnable: false },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The spawn model-selection precedence + boundary decode (plan §3, §6.7).
// ---------------------------------------------------------------------------

describe("resolveSpawnModelSelection", () => {
  // Presets must reference the `pi` instance the matrix catalogue knows, so the
  // unified post-resolution catalogue validation accepts them.
  const reviewerSel = sel("pi", "openai-codex/gpt-5.6-sol");
  const localPresets: Record<string, ModelSelection> = {
    reviewer: reviewerSel,
    coder: sel("pi", "anthropic/claude-opus-4-8"),
  };
  const base = {
    presets: localPresets,
    profiles: INITIAL_MATRIX,
    catalogue: matrixCatalogue,
    presetNames: ["reviewer", "coder"],
    role: "researcher",
    parentSelection: parent,
    headroom: healthy,
  };
  const call = (over: Partial<Parameters<typeof resolveSpawnModelSelection>[0]>) =>
    resolveSpawnModelSelection({
      explicit: { provided: false, decoded: undefined },
      modelPreset: undefined,
      taskShape: undefined,
      sensitive: undefined,
      ...base,
      ...over,
    });

  it("rejects a schema-invalid taskShape value (non-string / empty / unknown) with a 400 message", () => {
    for (const bad of [42, "", "  ", {}, true, "nonsense"]) {
      const r = call({ taskShape: bad });
      expect(r.kind).toBe("error");
      expect(r.kind === "error" && r.message).toContain("taskShape must be one of");
    }
  });

  it("rejects a schema-invalid sensitive value with a 400 message", () => {
    for (const bad of [1, "", {}, "phi"]) {
      const r = call({ sensitive: bad });
      expect(r.kind).toBe("error");
      expect(r.kind === "error" && r.message).toContain("sensitive must be one of");
    }
  });

  it("resolves a valid taskShape to a profile pick", () => {
    const r = call({ taskShape: "thorough" });
    expect(r.kind === "ok" && r.source).toEqual({
      kind: "task-shape",
      shape: "thorough",
      rationale: "GPT-5.6 Sol (thorough)",
    });
    expect(r.kind === "ok" && r.warnings.join("\n")).toContain("model selected by shape");
  });

  it("falls through to role/inherit (with a warning) for a valid shape and no profiles", () => {
    const r = call({ taskShape: "explore", profiles: {} });
    expect(r.kind === "ok" && r.source.kind).toBe("inherited");
    expect(r.kind === "ok" && r.selection).toEqual(parent);
    expect(r.kind === "ok" && r.warnings.join("\n")).toContain(
      "no workstreamModelProfiles are configured",
    );
  });

  it("falls through to a role preset when the shape matches nothing", () => {
    // role 'reviewer' has a preset; explore over an oracle-only set matches nothing.
    const r = call({
      taskShape: "explore",
      role: "reviewer",
      profiles: {
        "Gemini 3.1 Pro": INITIAL_MATRIX["Gemini 3.1 Pro"]!,
      },
    });
    expect(r.kind === "ok" && r.source).toEqual({ kind: "role-preset", role: "reviewer" });
    expect(r.kind === "ok" && r.selection).toEqual(reviewerSel);
  });

  it("honours precedence explicit > preset > shape > role > inherit", () => {
    const explicitSel = sel("pi", "anthropic/claude-opus-4-8");
    // explicit wins over everything and warns that the shape was ignored.
    const withExplicit = call({
      explicit: { provided: true, decoded: explicitSel },
      modelPreset: "reviewer",
      taskShape: "explore",
    });
    expect(withExplicit.kind === "ok" && withExplicit.source.kind).toBe("explicit");
    expect(withExplicit.kind === "ok" && withExplicit.warnings.join("\n")).toContain(
      "explicit modelSelection takes precedence",
    );

    // preset wins over shape and warns.
    const withPreset = call({ modelPreset: "reviewer", taskShape: "explore" });
    expect(withPreset.kind === "ok" && withPreset.source).toEqual({
      kind: "preset",
      name: "reviewer",
    });
    expect(withPreset.kind === "ok" && withPreset.warnings.join("\n")).toContain(
      "explicit modelPreset takes precedence",
    );

    // shape wins over the role preset.
    const withShape = call({ taskShape: "explore", role: "reviewer" });
    expect(withShape.kind === "ok" && withShape.source.kind).toBe("task-shape");

    // role preset wins over inherit when nothing else is supplied.
    const withRole = call({ role: "reviewer" });
    expect(withRole.kind === "ok" && withRole.source).toEqual({
      kind: "role-preset",
      role: "reviewer",
    });

    // nothing supplied and no role preset ⇒ inherit.
    const inherited = call({ role: "researcher" });
    expect(inherited.kind === "ok" && inherited.source.kind).toBe("inherited");
  });

  it("rejects an invalid explicit modelSelection decode with a 400", () => {
    const r = call({ explicit: { provided: true, decoded: undefined } });
    expect(r.kind === "error" && r.message).toBe("modelSelection is invalid.");
  });

  it("rejects an unknown modelPreset name with the available names", () => {
    const r = call({ modelPreset: "nope" });
    expect(r.kind === "error" && r.message).toContain('Unknown modelPreset "nope"');
  });

  it("rejects a catalogue-invalid explicit selection with a source-aware 400", () => {
    const r = call({
      explicit: { provided: true, decoded: sel("google-vertex-claude", "x") },
    });
    expect(r.kind === "error" && r.message).toContain("This modelSelection");
    expect(r.kind === "error" && r.message).toContain("not a configured provider instance");
  });
});

describe("resolveScaffoldReference (scaffold key/thread resolution)", () => {
  const keyToId = new Map<string, ThreadId>();
  keyToId.set("api", id("wt_api"));
  keyToId.set("existing-child", id("wt_existing"));
  const existingIds = new Set<ThreadId>([id("wt_existing"), id("wt_other")]);

  it("resolves a batch node key to its preallocated id", () => {
    const r = resolveScaffoldReference({ ref: "api", keyToId, existingIds });
    expect(r).toEqual({ kind: "ok", id: id("wt_api") });
  });

  it("resolves an existing child's graphKey", () => {
    const r = resolveScaffoldReference({ ref: "existing-child", keyToId, existingIds });
    expect(r).toEqual({ kind: "ok", id: id("wt_existing") });
  });

  it("resolves a thread: reference to an active existing child id", () => {
    const r = resolveScaffoldReference({ ref: "thread:wt_other", keyToId, existingIds });
    expect(r).toEqual({ kind: "ok", id: id("wt_other") });
  });

  it("rejects a thread: reference that is not an active existing child", () => {
    const r = resolveScaffoldReference({ ref: "thread:wt_nope", keyToId, existingIds });
    expect(r.kind === "error" && r.message).toContain("does not name an active existing child");
  });

  it("rejects a bare UUID-shaped reference (missing thread: prefix)", () => {
    const uuid = "12345678-1234-1234-1234-1234567890ab";
    const r = resolveScaffoldReference({ ref: uuid, keyToId, existingIds });
    expect(r.kind === "error" && r.message).toContain("UUID-shaped but unprefixed");
  });

  it("rejects an unknown symbolic key", () => {
    const r = resolveScaffoldReference({ ref: "ghost", keyToId, existingIds });
    expect(r.kind === "error" && r.message).toContain("neither a node key in this scaffold");
  });
});

// loom: forkFrom (D2/D4) — spawn/scaffold surface validators.
const drivers = new Map<string, string>([
  ["pi", "pi"],
  ["codex", "codex"],
]);

const forkSibling = (
  value: string,
  overrides: {
    readonly role?: string | null;
    readonly instanceId?: string;
    readonly title?: string;
  } = {},
) => ({
  id: id(value),
  title: overrides.title ?? value,
  role: overrides.role === undefined ? "assessor" : overrides.role,
  modelSelection: sel(overrides.instanceId ?? "pi", `${value}-model`),
});

describe("forkIdentityFieldsRejection (D2)", () => {
  const none = {
    role: false,
    modelSelection: false,
    modelPreset: false,
    taskShape: false,
    sensitive: false,
  };

  it("returns undefined when no identity field is provided", () => {
    expect(forkIdentityFieldsRejection(none)).toBeUndefined();
  });

  it("rejects each identity field individually and names it", () => {
    for (const field of [
      "role",
      "modelSelection",
      "modelPreset",
      "taskShape",
      "sensitive",
    ] as const) {
      const message = forkIdentityFieldsRejection({ ...none, [field]: true });
      expect(message).toBeDefined();
      expect(message).toContain(field);
      expect(message).toContain("forkFrom");
      expect(message).toContain("Nothing was spawned.");
    }
  });

  it("lists every offending field when several are combined", () => {
    const message = forkIdentityFieldsRejection({ ...none, role: true, taskShape: true });
    expect(message).toContain("role");
    expect(message).toContain("taskShape");
  });

  it("honours a custom nothing-clause (scaffold)", () => {
    const message = forkIdentityFieldsRejection({ ...none, role: true }, "Nothing was created.");
    expect(message).toContain("Nothing was created.");
  });
});

describe("forkFromGateConflictMessage (D4)", () => {
  it("names both gate and forkFrom", () => {
    expect(forkFromGateConflictMessage()).toContain("gate and forkFrom");
    expect(forkFromGateConflictMessage("Nothing was created.")).toContain("Nothing was created.");
  });
});

describe("resolveForkSource (spawn, D4)", () => {
  const base = {
    newChildId: id("new-child"),
    activeChildren: [forkSibling("reader"), forkSibling("other")],
    archivedChildren: [{ id: id("gone"), title: "archived reader" }],
    instanceDrivers: drivers,
  };

  it("resolves an active pi-backed direct child and inherits its identity", () => {
    const r = resolveForkSource({ ...base, forkFrom: id("reader") });
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.id).toBe(id("reader"));
    expect(r.kind === "ok" && r.identity.role).toBe("assessor");
    expect(r.kind === "ok" && r.identity.modelSelection.instanceId).toBe("pi");
  });

  it("rejects an unknown id as not-a-direct-child and lists known children", () => {
    const r = resolveForkSource({ ...base, forkFrom: id("ghost") });
    expect(r.kind === "rejected" && r.message).toContain("active direct child");
    expect(r.kind === "rejected" && r.message).toContain("reader");
  });

  it("rejects an archived source with the archived rejection style", () => {
    const r = resolveForkSource({ ...base, forkFrom: id("gone") });
    expect(r.kind === "rejected" && r.message).toContain("archived");
  });

  it("rejects a non-pi source via provider instance metadata", () => {
    const r = resolveForkSource({
      ...base,
      activeChildren: [forkSibling("reader", { instanceId: "codex" })],
      forkFrom: id("reader"),
    });
    expect(r.kind === "rejected" && r.message).toContain("not pi-backed");
  });

  it("rejects forking the child being spawned (self)", () => {
    const r = resolveForkSource({ ...base, forkFrom: id("new-child") });
    expect(r.kind === "rejected" && r.message).toContain("child being spawned");
  });
});

describe("validateSpawnGraph forkFrom implied dependency (D3)", () => {
  const reader = sibling("reader", { role: "assessor" });

  it("adds forkFrom to blockedBy with a warning when absent", () => {
    const r = ok(
      validateSpawnGraph({
        siblings: [reader],
        blockedBy: undefined,
        gateRework: undefined,
        forkFrom: reader.id,
        isolationOverride: undefined,
        role: "assessor",
        newThreadId: id("fork"),
      }),
    );
    expect(r.blockedBy).toEqual([reader.id]);
    expect(r.warnings.some((w) => w.includes("forkFrom") && w.includes("added to blockedBy"))).toBe(
      true,
    );
  });

  it("does not double-add when forkFrom is already an explicit dependency", () => {
    const r = ok(
      validateSpawnGraph({
        siblings: [reader],
        blockedBy: [reader.id],
        gateRework: undefined,
        forkFrom: reader.id,
        isolationOverride: undefined,
        role: "assessor",
        newThreadId: id("fork"),
      }),
    );
    expect(r.blockedBy).toEqual([reader.id]);
    expect(r.warnings.some((w) => w.includes("added to blockedBy"))).toBe(false);
  });

  it("rejects a forkFrom that is not an active sibling", () => {
    const r = rejected(
      validateSpawnGraph({
        siblings: [reader],
        blockedBy: undefined,
        gateRework: undefined,
        forkFrom: id("ghost"),
        isolationOverride: undefined,
        role: "assessor",
        newThreadId: id("fork"),
      }),
    );
    expect(r.message).toContain("forkFrom must name an active sibling");
  });

  it("reports an implied-edge cycle as a node-labelled rejection, not a 500", () => {
    // A sibling X depends on the new fork child; the fork's implied edge points
    // back at X → cycle only visible once the implied edge is materialised.
    const x = sibling("x", { blockedBy: [id("fork")] });
    const r = rejected(
      validateSpawnGraph({
        siblings: [x],
        blockedBy: undefined,
        gateRework: undefined,
        forkFrom: x.id,
        isolationOverride: undefined,
        role: "assessor",
        newThreadId: id("fork"),
      }),
    );
    expect(r.message).toContain("cycle");
  });
});

describe("instanceDriverKinds", () => {
  it("maps instance id to driver kind", () => {
    const map = instanceDriverKinds([
      { instanceId: "pi", driver: "pi", models: [] } as never,
      { instanceId: "codex", driver: "codex", models: [] } as never,
    ]);
    expect(map.get("pi")).toBe("pi");
    expect(map.get("codex")).toBe("codex");
  });
});

describe("resolveForkChains (scaffold two-phase, D4)", () => {
  const piIdentity = (value: string, role: string | null = "assessor"): ForkIdentity => ({
    role,
    modelSelection: sel("pi", `${value}-model`),
  });

  it("resolves an in-batch key source and inherits its identity", () => {
    const readerId = id("reader");
    const r = resolveForkChains({
      nodes: [
        { key: "reader", id: readerId, forkFromId: undefined },
        { key: "fork", id: id("fork"), forkFromId: readerId },
      ],
      baseIdentityById: new Map([[readerId, piIdentity("reader")]]),
      instanceDrivers: drivers,
    });
    expect(r.kind).toBe("ok");
    const identity = r.kind === "ok" && r.identityByKey.get("fork");
    expect(identity && identity.modelSelection.instanceId).toBe("pi");
    expect(identity && identity.role).toBe("assessor");
  });

  it("resolves a thread:<id> (existing child) source from baseIdentityById", () => {
    const existingId = id("wt_existing");
    const r = resolveForkChains({
      nodes: [{ key: "fork", id: id("fork"), forkFromId: existingId }],
      baseIdentityById: new Map([[existingId, piIdentity("existing", "reader")]]),
      instanceDrivers: drivers,
    });
    expect(r.kind).toBe("ok");
    const identity = r.kind === "ok" && r.identityByKey.get("fork");
    expect(identity && identity.role).toBe("reader");
  });

  it("inherits fork-of-fork identity regardless of node array order", () => {
    const readerId = id("reader");
    const bId = id("b");
    const aId = id("a");
    const base = new Map([[readerId, piIdentity("reader", "lead")]]);
    // A forks B forks reader. Author A BEFORE B to prove order-independence.
    const r = resolveForkChains({
      nodes: [
        { key: "a", id: aId, forkFromId: bId },
        { key: "b", id: bId, forkFromId: readerId },
        { key: "reader", id: readerId, forkFromId: undefined },
      ],
      baseIdentityById: base,
      instanceDrivers: drivers,
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    expect(r.identityByKey.get("a")?.role).toBe("lead");
    expect(r.identityByKey.get("b")?.role).toBe("lead");
    expect(r.identityByKey.get("a")?.modelSelection).toEqual(sel("pi", "reader-model"));
  });

  it("rejects a self-fork with a node-labelled error", () => {
    const r = resolveForkChains({
      nodes: [{ key: "a", id: id("a"), forkFromId: id("a") }],
      baseIdentityById: new Map(),
      instanceDrivers: drivers,
    });
    expect(r.kind === "error" && r.nodeKey).toBe("a");
    expect(r.kind === "error" && r.message).toContain("itself");
  });

  it("rejects a fork-edge cycle with a node-labelled error", () => {
    const r = resolveForkChains({
      nodes: [
        { key: "a", id: id("a"), forkFromId: id("b") },
        { key: "b", id: id("b"), forkFromId: id("a") },
      ],
      baseIdentityById: new Map(),
      instanceDrivers: drivers,
    });
    expect(r.kind).toBe("error");
    expect(r.kind === "error" && r.message).toContain("cycle");
  });

  it("rejects a non-pi source with a node-labelled error", () => {
    const readerId = id("reader");
    const r = resolveForkChains({
      nodes: [
        { key: "reader", id: readerId, forkFromId: undefined },
        { key: "fork", id: id("fork"), forkFromId: readerId },
      ],
      baseIdentityById: new Map([
        [readerId, { role: "assessor", modelSelection: sel("codex", "reader-model") }],
      ]),
      instanceDrivers: drivers,
    });
    expect(r.kind === "error" && r.nodeKey).toBe("fork");
    expect(r.kind === "error" && r.message).toContain("not pi-backed");
  });

  it("resolves the reader → three-fork acceptance shape (all inherit the reader)", () => {
    const readerId = id("reader");
    const r = resolveForkChains({
      nodes: [
        { key: "reader", id: readerId, forkFromId: undefined },
        { key: "lens-a", id: id("lens-a"), forkFromId: readerId },
        { key: "lens-b", id: id("lens-b"), forkFromId: readerId },
        { key: "lens-c", id: id("lens-c"), forkFromId: readerId },
      ],
      baseIdentityById: new Map([[readerId, piIdentity("reader")]]),
      instanceDrivers: drivers,
    });
    expect(r.kind).toBe("ok");
    if (r.kind !== "ok") return;
    for (const key of ["lens-a", "lens-b", "lens-c"]) {
      expect(r.identityByKey.get(key)?.modelSelection).toEqual(sel("pi", "reader-model"));
    }
  });
});
