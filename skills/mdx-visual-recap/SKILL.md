---
name: mdx-visual-recap
description: >-
  Author a recap of work that already exists — or a decision/review batch
  (sign-off gate, audit verdicts, PR-style review) — as a rich, reviewable MDX
  document using T3 Code's supported block vocabulary, including the review
  blocks (FieldDiff, Card, Details, ReviewChoice) that capture per-item
  before/after evidence and tri-state verdicts inline. Use when the document
  describes or reviews existing changes and the reviewer must triage items and
  record decisions in-app. For a forward-looking implementation plan of work not
  yet written, use mdx-visual-plan.
---

# MDX Visual Recaps & decision documents

**Genres: the recap and the decision/review batch** — documents about work that
**already exists**. Two activation spaces:

- **Recap.** Explain a finished change — a branch, a thread's work, an incident
  — as a reviewable artefact rather than a chat wall: what changed, why, and the
  load-bearing diffs, with per-tab review controls when it doubles as a gate.
- **Decision / review batch.** A sign-off over N items each needing a verdict —
  a taxonomy sign-off, an audit, a PR-style review. The reviewer triages the
  batch by tone at a glance, drills into per-item evidence, and records an
  Accept / Reject / Discuss decision on each — all in one review turn.

Both are **review of existing analysis or work, not forward planning.** Do not
carry planning discipline here: "planning is read-only" and "the plan is the
approval gate" do not apply — the work is done; the document reviews it. For a
proposal of work not yet written, use the **`mdx-visual-plan`** skill.

T3 Code renders the MDX in its own in-app document panel and lets the reviewer
annotate any span, answer question forms, and record per-item verdicts — each
comes back as a normal review turn. **The artefact is the conversation.**

This is a first-party, fully local capability: a recap is just an `.mdx` file the
renderer reads. Delivery is one line — write the file, lint it, hand back the
path. There is no MCP connector, no hosted publish step, and no never-inline
rules; embed everything (see self-containment below).

## Where the document goes

```
recaps/<slug>/recap.mdx
```

`<slug>` is a short kebab-case name for the work under review. Use a folder per
recap so sibling artefacts can live beside it. (A decision batch is still a
recap-genre artefact — `recaps/<slug>/recap.mdx` — unless it is clearly a plan's
sign-off, in which case `plans/<slug>/…` is fine.) The `.mdx` extension routes
the file to the renderer. After writing it, tell the reviewer the path and ask
them to open, triage, and decide in-app.

## Validate before presenting (mandatory)

```
node apps/web/scripts/lint-plan.mjs recaps/<slug>/recap.mdx
```

The validator exercises the real renderer pipeline (compile gate, block
registry, zod schemas) and reports `file:line` findings — including the
**duplicate `<ReviewChoice itemId>`** check (duplicate ids silently collapse two
widgets onto one decision, so this is an `error`). Fix all `error` findings and
read each `warning` before handing the document back.

## Scope-gathering (recap genre)

Before drafting a recap, settle what is in scope — this is the recap-specific
discipline the plan genre has no analogue for:

- **Default scope is the whole work unit / thread, not the latest message.**
  Gather the changes the work unit actually made — its commits, its diff against
  the base, the thread's decisions — not just the most recent turn.
- **Separate thread-owned changes from pre-existing dirty state.** A recap
  describes what _this_ work did; exclude unrelated uncommitted edits and
  pre-existing drift from the "what changed" story (mention them only if they
  affect the review).
- **When scope is genuinely ambiguous, state the assumption in the recap**
  (e.g. "this recap covers the branch's diff against `main`, excluding the
  unrelated lockfile churn") rather than blocking on a question. Only ask when
  the ambiguity would materially change what you review.

## Self-containment (both genres)

**Never point the reviewer at a companion file for evidence the decision depends
on** — embed it in the document, behind a `<Details>` drill-down when it is
bulky (full production records, raw packs, long logs). A recap that says "see
the attached HTML for the before/after" has already lost: the `<Details>`
drill-down, not the companion file, is the mechanism. This is the single rule
that most separates a self-contained MDX artefact from a linked-out one.

This rule is **unqualified — there is no size exemption**. A fully
evidence-embedded decision document is expected to reach a few MB, and the
renderer carries it (off-main-thread compile, lazy `<Details>`). Embed the full
records; do not thin the evidence or link out because the document is large. The
only size limit is the 8 MiB transport ceiling `planLint` enforces (warn >6 MB,
error >8 MiB) — a batch that big should be split into per-pack documents. See
the **size budget** passage in `document-quality.md`.

## Block vocabulary and reference core

The block vocabulary, wire contract, quality bar, and routing/checklist guidance
are **shared across genres** and live once in the `mdx-doc-core` reference core.
Consult them — do not guess props:

- **[`../mdx-doc-core/references/block-vocabulary.md`](../mdx-doc-core/references/block-vocabulary.md)**
  — every block by example, including the **review blocks** (`<FieldDiff>`,
  `<Card>`, `<Details>`, `<ReviewChoice>`) this genre leans on.
- **[`../mdx-doc-core/references/block-schema.md`](../mdx-doc-core/references/block-schema.md)**
  — the generated authority for exact props and enum values.
- **[`../mdx-doc-core/references/document-quality.md`](../mdx-doc-core/references/document-quality.md)**
  — the prose quality bar, the "Choose the representation" routing table, the
  self-containment rule, and the **reader-experience final checklist**. Check
  the recap against that checklist before handing it back.
- **[`../mdx-doc-core/references/exemplar.md`](../mdx-doc-core/references/exemplar.md)**
  — worked decision-review and recap skeletons, plus named anti-patterns. The
  worked review-blocks fixture lives at `plans/mdx-review-blocks/plan.mdx`.

The MDX contract is one paragraph: the tag names are the stable wire contract;
use ordinary Markdown for everything else; the attribute-encoding rules live in
the `block-schema.md` "Encoding recap" preamble, and the validator catches
mechanical mistakes.

## The decision-document skeleton

A verdict batch (like a tier-A taxonomy sign-off) reads, top to bottom:

1. **Top `<Callout tone="decision">`** stating the review protocol and the
   **silence-defaults-to-recommendation** rule — the widget reports only explicit
   choices, so the "silence = accept" convention is document policy stated here,
   not in the widget. This is the first viewport: what is being decided and what
   sign-off means.
2. **A compact all-items `<Table filterable>`** — one row per item (id, subject,
   verdict class, recommendation), so the whole batch is scannable before the
   detail. Mark it `filterable` for a large batch: it adds a client-side row
   filter and header-click sort (asc → desc → unsorted, numeric-aware) so the
   reviewer can jump to a subject or sort by verdict class without scrolling the
   whole batch. The evidence stays in each item's collapsed drill-down, so the
   table stays cheap.
3. **One `<Card>` per item**, `tone` = the verdict class (colour is triage only;
   meaning rides the `badge`/heading), with `meta` chips for pack / confidence /
   recommended action. Inside each card, in order:
   - one or two sentences of verdict prose;
   - the decisive evidence as a `<FieldDiff>` (use its null / absent / kept
     distinctions) — never a line `<Diff>` of a JSON string;
   - a `<Details>` drill-down embedding the bulk evidence (full production
     entry, counterpart pack) — never a link out;
   - a `<ReviewChoice itemId>` (unique id per document) capturing the per-item
     Accept / Reject / Discuss decision.

   When a document contains `<ReviewChoice>` items the renderer shows a sticky
   **"N of M decided"** counter automatically — no authoring needed; it tracks
   progress through a large batch. (The "silence = accept" rule still means an
   undecided item ships the recommendation; the counter only reflects explicit
   decisions recorded so far.)

4. **A bottom `<QuestionForm>`** for only the genuinely balanced calls (rollout
   strategy, a schema question) — not a second copy of the per-item decisions.

## The recap skeleton

A recap of a finished change reads:

1. **UI-impact headline** — wireframes (`<Screen>`, or a `<Columns>` before/after
   pair), but **only when the diff changed rendered UI**; skip it for pure
   backend work.
2. **A 1–3 paragraph outcome narrative** — what changed and why, in the
   codebase's vocabulary.
3. **Contract changes** — `<DataModel>` / `<Endpoint>` for any schema or API
   delta.
4. **A `<FileTree>` with change flags** — the change map.
5. **`## Key changes`** as one horizontal `<TabsBlock>` of `<Diff>` /
   `<AnnotatedCode>` — **3–8 tabs, ~150 lines per excerpt**, each with a one-line
   summary and a few line annotations. Add a `<ReviewChoice>` per tab when the
   recap doubles as a review gate.

## Budgets

Keep the document scannable — these budgets are what stop a recap sprawling:

- **Key-change tabs: 3–8.** If more files matter, group or summarise; a reader
  will not tab through fifteen diffs.
- **~150 lines per code excerpt.** Excerpt the load-bearing hunk, not the whole
  file; use a `<Details>` drill-down for the rest if it is genuinely needed.
- **One decision surface per item.** A `<ReviewChoice>` per item (unique
  `itemId`); a bottom `<QuestionForm>` only for the balanced calls — never a
  second copy of the per-item decisions.

Before handing back, check the recap against the **reader-experience final
checklist** in
[`../mdx-doc-core/references/document-quality.md`](../mdx-doc-core/references/document-quality.md)
— that checklist is the single source of truth for the bar; work through every
item on it.
