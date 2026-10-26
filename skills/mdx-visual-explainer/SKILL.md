---
name: mdx-visual-explainer
description: >-
  Author an explainer as a reviewable MDX document: its job is to make the
  reader understand something, not to approve or decide anything. Use when the
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
anything that does not land. A child thread's reader is reached through its
parent: the report carries the path, the reader brief's three lines and the one
thing that needs the human, so the parent can hand the document on without
reading it first.

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
2. **`## 1. The mental model`** — the two to four things the reader will meet
   and how they relate. By default these are the cases the reader experiences —
   the outcomes, states or paths, each with what triggers it and what the
   reader sees — rather than the modules that implement them: a reader
   recognises a case when it happens to them, and a module only once they have
   read the code, so the module is named inside the case it implements. When
   the subject is "what can happen to X", a `<Columns>` of `<Card>`s, one per
   case and toned by what it means for the reader, usually reads fastest and
   can sit on the first screen, since it is the answer; a `<Mermaid>` of about
   ten nodes is for when the relation between the pieces is the point. A
   sentence under either says how to read it. Overview before any detail; the
   detail goes in the next section.
3. **`## 2. How it works`** — one sub-section per piece, each as _input → what
   happens → output_, with one literal example beside it: the record before
   and after (`<FieldDiff>`), the input line and the output line (`<Code>`),
   the quoted sentence and what it was classified as, the exact message or
   tool result the reader will receive. When the output is an artefact — a
   compiled string, a DOM fragment, a JSON record — the example is the
   artefact itself, trimmed, in the block that matches its shape (`<Code>`,
   `<Json>`). One example per piece is the default; a second is for a
   boundary the first does not show. Past three or four pieces, a piece or a
   worked example the reader will come back to can be its own numbered `##`
   rather than a `###` here, since the outline is how they return to it.
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
- **One overview from the reader's seat.** When the reader is on the receiving
  end of the system — they get its notices, wait on its results — the overview
  they will come back to is indexed by what happened and answers what they
  see, through which surface, and how soon. The code's own decomposition
  serves the reader who wants the mechanism; a reader who returns mid-incident
  looks up the event, not the module.
- **Mechanism, not narration.** Walk the data, not the control flow: what
  comes in, what decision is made on it, what goes out. Code is quoted where
  the line itself is the point (`<AnnotatedCode>` with a note on that line);
  otherwise the behaviour is stated and the file named. A workable budget is
  one or two `<AnnotatedCode>` per document, each about fifteen lines with
  notes on the three or four lines that carry the mechanism: a reader who
  wanted the file would open it, and a long quote with a note per line is the
  file again, read slower.
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
bash ../mdx-doc-core/scripts/lint-doc.sh explainers/<slug>/explainer.mdx --out explainers/<slug>/render.html --png
```

The script path resolves against this skill's directory, the document paths
against your working directory.

A stray `<` or `{` in prose is an MDX compile error that kills the whole
rendered document, and an unknown tag or invalid props show an error card in
place, so the render-health check runs before the reader hears the path: lint
(compile gate, block registry, zod schemas, mermaid parser) reporting
`file:line` findings, then a headless render through the real block registry
that prints the block types that mounted. Fix all `error` findings and read
each `warning`. Exit code 0 means the document compiles and renders, so it
will display in-app. `--out --png` writes the rendered page and PNG slices
of it beside the explainer, for you to `read` and look at (§10 of
`document-quality.md`, which also says what the page cannot show: a
`<Mermaid>` draws only in-app). For this genre the look
matters more than most, since a figure that does not read is the explanation
failing — so when the diagram is the one thing you cannot see, the mental
model is safer as the cards or `<Steps>` ladder the page can check, with any
`<Mermaid>` kept to the few-node, short-label shape that renders predictably
and the sentence under it standing in for the picture.

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
