---
name: mdx-visual-plan
description: >-
  Author an implementation plan — a proposal for work that does not yet exist,
  before any code is written — as a reviewable MDX document that opens with the
  recommendation for a named reader, using T3 Code's block vocabulary (data
  models, endpoints, file trees, annotated code, diagrams, tables, diffs,
  callouts, checklists, OpenAPI/Mermaid, containers, and — for UI work —
  wireframe/design artboards, a spatial canvas and interactive prototypes). Use
  when a plan is worth reviewing and annotating in-app and the work is
  approval-gated. For a recap of work already done or a decision batch, use
  mdx-visual-recap; to explain, orient or diagnose without asking for a
  decision, use mdx-visual-explainer.
pi_global: true
pi_global_requires: [mdx-doc-core]
---

# MDX Visual Plans

**Genre: the implementation plan** — a proposal for work that does not yet
exist, read by someone who decides whether it goes ahead. The plan is the
approval gate: you surface it, the reader reviews and annotates it in-app, and
implementation starts after they approve. For a change that already exists, or
a batch of verdicts, use **`mdx-visual-recap`**; for a document whose job is
understanding rather than approval, use **`mdx-visual-explainer`**.

A plan is an `.mdx` file in the workspace that T3 Code renders in its document
panel. Any span can be annotated; a selection leaves an anchored comment that
comes back to you as a normal turn, and the bottom `<QuestionForm>` comes back
as answers. There is no hosted app, connector or account: you write the file.

## When to write one

Whenever the plan is a better reviewable artefact than a chat paragraph:
multi-file or ambiguous work, a data-model, API or schema decision that needs
alignment, a refactor with real risk, anything where the reader should react to
a direction before you build it. A modest change still qualifies when the
reader needs to see the shape first. Truly trivial, unambiguous work — a typo,
a one-line fix, a single well-specified function — is better just done; a
single-step plan costs the reader more than the change.

## Where it goes

```
plans/<slug>/plan.mdx
```

`<slug>` is a short kebab-case name for the work. A folder per plan lets later
phases put sibling artefacts beside it. The `.mdx` extension is what routes the
file to the renderer. When it is written and checked, tell the reader the path
and ask them to open, review and annotate it — that request is the whole
handoff. A plan is signed with `sign_document` when the thread has the tool:
an implementer who later meets a decision the plan does not settle consults
its author through the signature (`consult_manager`), and an unsigned plan has
no author to ask. The renderer hides the frontmatter it adds.

## Before drafting

**Write the reader brief first.** Three lines in the frontmatter — who reads
this and what they are there to do, what they already know, what they must be
able to say or decide after the first screen — per §1 of
[`document-quality.md`](../mdx-doc-core/references/document-quality.md). A plan
written from a brief is read by someone who was not in the conversation and
has not read the research; the first screen is written for them.

**Ground the plan in the real codebase.** Read the actual files, modules,
schemas and existing patterns; name real files, symbols and data shapes. For
each step say what it reuses before what it adds, so the plan explains the
genuinely new delta rather than redescribing what exists. Delegate wide
exploration to a sub-agent when the surface is large and fold the findings
back. Planning is read-only: the plan file is the one write, and source edits
wait for approval — a plan that has already changed the code is not a proposal.

## The plan skeleton

Top to bottom (worked versions, for UI and for backend work, are in
[`exemplar.md`](../mdx-doc-core/references/exemplar.md)):

1. **First screen — the recommendation.** What you propose, what the user
   gets, the one or two bets it makes and roughly what it costs, in a
   paragraph a reader with no context can repeat. For UI work, the change as a
   comparable Before / After pair (`<Columns>` of `<Screen>`) under it, or
   under the "what it means" lines when the pair is tall enough to push them
   off the first screen; for a broad or abstract plan, one concrete product
   snapshot (a single `<Screen>` or top `<DesignBoard>` artboard) and a
   sentence on what the user sees, before any mode table or architecture.
2. **What it means** — scope and non-goals in a few lines, what "done" means,
   and a one-line pointer to the open questions at the end if there are any.
   The first screen as a whole (recommendation, bets, cost, what is being
   approved) reads best under about 300 words; past that the reader is into
   the evidence before they hold the answer, so for a plan with several
   defects or bets, "done" means opens `## 1` and the approval ask stays.
3. **Numbered sections for the approach** — the key decisions with their
   rationale, each as settled prose or a `<Callout tone="decision">` with a
   `<Columns>` weighing the rejected alternative; the `<DataModel>` /
   `<Endpoint>` / `<AnnotatedCode>` / `<Mermaid>` beside the prose that needs
   it; ordered steps naming real files and symbols.
4. **The change map in a drill-down** — a `<Details>` holding the `<FileTree>`
   with change badges, so it is there for the implementer without taking the
   reader's first pass.
5. **Verification** — the command, test or checkable behaviour; when the plan
   changes UI, files, providers or a multi-step flow, at least one end-to-end
   smoke that matches the user journey (a real folder, a real fixture, the
   browser interaction, the on-disk assertion), not only "typecheck passes".
6. **One `<QuestionForm>` at the bottom** for what is genuinely open, each
   question with a `recommended` default.

## Planning discipline

- **Decide the hard-to-reverse bets first.** For backend, data or API work,
  the decisions that are expensive to undo once data or callers depend on
  them — wire format, public ids, data-model shape, auth and ownership
  boundaries — are settled in the plan even when most of the feature ships
  later; then scope to the smallest first cut that proves the approach without
  foreclosing it, saying what is in and what is deferred.
- **Specific over vague.** Ordered steps name real files, symbols, actions and
  data shapes; a step like "make it work" tells the implementer nothing and the
  reader less.
- **Stands alone.** The reader never saw the chat, so even a revised draft is
  written as the current proposal, not a changelog of the conversation ("as
  discussed", "unlike the previous version"). State the model directly.
- **Keep the altitude the reader asked at.** When the request is a framework
  or product change, separate the reusable core from the motivating example
  and label the example as one, unless it is the whole scope.
- **Explore rather than ask.** Present the approach and the options in the
  plan; a clarifying question is for an ambiguity that would change the design
  and cannot be resolved from the code. Otherwise state the assumption and
  proceed, and put any genuinely open decision in the bottom form.

## Validate before presenting

A stray `<` or `{` in prose is an MDX compile error that kills the whole
rendered document; an unknown tag or invalid props shows an error card in
place; dangling canvas ids, ragged tables and sanitiser-stripped HTML degrade
silently. Run the render-health check and fix every finding before telling the
reader the plan is ready:

```
node apps/web/scripts/lint-plan.mjs plans/<slug>/plan.mdx --out plans/<slug>/render.html
```

Two stages against the real renderer modules: **lint** (compile gate, block
registry, zod schemas, mermaid parser, wireframe sanitiser) reporting
`file:line` findings, then a headless **render** through the real block
registry, which catches a block that throws or degrades on a payload its schema
accepts, and prints the block types that mounted. Fix all `error` findings;
read each `warning` and fix it unless the degradation is intended. Exit code 0
means the document compiles and renders, so it will display in-app; a plan
handed over on an unrun or failing check may open as an error card. `--out`
also writes the rendered page beside the plan so you can look at it — how, why
it sits beside the document, and what it cannot show (a `<Mermaid>` draws
only in-app), is §10 of `document-quality.md`.

If a reader reports the plan looking broken (JSX shown as literal escaped text)
after a passing check, the document is healthy: that signature is the plain
markdown fallback, a view or routing problem rather than a document defect.

## The reference core

Shared across genres, in `mdx-doc-core`:

- [`document-quality.md`](../mdx-doc-core/references/document-quality.md) —
  the reader brief, the first-screen rule, hierarchy, representation, the
  question form, self-containment and the final checklist. Read it before
  drafting the body and run the checklist before handing off.
- [`exemplar.md`](../mdx-doc-core/references/exemplar.md) — worked skeletons
  per genre and the anti-patterns with their cost to the reader.
- [`block-vocabulary.md`](../mdx-doc-core/references/block-vocabulary.md) —
  every block by example; [`block-schema.md`](../mdx-doc-core/references/block-schema.md)
  — the generated authority for exact props and enum values, including the
  attribute-encoding rules in its "Encoding recap". The tag names are the wire
  contract: the renderer knows only those tags and their documented attributes,
  and ordinary Markdown carries everything else.
- [`wireframe.md`](../mdx-doc-core/references/wireframe.md) and
  [`canvas.md`](../mdx-doc-core/references/canvas.md) — read before authoring
  a wireframe or spatial canvas.
