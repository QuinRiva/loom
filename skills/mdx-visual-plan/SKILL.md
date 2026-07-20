---
name: mdx-visual-plan
description: >-
  Author an implementation plan — a proposal for work that does not yet exist,
  before any code is written — as a rich, reviewable MDX document using T3
  Code's supported block vocabulary (data models, endpoints, file trees,
  annotated code, diagrams, tables, diffs, callouts, checklists, OpenAPI/Mermaid,
  containers, and — for UI work — wireframe/design artboards, a spatial canvas,
  and interactive prototypes) instead of a chat-only prose plan. Use when a plan
  is worth reviewing and annotating in-app and the work is approval-gated. For a
  recap of work already done, or a decision/review batch, use mdx-visual-recap.
pi_global: true
pi_global_requires: [mdx-doc-core]
---

# MDX Visual Plans

**Genre: the implementation plan** — a proposal for work that does not yet
exist. Its activation space is forward planning that is **approval-gated**: the
user reviews and annotates the plan, and you implement only after they approve.
For a recap of a change that already exists, or a decision/verdict batch, reach
for the **`mdx-visual-recap`** skill instead — "planning is read-only" and "the
plan is the approval gate" are both actively wrong for a document about work that
is already done.

Write the plan you would normally hand back as Markdown, but as a **scannable MDX
document with structured blocks mixed into the prose**: data models, API
endpoints, file/change trees, annotated code walkthroughs, architecture
diagrams, and a bottom open-questions form. T3 Code renders the MDX in its own
in-app document panel and lets the user annotate any span of it — selecting text
leaves an anchored comment that is fed back to you as a normal turn. **The plan
is the approval gate: you surface it, the user reviews and annotates it, and you
implement only after they approve.**

This is a first-party, fully local capability: a plan is just an `.mdx` file in
the workspace that the renderer reads. You author it with ordinary file writes.
There is no hosted app, no MCP connector, and no external account.

## When to write one — and when not to

Write an MDX visual plan whenever the plan is a better **reviewable artefact**
than a chat paragraph: multi-file or ambiguous work, a data-model / API / schema
decision that needs alignment, a refactor with real risk, or anything where the
user should react to a direction before you build it. A modest change still
qualifies if the user needs to see and sign off on the shape first.

**Skip it for truly trivial, unambiguous work** — a typo, a one-line fix, a
single well-specified function, anything whose diff you could describe in one
sentence. Just make the change. Never pad a plan with filler, and never ship a
single-step plan.

## Where the plan goes

Write one plan per task to:

```
plans/<slug>/plan.mdx
```

`<slug>` is a short kebab-case name for the work (e.g.
`plans/mdx-comment-injection/plan.mdx`). Use a folder per plan so later phases
can add sibling artefacts beside it without moving the plan. The `.mdx`
extension is what routes the file to the plan renderer. After writing it, tell
the user the path and ask them to open, review, and annotate it — do not ask a
separate "does this look good?" question on top of that.

## Validate before presenting (mandatory)

A stray `<`/`{` in prose kills the ENTIRE rendered document (MDX compile
error); an unknown tag or invalid props show error cards in place; and several
mistakes (dangling canvas ids, ragged tables, sanitiser-stripped HTML) degrade
silently. **Always run the plan validator on your `.mdx` file and fix every
finding BEFORE telling the user the plan is ready:**

```
node apps/web/scripts/lint-plan.mjs plans/<slug>/plan.mdx
```

It exercises the real renderer pipeline (compile gate, block registry, zod
schemas, mermaid parser, wireframe sanitiser) and reports `file:line` findings.
Fix all `error` findings; read each `warning` and fix it unless the degradation
is genuinely intended. Exit code 0 with no findings means the plan will render.

## Research before you draft

Ground the plan in the real codebase, not from memory:

- Read the actual files, modules, schemas, and existing patterns first. Name
  real files, symbols, functions, and data shapes — never invented ones.
- **Lead with reuse.** For each step, say what it reuses (an existing module,
  schema, component, helper) before what it adds, so the plan explains the
  genuinely new delta instead of redescribing what already exists.
- Delegate wide exploration to a sub-agent when the surface is large; fold the
  findings back into the plan.
- **Planning is read-only.** Make no source edits while researching or drafting
  the plan. Start editing only after the user approves the direction. (Writing
  the `plans/<slug>/plan.mdx` file itself is the one allowed write.)

## Planning discipline (the quality bar)

- **Decide the hard-to-reverse bets first.** For non-trivial backend, data, or
  API work, call out the decisions that are expensive to undo once data or
  callers depend on them — wire format, public ids, data-model shape, auth and
  ownership boundaries — and settle them in the plan even if most of the feature
  ships later. Then scope to the smallest first cut that proves the approach
  without foreclosing it, stating what is in and what is explicitly deferred.
- **Serious technical plan, not marketing.** Outcome-first and specific: state
  the objective and what "done" means, scope and non-goals, the approach with
  key decisions and their rationale, ordered steps naming real files/symbols,
  the risks, and a closing verification step (a command, test, or checkable
  behaviour). Replace vague prose with specifics — never a step like "make it
  work". No hero headings, value props, or marketing cards.
- **Stands alone.** A reader who never saw the chat must understand the plan.
  Even when you are revising an earlier draft, write the current proposal, not a
  changelog of the conversation. Avoid "as discussed above", "this revision",
  "unlike the previous version". State the positive model directly.
- **Keep examples at the right altitude.** When the request is a broad framework
  or product change, separate the reusable core from the motivating example;
  label examples as examples unless they are the whole scope.
- **Make the first read concrete.** For a broad, abstract, or strategic plan,
  lead with one concrete product snapshot — a single `<Screen>` (or top
  `<DesignBoard>` artboard) plus a sentence on what the user sees — _before_ dense
  mode tables, manifests, or architecture.
- **Clarify vs. assume.** Do not ask how to build it — explore and present the
  approach and options in the plan. Ask a clarifying question only when an
  ambiguity would change the design and you cannot resolve it from the code;
  otherwise state the assumption explicitly and proceed, and record any genuinely
  open decision in the single bottom Open Questions form.
- **One open-questions block, at the bottom.** Surface unresolved decisions in a
  single `<QuestionForm>` at the end of the document. That is the ONLY place that
  enumerates open questions — never a second questions list or a parallel
  "decisions" wall earlier in the document.
- **Verification exercises the real workflow.** When the plan changes UI, files,
  providers, or multi-step flows, include at least one end-to-end smoke that
  matches the user journey, and name the command or manual path when known — not
  just "typecheck passes".

## The MDX contract (one paragraph)

The block tag names are the stable wire contract — the renderer only knows those
tags and their documented attributes. Do not invent tags or attributes; use
ordinary Markdown (GFM) for everything else, and place blocks next to the prose
they support. The full attribute-encoding rules live in the **"Encoding recap"**
preamble of the shared core's
[`block-schema.md`](../mdx-doc-core/references/block-schema.md); the validator
above catches mechanical mistakes, so don't spend your budget on escaping rules.

## Block vocabulary and reference core

The block vocabulary, wire contract, quality bar, and wireframe/canvas contracts
are **shared across genres** and live once in the `mdx-doc-core` reference core.
Consult them — do not guess props or re-derive the quality bar:

- **[`../mdx-doc-core/references/block-vocabulary.md`](../mdx-doc-core/references/block-vocabulary.md)**
  — every block by example, grouped (document / review / container / visual /
  iframe), and the content→representation routing choices.
- **[`../mdx-doc-core/references/block-schema.md`](../mdx-doc-core/references/block-schema.md)**
  — the generated authority for exact props, types, and enum values (cannot
  drift from the live schemas). Consult it for anything an example omits.
- **[`../mdx-doc-core/references/document-quality.md`](../mdx-doc-core/references/document-quality.md)**
  — the prose quality bar, the "Choose the representation" routing table, the
  self-containment rule, and the reader-experience final checklist.
- **[`../mdx-doc-core/references/wireframe.md`](../mdx-doc-core/references/wireframe.md)**
  and **[`../mdx-doc-core/references/canvas.md`](../mdx-doc-core/references/canvas.md)**
  — read before authoring any wireframe or spatial canvas.
- **[`../mdx-doc-core/references/exemplar.md`](../mdx-doc-core/references/exemplar.md)**
  — worked skeletons (plan, decision-review, recap) and named anti-patterns.

## The plan skeleton

A typical plan reads, top to bottom: a short **objective + done-criteria**
paragraph; a `<FileTree>` of what changes; the **approach** in prose with the key
decisions stated (a `<DataModel>` / `<Endpoint>` / `<AnnotatedCode>` / `<Diagram>`
next to the prose that needs it); **scope and non-goals**; a **verification**
step; and a single `<QuestionForm>` at the very bottom for anything still open.
For a complex plan, do a final pass: every meaningful decision is either settled
in the plan with rationale or sits in that bottom form with a recommended
default.

Before writing the prose body, read
[`../mdx-doc-core/references/document-quality.md`](../mdx-doc-core/references/document-quality.md),
and check your draft against the worked skeletons and named anti-patterns in
[`../mdx-doc-core/references/exemplar.md`](../mdx-doc-core/references/exemplar.md).
