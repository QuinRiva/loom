// Loom additions to the settings contracts, kept out of upstream's `settings.ts` so merges touch
// one-line splice points. Importing `ModelSelection` here is safe (unlike `orchestration.loom.ts`):
// nothing here value-imports `settings.ts`, so there is no cycle. `PiSettings` lives in
// `@t3tools/provider-pi/settings`.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

// Capability-based model selection: a parent states task SHAPE in one token and the server resolves
// it against operator-maintained `workstreamModelProfiles`. `explore`: open-ended, plan likely to
// change. `thorough`: edge cases, migrations, hardening, review gates. `mechanical`: bounded,
// high-volume work (extraction, renames).
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

// Cross-vendor reroute: when a pi thread's vendor has no healthy account, Loom moves it to ONE
// fallback model of another vendor (`fallbackTarget`, a pi slug); null parks it until the window
// resets (resume is upstream's `autoResumeLimitedThreads`). Each key carries its default so the
// sparse settings.json write, which strips default-valued keys, can encode a partial value.
export const ProviderFailoverSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
  fallbackTarget: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
});
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

// Struct field records (shape c). Each is spread — HEAD position — into the
// upstream struct that owns it.

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
  // One-shot durable auto-open of the Workstream (graph) right-panel surface
  // (loom UI, plan W1). Default on: first-visit discovery is wanted without a
  // manual + → tab per thread, and the per-thread one-shot flags make the cost
  // a single non-overriding seed per thread. Goal tasks never auto-opens (G3).
  autoOpenWorkstreamPanel: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
} as const;

// Spread into `ClientSettingsPatch`.
export const LoomClientSettingsPatchFields = {
  autoOpenWorkstreamPanel: Schema.optionalKey(Schema.Boolean),
} as const;

// Spread into `ServerSettings`.
export const LoomServerSettingsFields = {
  // Named model presets for workstream spawns (slug to full `ModelSelection`). `workstream_spawn`
  // resolves one by explicit `modelPreset`, or, with no model field given, by the child's `role`.
  // Default empty, so spawns otherwise inherit the parent's selection.
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
  // Share of new ROOT threads on the 1-hour prompt cache (children are always
  // 5-minute): a root is 1-hour when sha256(threadId)[0] < 256 × share, fixed at
  // its first launch. 0 = every root 5-minute, 1 = every root 1-hour. Read at
  // each launch; hand-edit settings.json. See docs/operations/prompt-cache-retention.md.
  rootCacheLongShare: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })).pipe(
    Schema.withDecodingDefault(Effect.succeed(0.5)),
  ),
  threadSearchEmbedding: ThreadSearchEmbeddingSettings.pipe(
    Schema.withDecodingDefault(
      Effect.succeed({ provider: "local" as const, model: "Xenova/bge-small-en-v1.5" }),
    ),
  ),
  // Quiescence as completion (pull 9 Phase 3b): a started Loom child idle this
  // long after a control-started turn (kickoff, wake, the parent's prompt) gets
  // a synthesised report and yields to its parent.
  quiescenceGraceMs: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(600_000))),
  // The same for a turn a human started; null = never (a human is in the loop).
  quiescenceHumanGraceMs: Schema.NullOr(Schema.Number).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
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
  quiescenceGraceMs: Schema.optionalKey(Schema.Number),
  quiescenceHumanGraceMs: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  // Shallow-merged into current (see applyServerSettingsPatch): each key replaces when present.
  providerFailover: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      fallbackTarget: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
    }),
  ),
} as const;
