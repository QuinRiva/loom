# Model profiles: capability-based Workstream model selection

This document is the operator's source of truth for the
`workstreamModelProfiles` server setting that powers `taskShape`-based model
selection when spawning Workstream children. The design rationale lives in
`plans/2026-07-13-capability-based-model-selection.md`; this page is the
practical reference: what each dimension means, how the scores are calibrated,
the initial matrix to apply, how to re-score when a new model ships, and which
comparative sources to trust.

The server never invents these numbers. The capability→model mapping is
maintained **manually** here and applied to settings; there is no automated
benchmarking. Updating for a new model release is a documented ~10-minute edit
(see [Re-scoring routine](#re-scoring-routine-for-a-new-model)).

## Why this exists

A parent orchestrator cannot meaningfully choose between models by name: no
model natively knows the relative capabilities of models that post-date its
training data, so name-based selection is guesswork dressed as a decision.
Instead, the parent expresses the _shape_ of the work in one token
(`taskShape`) and the server resolves deterministically against these profiles.
The parent never sees usage meters, prices, or the score matrix — it knows the
task, the server knows everything else.

## Task shapes

`taskShape` is an optional enum on `workstream_spawn`. Three shapes:

| `taskShape`  | Intended use                                                                                                                                                |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(omitted)_  | most spawns — the role preset, as today                                                                                                                     |
| `explore`    | open-ended/prototype work, vague objective, plan likely to change                                                                                           |
| `thorough`   | edge cases, migrations, hardening, review gates — anywhere missing a real issue is worse than noise                                                         |
| `mechanical` | bounded, self-contained, high-volume work: extraction, renames, formatting. NOT long-context extraction runs (those are `thorough` or an explicit override) |

Precedence: explicit `modelSelection` > `modelPreset` > `taskShape` > role
preset > inherit. When both a preset/selection and a shape are supplied, the
shape is ignored with a one-line warning in the spawn result. A valid shape on
a server with **no** configured profiles is not an error — it falls through to
the role preset/inherit path with a warning. Profiles are additive; the
existing `workstreamModelPresets` machinery is unchanged.

An optional `sensitive: "security"` marker, passed alongside `taskShape`,
excludes any profile carrying `unsuitableFor: ["security-sensitive"]` from the
candidate set — see [`unsuitableFor`](#unsuitablefor).

## Scored dimensions

Four dimensions are scored **1–10**. Seven candidate dimensions collapsed to
four because `reasoning`/`code_craft`/`critique`/`synthesis` rank-order models
identically nearly everywhere (one "horsepower" factor); the surviving axes each
_break or invert_ that order somewhere.

| Dimension         | Meaning                                                                                                           | High looks like  | Low looks like                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- | -------------------------------------------------------------------- |
| `horsepower`      | Raw capability: reasoning depth, code quality, prose                                                              | Fable 5, Sol     | Luna, Flash                                                          |
| `goalOrientation` | Sees the forest: works out what the user is _actually_ trying to achieve; questions the approach when it is wrong | Anthropic family | executes the letter of the brief; accepts the approach at face value |
| `thoroughness`    | Sees the trees: edge cases, cascading downstream effects, complete impact analysis                                | OpenAI family    | misses edge cases; shallow one-pass answers                          |
| `endurance`       | Long autonomous tool-use runs without derailing, giving up, or losing state                                       | Sol, Opus, Fable | Gemini (derails), Luna (context cliff)                               |

`goalOrientation` vs `thoroughness` is the false-negative vs false-positive
framing: Anthropic models are FN-prone (miss edge cases, get the goal right),
OpenAI models are FP-prone (catch everything, including non-meaningful "issues",
and over-engineer). This split is what makes build-with-Anthropic /
review-with-OpenAI gate pairings principled.

### Scoring calibration

Scores are **ordinal within a dimension**, not absolute. The scale is
calibrated so that **today's best-in-class model scores ≈ 7–8**, deliberately
leaving headroom (9–10) so a genuinely stronger model can be added later
without rescaling every existing profile. A 10 is not "excellent" — it is
"materially beyond anything shipping in July 2026". When in doubt, compress:
most production-grade models on a given axis sit at 6–8, and the ordering
between them is what drives routing, not the absolute value.

Because scores are integers and comparisons are ordinal, a stale 7-vs-8 rarely
changes the pick within a shape — which is the point. Do not agonise over a
single point; get the rank order right.

## Facts and flags (not scored)

Per profile, alongside the four scores:

- **`selection`** (required) — the `ModelSelection` (instanceId + model +
  optional options) the profile routes to.
- **`costPerMtok`** (required) — input/output USD per million tokens. Used as
  the `mechanical` primary sort key and the universal tie-break.
- **`agentic`** (required) — `full` / `bounded` / `oracle`. `oracle` means
  **never spawn as an autonomous child**; use only for one-shot consultation
  (complex question in, answer out). Oracle profiles are excluded from spawn
  resolution entirely — scores cannot express "don't spawn this", the flag
  does.
- **`unsuitableFor`** (optional) — see below.
- Documentation-only (rendered on the discovery surface, never routed on):
  **`usableContext`** (honest usable window, not the advertised number),
  **`speed`** (`fast`/`moderate`/`slow`), **`vision`**, **`domainKnowledge`**,
  and free-text **`notes`** (behavioural caveats).

### `unsuitableFor`

The single machine-readable, safety-relevant routing rule (v1: one token,
`"security-sensitive"`). A profile carrying it is excluded whenever a parent
passes `sensitive: "security"`. This exists because Fable 5's safety classifier
interrupts/reroutes security/crypto/bio-adjacent runs mid-flight, and `explore`
deterministically resolves to Fable — a free-text note cannot prevent that.

## Resolution algorithm

The resolver is a pure function; the per-shape tables **are** the
specification. For each shape:

| Shape        | Filter (floors)                             | Sort keys, in order                             |
| ------------ | ------------------------------------------- | ----------------------------------------------- |
| `explore`    | `agentic = full`, endurance ≥ 5             | goalOrientation ↓, horsepower ↓, thoroughness ↓ |
| `thorough`   | `agentic = full`                            | thoroughness ↓, horsepower ↓, goalOrientation ↓ |
| `mechanical` | `agentic ∈ {full, bounded}`, horsepower ≥ 5 | costPerMtok.input ↑, horsepower ↓               |

Universal final tie-breaks appended to **every** sort: `costPerMtok.input` ↑,
then profile name lexicographic ↑ (a strict total order, so parallel spawns
never flip-flop on sort stability). Profiles with `agentic = oracle` or a
matching `unsuitableFor` exclusion never enter the candidate set.

With integer scores this yields a static ranked list per shape until the matrix
changes — intended, and pinned by a snapshot test so an operator editing scores
sees exactly which routings changed.

Each shape-filtered candidate is then placed in a **headroom bucket** and the
top-ranked profile from the best non-empty bucket is picked:

- **`skipped`** — the account has an active hard-exhaustion mark (this also
  covers a Codex `limitReached` flag).
- **`demoted`** — the binding window's `usedPercent ≥ 90` (and not about to
  reset).
- **`healthy`** — everything else, including anything whose usage data is
  missing or stale.

Headroom uses the router's best-remaining view (a pooled instance is only as
exhausted as its freshest account), considers only account-wide windows plus
windows mapped to the selected model, discounts a window resetting within ~15
minutes, and treats data older than ~15 minutes (or absent) as unknown ⇒
healthy — it never demotes on stale/missing data. A nearly-exhausted
right-shaped model always beats refusing to spawn.

Finally the pick is validated against the live model catalogue (the same
fail-fast check presets use). An invalid pick drops to the next profile in
bucket order, recording a `skipped profile X (invalid: …)` warning so operator
misconfiguration is never silent.

## Initial matrix

Operator-adjusted (Grok dropped — not in use). Apply these as
`workstreamModelProfiles` entries in server settings, keyed by profile name.

| Model            | horsepower | goalOrientation | thoroughness | endurance | agentic |
| ---------------- | ---------- | --------------- | ------------ | --------- | ------- |
| Fable 5          | 8          | 8               | 6            | 7         | full    |
| Opus 4.8         | 7          | 7               | 6            | 7         | full    |
| GPT-5.6 Sol      | 8          | 5               | 8            | 7         | full    |
| GPT-5.6 Terra    | 7          | 5               | 7            | 6         | full    |
| GPT-5.6 Luna     | 5          | 3               | 5            | 5         | bounded |
| Gemini 3.1 Pro   | 7          | 7               | 3            | 3         | oracle  |
| Gemini 3.0 Flash | 5          | 5               | 2            | 3         | oracle  |

Given this matrix, the resolver ranks (before headroom):

- **explore** → Fable 5, Opus 4.8, GPT-5.6 Sol, GPT-5.6 Terra
- **thorough** → GPT-5.6 Sol, GPT-5.6 Terra, Fable 5, Opus 4.8
- **mechanical** → ordered by cost, then horsepower (Luna/Terra/Sol/Opus/Fable
  for the representative costs)

### Per-model routing notes

Carry these in each profile's `notes` field so whoever reads the profile sees
the behavioural caveats.

- **Fable 5** — never route security/crypto/bio-adjacent work (safety
  classifier interrupts/reroutes mid-run); mark it `unsuitableFor:
["security-sensitive"]`. No ZDR; premium cost.
- **Opus 4.8** — dependable default; false-green "done" risk → put hard
  verification gates on coders.
- **GPT-5.6 Sol** — maximum-thoroughness reviewer/hardener; gate destructive
  actions; verify claimed results (documented false-completion/eval-gaming);
  expect some non-meaningful findings.
- **GPT-5.6 Terra** — a lighter Sol; same OpenAI thoroughness bias, less
  horsepower/endurance.
- **GPT-5.6 Luna** — bounded agentic; watch for a context cliff on long runs.
  Suits `mechanical` on cost.
- **Gemini 3.1 Pro** — `oracle`: one-shot graph interpretation and
  domain-semantic questions; big-picture-good but low-exploration (can
  confidently reach wrong conclusions); sycophantic under pushback — never in
  rebuttal loops. **Premature success**: declares completion before the task
  contract is met — any Gemini child needs an explicit, mechanical completion
  contract and should not be trusted on self-reported "done". Best vision +
  domain knowledge in the field. Excluded from spawn resolution by the `oracle`
  flag.
- **Gemini 3.0 Flash** — `oracle`: fast, cheap, shallow; consultation only.

## Re-scoring routine for a new model

When a new model ships (~10 minutes):

1. **Gather comparative evidence** from the [trusted
   sources](#trusted-comparative-sources) below — prefer contemporaneous
   head-to-head comparisons against models already in the matrix over absolute
   benchmark numbers.
2. **Place it on each of the four dimensions** relative to the existing
   entries, not on an absolute scale. Ask "is it above or below Opus on
   horsepower? above or below Sol on thoroughness?" and slot it in. Keep
   best-in-class at 7–8; only use 9–10 for a genuine step-change.
3. **Set the facts/flags**: `agentic` (is it safe to run autonomously, or
   oracle-only?), `costPerMtok`, honest `usableContext`, and any behavioural
   `notes` and `unsuitableFor` caveats.
4. **Add the profile** to `workstreamModelProfiles` in server settings (whole-
   map replacement — send the complete set).
5. **Run the per-shape ranking snapshot test** and read the diff: it shows
   exactly which routings the new model (and any score edits) changed. Confirm
   the changes are intended before committing.

Prefer getting the **rank order** right over precise absolute values — routing
is ordinal within a shape.

## Trusted comparative sources

Weight independent head-to-head evaluation over vendor claims. Discount
first-party marketing numbers (use system cards for capability/safety
_behaviour_, not for leaderboard bragging).

- **Artificial Analysis** — cross-model intelligence/price/speed comparisons.
- **LMArena** — human-preference head-to-head ranking.
- **Aider polyglot** — real multi-language code-editing benchmark.
- **SWE-bench / Vals** — software-engineering task resolution.
- **Terminal-Bench** — long autonomous tool-use / agentic endurance.
- **Simon Willison's blog** — timely, hands-on qualitative assessments.
- **First-party system cards** — for capability boundaries and safety
  behaviour (e.g. classifier interrupts), NOT for comparative scores; discount
  vendor performance claims.
