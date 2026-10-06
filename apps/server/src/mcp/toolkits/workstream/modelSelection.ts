/**
 * A child's model at spawn (ported from V1's `WorkstreamSpawnHttp.ts`):
 * explicit `modelSelection` > `modelPreset` > `taskShape` (resolved against the
 * operator's capability profiles, bucketed by live headroom) > a preset named
 * after the role > the parent's selection. The resolution is one pure function
 * (`resolveSpawnModelSelection`); `resolveChildModel` reads the settings,
 * provider catalogue and health registry once and calls it. Every selection it
 * returns uses upstream's `thinking` option id — V1's pi driver called it
 * `thinkingLevel`, and presets or inherited selections may still carry that.
 *
 * @module mcp/toolkits/workstream/modelSelection
 */
import {
  isProviderAvailable,
  ModelSelection,
  type ProfileUnsuitableFor,
  type ServerProvider,
  type TaskShape,
  type WorkstreamModelProfile,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  type AccountUsageSnapshot,
  accountUsageRoutingKey,
} from "../../../provider/accountUsage.loom.ts";
import {
  formatResetHint,
  subscriptionScopeForSelection,
  usageSourceInstances,
} from "../../../provider/exhaustionMapping.ts";
import {
  aggregateAccountsBestRemaining,
  matches,
  ProviderHealthRegistry,
} from "../../../provider/Services/ProviderHealthRegistry.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { LoomToolError } from "./defs.ts";
import type { PresetCatalogueEntry, ProfileSummaryEntry } from "./render.ts";

export const TASK_SHAPES: ReadonlyArray<TaskShape> = ["explore", "thorough", "mechanical"];

/** Upstream's option id for a pi thinking level; V1 selections carry `thinkingLevel`. */
export const withUpstreamOptionIds = (selection: ModelSelection): ModelSelection =>
  selection.options?.some((option) => option.id === "thinkingLevel") === true
    ? {
        ...selection,
        options: selection.options.map((option) =>
          option.id === "thinkingLevel" ? { ...option, id: "thinking" } : option,
        ),
      }
    : selection;

// ---------------------------------------------------------------------------
// Catalogue validation
// ---------------------------------------------------------------------------

/** One usable instance and its known slugs; empty `models` = not yet loaded (slug unchecked). */
export interface ModelCatalogueEntry {
  readonly instanceId: string;
  readonly models: ReadonlyArray<string>;
}

export const modelCatalogueOf = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ModelCatalogueEntry> =>
  providers.filter(isProviderAvailable).map((provider) => ({
    instanceId: provider.instanceId,
    models: provider.models.map((model) => model.slug),
  }));

type ModelSelectionValidation =
  | { readonly kind: "ok" }
  | { readonly kind: "unknown-instance"; readonly instanceId: string }
  | {
      readonly kind: "unknown-model";
      readonly instanceId: string;
      readonly model: string;
      readonly models: ReadonlyArray<string>;
    };

export const validateModelSelection = (
  selection: ModelSelection,
  catalogue: ReadonlyArray<ModelCatalogueEntry>,
): ModelSelectionValidation => {
  const entry = catalogue.find((candidate) => candidate.instanceId === selection.instanceId);
  if (entry === undefined) return { kind: "unknown-instance", instanceId: selection.instanceId };
  return entry.models.length > 0 && !entry.models.includes(selection.model)
    ? {
        kind: "unknown-model",
        instanceId: selection.instanceId,
        model: selection.model,
        models: entry.models,
      }
    : { kind: "ok" };
};

type SelectionSource =
  | { readonly kind: "explicit" }
  | { readonly kind: "preset"; readonly name: string }
  | { readonly kind: "role-preset"; readonly role: string }
  | { readonly kind: "task-shape"; readonly shape: TaskShape }
  | { readonly kind: "inherited" };

const describeSource = (source: SelectionSource): string => {
  switch (source.kind) {
    case "explicit":
      return "This modelSelection";
    case "preset":
      return `modelPreset "${source.name}" (resolved from server settings)`;
    case "role-preset":
      return `The role-default preset for role "${source.role}" (resolved from server settings)`;
    case "task-shape":
      return `The taskShape "${source.shape}" resolution (resolved from server settings profiles)`;
    case "inherited":
      return "The inherited (parent) model selection";
  }
};

const formatCatalogue = (catalogue: ReadonlyArray<ModelCatalogueEntry>): string =>
  catalogue.length === 0
    ? "none configured"
    : catalogue
        .map(
          (entry) =>
            `${entry.instanceId} (${entry.models.length > 0 ? `${entry.models.length} models` : "catalogue not yet loaded"})`,
        )
        .join("; ");

// A shortlist bound, not a token budget: a needle matching more slugs was too generic anyway.
const NEAR_MATCH_LIMIT = 10;
const nearMatchesLine = (attempted: string, models: ReadonlyArray<string>): string => {
  const needle = attempted.toLowerCase();
  const near = models.filter((slug) => {
    const lower = slug.toLowerCase();
    return lower.includes(needle) || needle.includes(lower);
  });
  return near.length === 0
    ? `None of the ${models.length} known slugs for this instance resemble it.`
    : `Closest known slugs: ${near.slice(0, NEAR_MATCH_LIMIT).join(", ")}${
        near.length > NEAR_MATCH_LIMIT ? ` (+${near.length - NEAR_MATCH_LIMIT} more)` : ""
      }.`;
};

const invalidModelSelectionMessage = (
  validation: Exclude<ModelSelectionValidation, { readonly kind: "ok" }>,
  catalogue: ReadonlyArray<ModelCatalogueEntry>,
  presets: ReadonlyArray<string>,
  source: SelectionSource,
): string =>
  validation.kind === "unknown-instance"
    ? `${describeSource(source)} references instanceId "${validation.instanceId}", which is not a configured provider instance in this build. Valid instances: ${formatCatalogue(catalogue)}. Configured presets: ${presets.length > 0 ? presets.join(", ") : "none"}. Prefer a configured modelPreset (or omit both to inherit) rather than guessing instance ids/model slugs from another environment${source.kind === "preset" || source.kind === "role-preset" ? ", or fix the preset in server settings" : ""}. Nothing was spawned.`
    : `${describeSource(source)} references model "${validation.model}", which is not a known model for instance "${validation.instanceId}". ${nearMatchesLine(validation.model, validation.models)} Prefer a configured modelPreset or taskShape over a raw slug. Nothing was spawned.`;

// ---------------------------------------------------------------------------
// Headroom (plan §4 of the capability-selection design)
// ---------------------------------------------------------------------------

export type HeadroomBucket = "healthy" | "demoted" | "skipped";

// Older (or absent) usage data is unknown ⇒ healthy; a window resetting within
// the discount horizon is not binding; ≥90% of a binding window demotes.
const HEADROOM_STALE_MS = 15 * 60_000;
const HEADROOM_RESET_DISCOUNT_MS = 15 * 60_000;
const HEADROOM_DEMOTE_PERCENT = 90;

export interface ShapeHeadroomInput {
  readonly usage: ReadonlyArray<AccountUsageSnapshot>;
  readonly isExhausted: (accountKey: string, modelId: string) => boolean;
  readonly usageSourceInstances: ReadonlySet<string>;
  readonly nowMs: number;
}

const withinResetDiscount = (resetsAt: string | null, nowMs: number): boolean => {
  const delta = resetsAt === null ? Number.NaN : Date.parse(resetsAt) - nowMs;
  return delta > 0 && delta <= HEADROOM_RESET_DISCOUNT_MS;
};

/**
 * `skipped` on an active exhaustion mark or a fresh `limitReached`; `demoted`
 * when a binding window is ≥90%; `healthy` otherwise — including missing or
 * stale data (never demote on unknown). Pooled accounts aggregate to their
 * best remaining, as the router fails over between them.
 */
export const headroomBucketFor = (
  selection: ModelSelection,
  input: ShapeHeadroomInput,
): HeadroomBucket => {
  const scope = subscriptionScopeForSelection(selection, input.usageSourceInstances);
  if (scope.accountKey === null) return "healthy"; // API-billed: no subscription window
  if (input.isExhausted(scope.accountKey, scope.modelId)) return "skipped";
  const snapshot = aggregateAccountsBestRemaining(input.usage).find(
    (candidate) => accountUsageRoutingKey(candidate) === scope.accountKey,
  );
  if (snapshot === undefined) return "healthy";
  const observedMs = Date.parse(snapshot.observedAt);
  if (!Number.isFinite(observedMs) || input.nowMs - observedMs > HEADROOM_STALE_MS) {
    return "healthy";
  }
  if (snapshot.limitReached === true) return "skipped";
  const maxPercent = snapshot.windows
    .filter(
      (window) =>
        (window.scope === undefined || window.scope.modelId === scope.modelId) &&
        !withinResetDiscount(window.resetsAt, input.nowMs),
    )
    .reduce((max, window) => Math.max(max, window.usedPercent), -1);
  return maxPercent >= HEADROOM_DEMOTE_PERCENT ? "demoted" : "healthy";
};

// ---------------------------------------------------------------------------
// Task shapes
// ---------------------------------------------------------------------------

interface ScoredCandidate {
  readonly name: string;
  readonly profile: WorkstreamModelProfile;
}

type SortDirective = {
  readonly get: (candidate: ScoredCandidate) => number;
  readonly dir: "asc" | "desc";
};

const byScore = (key: keyof WorkstreamModelProfile["scores"]): SortDirective => ({
  get: (candidate) => candidate.profile.scores[key],
  dir: "desc",
});
const byCostInput: SortDirective = {
  get: (candidate) => candidate.profile.costPerMtok.input,
  dir: "asc",
};

// Per-shape floors and ordering. Oracle and `unsuitableFor` exclusions apply to every shape.
const SHAPE_RESOLVERS: Record<
  TaskShape,
  {
    readonly filter: (profile: WorkstreamModelProfile) => boolean;
    readonly sortKeys: ReadonlyArray<SortDirective>;
  }
> = {
  explore: {
    filter: (profile) => profile.agentic === "full" && profile.scores.endurance >= 5,
    sortKeys: [byScore("goalOrientation"), byScore("horsepower"), byScore("thoroughness")],
  },
  thorough: {
    filter: (profile) => profile.agentic === "full",
    sortKeys: [byScore("thoroughness"), byScore("horsepower"), byScore("goalOrientation")],
  },
  mechanical: {
    filter: (profile) =>
      (profile.agentic === "full" || profile.agentic === "bounded") &&
      profile.scores.horsepower >= 5,
    sortKeys: [byCostInput, byScore("horsepower")],
  },
};

const SENSITIVE_EXCLUSIONS: Record<string, ProfileUnsuitableFor> = {
  security: "security-sensitive",
};

/** The shape keys, then input cost ↑, then name ↑ — a total order, so parallel spawns agree. */
const compareCandidates =
  (sortKeys: ReadonlyArray<SortDirective>) =>
  (a: ScoredCandidate, b: ScoredCandidate): number => {
    for (const key of [...sortKeys, byCostInput]) {
      const delta = key.get(a) - key.get(b);
      if (delta !== 0) return key.dir === "asc" ? delta : -delta;
    }
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  };

export const rankShapeCandidates = (input: {
  readonly shape: TaskShape;
  readonly sensitive: string | undefined;
  readonly profiles: Readonly<Record<string, WorkstreamModelProfile>>;
}): ReadonlyArray<ScoredCandidate> => {
  const exclusion =
    input.sensitive === undefined ? undefined : SENSITIVE_EXCLUSIONS[input.sensitive];
  const resolver = SHAPE_RESOLVERS[input.shape];
  return Object.entries(input.profiles)
    .map(([name, profile]) => ({ name, profile }))
    .filter(
      ({ profile }) =>
        profile.agentic !== "oracle" &&
        (exclusion === undefined || !(profile.unsuitableFor ?? []).includes(exclusion)) &&
        resolver.filter(profile),
    )
    .toSorted(compareCandidates(resolver.sortKeys));
};

// Categorical rationale only — no percentages, prices or scores in parent-facing text.
const FIRST_CHOICE_LOSS: Record<HeadroomBucket, string> = {
  healthy: "first choice unavailable",
  demoted: "first choice on low headroom",
  skipped: "first choice exhausted",
};
const PICK_CAVEAT: Record<HeadroomBucket, string> = {
  healthy: "",
  demoted: "running on low headroom",
  skipped: "every shape match exhausted — the child waits for the earliest reset",
};
const BUCKET_ORDER: ReadonlyArray<HeadroomBucket> = ["healthy", "demoted", "skipped"];

type ShapeResolution =
  | {
      readonly kind: "selection";
      readonly selection: ModelSelection;
      readonly rationale: string;
      readonly warnings: ReadonlyArray<string>;
    }
  | { readonly kind: "fall-through"; readonly warnings: ReadonlyArray<string> };

/**
 * A shape → the best-ranked catalogue-valid profile in the best headroom
 * bucket. No profiles, no match or no valid match falls through to the role
 * preset with a warning — a shape is advisory, never an error.
 */
const resolveShapeSelection = (input: {
  readonly shape: TaskShape;
  readonly sensitive: string | undefined;
  readonly profiles: Readonly<Record<string, WorkstreamModelProfile>>;
  readonly catalogue: ReadonlyArray<ModelCatalogueEntry>;
  readonly headroom: ShapeHeadroomInput;
}): ShapeResolution => {
  const fallThrough = (why: string, warnings: ReadonlyArray<string> = []): ShapeResolution => ({
    kind: "fall-through",
    warnings: [
      ...warnings,
      `taskShape "${input.shape}"${input.sensitive === undefined ? "" : ` (sensitive: ${input.sensitive})`} ${why} — falling through to the role preset / inherited model.`,
    ],
  });
  if (Object.keys(input.profiles).length === 0) {
    return fallThrough(
      "requested but no workstreamModelProfiles are configured (see docs/operations/model-profiles.md)",
    );
  }
  const bucketed = rankShapeCandidates(input).map((candidate) => ({
    candidate,
    bucket: headroomBucketFor(candidate.profile.selection, input.headroom),
  }));
  const top = bucketed[0];
  if (top === undefined) return fallThrough("matched no configured profile");
  const warnings: Array<string> = [];
  for (const entry of BUCKET_ORDER.flatMap((bucket) =>
    bucketed.filter((candidate) => candidate.bucket === bucket),
  )) {
    const validation = validateModelSelection(entry.candidate.profile.selection, input.catalogue);
    if (validation.kind === "ok") {
      const notes = [
        entry.candidate.name === top.candidate.name
          ? ""
          : `${FIRST_CHOICE_LOSS[top.bucket]} — substituted`,
        PICK_CAVEAT[entry.bucket],
      ].filter((note) => note !== "");
      return {
        kind: "selection",
        selection: entry.candidate.profile.selection,
        rationale: `${entry.candidate.name} (${input.shape}${notes.length > 0 ? `; ${notes.join("; ")}` : ""})`,
        warnings,
      };
    }
    warnings.push(
      `skipped profile "${entry.candidate.name}" (invalid: ${
        validation.kind === "unknown-instance"
          ? `instance "${validation.instanceId}" is not configured`
          : `model "${validation.model}" is unknown for instance "${validation.instanceId}"`
      }).`,
    );
  }
  return fallThrough("matched profile(s) but none reference a configured instance/model", warnings);
};

// ---------------------------------------------------------------------------
// The precedence
// ---------------------------------------------------------------------------

export interface SpawnModelInput {
  /** The decoded explicit selection; `null` when one was supplied but did not decode. */
  readonly explicit: ModelSelection | null | undefined;
  readonly modelPreset: string | undefined;
  readonly taskShape: TaskShape | undefined;
  readonly sensitive: string | undefined;
  readonly presets: Readonly<Record<string, ModelSelection>>;
  readonly profiles: Readonly<Record<string, WorkstreamModelProfile>>;
  readonly catalogue: ReadonlyArray<ModelCatalogueEntry>;
  readonly role: string;
  readonly parentSelection: ModelSelection;
  readonly headroom: ShapeHeadroomInput;
}

export type SpawnModelResolution =
  | { readonly kind: "error"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly selection: ModelSelection;
      readonly warnings: ReadonlyArray<string>;
    };

/** The whole precedence as one pure function; every non-inherited source is catalogue-validated. */
export const resolveSpawnModelSelection = (input: SpawnModelInput): SpawnModelResolution => {
  const warnings: Array<string> = [];
  const ignoredShape = (by: string) => {
    if (input.taskShape !== undefined)
      warnings.push(
        `taskShape "${input.taskShape}" was ignored: an explicit ${by} takes precedence.`,
      );
  };
  const roleOrInherit = (): { selection: ModelSelection; source: SelectionSource } => {
    const rolePreset = input.presets[input.role];
    return rolePreset === undefined
      ? { selection: input.parentSelection, source: { kind: "inherited" } }
      : { selection: rolePreset, source: { kind: "role-preset", role: input.role } };
  };

  let resolved: { selection: ModelSelection; source: SelectionSource };
  if (input.explicit !== undefined) {
    if (input.explicit === null) return { kind: "error", message: "modelSelection is invalid." };
    resolved = { selection: input.explicit, source: { kind: "explicit" } };
    ignoredShape("modelSelection");
  } else if (input.modelPreset !== undefined) {
    const preset = input.presets[input.modelPreset];
    if (preset === undefined) {
      const available = Object.keys(input.presets);
      return {
        kind: "error",
        message: `Unknown modelPreset "${input.modelPreset}". Available presets: ${available.length > 0 ? available.join(", ") : "none configured"}.`,
      };
    }
    resolved = { selection: preset, source: { kind: "preset", name: input.modelPreset } };
    ignoredShape("modelPreset");
  } else if (input.taskShape !== undefined) {
    const shape = resolveShapeSelection({ ...input, shape: input.taskShape });
    warnings.push(...shape.warnings);
    if (shape.kind === "selection") {
      warnings.push(`model selected by shape: ${shape.rationale}.`);
      resolved = {
        selection: shape.selection,
        source: { kind: "task-shape", shape: input.taskShape },
      };
    } else resolved = roleOrInherit();
  } else resolved = roleOrInherit();

  if (resolved.source.kind !== "inherited") {
    const validation = validateModelSelection(resolved.selection, input.catalogue);
    if (validation.kind !== "ok") {
      return {
        kind: "error",
        message: invalidModelSelectionMessage(
          validation,
          input.catalogue,
          Object.keys(input.presets),
          resolved.source,
        ),
      };
    }
  }
  return { kind: "ok", selection: withUpstreamOptionIds(resolved.selection), warnings };
};

// ---------------------------------------------------------------------------
// The effectful edge
// ---------------------------------------------------------------------------

const decodeModelSelection = Schema.decodeUnknownEffect(ModelSelection);

/**
 * A spawned or scaffolded child's model, with its warnings — including a
 * warning when the resolved subscription is currently exhausted (the
 * selection is never rewritten for it; Loom's economics reroute at run time).
 */
export const resolveChildModel = Effect.fn("LoomToolkit.resolveChildModel")(function* (input: {
  readonly role: string;
  readonly modelSelection: unknown;
  readonly modelPreset: string | undefined;
  readonly taskShape: TaskShape | undefined;
  readonly sensitive: string | undefined;
  readonly parentSelection: ModelSelection;
}) {
  const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
    Effect.mapError((error) => new LoomToolError({ message: error.message })),
  );
  const catalogue = modelCatalogueOf(yield* (yield* ProviderRegistry).getProviders);
  const health = yield* ProviderHealthRegistry;
  const marks = yield* health.snapshot;
  const nowMs = yield* Clock.currentTimeMillis;
  const isExhausted = (accountKey: string, modelId: string) =>
    marks.some((mark) => matches(mark, accountKey, modelId));
  const sources = usageSourceInstances(settings.providerInstances);
  const resolution = resolveSpawnModelSelection({
    explicit:
      input.modelSelection === undefined
        ? undefined
        : yield* decodeModelSelection(input.modelSelection).pipe(Effect.orElseSucceed(() => null)),
    modelPreset: input.modelPreset,
    taskShape: input.taskShape,
    sensitive: input.sensitive,
    presets: settings.workstreamModelPresets,
    profiles: settings.workstreamModelProfiles,
    catalogue,
    role: input.role,
    parentSelection: input.parentSelection,
    headroom: { usage: yield* health.usage, isExhausted, usageSourceInstances: sources, nowMs },
  });
  if (resolution.kind === "error") return yield* new LoomToolError({ message: resolution.message });
  const scope = subscriptionScopeForSelection(resolution.selection, sources);
  if (scope.accountKey === null || !isExhausted(scope.accountKey, scope.modelId)) return resolution;
  const until = yield* health.exhaustedUntil(scope.accountKey, scope.modelId);
  return {
    ...resolution,
    warnings: [
      ...resolution.warnings,
      `Resolved model ${resolution.selection.model} is exhausted (resets ${formatResetHint(until, nowMs)}); the child's turns wait on that limit unless a fallback is configured.`,
    ],
  };
});

/** The spawn catalogue `workstream_list` shows: presets and profiles with their validity. */
export const spawnCatalogue = Effect.gen(function* () {
  const settings = yield* (yield* ServerSettingsService).getSettings.pipe(
    Effect.mapError((error) => new LoomToolError({ message: error.message })),
  );
  const catalogue = modelCatalogueOf(yield* (yield* ProviderRegistry).getProviders);
  const valid = (selection: ModelSelection) =>
    validateModelSelection(selection, catalogue).kind === "ok";
  return {
    modelPresets: Object.entries(settings.workstreamModelPresets).map(
      ([name, selection]): PresetCatalogueEntry => ({
        name,
        instanceId: selection.instanceId,
        model: selection.model,
        valid: valid(selection),
      }),
    ),
    taskShapes: TASK_SHAPES,
    modelProfiles: Object.entries(settings.workstreamModelProfiles).map(
      ([name, profile]): ProfileSummaryEntry => ({
        name,
        agentic: profile.agentic,
        ...(profile.usableContext === undefined ? {} : { usableContext: profile.usableContext }),
        valid: valid(profile.selection),
        spawnable: profile.agentic !== "oracle",
      }),
    ),
  };
});
