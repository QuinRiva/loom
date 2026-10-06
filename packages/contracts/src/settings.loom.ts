// Loom (fork) additions to the settings contracts, relocated out of the
// upstream-owned `settings.ts` so upstream merges touch one-line splice points.
// See `plans/2026-07-07-fork-seam-campaign.md` (Slice A).
//
// Unlike `orchestration.loom.ts`, importing `ModelSelection` (from
// `modelSelection.ts`, its home since upstream's V2) here is safe: `settings.ts`
// already imports it, and there is no value cycle back into `settings.ts`
// (nothing imports settings.ts from this file). `PiSettings` deliberately stays in `settings.ts` — it is built
// with the non-exported `makeBinaryPathSetting`, so moving it would create a
// value-init cycle.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

// Capability-based model selection (plans/2026-07-13-capability-based-model-selection.md).
// A parent expresses task SHAPE in one token; the server resolves deterministically
// against operator-maintained `workstreamModelProfiles`. See §3 for the vocabulary.
//
// `explore` — open-ended/prototype work, vague objective, plan likely to change.
// `thorough` — edge cases, migrations, hardening, review gates.
// `mechanical` — bounded, self-contained, high-volume work (extraction, renames).
export const TaskShape = Schema.Literals(["explore", "thorough", "mechanical"]);
export type TaskShape = typeof TaskShape.Type;

// A scored capability dimension: 1..10 integer. Best-in-class is calibrated at
// ~7-8 so a stronger model can score higher later without a global rescale.
const Score10 = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }));

// Machine-readable safety-relevant routing exclusion (§2). v1: a single token —
// a parent passing `sensitive: "security"` at spawn excludes profiles carrying it.
export const ProfileUnsuitableFor = Schema.Literals(["security-sensitive"]);
export type ProfileUnsuitableFor = typeof ProfileUnsuitableFor.Type;

// The `agentic` flag (§2): `oracle` means never spawn as an autonomous child —
// one-shot consultation only, so oracle profiles are excluded from spawn
// resolution entirely (scores cannot express "don't spawn this").
export const ProfileAgentic = Schema.Literals(["full", "bounded", "oracle"]);
export type ProfileAgentic = typeof ProfileAgentic.Type;

// One capability profile for a configured model (plan §5). Resolver inputs are
// required; documentation-only facts are optional (the rich comparative matrix
// lives in docs/operations/model-profiles.md, not forced into settings).
export const WorkstreamModelProfile = Schema.Struct({
  selection: ModelSelection, // instanceId + model (+ options)
  scores: Schema.Struct({
    horsepower: Score10,
    goalOrientation: Score10,
    thoroughness: Score10,
    endurance: Score10,
  }),
  costPerMtok: Schema.Struct({ input: Schema.Number, output: Schema.Number }),
  agentic: ProfileAgentic,
  unsuitableFor: Schema.optionalKey(Schema.Array(ProfileUnsuitableFor)),
  // Documentation-only (rendered on the discovery surface, never routed on):
  usableContext: Schema.optionalKey(Schema.Number), // honest usable tokens
  speed: Schema.optionalKey(Schema.Literals(["fast", "moderate", "slow"])),
  vision: Schema.optionalKey(Schema.Boolean),
  domainKnowledge: Schema.optionalKey(Schema.Boolean),
  notes: Schema.optionalKey(Schema.String),
});
export type WorkstreamModelProfile = typeof WorkstreamModelProfile.Type;

// Cross-vendor reroute (pull 9 Phase 3, 3c-2): when a pi thread's vendor has no
// healthy account, Loom moves it onto ONE fallback model of another vendor
// (`fallbackTarget`, a pi slug such as "cliproxy/claude-opus-5-5"); null ⇒ no
// reroute, the thread parks until its window resets. Resume-on-reset is
// upstream's `autoResumeLimitedThreads`; the chain editor and pause are gone.
const ProviderFailoverSettingsFields = Schema.Struct({
  enabled: Schema.Boolean,
  fallbackTarget: Schema.NullOr(TrimmedNonEmptyString),
});

const slugNamespace = (slug: string) => slug.split("/", 1)[0];

/**
 * The single target a stored V1 `chains` map collapses to: the first chain
 * entry, in stored order, that is a concrete slug (a `<m>`, bare-namespace or
 * `/*` entry needs the exhausted model's id, which a setting cannot know) of a
 * different vendor than its chain's key; null when there is none.
 */
export const fallbackTargetFromChains = (
  chains: Readonly<Record<string, ReadonlyArray<string>>>,
): string | null =>
  Object.entries(chains)
    .flatMap(([key, targets]) => targets.map((target) => ({ key, target: target.trim() })))
    .find(
      ({ key, target }) =>
        /^[^/]+\/[^*]/.test(target) &&
        !target.includes("<m>") &&
        slugNamespace(target) !== slugNamespace(key),
    )?.target ?? null;

// What settings.json may hold: the current keys, or V1's stored `chains`, read
// once and folded into `fallbackTarget` (settings.json has no migration ledger).
// V1's `resumeOnReset` and `pausedAccounts` are stripped as excess keys.
const StoredProviderFailoverSettings = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  fallbackTarget: Schema.optionalKey(Schema.NullOr(Schema.String)),
  chains: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
});

export const ProviderFailoverSettings = StoredProviderFailoverSettings.pipe(
  Schema.decodeTo(
    ProviderFailoverSettingsFields,
    SchemaTransformation.transform({
      decode: (stored) => ({
        enabled: stored.enabled ?? true,
        fallbackTarget:
          stored.fallbackTarget !== undefined
            ? stored.fallbackTarget
            : fallbackTargetFromChains(stored.chains ?? {}),
      }),
      encode: (settings) => settings,
    }),
  ),
);
export type ProviderFailoverSettings = typeof ProviderFailoverSettings.Type;

// Thread-search embedding provider (plans/thread-content-search). One vector per
// root thread; `none` (or an unreachable provider) means lexical-only search.
// Set in Settings → General → Thread search; a change re-embeds
// every root under the new provider's identity on the next sweep.
export const ThreadSearchEmbeddingSettings = Schema.Union([
  Schema.Struct({ provider: Schema.Literal("none") }),
  Schema.Struct({
    provider: Schema.Literal("local"),
    model: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("Xenova/bge-small-en-v1.5")),
    ),
  }),
  Schema.Struct({
    provider: Schema.Literal("openai-compatible"),
    baseUrl: TrimmedNonEmptyString, // e.g. https://api.openai.com/v1 or http://localhost:11434/v1
    model: TrimmedNonEmptyString,
    dim: Schema.Int,
    apiKey: Schema.optionalKey(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    provider: Schema.Literal("vertex"),
    project: TrimmedNonEmptyString,
    // gemini-embedding-2 is served from `global` only, so choosing it sends
    // thread text outside the configured region.
    location: Schema.String.pipe(
      Schema.withDecodingDefault(Effect.succeed("australia-southeast1")),
    ),
    model: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed("gemini-embedding-001"))),
  }),
]);
export type ThreadSearchEmbeddingSettings = typeof ThreadSearchEmbeddingSettings.Type;

// ---------------------------------------------------------------------------
// Struct field records (shape c). Each is spread — HEAD position — into the
// upstream struct that owns it.
// ---------------------------------------------------------------------------

// Spread into the nested `providerModelPreferences` value struct in BOTH
// `ClientSettingsSchema` and `ClientSettingsPatch` (byte-identical fields).
export const LoomModelPreferenceFields = {
  // Allow-list mode: when `showOnlySelectedModels` is on, only slugs in
  // `selectedModels` (plus custom models) surface in the model picker;
  // `hiddenModels` is ignored while the mode is active.
  selectedModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  showOnlySelectedModels: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
} as const;

// Spread into `ClientSettingsSchema`.
export const LoomClientSettingsFields = {
  // One-shot durable auto-open of the goal-tasks / Workstream right-panel
  // surfaces (loom UI, plan W1). Both default on: first-visit discovery is
  // wanted without a manual + → tab per thread, and the per-thread one-shot
  // flags make the cost a single non-overriding seed per thread.
  autoOpenGoalTasksPanel: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  autoOpenWorkstreamPanel: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  // Thread content search returns archived roots too unless this is off. A
  // per-device view preference, sent with every `orchestration.searchThreads`.
  threadSearchIncludeArchived: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
} as const;

// Spread into `ClientSettingsPatch`.
export const LoomClientSettingsPatchFields = {
  autoOpenGoalTasksPanel: Schema.optionalKey(Schema.Boolean),
  autoOpenWorkstreamPanel: Schema.optionalKey(Schema.Boolean),
  threadSearchIncludeArchived: Schema.optionalKey(Schema.Boolean),
} as const;

// Spread into `ServerSettings`.
export const LoomServerSettingsFields = {
  // Named model presets for Workstream spawns. Keyed by a plain slug; the
  // value is a full `ModelSelection`. `workstream_spawn` resolves a preset by
  // explicit `modelPreset` name, or — when neither model field is given — by
  // the child's `role` (a preset named after the role). Default empty so
  // existing spawns inherit the parent's selection exactly as before.
  workstreamModelPresets: Schema.Record(TrimmedNonEmptyString, ModelSelection).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  // Capability profiles for taskShape-based spawn resolution (plan §5). Keyed by
  // a plain profile name; whole-map replacement mirrors `workstreamModelPresets`.
  // Default empty — the initial matrix lives in docs for the operator to apply,
  // and an empty map makes `taskShape` fall through to the role preset/inherit.
  workstreamModelProfiles: Schema.Record(TrimmedNonEmptyString, WorkstreamModelProfile).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
  providerFailover: ProviderFailoverSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  // Prompt-cache retention for ROOT threads (children are always short):
  // `ab` = stable 50/50 hash of the thread id, `long` = all roots 1h,
  // `short` = all roots 5 min. Read at each launch; hand-edit settings.json.
  // See docs/operations/prompt-cache-retention.md.
  rootCacheRetention: Schema.Literals(["ab", "long", "short"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("ab" as const)),
  ),
  threadSearchEmbedding: ThreadSearchEmbeddingSettings.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({ provider: "local" as const, model: "Xenova/bge-small-en-v1.5" }),
    ),
  ),
} as const;

// Spread into `ServerSettingsPatch`.
export const LoomServerSettingsPatchFields = {
  // Whole-map replacement, mirroring `providerInstances`: presets are set as
  // complete entries, so a partial per-preset merge has no coherent meaning.
  workstreamModelPresets: Schema.optionalKey(Schema.Record(TrimmedNonEmptyString, ModelSelection)),
  // Whole-map replacement, mirroring `workstreamModelPresets`.
  workstreamModelProfiles: Schema.optionalKey(
    Schema.Record(TrimmedNonEmptyString, WorkstreamModelProfile),
  ),
  // Whole-value replacement: the union's fields depend on `provider`.
  threadSearchEmbedding: Schema.optionalKey(ThreadSearchEmbeddingSettings),
  // Shallow-merged into current (see applyServerSettingsPatch): each key replaces when present.
  providerFailover: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      fallbackTarget: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
    }),
  ),
} as const;
