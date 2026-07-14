// Loom (fork) additions to the settings contracts, relocated out of the
// upstream-owned `settings.ts` so upstream merges touch one-line splice points.
// See `plans/2026-07-07-fork-seam-campaign.md` (Slice A).
//
// Unlike `orchestration.loom.ts`, importing `ModelSelection` from
// `orchestration.ts` here is safe: `settings.ts` already imports it, and there
// is no value cycle back into `settings.ts` (nothing imports settings.ts from
// this file). `PiSettings` deliberately stays in `settings.ts` — it is built
// with the non-exported `makeBinaryPathSetting`, so moving it would create a
// value-init cycle.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./orchestration.ts";

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

// Tri-state visibility for the model reasoning/thinking block rendered above
// assistant answers. `off` hides it entirely; `collapsed` shows a summary
// header ("Thought for Xs") closed by default; `expanded` opens it by default.
export const ReasoningDisplayMode = Schema.Literals(["off", "collapsed", "expanded"]);
export type ReasoningDisplayMode = typeof ReasoningDisplayMode.Type;
export const DEFAULT_REASONING_DISPLAY_MODE: ReasoningDisplayMode = "collapsed";

// Cross-provider subscription-exhaustion failover (tier 2). Sparse, defaulted
// — no migration. `chains` is optional (absent ⇒ use built-in default chains,
// which live server-side); keys are exact slugs ("anthropic/claude-fable-5") or
// namespace wildcards ("openai-codex/*"), values ordered target slugs.
// `pausedAccounts` are account keys (providerInstanceId ?? providerName) the
// user has soft-paused — treated as exhausted account-wide indefinitely.
export const ProviderFailoverSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  resumeOnReset: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  chains: Schema.optional(
    Schema.Record(TrimmedNonEmptyString, Schema.Array(TrimmedNonEmptyString)),
  ),
  pausedAccounts: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ProviderFailoverSettings = typeof ProviderFailoverSettings.Type;

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
  reasoningDisplay: ReasoningDisplayMode.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_REASONING_DISPLAY_MODE)),
  ),
  // One-shot durable auto-open of the goal-tasks / Workstream right-panel
  // surfaces (loom UI, plan W1). Both default on: first-visit discovery is
  // wanted without a manual + → tab per thread, and the per-thread one-shot
  // flags make the cost a single non-overriding seed per thread.
  autoOpenGoalTasksPanel: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  autoOpenWorkstreamPanel: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
} as const;

// Spread into `ClientSettingsPatch`.
export const LoomClientSettingsPatchFields = {
  reasoningDisplay: Schema.optionalKey(ReasoningDisplayMode),
  autoOpenGoalTasksPanel: Schema.optionalKey(Schema.Boolean),
  autoOpenWorkstreamPanel: Schema.optionalKey(Schema.Boolean),
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
  // Shallow-merged into current (see applyServerSettingsPatch): scalar toggles
  // replace when present; `chains`/`pausedAccounts` replace wholesale (the UI
  // sends complete values), so a partial per-key merge has no coherent meaning.
  providerFailover: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      resumeOnReset: Schema.optionalKey(Schema.Boolean),
      chains: Schema.optionalKey(
        Schema.Record(TrimmedNonEmptyString, Schema.Array(TrimmedNonEmptyString)),
      ),
      pausedAccounts: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
    }),
  ),
} as const;
