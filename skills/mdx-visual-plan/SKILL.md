---
name: mdx-visual-plan
description: >-
  Author an intent brief or an implementation plan as a reviewable MDX
  document. Use when a request is for something its owner will judge in use
  rather than by a defect being gone (a feature or a change in behaviour; the
  brief comes first), and whenever work needs a plan.
  For a recap of work already done or a decision batch use mdx-visual-recap;
  to explain, orient or diagnose without asking for a decision use
  mdx-visual-explainer.
pi_global: true
pi_global_requires: [mdx-doc-core]
---

# MDX Visual Plans

**Two genres, one lifecycle.** The **intent brief** is the owner's approval
gate for feature work: one screen on what the feature is for and how they will
know it works, drafted from the request and corrected by them in-app. The
**implementation plan** is the proposal for how, written under an approved
brief and reviewed by an agent against it; the owner sees a plan only where it
reopens the brief. For a change that already exists, or a batch of verdicts,
use **`mdx-visual-recap`**; for a document whose job is understanding rather
than approval, use **`mdx-visual-explainer`**.

Either is an `.mdx` file in the workspace that T3 Code renders in its document
panel. Any span can be annotated; a selection leaves an anchored comment that
comes back to you as a normal turn, and the bottom `<QuestionForm>` comes back
as answers. There is no hosted app, connector or account: you write the file.

## Which to write

A defect fix, a typo, a one-line change: neither, just do it. A feature or a
change in behaviour, anything whose result the owner will judge in use rather
than by a defect being gone: an intent brief first, however small; a small
feature then goes straight to a coder whose reviewer judges against the brief.
Medium or larger work (multi-file or ambiguous, a data-model, API or schema
decision, a refactor with real risk): a plan as well, once the brief is
approved.

## The intent brief

`plans/<slug>/intent.mdx`, beside the plan it governs, committed with the work
and signed `role: intent` (a worked skeleton is in
[`exemplar.md`](../mdx-doc-core/references/exemplar.md)). Its owner reads it
in about a minute, so it states outcomes rather than mechanisms and fits one
screen; when it runs long, cut prose before cutting questions. Its parts:

- **Goal.** What the owner is trying to achieve or find out, opening with
  their literal ask quoted: the semantic goal, which may be a question ("can X
  make Y effortless?") rather than a deliverable.
- **You'll know it works when.** A few lines of what the owner does and sees
  in the running software, each checkable by an agent at review and by the
  owner at near-done, and what it **must not** do or cost (what has to keep
  working; a cost the approach may not incur). No tool probes here; the plan
  derives them.
- **Approaches in play.** The owner's idea as one candidate, plus the
  alternatives worth trying, each with "wins if …"; agents move among these
  without asking, a throwaway spike decides where that is cheap, and a dropped
  approach stays listed with its reason so no later round retries it.
- **Decided.** The owner's words, quoted: the lines a plan may not cross. A
  low-stakes fork is an **Assumed** line here ("picking X over Y because R;
  redirect if wrong"), not a question.
- **Not doing.** Scope only; hard lines.
- **Questions for you.** A `<QuestionForm>` of the questions that gate
  approval, each with why it matters and a `recommended` answer, answerable
  with yes, no or a correction; a bare "go" accepts every recommended answer.
- **Still unknown.** Questions nobody can answer yet, each stated precisely
  with what settles it. These do not gate approval; by near-done each is a check, a
  decision or a dropped approach.

Depth follows how well-defined the request is. Draft first, from the request
and what the codebase settles, and ask inside the form. Interview beforehand,
one question at a time with a recommended answer, when Goal or the checks
cannot be drafted without guessing. For a bigger-picture or comprehensive
effort, one that spans sessions or whose decisions depend on each other,
`read` the wayfinder skill at
`~/pi-craft/plugins/pi-craft/skills/mattpocock/wayfinder/SKILL.md` (it is
`disable-model-invocation`, so it is not in your catalogue) and let its map
drive the questions; the brief is its destination.

The brief is rewritten in place as the work teaches, never appended to as a
log; git is its history, and `status` moves `draft` → `approved` → `done`, or
`dropped`. Agents may settle an unknown into a check or a dropped approach,
record a chosen or dropped approach with its reason, tighten a check's wording
without changing what passes it, and add or revise Assumed lines. Only the
owner may change the Goal, their quoted words, what a check means, a must-not
or a Decided line that is not Assumed; needing one of those changed, or finding
one no longer clear, goes to the owner as one question, as does a new decision
that is theirs (a product trade-off, deleting data or artefacts, overriding a
design document), such as a choice between approaches that differ only on
something the owner alone can judge ("try A and B", with cheap spikes to try).
At near-done the owner tries their checks
and reacts; the reaction becomes changed or new checks in the same brief,
beside the passed checks and must-not lines every later round is still held
to, and the build goes again until the owner says it works and `status` is
`done`.

## Where the plan goes

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

**Pin the words before the design.** When the plan introduces concepts the
codebase does not name, or leans on terms it uses loosely, settle them with the
`domain-modeling` skill first; it knows what a planner may write.

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
   defects or bets, the "done" line can open `## 1` while the approval ask
   stays on the first screen.
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
bash ../mdx-doc-core/scripts/lint-doc.sh plans/<slug>/plan.mdx --out plans/<slug>/render.html --png
```

The script path resolves against this skill's directory, the document paths
against your working directory.

The same check runs on `intent.mdx`.

Two stages against the real renderer modules: **lint** (compile gate, block
registry, zod schemas, mermaid parser, wireframe sanitiser) reporting
`file:line` findings, then a headless **render** through the real block
registry, which catches a block that throws or degrades on a payload its schema
accepts, and prints the block types that mounted. Fix all `error` findings;
read each `warning` and fix it unless the degradation is intended. Exit code 0
means the document compiles and renders, so it will display in-app; a plan
handed over on an unrun or failing check may open as an error card.
`--out --png` also writes the rendered page and PNG slices of it beside the
plan, for you to `read` and look at — how, why they sit beside the document,
and what the page cannot show (a `<Mermaid>` draws only in-app), is §10 of
`document-quality.md`.

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
