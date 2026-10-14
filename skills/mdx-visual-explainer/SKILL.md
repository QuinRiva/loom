---
name: mdx-visual-explainer
description: >-
  Author an explainer — a document whose job is to make a named reader
  understand something (a system, a change, a diagnosis, the state of a piece
  of work) rather than to approve or decide — as a reviewable MDX document
  that opens with the summary and mental model, gives the mechanism with one
  literal example per piece, and ends with what to do next. Use when the
  request is "help me understand", "walk me through", "what is going on with",
  "why does this happen", re-orienting after time away, or "explain it so I
  can explain it to others". For a proposal of work not yet written use
  mdx-visual-plan; for a recap or a batch of verdicts use mdx-visual-recap.
pi_global: true
pi_global_requires: [mdx-doc-core]
---

# MDX Visual Explainers

**Genre: the explainer** — a document that explains, orients or diagnoses for
a reader who has read nothing. Its job is understanding: after reading it the
reader can say what the thing is, how it works, why it behaves as it does, and
what to do about it, in their own words. It asks for no sign-off. A diagnosis
may end in a recommendation, and an explainer may carry one `<QuestionForm>`
where a decision genuinely rides on the explanation; what it does not carry is
a review protocol or a verdict per item — when the reader's job is to approve
or decide, the plan and recap genres already own that shape.

Typical requests: _help me understand the new classification pipeline_; _walk
me through why the nightly job double-counts_; _I've been away a week — where
is this work up to?_; _explain this well enough that I can explain it to the
client_. These are most of the "can you make me an HTML page" requests; this
genre puts the same document in the annotatable panel, where a span the reader
does not follow becomes a comment that comes back to you.

An explainer is an `.mdx` file the T3 Code document panel renders; you write
it with ordinary file writes. There is no hosted app, connector or account.

## Where it goes

```
explainers/<slug>/explainer.mdx
```

`<slug>` is a short kebab-case name for the subject. A folder per explainer so
sibling artefacts (a rendered page, an image) can sit beside it. When it is
written and checked, tell the reader the path and ask them to open it and mark
anything that does not land.

## Before drafting

**Write the reader brief first** — in the frontmatter, per §1 of
[`document-quality.md`](../mdx-doc-core/references/document-quality.md):

```yaml
---
reader:
  who: the owner of the extraction system, back after a week away
  knows: the product and last month's design; nothing that shipped since
  after_first_screen: what the new pipeline does differently and whether anything needs them today
---
```

For this genre `knows` does most of the work: an explainer is the distance
between what the reader already holds and what they need to hold, so a
document written without that line explains either too much or the wrong
thing. `after_first_screen` is the sentence they should be able to say — to
themselves, or to the person they have to explain it to.

**Gather before you explain.** Read the real code, records and logs the
explanation rests on; the examples in the document are real inputs and real
outputs, quoted; a reader who says abstract explanations are meaningless to
them means it. Where the request is a diagnosis, find the
evidence that isolates the cause from its neighbours before writing — the
document names what would have been true under each rival cause and shows why
it is not.

## The explainer skeleton

Top to bottom (the worked version is in
[`exemplar.md`](../mdx-doc-core/references/exemplar.md)):

1. **First screen — the summary.** What the thing is, in the reader's terms,
   and the one sentence they could use to explain it to someone else. For a
   diagnosis: the cause, and the one number or example that pins it. For an
   orientation: where the work is up to and the one thing that needs them, if
   anything does. A `<Callout tone="warning">` here for the one thing that is
   urgent; otherwise prose.
2. **`## 1. The mental model`** — the two to four pieces the reader needs to
   hold and how they relate: a `<Mermaid>` of about ten nodes at most, or a
   `<Columns>` of `<Card>`s one per piece with a `badge` naming its role, with
   a sentence under it saying how to read it. Overview before any detail; the
   detail goes in the next section.
3. **`## 2. How it works`** — one sub-section per piece, each as _input → what
   happens → output_, with one literal example beside it: the record before
   and after (`<FieldDiff>`), the input line and the output line (`<Code>`),
   the quoted sentence and what it was classified as. One example per piece is
   the default; a second example is for a boundary the first does not show.
4. **`## 3. What this means for you`** — what to do next, what to watch, what
   is unaffected. A short list, or a `<Checklist>` when there are steps.
5. **`## 4. Open edges`** (optional) — what the explanation does not cover,
   what the evidence does not yet settle, and the single `<QuestionForm>` if
   one decision genuinely rides on it.

A long explainer (four or more sections) numbers its sections; a short one
may be three paragraphs and a diagram. Both open with the summary.

## Explainer discipline

- **The reader's vocabulary first, the codebase's second.** Name a thing by
  what it does for the reader ("the step that decides which document type
  this is") and give the code's name once, in the same sentence, so they can
  find it later. A thread id, an item code or "per the report" is replaced
  by what it refers to.
- **Mechanism, not narration.** Walk the data, not the control flow: what
  comes in, what decision is made on it, what goes out. Code is quoted where
  the line itself is the point (`<AnnotatedCode>` with a note on that line);
  otherwise the behaviour is stated and the file named.
- **Judgement in the block.** A piece's state — new, changed, removed, risky,
  the one that is wrong — is a `<Card>` `tone` and `badge`, or a `<Callout>`
  tone, with the prose carrying the why.
- **Hierarchy over completeness.** The reader needs the shape and one example
  per piece; the full file list, the long log and the exhaustive record go in
  a `<Details>` drill-down, present for whoever wants them and invisible to
  whoever does not.
- **A diagnosis shows its isolation.** The cause, the signature that
  identifies it, the count of what it affects, and why the plausible
  alternatives do not fit — each with its example. A recommendation, if the
  reader asked for one, follows the diagnosis in `## 3` and is written as a
  recommendation with its cost, not as a plan; a plan is its own document.
- **Decisions only where they ride on the explanation.** The default explainer
  has no `<QuestionForm>` and no `<ReviewChoice>`; a reader who finishes it
  and wants to decide something will annotate or reply. Add the form only when
  the explanation exists to let them choose, and then one form, at the end.

## Validate before presenting

```
node apps/web/scripts/lint-plan.mjs explainers/<slug>/explainer.mdx --out explainers/<slug>/render.html
```

A stray `<` or `{` in prose is an MDX compile error that kills the whole
rendered document, and an unknown tag or invalid props show an error card in
place, so the render-health check runs before the reader hears the path: lint
(compile gate, block registry, zod schemas, mermaid parser) reporting
`file:line` findings, then a headless render through the real block registry
that prints the block types that mounted. Fix all `error` findings and read
each `warning`. Exit code 0 means the document compiles and renders, so it
will display in-app. `--out` writes the rendered page beside the explainer so
you can look at it (§10 of `document-quality.md`) — for this genre
especially, since a diagram that does not read is the explanation failing.

A reader reporting the document as broken (JSX shown as literal escaped text)
after a passing check is seeing the plain markdown fallback — a view or
routing problem, not a document defect.

## The reference core

Shared across genres, in `mdx-doc-core`:

- [`document-quality.md`](../mdx-doc-core/references/document-quality.md) —
  the reader brief, the first-screen rule, hierarchy, representation, the
  gloss rule, self-containment and the final checklist; run that checklist
  before handing back (the capture-surface items apply only when the document
  asks for a decision).
- [`exemplar.md`](../mdx-doc-core/references/exemplar.md) — the worked
  explainer skeleton and the anti-patterns with their cost to the reader.
- [`block-vocabulary.md`](../mdx-doc-core/references/block-vocabulary.md) —
  every block by example; [`block-schema.md`](../mdx-doc-core/references/block-schema.md)
  — the generated authority for exact props and enum values and the
  attribute-encoding rules. The tag names are the wire contract; ordinary
  Markdown carries everything else.
- [`wireframe.md`](../mdx-doc-core/references/wireframe.md) and
  [`canvas.md`](../mdx-doc-core/references/canvas.md) — when the explanation
  is of a screen.
