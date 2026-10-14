---
name: mdx-visual-recap
description: >-
  Author a recap of work that already exists — or a decision/review batch
  (sign-off gate, audit verdicts, PR-style review) — as a reviewable MDX
  document that opens with the verdict and its numbers for a named reader,
  using T3 Code's block vocabulary including the review blocks (FieldDiff,
  Card, Details, ReviewChoice) that hold per-item before/after evidence and
  tri-state verdicts inline. Use when the document describes or reviews
  existing changes and the reader must triage items and record decisions
  in-app. For a plan of work not yet written, use mdx-visual-plan; to explain,
  orient or diagnose without asking for decisions, use mdx-visual-explainer.
pi_global: true
pi_global_requires: [mdx-doc-core]
---

# MDX Visual Recaps and decision documents

**Genres: the recap and the decision batch** — documents about work or
analysis that **already exists**, read by someone who must take it in and,
usually, sign something off.

- **Recap.** A finished change — a branch, a thread's work, an incident — as a
  reviewable artefact: what changed for the reader, why, and the load-bearing
  evidence, with per-tab review controls when it doubles as a gate.
- **Decision batch.** A sign-off over N items each needing a verdict — a
  taxonomy review, an audit, a PR-style review. The reader triages the batch
  by tone, drills into per-item evidence, and records Accept / Reject /
  Discuss on each, all in one review turn.

Both review what exists; the plan genre's "planning is read-only" and "the
plan is the approval gate" do not apply here. For a proposal of work not yet
written use **`mdx-visual-plan`**; for a document that explains or diagnoses
without asking for verdicts use **`mdx-visual-explainer`**.

T3 Code renders the `.mdx` in its document panel; the reader annotates spans,
answers forms and records per-item verdicts, each arriving as a normal turn.
The artefact is the conversation. Delivery is: write the file, run the check,
hand back the path.

## Where it goes

```
recaps/<slug>/recap.mdx
```

A folder per recap so sibling artefacts can sit beside it. A decision batch is
a recap-genre artefact at the same path unless it is plainly a plan's sign-off,
in which case `plans/<slug>/…` is fine. When it is written and checked, tell
the reader the path and ask them to open, triage and decide in-app.

## Before drafting

**Write the reader brief first** — who reads this and what they are there to
do, what they already know, what they must be able to say or decide after the
first screen — in the frontmatter, per §1 of
[`document-quality.md`](../mdx-doc-core/references/document-quality.md). The
reader of a recap has usually read none of the thread, none of the child
reports and none of the commits; the first screen is written for them, in
their terms, with the codebase's names glossed on first use.

**Settle the scope** (recap genre). The default unit is the whole piece of
work — its commits, its diff against the base, the thread's decisions — not
the latest message. Separate what _this_ work did from pre-existing dirty state
and unrelated uncommitted edits; mention those only when they affect the
review. When scope is genuinely ambiguous, state the assumption in the recap
("this covers the branch's diff against `main`, excluding the lockfile churn")
and ask only if the ambiguity would materially change what you review.

## The decision-batch skeleton

Top to bottom (the worked version is in
[`exemplar.md`](../mdx-doc-core/references/exemplar.md)):

1. **First screen — the verdict with its numbers.** _Of N items: a apply as
   written, b apply once amended, c should be withdrawn._ Then one line on
   what that means for the reader (the pattern behind the amendments, the one
   item that is urgent), then **one line of protocol**: an item left undecided
   takes its recommendation. The widget reports only explicit choices, so that
   convention is document policy and has to be said — once, after the answer.
2. **`## 1. All items`** — a compact `<Table filterable>`, one row per item
   (subject, verdict class, recommendation). `filterable` adds a client-side
   row filter and header-click sort (asc → desc → unsorted, numeric-aware), so
   a large batch can be navigated by subject or by class; the evidence stays in
   each item's collapsed drill-down, so the table stays cheap.
3. **`## 2. The items`** — one `<Card>` per item, `tone` = the verdict class
   with the `badge` naming it (colour triages; the badge carries the meaning),
   `meta` chips for pack / confidence / recommended action. Inside, in order:
   one or two sentences of _why_; the decisive evidence as a `<FieldDiff>`
   (its null / absent / kept distinctions carry meaning — a JSON string in a
   line `<Diff>` is the shape it exists to retire); a `<Details>` holding the
   bulk evidence (full production entry, counterpart pack); a
   `<ReviewChoice itemId>` whose id is unique in the document — a duplicate id
   silently collapses two widgets onto one decision, and the lint reports it
   as an error. The renderer shows a sticky "N of M decided" counter whenever
   `<ReviewChoice>` items are present; it counts explicit decisions only.
4. **A bottom `<QuestionForm>`** for the genuinely balanced calls only
   (rollout strategy, a schema question), not a second copy of the per-item
   decisions.

## The recap skeleton

1. **First screen — what changed for the reader, with the number that proves
   it.** What they can now do, or what no longer happens, in their terms;
   then what it means: what to check, what is still open, whether anything
   needs their decision. The objective and the codebase's framing come after
   this, not before it.
2. **`## 1. Before and after`** — a `<Columns>` or `<Screen>` pair when the
   change touched rendered UI; otherwise the behaviour before and after in
   prose, one literal example each.
3. **`## 2. How it works now`** — the mechanism in the reader's terms, an
   example beside each piece; `<DataModel>` / `<Endpoint>` beside the prose
   for any schema or API delta.
4. **`## 3. The changes`** — the key changes as one horizontal `<TabsBlock>`
   of `<Diff>` / `<AnnotatedCode>`, each tab with a one-line summary and a few
   line notes; a `<ReviewChoice>` per tab when the recap doubles as a gate.
   The `<FileTree>` change map in a `<Details>`.
5. **`## 4. Still open`** — risks, follow-ups, and the pointer to a bottom
   `<QuestionForm>` if a direction is genuinely open.

## Budgets

These are what keep a recap scannable:

- **Key-change tabs: three to eight.** A reader does not tab through fifteen
  diffs; group or summarise when more files matter.
- **About 150 lines per excerpt.** The load-bearing hunk, not the whole file;
  the rest in a `<Details>` if it is genuinely needed.
- **One decision surface per item.** A `<ReviewChoice>` per item with a unique
  `itemId`; the bottom `<QuestionForm>` for the balanced calls only.

## Self-contained, whatever the size

The reader decides every item without leaving the document. Evidence a
decision depends on — full production records, raw packs, long logs, the
before/after — is embedded, in a `<Details>` drill-down when bulky, rather than
pointed at in a companion file; a recap that says "see the attached HTML" has
sent its reader away at the moment they were deciding. Size is not a reason to
link out: a fully evidence-embedded batch of a few MB opens and stays
responsive (off-main-thread compile, lazy `<Details>`). The one hard bound is
the 8 MiB transport ceiling `planLint` enforces (warn above 6 MB, error above
8 MiB); a batch that large is split into per-pack documents, not thinned.
§7 of `document-quality.md` has the practical bounds.

## Validate before presenting

```
node apps/web/scripts/lint-plan.mjs recaps/<slug>/recap.mdx --out recaps/<slug>/render.html
```

The render-health gate, in two stages against the real renderer modules:
**lint** (compile gate, block registry, zod schemas, the duplicate
`<ReviewChoice itemId>` check) reporting `file:line` findings, then a headless
**render** through the real block registry, which catches a block that throws
or degrades on a payload its schema accepts and prints the block types that
mounted — confirm every `<ReviewChoice>` is there. Fix all `error` findings
and read each `warning`. Exit code 0 means the recap compiles and renders, so
it will display in-app; a document handed over on an unrun or failing check
may open as an error card. `--out` writes the rendered page beside the recap
so you can look at it (§10 of `document-quality.md`).

A reader reporting the recap as broken (JSX shown as literal escaped text)
after a passing check is seeing the plain markdown fallback — a view or
routing problem, not a document defect.

## The reference core

Shared across genres, in `mdx-doc-core`:

- [`document-quality.md`](../mdx-doc-core/references/document-quality.md) —
  the reader brief, the first-screen rule, hierarchy, representation, the
  question form, self-containment and the final checklist; run that checklist
  before handing back.
- [`exemplar.md`](../mdx-doc-core/references/exemplar.md) — the worked
  decision-batch and recap skeletons and the anti-patterns with their cost.
- [`block-vocabulary.md`](../mdx-doc-core/references/block-vocabulary.md) —
  every block by example, including the review blocks this genre leans on;
  [`block-schema.md`](../mdx-doc-core/references/block-schema.md) — the
  generated authority for exact props and enum values and the
  attribute-encoding rules. The tag names are the wire contract; ordinary
  Markdown carries everything else.
