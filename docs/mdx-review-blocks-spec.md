---
manager_sessions:
  - id: cf8d54bd-a4c8-4c96-8b14-6942efcc34bd
    role: plan
    authored_at: 2026-07-16T01:09:29.594Z
---

# MDX plan review blocks — spec

Four new blocks + a wrap-text control + skill-phrasing changes that close the
gap between the MDX plan renderer and the HTML explainer artefacts (the Pi
`visual-explainer` skill) for **decision-review documents**. Motivated by the
tier-A taxonomy sign-off comparison: the MDX plan
(`data-pipeline-jobs/lease-extraction/plans/fable5-tier-a-signoff/plan.mdx`)
lost to the HTML doc (`scripts/fable5_tier_a/decision_doc.html`) on five
counts — field-level diffs rendered as unreadable line diffs, no progressive
disclosure, no per-item visual identity, no per-item decision capture, and
authoring friction that pushed evidence out of the document. Blocks 1–4 close
those; the wrap control fixes the shared long-string failure; the skill
changes make the model actually produce the better artefact.

All blocks follow the existing contract in
`apps/web/src/components/files/mdx-plan/blockTypes.ts`: one file per block in
`blocks/`, a zod schema, a `BlockMdxConfig` (tag + `toAttrs`/`fromAttrs`), a
`Read` renderer, one registry entry in `registry.tsx`. The generated
`references/block-schema.md` and `lint-plan.mjs` pick new blocks up from the
registry automatically, with two exceptions called out inline: the schema
generator must learn to render nullable fields (§1), and the linter gains
one semantic check for `<ReviewChoice>` id uniqueness (§4).

---

## 1. `<FieldDiff>` — record-level before/after

**Problem it solves.** The plan's workhorse change unit is "these 2–3 fields
of a record change", but `<Diff>` is a _line_ differ with `whitespace-pre`:
a 300-char `condition` string becomes one horizontally-scrolled line, twice,
in half-width columns. The HTML doc's CURRENT/PROPOSED field cards were the
single biggest readability win.

**Rendering.** Two labelled panels side by side (stacking under ~640px):
left tinted `bg-destructive/5`, right tinted `bg-emerald-500/5` (matching
`<Diff>`'s row colours). Each panel lists the fields in authored order:
field name in mono muted small-caps on its own line, value below in
**wrapped** prose (`whitespace-pre-wrap break-words`). Value rendering:

- **Key present with value `null`** → italic muted `null` (the HTML doc's
  `.fld .null`) — the field exists and its value is null (the common
  "condition: null" case).
- **Key absent** → muted em-dash — the field does not apply on that side
  (e.g. a `containment_description` introduced only in the after state).
  The wire preserves this distinction (the attr JSON walker keeps `null`
  and drops only `undefined`), and the renderer keeps the two panels
  row-aligned per field either way.
- `kept: true` fields render at reduced opacity in **both** panels with a
  small `unchanged` tag — for context fields the reviewer needs to see
  (e.g. `containment_certainty: "definitive"` in C-3).

Header row mirrors `<Diff>`: optional `title` (mono, truncate), changed-field
count chip. The count excludes `kept` rows — it is the number of fields that
actually change. No unified/split toggle — the two-panel layout is the point.

**Data + schema.**

```ts
export interface FieldDiffField {
  /** Field name/path, e.g. "necessity" or "target.direct_debit_request.applicability_condition". */
  name: string;
  /** Value before. `null` = field present with null value; omit = field absent on this side. */
  before?: string | null;
  /** Value after. `null` = field present with null value; omit = field absent on this side. */
  after?: string | null;
  /** Render dimmed in both panels with an "unchanged" tag (context field). */
  kept?: boolean;
  /** Optional one-line margin note under the field row. */
  note?: string;
}

export interface FieldDiffData {
  title?: string;
  beforeLabel?: string; // default "Before"
  afterLabel?: string; // default "After"
  fields: FieldDiffField[];
}
```

```ts
const fieldDiffFieldSchema = z.object({
  name: z.string().trim().min(1).max(300),
  before: z.string().max(8000).nullable().optional(),
  after: z.string().max(8000).nullable().optional(),
  kept: z.boolean().optional(),
  note: z.string().trim().max(1000).optional(),
});

export const fieldDiffSchema = z.object({
  title: z.string().trim().max(400).optional(),
  beforeLabel: z.string().trim().max(80).optional(),
  afterLabel: z.string().trim().max(80).optional(),
  fields: z.array(fieldDiffFieldSchema).min(1).max(40),
});
```

**Doc-generator change (required).** `blockSchemaDoc.ts` currently peels
`ZodNullable` and reports only the inner type, so `before`/`after` would be
documented as optional `string` — contradicting the schema and breaking the
"generated reference is authoritative" guarantee. Amend the generator (and
its test expectations) to render nullable fields as `string | null`.

**MDX wire shape** (tag `FieldDiff`, self-closing, `fields` a JSON array
attr — same encoding as `<DataModel entities>`):

```mdx
<FieldDiff
  title="as_built_drawing.systems_baseline_for_inspection"
  beforeLabel="Current (production)"
  afterLabel="Proposed"
  fields={[
    { name: "necessity", before: "optional", after: "conditional" },
    {
      name: "condition",
      before:
        "Applies where a downstream technical inspection report (e.g. a thermographic survey…) relies on the as-built record to identify, locate, or contextualise the components it inspects.",
      after:
        "When a downstream building-wide or multi-tenancy technical inspection — e.g. a thermographic survey of switchboards and distribution boards — relies on the as-built record to locate and identify the components it inspects; single-asset scans typically do not.",
    },
  ]}
/>
```

**Skill guidance.** Add to the block vocabulary + `document-quality.md`
routing: _use `<FieldDiff>` when the change is a few fields of a
record/config; use `<Diff>` only when the change is genuinely line-oriented
source code._ This retires the "JSON-string-in-a-line-diff" anti-pattern.

---

## 2. `<Details>` — collapsible container

**Problem it solves.** No progressive disclosure exists, so bulk evidence
(full production entries, raw packs) had to live in a companion HTML file —
the MDX artefact linked out for its own drill-downs.

**Rendering.** A native `<details>`/`<summary>` styled like the other card
blocks (rounded border, muted summary row with a chevron). `passChildren`
container: the body is ordinary MDX — prose and any nested blocks, including
another `<Details>` (the HTML doc nests drill-downs two deep). `open` renders
expanded by default.

**Data + schema.**

```ts
export interface DetailsData {
  summary: string;
  open?: boolean;
}

export const detailsSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  open: z.boolean().optional(),
});
```

**MDX wire shape** (tag `Details`, paired, `passChildren: true`):

```mdx
<Details summary="Full production entry: as_built_drawing">
  <Json title="as_built_drawing" json={"{ … }"} collapsedDepth={2} />
</Details>
```

**Annotation interaction (the one real subtlety).** Nested blocks keep their
own `data-plan-block-id` via `assignBlockIds` recursion, and the anchor
resolver itself is unaffected by collapsing — it flattens DOM **text nodes**
regardless of layout (`annotation/anchoring.ts`) and constructs the `Range`
fine inside a closed `<details>`. The failure is downstream, in overlay
geometry: a range inside a closed disclosure yields **zero client rects**,
which `MdxPlanAnnotationLayer` currently classifies as `detached`
(quote-deleted), suppressing the highlight and badge entirely. And the
composer chip surface exposes only removal — there is no chip→document
navigation callback to hook. So the design is:

1. **Classification, not force-open.** When a resolved range yields zero
   rects, walk its ancestors: if a closed `<details>` (or an unselected tab
   panel) encloses it, classify the annotation as `collapsed` — a new state
   distinct from `detached`. Never mutate `details.open` during overlay
   recomputation: annotated disclosures the user closed must stay closed
   (force-open on every recompute would defeat progressive disclosure).
2. **Badge on the enclosing summary.** A `collapsed` annotation renders its
   badge on the nearest visible enclosing element (the `<Details>` summary
   row, or the tab strip), with a count when several collapse into one
   surface — so hidden annotations remain discoverable.
3. **Open-on-navigate.** Clicking that badge (the existing overlay
   affordance — not the composer chip, which has no navigation path) opens
   every enclosing `<details>` / activates the tab, recomputes geometry,
   then scrolls to the now-visible highlight.

Selection inside an _open_ details works unchanged. Creating an annotation
never needs the closed case (you can't select hidden text).

**Scope note.** The zero-rects→`detached` misclassification is pre-existing:
it already affects annotations inside unselected `<TabsBlock>` tabs and
collapsed `<Code maxLines>` overflow. The `collapsed` state and
ancestor-walk should treat closed `<details>` and hidden tab panels
uniformly; the `<Code>`/`<Json>` truncation cases (content genuinely
unmounted/clipped rather than hidden) stay out of scope for this cut and
keep their current behaviour — note this as a known limitation rather than
claiming "no coupling".

---

## 3. `<Card>` — toned item container

**Problem it solves.** 31 verdict items rendered as undifferentiated grey
headings; the HTML doc's colour-coded left border + badge header row gave
instant visual triage.

**Rendering.** A bordered card with a 4px left border in the tone colour, a
header row, and a `passChildren` body. Header row (flex, wraps): `heading`
(bold), optional `badge` (filled pill in the tone colour), optional `meta`
chips (muted outline pills — the HTML doc's section tag / option label /
confidence slots). Give items an `id` so annotations anchor to the whole
card and `<Details>` drill-downs live inside it.

**Tones.** A closed six-slot **categorical palette of its own** (not shared
Callout semantics — Callout's enum has `decision` and lacks
`neutral`/`accent`; and a Card tone is a _category colour_, not a status:
the motivating doc maps `success`-green to a defect class). Meaning always
rides the badge/heading text; colour is triage only. Mapped to the theme
(light/dark aware):

| tone                | colour                     | typical use in a review doc     |
| ------------------- | -------------------------- | ------------------------------- |
| `neutral` (default) | border                     | no categorical meaning          |
| `info`              | blue                       | e.g. CONDITION_WRONG            |
| `success`           | green                      | e.g. NECESSITY_WRONG / accepted |
| `warning`           | amber                      | e.g. UNEXPRESSIBLE / flagged    |
| `risk`              | red                        | rejected / dangerous            |
| `accent`            | purple/violet theme accent | e.g. OTHER_DEFECT / structural  |

Six tones is deliberate: enough categorical space for a verdict taxonomy,
closed enough to stay themeable. Arbitrary colours stay out of the contract.

**Data + schema.**

```ts
export type CardTone = "neutral" | "info" | "success" | "warning" | "risk" | "accent";

export interface CardData {
  heading: string;
  tone?: CardTone;
  badge?: string;
  meta?: string[];
}

export const cardSchema = z.object({
  heading: z.string().trim().min(1).max(300),
  tone: z.enum(["neutral", "info", "success", "warning", "risk", "accent"]).optional(),
  badge: z.string().trim().max(60).optional(),
  meta: z.array(z.string().trim().min(1).max(120)).max(8).optional(),
});
```

**MDX wire shape** (tag `Card`, paired, `passChildren: true`):

```mdx
<Card
  id="item-a1"
  heading="A-1 · as_built_drawing.systems_baseline_for_inspection"
  tone="success"
  badge="NECESSITY_WRONG"
  meta={["Pack A", "confidence: medium", "promote / author-condition"]}
>
  The counterpart models this edge as genuinely conditional with a crisp gate…

  <FieldDiff … />
  <Details summary="Drill down — full production entries">…</Details>
  <ReviewChoice itemId="a1" label="A-1" />
</Card>
```

**Not a section.** `<Card>` is a container block like `<Columns>` — one
annotatable unit whose nested blocks keep their own ids. It does not
participate in the document's heading/section model; headings inside it
render normally.

---

## 4. `<ReviewChoice>` — per-item tri-state decision capture

**Problem it solves.** "Default-accept, flag exceptions" over 31 items is a
tri-state pattern (Accept / Reject / Discuss + note) that neither span
annotations nor the single bottom `<QuestionForm>` expresses. The HTML doc
had it per item — but its state was trapped in the page behind a manual
export. This is where MDX **beats** HTML: the decision lands as a structured
review comment on the next turn, no export step.

**Rendering.** A compact one-row widget (the HTML doc's `.controls` row):
a three-segment toggle (Accept green / Reject red / Discuss amber — filled
when selected, tri-state, click-again to clear) and a flexible note input.
When the annotation layer's context is absent (bare renderer/tests) it
renders read-only, exactly like `<QuestionForm>`.

**Data + schema.**

```ts
export type ReviewVerdict = "accept" | "reject" | "discuss";

export interface ReviewChoiceData {
  /** Stable item id — the aggregation key. Required. */
  itemId: string;
  /** Short display label, e.g. "A-1". Defaults to itemId. */
  label?: string;
  /** Note-field placeholder. */
  placeholder?: string;
}

export const reviewChoiceSchema = z.object({
  itemId: z.string().trim().min(1).max(120),
  label: z.string().trim().max(120).optional(),
  placeholder: z.string().trim().max(240).optional(),
});
```

**MDX wire shape** (tag `ReviewChoice`, self-closing):

```mdx
<ReviewChoice itemId="a1" label="A-1" placeholder="Why, if rejecting…" />
```

**Wire behaviour — reuse the question-answer channel.** Extend the
`questionAnswers.ts` pattern rather than inventing a parallel one:

- A `PlanReviewChoicesContext` provided by `MdxPlanAnnotationLayer`
  (alongside `PlanQuestionAnswersContext`), backed by the same
  draft-store + composer-comment plumbing.
- Deterministic comment id `mdx-review:<filePath>:<itemId>` so re-deciding
  upserts (mirror of `questionAnswerCommentId`). Clearing the toggle with an
  empty note removes the comment.
- **Filter the new prefix everywhere question ids are filtered.** The
  annotation layer distinguishes question-answer comments from freeform
  overlay comments by id prefix; today only `mdx-question:` is excluded from
  the highlight overlays. `mdx-review:` must join that filter (an
  `isReviewChoiceCommentId` sibling of `isQuestionAnswerCommentId`), or
  every decision would render a spurious overlay highlight.
- **`itemId` must be unique per file.** Duplicate ids silently collapse two
  widgets onto one deterministic comment. The registry-derived linter cannot
  infer this semantic rule, so add one explicit `lint-plan.mjs` check:
  duplicate `<ReviewChoice itemId>` within a document is an `error`. (This
  amends the "no lint changes" claim in the preamble — it is the one lint
  addition.)
- Agent-facing comment text:
  `Review A-1 → reject — "the other conditions appear to be where this is required…"`
  (verdict always present; note appended when non-empty; a note with no
  verdict serialises as `Review A-1 → comment — "…"`).
- Comments are block-anchored to the widget's element (same
  `blockElement` mechanism `setAnswer` uses), so they scroll-target the item.
- The composer chip renders like question-answer chips; removing the chip
  un-decides the item (comment-is-truth, selections in the draft store —
  identical source-of-truth split to questions).

**Unanswered semantics live in prose, not the widget.** The widget reports
only explicit choices. A "silence = accept the recommendation" convention is
document policy — the authoring skill tells the model to state it in a
`<Callout tone="decision">` at the top (as the tier-A plan already did).

**Deferred (explicitly out of scope):** a sticky document-level toolbar with
aggregate counts and bulk actions ("accept all remaining"). The per-file
decided-count can later ride the annotation layer for free; don't build it
until a real doc needs it.

---

## 5. Wrap-text toggle (cross-cutting)

**Problem it solves.** Long embedded strings/JSON force horizontal scrolling
in `<Code>`, `<AnnotatedCode>`, `<Diff>`, and `<Json>`. T3 Code's code viewer
already has a wrap button; the plan blocks need the same.

**Control.** A shared `WrapToggle` header button (icon: `IconTextWrap`,
`aria-pressed`, same visual language as `<Diff>`'s Unified/Split
`ModeButton`), added to the `figcaption` header of:

- `<Code>` / `<AnnotatedCode>` — toggles a `plan-code-wrap` class on the
  Shiki container: `.plan-code-wrap pre { white-space: pre-wrap; overflow-wrap: anywhere; }`.
  The non-Shiki fallback `<pre>` toggles the same classes directly.
- `<Json>` — toggles value spans from `whitespace-nowrap` to
  `whitespace-pre-wrap break-words` (keys stay nowrap; indentation padding
  is structural, so wrapping is safe).
- `<Diff>` — toggles row text spans from `whitespace-pre` to
  `whitespace-pre-wrap break-words`. **Two preconditions.** (a) Split mode
  must keep left/right rows height-aligned when one side wraps taller. The
  current implementation renders two independent columns, which breaks under
  wrapping. Restructure split rendering to one CSS grid
  (`grid-template-columns: 1fr 1fr`) with each `SplitRow` pair occupying one
  grid row — pairs then share row height natively. (Internal refactor of
  `DiffRead` only; the `pairSplitRows` model, truncation button, and
  annotation list are unchanged.) (b) The row text span must actually be
  allowed to shrink: give it `min-w-0 flex-1` (today it has neither), or
  long unbroken tokens still refuse to wrap inside the flex row.

**Header placement.** `<Code>`/`<AnnotatedCode>` render their `figcaption`
header only when `filename`/language is present, and `<Json>`'s title row is
optional. When a block needs the toggle but would render no header, render
the header anyway (empty label + the toggle) — a floating overlay button on
headerless blocks is not worth the complexity.

The `.plan-code-wrap` CSS rule lands in `apps/web/src/index.css` (the
existing home of `plan-*` styles).

**Authored default.** Each of the four blocks gains an optional
`wrap?: boolean` prop (default `false`) setting the initial state, so an
author embedding prose-heavy JSON can ship it wrapped. The prop is additive
to each schema and `toAttrs`/`fromAttrs`; wire-compatible with existing
plans.

**`<FieldDiff>` needs no toggle** — it always wraps; that's its reason to
exist.

---

## 6. Skill restructure: genre skills over a shared core

The Pi `visual-explainer` skill outperforms not because HTML is richer but
because its phrasing is **artefact-first**: a content→representation routing
table, hard aesthetic/layout invariants, and a reader-experience final
checklist. The MDX skill spends its prime tokens on wire mechanics and
planning-process discipline, frames everything as a _coding plan_, and never
tells the model what a good _decision document_ looks like — which is exactly
the genre where it lost.

Rather than stretching one skill over every genre, restructure to **thin
genre skills over one shared reference core** (mirroring BuilderIO's
`visual-plan` / `visual-recap` split, minus their hosted-app plumbing):

```
skills/
  mdx-visual-plan/SKILL.md     — trigger + planning discipline + plan skeleton
  mdx-visual-recap/SKILL.md    — trigger + diff scope-gathering + recap/review
                                 skeleton + budgets (NEW)
  mdx-doc-core/references/     — shared: block-schema.md, document-quality.md,
                                 wireframe.md, canvas.md, exemplar skeletons,
                                 validator usage (MOVED from mdx-visual-plan)
```

Why split rather than absorb:

- **Trigger separation.** Skill selection is description-driven. A recap /
  decision-batch request ("recap this branch", "prepare the sign-off doc for
  these verdicts") should never load planning discipline — "planning is
  read-only" and "the plan is the approval gate" are both actively wrong for
  a document describing work that already exists.
- **Genre-specific content is real.** The recap skill carries what the plan
  skill has no analogue for: diff/thread scope-gathering (collect the work
  unit's changes, exclude pre-existing dirty work), the recap skeleton
  (headline → narrative → contract blocks → `<FileTree>` → key-change tabs),
  and budgets (3–8 key-change tabs, ~150 lines per excerpt).
- **The decision-doc genre lives in the recap skill.** A verdict batch like
  the tier-A sign-off is _review of existing analysis_, not forward
  planning. Its skeleton (§6.3 below) ships in `mdx-visual-recap`.
- **No drift.** The block vocabulary, wire contract, quality bar, and
  wireframe/canvas contracts exist once, in `mdx-doc-core/references/`,
  pointed at by both SKILL.md files. Do **not** copy them per skill.

**Packaging & activation contract** (`mdx-doc-core` is NOT itself a skill —
skill discovery requires a `SKILL.md`, and a references-only directory is
invisible to it):

- `skills/mdx-doc-core/` is a plain sibling directory. Each genre SKILL.md
  references shared files by relative path (`../mdx-doc-core/references/…`).
- **Role injection** (`roles/*.md` frontmatter → `--skill` paths resolved
  against the repo root) works unchanged: the relative `../mdx-doc-core`
  traversal resolves inside the repo. `roles/planner.md` keeps
  `skills/mdx-visual-plan`; `roles/reviewer.md` gains
  `skills/mdx-visual-recap` (recaps and decision batches are review-side
  artefacts).
- **The orchestrator loads both.** `roles/orchestrator.md` gains frontmatter
  pinning `skills/mdx-visual-plan` and `skills/mdx-visual-recap`, plus a
  body element making artefact-mediated communication an explicit move:

  > **Communicate through artefacts, not chat walls.** When the human must
  > review or decide something non-trivial — a direction, a batch of
  > verdicts, an incident explanation, the shape of a finished change —
  > deliver it as a reviewable MDX document (per the mdx-visual-plan /
  > mdx-visual-recap skills) and hand back the path, rather than a long
  > chat message. Author it yourself when it is a synthesis of work you
  > already hold in context (that is orchestration — you are the human's
  > single point of contact); commission it in a child's brief when it
  > requires fresh investigation ("deliver your findings as an annotatable
  > MDX recap per the mdx-visual-recap skill"). Annotations and question
  > answers come back as review turns — the artefact is the conversation.

  Rationale: without this, the orchestrator has no skill loaded and no cue
  that briefs can request artefacts — the human cannot say "build me an
  artefact that explains the issue" and have it route anywhere. Skill
  loading is progressive-disclosure, so carrying both descriptions is
  near-free.

- **Provider-native symlink installs**: `scripts/enable-mdx-plan-skill.sh`
  symlinks only the plan skill dir, so `../mdx-doc-core` would dangle beside
  the installed symlink. Extend the script to symlink all three directories
  (`mdx-visual-plan`, `mdx-visual-recap`, `mdx-doc-core`) as siblings into
  each provider skill dir, and rename it `enable-mdx-doc-skills.sh`.

Explicitly not ported from BuilderIO's recap skill: the Plan MCP connector,
hosted publish rules, never-inline enforcement, and the local-files bridge —
all hosted-app plumbing. Loom's delivery rule is one line: write
`plans/<slug>/plan.mdx` or `recaps/<slug>/recap.mdx`, run `lint-plan.mjs`,
tell the user the path.

Phrasing changes across the restructured skills:

1. **Name the genres.** Each SKILL.md opens by naming its genre and its
   activation space. `mdx-visual-plan`: implementation plans, before work
   exists, approval-gated. `mdx-visual-recap`: recaps of existing changes
   AND **decision/review batches** (sign-off gates, audit verdicts,
   PR-style reviews). Today's single skill says "plan" ~60 times and never
   describes the review genre, so the model pattern-matches decision docs
   out of scope.

2. **Add a routing table** (mirroring visual-explainer's "Choose the
   representation") to the shared core, early and prominent:

   | Content                                | Representation                                                        |
   | -------------------------------------- | --------------------------------------------------------------------- |
   | A few fields of a record change        | `<FieldDiff>`                                                         |
   | Line-oriented source change            | `<Diff>`                                                              |
   | N similar items each needing a verdict | `<Card tone>` per item + `<ReviewChoice>` + summary `<Table>`         |
   | Bulk evidence / full records           | `<Details>` + `<Json>`/`<Code>` inside, `wrap` for prose-heavy values |
   | Balanced judgement calls (few)         | bottom `<QuestionForm>` with `recommended`                            |
   | Typed entities / API ops / change map  | `<DataModel>` / `<Endpoint>` / `<FileTree>`                           |
   | Genuine 2-D structure                  | `<Diagram>` / `<Mermaid>`                                             |

3. **Decision-doc skeleton** (in `mdx-visual-recap`, exemplar in the shared
   core): top `<Callout tone="decision">` stating the review protocol and the
   silence-defaults-to-recommendation rule; a compact all-items `<Table>`;
   one `<Card>` per item (tone = verdict class, badge, meta chips) containing
   verdict prose, decisive evidence, `<FieldDiff>`, a `<Details>` drill-down,
   and a `<ReviewChoice>`; a bottom `<QuestionForm>` for only the genuinely
   balanced calls.

   **Recap skeleton** (also in `mdx-visual-recap`, adapted from BuilderIO's
   canonical shape): UI-impact headline (wireframes, only when the diff
   changed rendered UI) → 1–3 paragraph outcome narrative → `<DataModel>` /
   `<Endpoint>` for contract changes → `<FileTree>` with change flags →
   `## Key changes` as one horizontal `<TabsBlock>` of `<Diff>` /
   `<AnnotatedCode>`, 3–8 tabs, ~150 lines per excerpt, each with a one-line
   summary and a few line annotations. Optionally a `<ReviewChoice>` per
   key-change tab when the recap doubles as a review gate.

4. **Add a reader-experience final checklist** to the shared core (the visual-explainer pattern
   that most directly drove quality), e.g.: no horizontal scrolling at
   desktop width — any long string is wrapped or wrap-toggleable; every item
   in a batch is visually triaged by tone at a glance; all evidence needed to
   decide an item is inside the document (drill-down, not a companion file);
   every decision the reviewer must make has an in-document capture surface;
   the first viewport states what is being decided and what happens on
   sign-off.

5. **Demote wire mechanics.** Move the attribute-encoding rules ("The MDX
   contract" section) into the shared core's `block-schema.md` preamble,
   keeping one paragraph + the validator command in each SKILL.md. The prime
   instruction budget should sell the artefact quality bar, not the escaping
   rules — the validator already catches mechanical mistakes.

6. **Self-containment rule.** Add one explicit invariant to the shared core:
   _never point the reviewer at a companion file for evidence the decision
   depends on; embed it behind `<Details>`._ (The tier-A plan violated this
   in its second paragraph.)

7. **Scope-gathering section** (recap skill only): default scope is the
   whole work unit/thread, not the latest message; separate thread-owned
   changes from pre-existing dirty state; when scope is genuinely ambiguous,
   state the assumption in the recap rather than blocking on a question.

---

## File map

| File                                                                                        | Change                                                                                              |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/files/mdx-plan/blocks/fieldDiff.tsx`                               | new                                                                                                 |
| `apps/web/src/components/files/mdx-plan/blocks/details.tsx`                                 | new                                                                                                 |
| `apps/web/src/components/files/mdx-plan/blocks/card.tsx`                                    | new                                                                                                 |
| `apps/web/src/components/files/mdx-plan/blocks/reviewChoice.tsx`                            | new                                                                                                 |
| `apps/web/src/components/files/mdx-plan/blocks/wrapToggle.tsx`                              | new shared header control                                                                           |
| `apps/web/src/components/files/mdx-plan/blocks/{code,diff,json,annotatedCode}.tsx`          | `wrap` prop + toggle; diff split-mode grid refactor                                                 |
| `apps/web/src/components/files/mdx-plan/registry.tsx`                                       | 4 entries                                                                                           |
| `apps/web/src/components/files/mdx-plan/questionAnswers.ts` (or sibling `reviewChoices.ts`) | review-choice context + comment id/format helpers                                                   |
| `apps/web/src/components/files/mdx-plan/annotation/MdxPlanAnnotationLayer.tsx`              | provide review context; open-`<details>`-on-anchor-resolve                                          |
| `skills/mdx-doc-core/references/`                                                           | new shared core (moved from `mdx-visual-plan/references/` + routing table, checklist, skeletons)    |
| `apps/web/src/components/files/mdx-plan/blockSchemaDoc.ts` (+ test)                         | output path → `skills/mdx-doc-core/references/block-schema.md`; render `ZodNullable` as `T \| null` |
| `apps/web/src/index.css`                                                                    | `.plan-code-wrap` wrap styles                                                                       |
| `apps/web/src/components/files/mdx-plan/planLint.ts`                                        | duplicate `<ReviewChoice itemId>` check                                                             |
| `roles/planner.md` / `roles/reviewer.md`                                                    | planner keeps plan skill; reviewer gains `skills/mdx-visual-recap`                                  |
| `roles/orchestrator.md`                                                                     | frontmatter: both skills; body: "communicate through artefacts" element                             |
| `scripts/enable-mdx-plan-skill.sh`                                                          | → `enable-mdx-doc-skills.sh`; symlink all three skill dirs                                          |
| `skills/mdx-visual-plan/SKILL.md`                                                           | slimmed to genre trigger + planning discipline + plan skeleton; points at shared core               |
| `skills/mdx-visual-recap/SKILL.md`                                                          | new: recap + decision-batch genre, scope-gathering, skeletons, budgets                              |

Tests follow the existing per-area pattern (`mdxPlan.test.ts` round-trip +
schema cases per block; annotation-layer cases for the details-expansion and
review-comment upsert paths).

## Acceptance test

The motivating artefacts live **outside this repo**, in the lease-extraction
worktree:

- MDX plan: `/home/Carl/.roo/worktrees/PE-1593-taxonomy-relationship-semantics/data-pipeline-jobs/lease-extraction/plans/fable5-tier-a-signoff/plan.mdx`
- HTML doc + source packs: `/home/Carl/.roo/worktrees/PE-1593-taxonomy-relationship-semantics/data-pipeline-jobs/lease-extraction/scripts/fable5_tier_a/` (`decision_doc.html`, `packs/`)

So the implementer also commits a **representative in-repo fixture**: a
3–5-item decision-doc `plan.mdx` exercising every new block (`<Card>` tones,
`<FieldDiff>` with null/absent/kept fields, nested `<Details>`,
`<ReviewChoice>`, wrap-toggled `<Json>`), used by tests and as the exemplar's
worked example.

End-to-end comparison (requires access to the worktree above): regenerate
the tier-A sign-off document with the upgraded vocabulary and skill, from
the same source packs, and compare against `decision_doc.html` on: per-item
triage at a glance, readability of every before/after, evidence drill-down
without leaving the file, and capturing a 31-item review (defaults + a
handful of rejects/discussions) in one review turn. The MDX version should
now win the last criterion outright (native turn injection vs manual
export) and tie the first three.
