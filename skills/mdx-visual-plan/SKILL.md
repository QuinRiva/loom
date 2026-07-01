---
name: mdx-visual-plan
description: >-
  Author a coding plan as a rich, reviewable MDX document using T3 Code's
  supported block vocabulary (data models, endpoints, file trees, annotated
  code, diagrams, open-question forms) instead of a chat-only prose plan. Use
  when a plan is worth reviewing and annotating in-app before any code is
  written. Document-only; canvas / wireframe / live-prototype surfaces are a
  later phase and are not yet available.
---

# MDX Visual Plans

Write the plan you would normally hand back as Markdown, but as a **scannable MDX
document with structured blocks mixed into the prose**: data models, API
endpoints, file/change trees, annotated code walkthroughs, architecture
diagrams, and a bottom open-questions form. T3 Code renders the MDX in its own
in-app document panel and lets the user annotate any span of it — selecting text
leaves an anchored comment that is fed back to you as a normal turn. **The plan
is the approval gate: you surface it, the user reviews and annotates it, and you
implement only after they approve.**

This is a first-party, fully local capability. There is no hosted app, no MCP
connector, and no external account: a plan is just an `.mdx` file in the
workspace that the renderer reads. You author it with ordinary file writes.

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
extension is what routes the file to the plan renderer; a plain `.md` file is
shown as ordinary markdown. After writing it, tell the user the path and ask
them to open, review, and annotate it — do not ask a separate "does this look
good?" question on top of that.

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

## Discipline (the quality bar)

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
- **Clarify vs. assume.** Do not ask how to build it — explore and present the
  approach and options in the plan. Ask a clarifying question only when an
  ambiguity would change the design and you cannot resolve it from the code;
  otherwise state the assumption explicitly and proceed, and record any genuinely
  open decision in the single bottom Open Questions form.
- **One open-questions block, at the bottom.** Surface unresolved decisions in a
  single `<QuestionForm>` at the end of the document (see below). That is the
  ONLY place that enumerates open questions — never a second questions list or a
  parallel "decisions" wall earlier in the document. A one-line pointer in the
  overview ("a few decisions are still open — see the end") is fine.
- **Verification exercises the real workflow.** When the plan changes UI, files,
  providers, or multi-step flows, include at least one end-to-end smoke that
  matches the user journey, and name the command or manual path when known — not
  just "typecheck passes".

## The MDX contract

The block **tag names below are the stable wire contract** — the renderer only
knows these tags and their documented attributes. Do not invent new tags or
attributes; use ordinary Markdown (GFM) prose, headings, lists, and links for
everything else, and place blocks directly next to the prose they support.

Attributes follow one fixed encoding:

- **Scalar string** → `attr="value"` (a simple string). If it contains newlines
  or unusual characters it is written as a JSON string expression instead:
  `attr={"line one\nline two"}`.
- **Number** → `attr={12}`. **Boolean true** → bare `attr` (omit for false).
- **Structured data** (arrays / objects) → a JSON literal in braces, with
  double-quoted keys, e.g. `entries={[{ "path": "src/x.ts", "change": "added" }]}`.
- Do **not** use arbitrary `{expressions}` in the document body or as attribute
  values — only literal data. The renderer rejects imports/exports and free
  expressions.
- Optionally give a block a stable `id="..."` so a review comment can anchor to
  the whole block (prose spans anchor by quoted text automatically).

## Block vocabulary (first cut — 8 document blocks)

Each block is shown with a short, real example. Only the fields you need are
required; omit the rest.

### `<DataModel>` — entities, typed fields, relations

Entity cards with typed fields (PK/FK/nullable) and foreign-key relations.
Field `change` and entity `change` accept `added|modified|removed|renamed`.

```mdx
<DataModel
  entities={[
    {
      id: "planComment",
      name: "PlanComment",
      fields: [
        { name: "id", type: "string", pk: true },
        { name: "planPath", type: "string", note: "the .mdx path" },
        { name: "anchor", type: "PlanCommentAnchor", nullable: true },
        { name: "status", type: "open | resolved" },
      ],
    },
  ]}
  relations={[{ from: "planComment", to: "planComment", kind: "1-n", label: "parentCommentId" }]}
/>
```

### `<Endpoint>` — one API operation

A method pill + path that expands to params, request body, and per-status
responses. `method` and `path` are required; `params[].in` is
`path|query|header|body`. The **prose between the tags is the description**.

```mdx
<Endpoint
  method="POST"
  path="/api/plans/:slug/comments"
  summary="Attach a review comment to a plan span"
  params={[
    { name: "slug", in: "path", type: "string", required: true },
    { name: "anchor", in: "body", type: "PlanCommentAnchor", required: true },
  ]}
  responses={[{ status: "201", description: "Comment created" }]}
>
  Anchors a comment to a text-quote span, then injects it back to the agent as a normal user turn.
</Endpoint>
```

### `<FileTree>` — the file/change map

Slash-delimited paths with per-file change badges, notes, and optional snippets.

```mdx
<FileTree
  title="Renderer wiring"
  entries={[
    {
      path: "apps/web/src/components/files/FilePreviewPanel.tsx",
      change: "modified",
      note: "route .mdx to the MDX renderer",
    },
    {
      path: "apps/web/src/mdx/renderPlanMdx.ts",
      change: "added",
      note: "evaluate() wrapper + remark guard",
    },
  ]}
/>
```

### `<Code>` — one syntax-highlighted snippet

`code` is required; `language`, `filename`, `caption`, `maxLines` are optional.
Multiline code is written as a JSON string expression.

```mdx
<Code
  filename="apps/web/src/mdx/registry.ts"
  language="ts"
  code={"export const planBlocks = {\n  DataModel,\n  Endpoint,\n  FileTree,\n} as const;\n"}
/>
```

### `<AnnotatedCode>` — a code walkthrough with margin notes

Prefer this over a bare `<Code>` when specific lines are worth calling out. Each
annotation is `{ "lines": "12" | "12-18", "label"?, "note" }`. Keep a few
high-signal notes, not one per line.

```mdx
<AnnotatedCode
  filename="apps/web/src/mdx/renderPlanMdx.ts"
  language="ts"
  code={
    "const { default: Content } = await evaluate(src, {\n  ...runtime,\n  remarkPlugins: [remarkNoCodeEscapes],\n  useMDXComponents: () => registry,\n});\n"
  }
  annotations={[
    {
      lines: "1",
      label: "runtime compile",
      note: "isomorphic evaluate() — identical in Node and the browser",
    },
    { lines: "3", note: "guard rejects import/export and body {expressions}" },
  ]}
/>
```

### `<Diagram>` — a 2-D architecture / data-flow diagram

Use for real spatial relationships (layers, before/after, data flow) — not a
default left-to-right chain. Simple form uses `data` with `nodes`/`edges`
(`x`/`y` are 0–100 percentages); a `caption` labels it.

```mdx
<Diagram
  caption="Comment injection path"
  data={{
    nodes: [
      { id: "sel", label: "Selection", x: 10, y: 45 },
      { id: "anchor", label: "text-quote anchor", x: 45, y: 45 },
      { id: "turn", label: "user turn", x: 82, y: 45 },
    ],
    edges: [
      { from: "sel", to: "anchor" },
      { from: "anchor", to: "turn", label: "inject" },
    ],
  }}
/>
```

### `<Json>` — a collapsible JSON tree

`json` is the JSON **as a string** (so it round-trips verbatim); `title` and
`collapsedDepth` are optional.

```mdx
<Json
  title="Example comment payload"
  json={'{\n  "id": "c_01",\n  "planPath": "plans/mdx-annotation/plan.mdx",\n  "status": "open"\n}'}
/>
```

### `<QuestionForm>` — the bottom Open Questions block

The single place for unresolved decisions. Each question has a `mode` of
`single | multi | freeform`; mark the option you would choose `recommended: true`.
A write-in field always renders, so never add an "Other" option yourself.

```mdx
<QuestionForm
  questions={[
    {
      id: "csp",
      title: "Accept unsafe-eval for the runtime MDX renderer?",
      mode: "single",
      options: [
        {
          id: "a",
          label: "In-browser evaluate() (Option A)",
          recommended: true,
          detail: "No CSP today; the guard bounds the eval surface.",
        },
        {
          id: "b",
          label: "Server compile() + blob: module (Option B)",
          detail: "Only if a strict CSP becomes a requirement.",
        },
      ],
    },
  ]}
/>
```

## Shape of a good plan

A typical document reads: a short **objective + done-criteria** paragraph; a
`<FileTree>` of what changes; the **approach** in prose with the key decisions
stated (a `<DataModel>` / `<Endpoint>` / `<AnnotatedCode>` / `<Diagram>` next to
the prose that needs it); **scope and non-goals**; a **verification** step; and
a single `<QuestionForm>` at the very bottom for anything still open. For a
complex plan, do a final pass: every meaningful decision is either settled in the
plan with rationale or sits in that bottom form with a recommended default.

## Not yet available (later phase)

The rich **visual surfaces** — a wireframe/mockup canvas, live interactive
prototype tabs, and full-fidelity design screens — are a later phase and are
**not yet supported**. Do not author `<WireframeBlock>`, `<Screen>`, canvas
artboards, or prototype tabs, and do not tell the user a UI can be prototyped in
the plan yet. For now, keep plans **document-only**; explain UI direction in
prose plus a `<Diagram>` where a spatial view genuinely helps.
