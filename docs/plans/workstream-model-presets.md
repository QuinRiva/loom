---
manager_sessions:
  - id: c8c60ee8-e9c3-49aa-9222-47ec98f89dc1
    role: plan
    authored_at: 2026-06-25T05:56:05.954Z
---

# Plan: Workstream model presets (named selection + role auto-default)

## Problem

`workstream_spawn` accepts a full `ModelSelection` (`{ instanceId, model, options[] }`)
or inherits the parent's. There is no catalogue and no named shortcut, so an agent
that wants a specific non-inherited model (e.g. "spawn a reviewer on GPT‑5.5 at high
reasoning") must reconstruct three opaque values from scratch each time — the
configured instance id, the exact model slug, and the reasoning-option encoding.
None are in the agent's context, so it grep-spelunks the codebase nondeterministically
(observed 4–8+ tool calls). We want this to be a _name the agent already knows_, not a
structure it has to derive.

## Design

One mechanism, two ergonomic layers:

- **B — named presets.** A server-settings map `workstreamModelPresets: Record<name, ModelSelection>`.
  `workstream_spawn` gains an optional `modelPreset: string`; the server resolves it to the
  stored `ModelSelection`.
- **C — role auto-default.** `workstream_spawn` already takes `role`. When neither
  `modelSelection` nor `modelPreset` is supplied, the server auto-selects the preset whose
  key equals `role`. So "spawn a reviewer" (role `"reviewer"` + a configured `reviewer` preset)
  Just Works with no model fields at all.

Both layers resolve against the **same** keyed map — a preset named `reviewer` serves both
`modelPreset: "reviewer"` and `role: "reviewer"`.

### Resolution precedence (in `handleWorkstreamSpawn`)

1. Explicit `body.modelSelection` → decode and use (unchanged behaviour; wins over everything).
2. Else `body.modelPreset` present → look up `settings.workstreamModelPresets[modelPreset]`.
   - found → use it.
   - missing → **400**, message listing the available preset names (fail visibly; do not
     silently fall back — a named preset that doesn't exist is an authoring error).
3. Else a preset keyed by `role` exists → use it (layer C).
4. Else inherit the parent's `modelSelection` (current behaviour).

Backward-safe: default settings have an empty preset map, so steps 2–3 are inert and
existing spawns inherit the parent exactly as today.

## Changes

### 1. Contracts — `packages/contracts/src/settings.ts`

- Add to `ServerSettings`:
  `workstreamModelPresets: Schema.Record(PresetName, ModelSelection)` with a decoding
  default of `{}`. `PresetName` = trimmed-non-empty string key (a plain slug; reuse the
  existing trimmed-string key type — no new brand needed unless one is already idiomatic here).
- Add to `ServerSettingsPatch`:
  `workstreamModelPresets: Schema.optionalKey(Schema.Record(PresetName, ModelSelectionPatch))`
  — but presets are set as whole entries, so the simplest correct semantics is **replace the
  whole map** when the key is present (mirror how `providerInstances` is handled in the patch
  path rather than the per-field merge `textGenerationModelSelection` uses).
- `ModelSelection` already absorbs the legacy `{provider}` shape via its pre-decode transform,
  so preset values get that for free.

### 2. Shared — `packages/shared/src/serverSettings.ts`

- In `applyServerSettingsPatch`, when `patch.workstreamModelPresets !== undefined`, replace
  `current.workstreamModelPresets` wholesale (same pattern as the existing
  `providerInstances` replace branch). No deep per-preset merge.

### 3. Server handler — `apps/server/src/mcp/WorkstreamSpawnHttp.ts`

- Accept `modelPreset?: unknown` on `WorkstreamSpawnRequest`; `trimString` it.
- Inject `ServerSettingsService` and read `getSettings` once in `handleWorkstreamSpawn`.
- Implement the 4-step precedence above, replacing the current
  "explicit modelSelection or inherit parent" block. Keep the existing 400 on an invalid
  explicit `modelSelection`. For an unknown `modelPreset`, 400 with a message of the form
  `Unknown modelPreset "<x>". Available presets: a, b, c.` (or "none configured").
- Confirm `ServerSettingsService` is in the router layer's context where these routes are
  mounted (`server.ts` already provides the serverSettings layer); add it to the handler's
  required services.

### 4. Tool surface — `apps/server/src/provider/Drivers/Pi/WorkstreamSpawnExtension.ts`

- Add `modelPreset: { type: "string", ... }` to the `workstream_spawn` JSON-schema `properties`.
- Update the tool `description`, `promptSnippet`, and the `modelSelection`/new `modelPreset`
  param descriptions to explain: pass `modelPreset` to run the child on a named preset; if you
  omit both `modelSelection` and `modelPreset`, a preset matching the child's `role` is used
  when configured, otherwise the parent's model is inherited.
- Preset _names_ are dynamic (per deployment), so the static description explains the concept
  rather than hardcoding a list. (Optional, note only — not required for this change:
  templating `ensurePiWorkstreamSpawnExtension` to inject the configured names into the
  description. Skip unless trivial.)

### 5. Settings UI — scope note

Making presets _configurable_ in the web settings form is a **follow-up**, not part of this
change, unless the settings form is already schema-driven (auto-renders from the
`ServerSettings` schema/annotations) — in that case verify the new field surfaces sanely and
leave it; do not build a bespoke editor here. Presets are persistable now via the existing
settings-patch path regardless. Call out explicitly in the handoff which of these turned out
to be the case.

## Verification (required before "done")

- `vp run typecheck` and `vp check` must pass.
- Lightweight, high-value tests only (per repo AGENTS.md — tests are optional/rare):
  - settings schema: `workstreamModelPresets` decodes with default `{}` and round-trips a
    populated map.
  - patch merge: providing `workstreamModelPresets` replaces the map.
  - spawn precedence: the 4-way resolution (explicit > preset > role > inherit) and the
    unknown-preset 400. Extend the existing `WorkstreamSpawnHttp`/`server.test.ts` coverage
    rather than adding a new mock-heavy suite.
- Canonical entrypoint: exercise a real spawn through the running server if feasible
  (a child spawned with `modelPreset` and one relying on the `role` default), and report the
  resolved `modelSelection` on the created child. If that requires resources not available in
  the worktree, say so explicitly instead of substituting a synthetic smoke test.

## Out of scope

- Rich settings-form preset editor (follow-up).
- Any AGENTS.md cheatsheet stopgap (explicitly not wanted).
- Changing inherit-parent default behaviour when no presets are configured.
