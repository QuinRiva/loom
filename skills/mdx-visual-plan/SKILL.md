---
name: mdx-visual-plan
description: >-
  Author a coding plan as a rich, reviewable MDX document using T3 Code's
  supported block vocabulary (data models, endpoints, file trees, annotated
  code, diagrams, tables, diffs, callouts, checklists, OpenAPI/Mermaid,
  containers, and — for UI work — wireframe/design artboards, a spatial canvas,
  and interactive prototypes) instead of a chat-only prose plan. Use when a plan
  is worth reviewing and annotating in-app before any code is written.
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
workspace that the renderer reads. You author it with ordinary file writes. The
full vocabulary now ships — document blocks for architecture/backend/data plans,
and visual surfaces (wireframe, design, spatial canvas, interactive prototype)
for UI work. See [Choosing a surface](#choosing-a-surface) for when to reach for
each.

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

## Block vocabulary

Each block is shown with a short, real example. Only the fields you need are
required; omit the rest. The blocks fall into four groups: **document blocks**
(prose-embedded structure — the default), **containers** (side-by-side / tabbed
layout), **visual surfaces** (wireframe / design / canvas, for UI work), and
**iframe surfaces** (embedded HTML / interactive prototypes).

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

### `<Callout>` — an emphasised note with a tone

A highlighted aside. `tone` is `info | decision | risk | warning | success`
(default `info`); the **prose between the tags is the body**.

```mdx
<Callout tone="risk">
  The MDX runtime uses `evaluate()`, which needs `unsafe-eval`; the remark guard bounds the surface.
</Callout>
```

### `<Checklist>` — a static list of ticked/unticked items

Read-only (the tick reflects the authored `checked` state; it is not
interactive). Each item is `{ id, label, checked?, note? }`.

```mdx
<Checklist
  items={[
    { id: "guard", label: "remark guard rejects imports and expressions", checked: true },
    { id: "csp", label: "decide the CSP posture", note: "tracked in Open Questions" },
  ]}
/>
```

### `<Table>` — a simple grid

Header `columns` + string `rows` (each row an array of cell strings). Optional
`density` is `compact | normal | relaxed`. Good for comparisons and parameter
grids; use `<DataModel>` for typed entities, not this.

```mdx
<Table
  columns={["Surface", "Origin", "Scripts"]}
  rows={[
    ["Prototype", "opaque (sandboxed)", "inline only"],
    ["HtmlBlock", "opaque (sandboxed)", "none"],
  ]}
/>
```

### `<Diff>` — a before/after line diff

GitHub-style diff of `before` vs `after` (both multiline string attrs), `mode`
`unified | split`. Optional line-anchored `annotations`
(`{ side?: "before" | "after", lines: "3" | "3-5", label?, note }`). Prefer this
over two `<Code>` blocks when the change itself is the point.

```mdx
<Diff
  filename="apps/web/src/mdx/registry.ts"
  language="ts"
  mode="split"
  before={"export const planBlocks = {\n  Code,\n};\n"}
  after={"export const planBlocks = {\n  Code,\n  Callout,\n};\n"}
  annotations={[{ side: "after", lines: "3", note: "new block wired into the registry" }]}
/>
```

### `<OpenApi>` — an API reference from a spec document

A Redoc-style reference rendered from a whole OpenAPI 3 / Swagger 2 document.
`spec` is the raw spec **as a string** (v1 parses **JSON only** — no YAML);
`title` is optional. Use `<Endpoint>` for one or two operations; reach for
`<OpenApi>` only when you genuinely have a whole spec.

```mdx
<OpenApi
  title="Plans API"
  spec={
    '{\n  "openapi": "3.0.0",\n  "info": { "title": "Plans", "version": "1.0" },\n  "paths": {\n    "/plans/{slug}/comments": {\n      "post": { "summary": "Add a comment", "responses": { "201": { "description": "Created" } } }\n    }\n  }\n}'
  }
/>
```

### `<Mermaid>` — a Mermaid diagram

Renders a Mermaid diagram from its text `source` (multiline string attr), with an
optional `caption`. Runs in Mermaid's `strict` security mode (no `%%{init}%%`
directives, HTML labels, or click JS). Use `<Diagram>` for a hand-placed spatial
layout; use `<Mermaid>` when Mermaid's auto-layout of a flow/sequence/ER graph is
enough.

```mdx
<Mermaid
  caption="Review loop"
  source={"flowchart LR\n  Plan --> Review\n  Review --> Implement\n"}
/>
```

### `<VisualQuestions>` — deprecated alias of `<QuestionForm>`

Same question/option shape as `<QuestionForm>` (BuilderIO marks it deprecated in
favour of `question-form`). **Prefer `<QuestionForm>`** for the bottom
Open Questions block; only use `<VisualQuestions>` when porting an existing plan
that already has one.

```mdx
<VisualQuestions
  questions={[
    {
      id: "cut",
      title: "Ship the document-only cut first?",
      mode: "single",
      options: [
        { id: "a", label: "Yes", recommended: true },
        { id: "b", label: "No" },
      ],
    },
  ]}
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

### Containers: `<Columns>` and `<TabsBlock>`

Containers lay out **other blocks** side by side or in tabs. Each container is
one annotatable block; its nested blocks keep their own annotation ids. The
inner slot tags are `<Column>` and `<Tab>` (BuilderIO's container tag is
`TabsBlock`, not `Tabs`); a per-slot `label` names it.

`<Columns>` — side-by-side, the common case being a before/after or
current/target pair:

```mdx
<Columns>
  <Column label="Before">
    <Code language="ts" code={"const x = 1;\n"} />
  </Column>
  <Column label="After">
    <Code language="ts" code={"const x = 2;\n"} />
  </Column>
</Columns>
```

`<TabsBlock>` — tabbed panels (optional `orientation` `horizontal | vertical`);
one `<Tab label>` per panel:

```mdx
<TabsBlock>
  <Tab label="Schema">
    <DataModel
      entities={[{ id: "c", name: "Comment", fields: [{ name: "id", type: "string", pk: true }] }]}
    />
  </Tab>
  <Tab label="Endpoint">
    <Endpoint method="GET" path="/api/comments" summary="List comments" />
  </Tab>
</TabsBlock>
```

### Visual surfaces (UI work)

For plans about **screens and flows**, author the UI directly instead of
describing it. Wireframe/design artboards render a self-contained HTML fragment
inside a surface-locked frame; the canvas lays several artboards out in space.
The author writes plain semantic product HTML — the renderer owns the frame,
theme, and (for wireframes) the `--wf-*` design tokens and `.wf-*` helper classes
(the [wireframe authoring contract](#wireframe-authoring-contract) below). The
`html` is sanitised before it is injected.

#### `<Screen>` — a low-fidelity wireframe artboard

`surface` is `browser | desktop | mobile | popover | panel` (default `browser`);
`html` is the self-contained fragment; `caption` is optional. Author with the
neutral `--wf-*` tokens / `.wf-*` classes, not branded styling.

```mdx
<Screen
  surface="mobile"
  caption="Comment composer"
  html={'<div class="wf-card"><h1>Add comment</h1><textarea></textarea><button>Send</button></div>'}
/>
```

#### `<Design>` — a design-fidelity artboard

The same surface/html/caption shape as `<Screen>`, but branded styling classes
are preserved and the sketch chrome is dropped — use it when you want to show
real visual fidelity rather than a grey-box wireframe. Fidelity is implied by the
tag; there is no `css`/`style` attribute (HTML only).

```mdx
<Design
  surface="browser"
  caption="Branded settings screen"
  html={'<div class="card"><h1>Settings</h1><button class="btn">Save</button></div>'}
/>
```

#### `<DesignBoard>` — a spatial canvas of artboards

Lays screens out in a shared board-unit coordinate space to show a **flow**. A
`<DesignBoard>` (optional `title`, `width`, `height` — board grows to fit its
children) contains:

- `<Artboard x y surface html caption? fidelity?>` — a positioned wireframe/design
  screen (same html as `<Screen>`). Give it an `id` so connectors/annotations can
  target it.
- `<Section title x y width height>` — an optional labelled frame grouping
  artboards (visual only).
- `<Connector from to label?>` — a flow arrow between two artboard `id`s.
- `<Annotation targetId? placement? x? y?>` — a gutter note parked beside a
  target artboard (`placement` `left | right | top | bottom`) or at free board
  coordinates; the note body is the prose between the tags.

```mdx
<DesignBoard title="Onboarding flow" width={1200} height={600}>
  <Section title="Auth" x={0} y={0} width={900} height={500}>
    <Artboard
      id="signin"
      x={40}
      y={60}
      surface="mobile"
      html={'<div class="wf-card"><h1>Sign in</h1></div>'}
    />
    <Artboard
      id="home"
      x={440}
      y={60}
      surface="mobile"
      html={'<div class="wf-card"><h1>Home</h1></div>'}
    />
  </Section>
  <Connector from="signin" to="home" label="submit" />
  <Annotation targetId="home" placement="right">
    Lands here after auth.
  </Annotation>
</DesignBoard>
```

#### Wireframe authoring contract

Inside a `<Screen>` / `<Artboard>` the renderer auto-themes bare semantic
elements — `h1`–`h3`, `p`, `a`, `small`, `hr`, `strong`, `button`, `input`,
`select`, `textarea`, `label` all pick up the wireframe look with **no classes**.
On top of that, a few helper classes and colour tokens are available; do not rely
on any other framework classes (they are stripped by the sanitiser).

- **Helper classes:** `.wf-card` / `.wf-box` (bordered container), `.wf-pill` /
  `.wf-chip` (rounded tag; add `.accent` to fill with the accent colour),
  `.wf-btn` (button look on a non-`<button>`), `.wf-muted` (muted text),
  `.wf-icon` (a 1em icon slot). Mark a primary button with `class="primary"` or
  `data-primary`.
- **Colour tokens (CSS vars, light/dark aware):** `--wf-ink` (text),
  `--wf-muted`, `--wf-line` (borders), `--wf-paper` (surface), `--wf-card`,
  `--wf-accent` / `--wf-accent-fg` / `--wf-accent-soft`, `--wf-warn`, `--wf-ok`,
  and `--wf-radius`. Reference them via `var(--wf-...)` in an inline `style`.
- **Surface presets** (max-width × min-height floor): `mobile` 300×360,
  `popover` 360×120, `panel` 420×200, `desktop` 840×200, `browser` 900×200. The
  frame shrinks responsively on narrow viewports.

`<Design>` fragments instead keep their own branded classes / inline styles —
the `--wf-*` theming does not apply there.

### Iframe surfaces: `<Prototype>` and `<HtmlBlock>`

Both render author-supplied HTML inside a **sandboxed, opaque-origin iframe** —
the frame cannot touch the parent app, cookies, or session. You write a
self-contained document; **no remote scripts load** (the CSP blocks them), so
inline everything. These are annotatable only as a whole block (you cannot select
into the frame). `caption` and `height` (px) are optional.

`<Prototype>` — **interactive**: scripts + forms run, so inline `<script>` and
handlers work. Use it when the reviewer needs to _operate_ a flow.

```mdx
<Prototype
  caption="Filter interaction"
  height={360}
  html={"<button onclick=\"document.body.append('clicked')\">Filter</button>"}
/>
```

`<HtmlBlock>` — **static**: the sandbox is fully locked, so no JS runs at all.
Use it to embed a static HTML snippet (a legend, a rendered table) that the other
blocks don't cover.

```mdx
<HtmlBlock caption="Status legend" html={"<ul><li>done</li><li>in progress</li></ul>"} />
```

## Choosing a surface

Default to **document blocks** and prose — they are the most scannable and the
most precisely annotatable. Add a visual surface only when it earns its place:

- **Architecture / backend / data / API plans** — document blocks only.
  `<DataModel>`, `<Endpoint>` / `<OpenApi>`, `<FileTree>`, `<AnnotatedCode>` /
  `<Diff>`, `<Diagram>` / `<Mermaid>`, `<Table>`, `<Callout>`. No UI surface.
- **UI layout / structure** — `<Screen>` (single screen) or `<DesignBoard>` with
  `<Artboard>`s + `<Connector>`s (a multi-screen flow). Grey-box wireframe
  fidelity; the point is layout and flow, not polish.
- **Branded / high-fidelity visuals** — `<Design>`, when the actual look matters.
- **An interaction the reviewer must operate** — `<Prototype>`. Reserve it for
  flows where clicking through beats a static picture; a static layout is a
  `<Screen>`, not a prototype.

Do not reach for a prototype or design artboard when a wireframe or a diagram
says the same thing, and never author a visual surface for a plan that has no UI.

## Shape of a good plan

A typical document reads: a short **objective + done-criteria** paragraph; a
`<FileTree>` of what changes; the **approach** in prose with the key decisions
stated (a `<DataModel>` / `<Endpoint>` / `<AnnotatedCode>` / `<Diagram>` next to
the prose that needs it); **scope and non-goals**; a **verification** step; and
a single `<QuestionForm>` at the very bottom for anything still open. For a
complex plan, do a final pass: every meaningful decision is either settled in the
plan with rationale or sits in that bottom form with a recommended default.
