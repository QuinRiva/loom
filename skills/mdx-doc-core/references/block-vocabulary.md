# Block vocabulary

The shared block vocabulary for every MDX-document genre (plans and
recaps / decision batches). This file teaches the **common shape** of each
block by example; [`block-schema.md`](block-schema.md) is the generated
authority for exact props and enum values. Consult it — do not guess props.

## The MDX contract (one paragraph)

The block **tag names below are the stable wire contract** — the renderer only
knows these tags and their documented attributes. Do not invent new tags or
attributes; use ordinary Markdown (GFM) prose, headings, lists, and links for
everything else, and place blocks directly next to the prose they support.
Optionally give a block a stable `id="..."` so a review comment can anchor to
the whole block (prose spans anchor by quoted text automatically). The full
attribute-encoding rules (scalars, numbers, booleans, JSON literals, no free
`{expressions}`) live in the **"Encoding recap"** preamble of
[`block-schema.md`](block-schema.md); the validator catches mechanical mistakes,
so this is a pointer rather than a re-statement.

## Block groups

The blocks fall into five groups: **document blocks** (prose-embedded structure
— the default), **review blocks** (field diffs, cards, drill-downs, per-item
decisions — for decision/recap documents), **containers** (side-by-side / tabbed
layout), **visual surfaces** (wireframe / design / canvas, for UI work), and
**iframe surfaces** (embedded HTML / interactive prototypes).

Each block is shown with a short, real example. Only the fields you need are
required; omit the rest.

### `<DataModel>` — entities, typed fields, relations

Entity cards with typed fields (PK/FK/nullable) and foreign-key relations.
Field `change` and entity `change` accept `added|modified|removed|renamed`.

The `fk` field is a **string** naming the FK target (`"Entity"` or
`"Entity.field"`), never a boolean. Relation `kind` is one of
`"1-1" | "1-n" | "n-n"` only — there is no `"n-1"`; model many-to-one as `"1-n"`
from the "one" side to the "many" side. See
[`block-schema.md`](block-schema.md) for the full field/relation shape.

```mdx
<DataModel
  entities={[
    {
      id: "comment",
      name: "PlanComment",
      fields: [
        { name: "id", type: "string", pk: true },
        { name: "planId", type: "string", fk: "Plan.id", note: "parent plan" },
        { name: "anchor", type: "PlanCommentAnchor", nullable: true },
        { name: "status", type: "open | resolved" },
      ],
    },
  ]}
  relations={[{ from: "plan", to: "comment", kind: "1-n", label: "comments" }]}
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

`code` is required; `language`, `filename`, `caption`, `maxLines`, `wrap` are
optional. Multiline code is written as a JSON string expression. Set `wrap` to
ship it soft-wrapped (the header gains a wrap toggle either way).

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
default left-to-right chain. Author it with flat `nodes`/`edges` props
(`x`/`y` are 0–100 percentages); a `caption` labels it. This is a constrained
nodes/edges model with no HTML/CSS diagram mode — for a rich layered, matrix, or
swimlane picture reach for `<Mermaid>` (auto-layout) or plain prose instead of
forcing it here.

```mdx
<Diagram
  caption="Comment injection path"
  nodes={[
    { id: "sel", label: "Selection", x: 10, y: 45 },
    { id: "anchor", label: "text-quote anchor", x: 45, y: 45 },
    { id: "turn", label: "user turn", x: 82, y: 45 },
  ]}
  edges={[
    { from: "sel", to: "anchor" },
    { from: "anchor", to: "turn", label: "inject" },
  ]}
/>
```

### `<Json>` — a collapsible JSON tree

`json` is the JSON **as a string** (so it round-trips verbatim); `title`,
`collapsedDepth`, and `wrap` are optional. `wrap` soft-wraps long values (the
title row gains a wrap toggle).

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
(`{ side?: "before" | "after", lines: "3" | "3-5", label?, note }`), optional
`wrap`. Prefer this over two `<Code>` blocks when the change itself is the
point — but only for genuinely **line-oriented** source; for a few fields of a
record use `<FieldDiff>` instead.

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
optional `caption`. Runs in Mermaid's `strict` security mode (sanitised output, no
click JS) with HTML labels disabled — labels render as plain SVG text. (Strict mode
alone does NOT disable `%%{init}%%` directives or HTML labels in mermaid 11.)
Use `<Diagram>` for a hand-placed spatial
layout; use `<Mermaid>` when Mermaid's auto-layout of a flow/sequence/ER graph is
enough.

```mdx
<Mermaid
  caption="Review loop"
  source={"flowchart LR\n  Plan --> Review\n  Review --> Implement\n"}
/>
```

### `<QuestionForm>` — the bottom Open Questions block

The single place for unresolved decisions. Each question has a `mode` of
`single | multi | freeform`; mark the option you would choose `recommended: true`.
The rendered block is answerable in place: the reviewer clicks options (one for
`single`, any number for `multi`) and each answer is attached to their next
review message as a structured "Q: … → chose: …" comment. A write-in field
renders only for `mode: "freeform"` or when the question sets
`allowOther: true` — never add an "Other" option yourself; set `allowOther`
instead. `submitLabel` is accepted for the wire round-trip but not rendered:
answers ride the review turn per question, so there is no submit button.

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

`<VisualQuestions>` is a **deprecated alias** with the same shape — prefer
`<QuestionForm>`; only use `<VisualQuestions>` when porting a plan that already
has one.

## Review blocks (decision / recap documents)

These four blocks close the gap between an MDX plan and a hand-built decision
document. Reach for them when the document reviews existing work — a verdict
batch, a sign-off gate, a PR-style review. See the decision-review skeleton in
[`exemplar.md`](exemplar.md) for how they compose.

### `<FieldDiff>` — record-level before/after

Two labelled panels side by side, listing the fields that change, values
**always wrapped**. Use it when the change is a few fields of a record/config —
this is the block that retires the "JSON-string-in-a-line-diff" anti-pattern.
Each field is `{ name, before?, after?, kept?, note? }`. The `before`/`after`
values distinguish three cases: **present with value** (a string), **present but
null** (`null` → italic muted `null`), and **absent on that side** (omit the
key → em-dash). `kept: true` renders the field dimmed in both panels with an
`unchanged` tag, for context fields.

```mdx
<FieldDiff
  title="as_built_drawing.systems_baseline_for_inspection"
  beforeLabel="Current (production)"
  afterLabel="Proposed"
  fields={[
    { name: "necessity", before: "optional", after: "conditional" },
    {
      name: "condition",
      before: null,
      after: "When a downstream inspection relies on the as-built record.",
    },
    { name: "containment_description", after: "Introduced only in the proposed state." },
    { name: "containment_certainty", before: "definitive", after: "definitive", kept: true },
  ]}
/>
```

### `<Details>` — collapsible container

A `passChildren` disclosure: the body is ordinary MDX — prose and any nested
blocks, including another `<Details>` (nest drill-downs). `open` renders it
expanded. This is the **self-containment mechanism**: embed bulk evidence (full
records, raw packs) behind a `<Details>` rather than linking out to a companion
file.

```mdx
<Details summary="Full production entry: as_built_drawing">
  <Json title="as_built_drawing" json={"{ … }"} collapsedDepth={2} wrap />
</Details>
```

### `<Card>` — toned item container

A bordered card with a coloured left border, a header row (`heading`, optional
`badge` pill, optional `meta` chips), and a `passChildren` body. Give each item
its own `<Card id>` so the batch is triaged by tone at a glance and annotations
anchor to the whole card. `tone` is a **six-slot categorical palette**
(`neutral | info | success | warning | risk | accent`) — colour is triage only;
meaning rides the badge/heading text.

```mdx
<Card
  id="item-a1"
  heading="A-1 · as_built_drawing.necessity"
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

### `<ReviewChoice>` — per-item tri-state decision capture

A compact one-row widget: an Accept / Reject / Discuss toggle plus a note field.
The decision lands as a structured review comment on the next turn — no export
step (this is where MDX beats a static HTML doc). `itemId` is the aggregation
key and **must be unique per document** (the linter flags duplicates). In a bare
renderer/test context it renders read-only. State the "silence = accept the
recommendation" convention in a top `<Callout tone="decision">`, not the widget.

```mdx
<ReviewChoice itemId="a1" label="A-1" placeholder="Why, if rejecting…" />
```

## Containers: `<Columns>` and `<TabsBlock>`

Containers lay out **other blocks** side by side or in tabs. Each container is
one annotatable block; its nested blocks keep their own annotation ids. The
inner slot tags are `<Column>` and `<Tab>` (the container tag is `TabsBlock`,
not `Tabs`); a per-slot `label` names it.

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

## Visual surfaces (UI work)

For plans about **screens and flows**, author the UI directly instead of
describing it. Wireframe/design artboards render a self-contained HTML fragment
inside a surface-locked frame; the canvas lays several artboards out in space.
The author writes plain semantic product HTML — the renderer owns the frame,
theme, and (for wireframes) the `--wf-*` design tokens and `.wf-*` helper classes
(the [wireframe authoring contract](#wireframe-authoring-contract) below). The
`html` is sanitised before it is injected.

**Before authoring any wireframe, READ [`wireframe.md`](wireframe.md)** —
the composition quality bar (surface choice, full-width chrome, pinned bottom
bars, before/after comparability, modify-don't-redesign, keeping product screens
pure) that separates a wireframe worth annotating from a mechanically-valid grey
box. **Before authoring a canvas, READ [`canvas.md`](canvas.md)**
for the board-unit spacing numbers that stop artboards overlapping.

### `<Screen>` — a low-fidelity wireframe artboard

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

### `<Design>` — a design-fidelity artboard

The same surface/html/caption shape as `<Screen>`. The difference is theme-class
handling, not a sketch effect (both tiers render a clean frame — there is no
hand-drawn sketch overlay): `<Screen>` **strips** host/branded theme classes and
applies the neutral `--wf-*` grey-box look, while `<Design>` **preserves** branded
classes and inline styles and renders a clean neutral frame — reach for it when
the actual branded look matters. The `--wf-*` theming does not apply inside a
`<Design>`; the fragment brings its own styling. Fidelity is implied by the tag;
there is no `css`/`style` attribute (HTML only).

```mdx
<Design
  surface="browser"
  caption="Branded settings screen"
  html={'<div class="card"><h1>Settings</h1><button class="btn">Save</button></div>'}
/>
```

### `<DesignBoard>` — a spatial canvas of artboards

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
<DesignBoard title="Onboarding flow" width={2200} height={900}>
  <Section title="Auth" x={0} y={0} width={1800} height={840}>
    <Artboard
      id="signin"
      x={40}
      y={60}
      surface="mobile"
      html={'<div class="wf-card"><h1>Sign in</h1></div>'}
    />
    <Artboard
      id="home"
      x={1080}
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

### Wireframe authoring contract

Inside a `<Screen>` / `<Artboard>` the renderer auto-themes bare semantic
elements — `h1`–`h3`, `p`, `a`, `small`, `hr`, `strong`, `button`, `input`,
`select`, `textarea`, `label` all pick up the wireframe look with **no classes**.
On top of that, a few helper classes and colour tokens are available; do not rely
on any other framework classes — the renderer ships no CSS for them (so an
arbitrary class styles nothing), and the sanitiser actively strips Tailwind
colour/shadow utilities (`bg-*`, `text-*`, `shadow-*`, `bg-[…]`) so host styling
cannot leak in.

- **Helper classes:** `.wf-card` / `.wf-box` (bordered container), `.wf-pill` /
  `.wf-chip` (rounded tag; add `.accent` to fill with the accent colour),
  `.wf-btn` (button look on a non-`<button>`), `.wf-muted` (muted text),
  `.wf-icon` (a 1em icon slot). Mark a primary button with `class="primary"` or
  `data-primary`.
- **Icon markers render empty today.** `.wf-icon` / `[data-icon]` size a 1em
  slot but the renderer's SVG icon replacement is deferred, so the slot renders
  blank — for a visible glyph use a short text label or an inline `<svg>`, not
  `<i data-icon="mail">`.
- **Colour tokens (CSS vars, light/dark aware):** `--wf-ink` (text),
  `--wf-muted`, `--wf-line` (borders), `--wf-paper` (surface), `--wf-card`,
  `--wf-accent` / `--wf-accent-fg` / `--wf-accent-soft`, `--wf-warn`, `--wf-ok`,
  and `--wf-radius`. Reference them via `var(--wf-...)` in an inline `style`.
- **Surface presets** (max-width × min-height floor): `mobile` 300×360,
  `popover` 360×120, `panel` 420×200, `desktop` 840×200, `browser` 900×200. The
  frame shrinks responsively on narrow viewports.

`<Design>` fragments instead keep their own branded classes / inline styles —
the `--wf-*` theming does not apply there.

## Iframe surfaces: `<Prototype>` and `<HtmlBlock>`

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
- **Decision / recap documents** — the review blocks (`<Card>`, `<FieldDiff>`,
  `<Details>`, `<ReviewChoice>`) plus document blocks.
- **UI layout / structure** — `<Screen>` (single screen) or `<DesignBoard>` with
  `<Artboard>`s + `<Connector>`s (a multi-screen flow). Grey-box wireframe
  fidelity; the point is layout and flow, not polish.
- **Branded / high-fidelity visuals** — `<Design>`, when the actual look matters.
- **An interaction the reviewer must operate** — `<Prototype>`. Reserve it for
  flows where clicking through beats a static picture; a static layout is a
  `<Screen>`, not a prototype.

Do not reach for a prototype or design artboard when a wireframe or a diagram
says the same thing, and never author a visual surface for a plan that has no UI.
