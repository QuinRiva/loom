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
} as const;

// Spread into `ClientSettingsPatch`.
export const LoomClientSettingsPatchFields = {
  reasoningDisplay: Schema.optionalKey(ReasoningDisplayMode),
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
  providerFailover: ProviderFailoverSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
} as const;

// Spread into `ServerSettingsPatch`.
export const LoomServerSettingsPatchFields = {
  // Whole-map replacement, mirroring `providerInstances`: presets are set as
  // complete entries, so a partial per-preset merge has no coherent meaning.
  workstreamModelPresets: Schema.optionalKey(Schema.Record(TrimmedNonEmptyString, ModelSelection)),
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
