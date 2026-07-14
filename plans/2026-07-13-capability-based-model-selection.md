---
manager_sessions:
  - id: c13bfd44-1153-412e-a39c-bc9721bb9057
    role: plan
    authored_at: 2026-07-13T04:30:39.932Z
---

# Capability-based model selection for Workstream children

**Status:** revised after three-model review (Fable 5, GPT-5.6 Sol, Gemini 3.1 Pro — all sound-with-changes)
**Owner:** Carl
**Date:** 2026-07-13

## 1. Problem

Models are a constantly moving target. A parent orchestrator cannot meaningfully
choose between `GPT 5.6 Sol` and `Fable 5` by name: no model natively knows the
relative capabilities of models that post-date its training data, so name-based
selection is guesswork dressed as a decision. Today's mechanism
(`workstreamModelPresets`: role-named presets plus explicit
`modelSelection`/`modelPreset`) works, but carries no semantics — a parent that
knows something about the *task* has no vocabulary to express it.

Additionally, subscription usage (5-hour / weekly windows per account) is
invisible to the spawn decision. Spawn warns on exhaustion after the fact but
never routes around a nearly-exhausted account.

### Design constraints

- The parent must spend near-zero reasoning tokens on model choice. There is
  generally no *correct* choice — a best guess is fine, and the occasional
  non-optimal pick is acceptable.
- The parent must never see usage meters, prices, or a score matrix; it knows
  the task's *shape*, the server knows everything else.
- The capability→model mapping is maintained **manually** by the operator, and
  updated when new models ship. No automated benchmarking.
- The primary user's work is exploratory data science, not narrow feature
  engineering: objectives are vague, plans are living documents, verification
  is expensive (statistical runs on real data). The dimension model reflects
  this.

## 2. Dimension model

Research (five triangulated researcher reports, July 2026, incl. a
cross-model calibration spine restricted to contemporaneous head-to-head
evidence) plus the operator's subjective experience produced **four scored
dimensions** and a set of facts/flags. Seven candidate dimensions were
collapsed to four because `reasoning`/`code_craft`/`critique`/`synthesis`
rank-order models identically nearly everywhere (one "horsepower" factor),
while the surviving axes each *break or invert* that order somewhere.

### Scored dimensions (1–10; best-in-class calibrated ≈ 7–8 so new models can
score higher without rescaling)

| Dimension | Meaning | High looks like | Low looks like |
|---|---|---|---|
| `horsepower` | Raw capability: reasoning depth, code quality, prose | Fable 5, Sol | Luna, Flash |
| `goalOrientation` | Sees the forest: works out what the user is *actually* trying to achieve, questions the approach when it is wrong | Anthropic family | executes the letter of the brief, accepts the approach at face value |
| `thoroughness` | Sees the trees: edge cases, cascading downstream effects, complete impact analysis | OpenAI family | misses edge cases; shallow one-pass answers |
| `endurance` | Long autonomous tool-use runs without derailing, giving up, or losing state | Sol, Opus, Fable | Gemini (derails), Luna (context cliff) |

`goalOrientation` vs `thoroughness` is the operator's false-negative vs
false-positive framing: Anthropic models are FN-prone (miss edge cases, get the
goal right), OpenAI models are FP-prone (catch everything, including
non-meaningful "issues", and over-engineer). This split is what makes
build-with-Anthropic / review-with-OpenAI gate pairings principled.

### Facts and flags (not scores — filters, tie-breaks, routing rules)

Per profile: `cost` (in/out $ per Mtok), `speed` (`fast`/`moderate`/`slow`),
`usableContext` (honest usable window, not advertised), `vision` (flag),
`domainKnowledge` (flag), `agentic` (`full` / `bounded` / `oracle`), and
free-text `notes` (behavioural caveats surfaced to whoever reads the profile).

`agentic: "oracle"` means: never spawn as an autonomous child; use only for
one-shot consultation (complex question in, answer out, handed to another
agent). Scores cannot express "don't spawn this"; the flag does.

One routing rule is safety-relevant and therefore machine-readable, not prose:
`unsuitableFor: ["security-sensitive"]` on a profile (v1: this single token).
A parent passing `sensitive: "security"` at spawn (optional, alongside
`taskShape`) excludes profiles carrying that marker. This exists because
Fable 5's safety classifier interrupts/reroutes security/crypto/bio-adjacent
runs mid-flight, and `explore` deterministically resolves to Fable — a
free-text note cannot prevent that. (Review finding, Fable + Sol.)

### Initial matrix (operator-adjusted; Grok dropped — not in use)

| Model | horsepower | goalOrientation | thoroughness | endurance | agentic |
|---|---|---|---|---|---|
| Fable 5 | 8 | 8 | 6 | 7 | full |
| Opus 4.8 | 7 | 7 | 6 | 7 | full |
| GPT-5.6 Sol | 8 | 5 | 8 | 7 | full |
| GPT-5.6 Terra | 7 | 5 | 7 | 6 | full |
| GPT-5.6 Luna | 5 | 3 | 5 | 5 | bounded |
| Gemini 3.1 Pro | 7 | 7 | 3 | 3 | oracle |
| Gemini 3.0 Flash | 5 | 5 | 2 | 3 | oracle |

Key notes carried per profile (abridged):
- **Fable 5** — never route security/crypto/bio-adjacent work (safety
  classifier interrupts/reroutes mid-run); no ZDR; premium cost.
- **Opus 4.8** — dependable default; false-green "done" risk → hard
  verification gates on coders.
- **Sol** — maximum-thoroughness reviewer/hardener; gate destructive actions;
  verify claimed results (documented false-completion/eval-gaming); expect
  some non-meaningful findings.
- **Gemini 3.1 Pro** — oracle: one-shot graph interpretation and
  domain-semantic questions; big-picture-good but low-exploration (can
  confidently reach wrong conclusions); sycophantic under pushback — never in
  rebuttal loops. **Premature success**: declares completion before the task
  contract is met (observed first-hand: ended a review turn without
  submitting; submitted with a wrong terminal token) — any Gemini child
  needs an explicit, mechanical completion contract and should not be
  trusted on self-reported "done". Best vision + domain knowledge in the
  field.

The matrix, dimension definitions, re-scoring routine, and the trusted
comparative sources list (Artificial Analysis, LMArena, Aider polyglot,
SWE-bench/Vals, Terminal-Bench, Simon Willison, first-party system cards) live
in `docs/operations/model-profiles.md`. Updating for a new model release is a
documented ~10-minute manual edit.

## 3. Parent-facing surface: `taskShape`

One optional enum on `workstream_spawn`. The parent expresses task shape in a
single token; the server resolves deterministically.

Three shapes (was four: `harden` and `deep-review` sorted identically with
this matrix and role/`gate` already tells the server a child is a reviewer —
Sol's review finding; one fewer decision token for the parent):

| `taskShape` | Intended use |
|---|---|
| *(omitted)* | most spawns — role preset, as today |
| `explore` | open-ended/prototype work, vague objective, plan likely to change |
| `thorough` | edge cases, migrations, hardening, review gates — anywhere missing a real issue is worse than noise |
| `mechanical` | bounded, self-contained, high-volume work: extraction, renames, formatting. NOT long-context extraction runs (those are `thorough` or an explicit override) |

Precedence: explicit `modelSelection` > `modelPreset` > `taskShape` > role
preset > inherit. All existing behaviour is preserved when `taskShape` is
omitted; presets stay as escape hatches. When both a preset/selection and
`taskShape` are passed, the shape is ignored with a one-line warning in the
spawn result (existing `warnings` array). `taskShape` is decoded and
validated at the HTTP boundary like every other body field — an unknown
token is a 400 (schema-level typo), but a *valid* shape on a server with no
profiles configured falls through to the role preset/inherit path with a
warning naming the misconfiguration, never a 400 (the parameter is advisory;
a hard failure would cost the parent exactly the re-spawn reasoning this
design eliminates).

The when-to-use guidance is four lines in the tool description — stable text
that never goes stale, because it references task characteristics rather than
model names. The score matrix itself is **not** injected into the parent's
context.

### Resolution algorithm (pure function — the tables ARE the specification)

Per-shape filter and ordering (review finding, all three: the resolver must
be totally specified — floors, key order, and tie-breaks are normative):

| Shape | Filter (floors) | Sort keys, in order |
|---|---|---|
| `explore` | `agentic = full`, endurance ≥ 5 | goalOrientation ↓, horsepower ↓, thoroughness ↓ |
| `thorough` | `agentic = full` | thoroughness ↓, horsepower ↓, goalOrientation ↓ |
| `mechanical` | `agentic ∈ {full, bounded}`, horsepower ≥ 5 | costPerMtok.input ↑, horsepower ↓ |

Universal final tie-breaks appended to every sort: `costPerMtok.input` ↑,
then profile name lexicographic ↑ (Gemini's review finding: without a strict
total order, parallel spawns could flip-flop on runtime sort stability).
Profiles with `agentic = oracle` or a matching `unsuitableFor` exclusion
never enter the candidate set. With integer scores this yields a static
ranked list per shape until the matrix changes — intended, and pinned by a
snapshot test (§6.7) so an operator editing scores sees exactly which
routings changed (Fable's review finding).

Algorithm:

1. **Filter** by the shape's row above. Empty ⇒ fall through to role
   preset/inherit with a warning (never 400 — see §3).
2. **Rank** by the shape's sort keys plus universal tie-breaks.
3. **Bucket by headroom** (§4): `healthy` / `demoted` / `skipped`. Pick the
   top-ranked profile from the best non-empty bucket. (Gemini's bucket
   formulation — a nearly-exhausted right-shaped model always beats
   refusing to spawn; existing per-dispatch failover and the exhaustion
   warning handle the rest.)
4. **Validate** the pick against the live model catalogue (same fail-fast
   check presets use). Invalid ⇒ drop to the next profile in the same
   bucket order, recording `skipped profile X (invalid: …)` in the spawn
   warnings — silent fallthrough would hide operator misconfiguration
   (Fable's review finding).
5. Return the selection plus a **categorical** rationale for the spawn
   result, e.g. `opus-4.8 (explore; headroom low on first choice — demoted)`
   or `fable-5 (explore)`. No usage percentages, prices, or scores in the
   parent-facing line (Sol's review finding: the design's own information
   boundary); exact telemetry stays in server logs.

## 4. Subscription headroom as a resolver input

Existing machinery: `AccountUsageRegistry` holds per-account
`AccountUsageWindow`s (`primary` ≈ 5-hour, `secondary` ≈ weekly) with
`usedPercent` and `resetsAt`, fed by provider rate-limit events;
`ProviderHealthRegistry` marks hard exhaustion; `resolveFailoverTarget`
already reroutes exhausted pi slugs per dispatch. Today spawn only *warns*.

Change: each shape-filtered candidate is placed in one of three **headroom
buckets**; resolution picks from the best non-empty bucket (§3 step 3):

- **`skipped`** — the account has an active hard-exhaustion mark or
  `limitReached` (matching the semantics per-dispatch failover applies).
- **`demoted`** — the *binding* window's `usedPercent ≥ 90`.
- **`healthy`** — everything else, including anything whose usage data is
  missing or stale.

Binding-window semantics (review finding, Fable + Sol — the naive read is
wrong for pooled accounts and scoped windows):

- **Aggregation:** reuse the best-remaining aggregation the routing layer
  already applies (`ProviderHealthRegistry.aggregateAccountsBestRemaining`):
  per window kind, the minimum `usedPercent` across an instance's pooled
  accounts — the router fails over between accounts, so an instance is only
  as exhausted as its *freshest* account. Reading raw per-account snapshots
  would wrongly demote a pooled instance whose other account is fresh.
- **Scope:** consider only account-wide windows plus windows mapped to the
  selected model (via the same `subscriptionScopeForSelection` resolution
  the existing exhaustion warning uses); ignore unmapped display-only
  scopes. Another model's exhausted window must not demote this one.
- **Reset discount:** a window whose `resetsAt` is a **valid future**
  timestamp within ~15 minutes is not binding (the child barely dispatches
  before it clears). An expired or null `resetsAt` gets no discount.
- **Freshness:** usage snapshots are memory-resident sparse merges; treat
  data older than ~15 minutes (or absent) as *unknown* ⇒ `healthy`. Never
  demote on stale or missing data (Sol's review finding: a stale 95%
  reading with a null reset would otherwise demote indefinitely).
- No slope projection, no cost-tier early demotion — an if-statement, not a
  model. The registry's `usageSlopePerMinute` exists if we later want "will
  exhaust before the child finishes"; out of scope.

The bucket decision (and why) rides the spawn warnings/rationale in
categorical form (§3 step 5); numeric telemetry stays server-side.

### Accepted v1 limitation: spawn-time resolution for deferred starts

A `blockedBy`/staged/gated child resolves its model at **spawn** but
dispatches at **release** — possibly hours later. Gated reviewers (prime
`thorough` consumers) *always* start deferred, so their headroom snapshot is
systematically stale (review finding, Fable + Sol). Accepted for v1: the
consequences are bounded — hard exhaustion at dispatch already gets the
per-dispatch failover/wait path, and a stale *demotion* merely picks the
second-ranked profile of the right shape. The v2 upgrade, if the limitation
bites in practice, is to persist the `taskShape` intent on the thread and
re-run resolution at first dispatch; noted here so the decision is legible.

## 5. Settings schema

New `workstreamModelProfiles` in `LoomServerSettingsFields`
(packages/contracts/src/settings.loom.ts), keyed by profile name:

Resolver inputs are required; documentation-only facts are optional (review
finding, Fable + Sol: don't force maintenance of fields nothing consumes —
the rich comparative matrix lives in `docs/operations/model-profiles.md`):

```ts
WorkstreamModelProfile = Schema.Struct({
  selection: ModelSelection,            // instanceId + model (+ options)
  scores: Schema.Struct({
    horsepower: Score10,                // Schema.Int 1..10
    goalOrientation: Score10,
    thoroughness: Score10,
    endurance: Score10,
  }),
  costPerMtok: Schema.Struct({ input: Schema.Number, output: Schema.Number }),
  agentic: Schema.Literals(["full", "bounded", "oracle"]),
  unsuitableFor: Schema.optionalKey(Schema.Array(Schema.Literals(["security-sensitive"]))),
  // Documentation-only (rendered, never routed on):
  usableContext: Schema.optionalKey(Schema.Number), // honest usable tokens
  speed: Schema.optionalKey(Schema.Literals(["fast", "moderate", "slow"])),
  vision: Schema.optionalKey(Schema.Boolean),
  domainKnowledge: Schema.optionalKey(Schema.Boolean),
  notes: Schema.optionalKey(Schema.String),
})
```

Patch field mirrors `workstreamModelPresets` (whole-map replacement — profiles
are set as complete entries). `workstreamModelPresets` is retained unchanged;
profiles are an additional layer, not a migration.

Alternate instances for the same model (e.g. `cliproxy/claude-opus-4-8` vs
`google-vertex-claude/claude-opus-4-8`) are separate profiles sharing scores;
the headroom demotion naturally routes between them because they draw on
different accounts. (A future refinement could share one score block across an
instance chain; not needed for v1.)

## 6. Code changes

1. **`packages/contracts/src/settings.loom.ts`** — `WorkstreamModelProfile`
   schema + `workstreamModelProfiles` field (settings + patch); `TaskShape`
   literal union exported as the canonical vocabulary.
2. **`packages/shared/src/serverSettings.ts`** — patch/merge handling for the
   new map (mirror of presets).
3. **`apps/server/src/mcp/WorkstreamSpawnHttp.ts`**
   - Add `taskShape` (and `sensitive`) to the `WorkstreamSpawnRequest`
     interface and decode/validate them at the boundary like the other
     body fields.
   - Pure `resolveShapeSelection({ shape, sensitive, profiles, usage,
     exhaustion, catalogue })` implementing §3–§4, beside
     `resolvePresetSelection`.
   - Slot into the precedence chain in `handleWorkstreamSpawn` (only when
     `modelSelection` and `modelPreset` are absent and `taskShape` present);
     warn when a shape is passed alongside a higher-precedence override.
   - Extend `SelectionSource` with `{ kind: "task-shape"; shape; rationale }`
     for error prose and result reporting.
   - No-profiles / empty-filter ⇒ warn + fall through to role preset/inherit
     (never 400 for a valid shape token; §3).
4. **`apps/server/src/provider/Drivers/Pi/providerToolDefs.ts`** — `taskShape`
   enum param on `workstream_spawn` with the three-line guidance table and
   the optional `sensitive` marker; trim the `modelSelection`/`modelPreset`
   descriptions to position them as escape hatches.
5. **`apps/server/src/mcp/workstreamRender.ts`** — the rendered
   `workstream_list` output (the ONLY surface a pi parent sees — the bridge
   is POST-and-print, so JSON fields are invisible; review finding, Fable +
   Sol) becomes: the task-shape vocabulary, configured presets, a compact
   profile summary (name, agentic flag, `usableContext`, validity — so a
   parent can spot when a shape would pick an insufficient-context model
   and deliberately override; Gemini's review finding), and a **compact**
   catalogue (one line per instance: `instanceId: slug, slug, …`) so
   explicit `modelSelection` overrides remain discoverable. Oracle profiles
   are marked "not spawnable" or omitted from the shape summary.
6. **`docs/operations/model-profiles.md`** — matrix, dimension definitions,
   scoring calibration (7–8 = today's best), re-scoring routine, trusted
   sources list, and the routing notes per model.
7. **Tests** — pure-function tests for `resolveShapeSelection` (per-shape
   filters/orderings/tie-breaks, headroom buckets incl. pooled best-remaining
   aggregation, near-reset discount, stale-data ⇒ healthy, catalogue
   validation fallthrough with warning, empty-filter fallthrough,
   `unsuitableFor` exclusion); a **per-shape ranking snapshot test** over the
   initial matrix so score edits surface their routing consequences in the
   diff; spawn-route tests for precedence, the shape+preset warning, and the
   categorical rationale; render tests for the new list block.

Out of scope for v1: an oracle-consultation tool for Gemini-class models
(tracked as follow-up; `agentic: "oracle"` profiles are simply excluded from
spawn resolution), slope-projected exhaustion, per-role default shapes,
dispatch-time re-resolution for deferred starts (§4, designated v2).

## 7. Risks / accepted limitations

- **Shape vocabulary fit.** Three shapes may prove too coarse or wrongly-cut;
  they are cheap to rename/extend (enum + resolver table). Trial and revise.
- **Score staleness.** Manual updates can lag releases; mitigated by the
  documented routine, the snapshot test, and scores mattering only ordinally
  (a stale 7 vs 8 rarely changes the pick within a shape).
- **Double maintenance** (presets + profiles). Accepted for v1; if shapes
  prove out, role presets could later become shape aliases.
- **Headroom flapping.** Usage percent moves; two spawns minutes apart may get
  different models. Accepted — "non-optimal every now and then" is within
  tolerance, and the rationale line makes it legible.
- **Spawn-time resolution is stale for deferred starts** (§4). Accepted for
  v1; dispatch-time re-resolution is the designated v2 upgrade.
- **Mid-run failover is shape-blind.** If a shape-picked model exhausts
  mid-run, `resolveFailoverTarget` walks static chains that know nothing of
  the shape's dimensions — a `thorough` child can land on a low-thoroughness
  fallback. Within stated tolerance; noted for legibility (Fable's review
  finding).
- **`unsuitableFor` relies on the parent flagging sensitivity.** A parent
  that omits `sensitive: "security"` on a security-adjacent explore task
  still routes to Fable. The tool description carries the prompt-side nudge;
  a content-based classifier is out of scope.
