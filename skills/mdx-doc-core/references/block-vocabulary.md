# Block vocabulary

The shared block vocabulary for every MDX-document genre (plans,
recaps / decision batches, and explainers). This file teaches the **common shape** of each
block by example and says what each prop _means_ (that `<Step at>` is the
rail label and `aside` the right-hand column lives here, beside the example);
[`block-schema.md`](block-schema.md) is the generated authority for exact
prop names, types and enum values, and is where a prop is checked before it
is written — a guessed prop fails validation and the block renders as an
error card.

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
so this is a pointer rather than a re-statement. One case it does not spell
out: an apostrophe inside a double-quoted attribute needs nothing
(`summary="why it isn't"`), and the `{"…"}` form is for a value that holds a
newline or a double quote. A handful of unstyled inline
HTML tags (`span`, `mark`, `kbd`, `sub`, `sup`, `small`, `br`) pass through with
their attributes stripped; any other lowercase tag is rejected and renders as an
error card — pills come from `<Badge>`, grids from `<Columns>`/`<Card>`, a
bespoke figure from `<HtmlBlock>`.

**Frontmatter.** Besides the `reader:` brief, `kicker:` is the small line
rendered above the title — genre, subject, date, the PR:
`kicker: "Incident recap · #280 · 26 Sep 2026"`. It is where the document
says what it is, so the title can say what it found. Quote the value: an
unquoted ` #` starts a YAML comment and silently cuts the line short.

## Block groups

The blocks fall into five groups: **document blocks** (prose-embedded structure
— the default), **review blocks** (field diffs, cards, drill-downs, per-item
decisions — for decision/recap documents), **containers** (side-by-side, tabbed or
stepped layout), **visual surfaces** (wireframe / design / canvas, for UI work), and
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
Entries render in the order written — there is no sorting — so list them in the
order the reader should read them (e.g. a pipeline in processing order). A path
ending in `/` is a folder: its `note` and `change` sit on the folder row, and
later entries under that path nest inside it.

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

`title` names the box (`What it means now`, `The causal proof`, `The one thing
to act on`) in place of the tone's generic label, so a bold run-in at the start
of the body becomes the title. `focus` is for the box the reader must not pass
— the verdict, its consequence, or the thing to act on — rendered as a
bordered panel at reading size with no icon. Keep it to one or two per
document: emphasis on every box is emphasis on none. A paragraph of inline
`<Badge>`s inside it reads as a status row.

```mdx
<Callout tone="decision" title="What it means now" focus>
  Pull 9 removed the merge step, so the missing edge no longer exists. **One thing is left to act on** — the stale-flag fix was lost.

  <Badge tone="success">deadlock notice · in place</Badge> <Badge tone="risk">stale-flag clear · lost</Badge>
</Callout>
```

```mdx
<Callout tone="risk">
  The MDX runtime uses `evaluate()`, which needs `unsafe-eval`; the remark guard bounds the surface.
</Callout>
```

### `<Badge>` — an inline pill

A pill for a state, class or verdict **inside a sentence**, list item, `<Card>`
or `<Callout>` body: the text between the tags is the label, `tone` is the
six-slot palette (`neutral | info | success | warning | risk | accent`, default
`neutral`). The text names the meaning; the colour makes it scannable. Write the
label in natural case — it displays uppercase.

```mdx
The stale-flag clear was <Badge tone="risk">lost</Badge> in the re-platform; the deadlock notice is <Badge tone="success">in place</Badge>.
```

For a pill in a `<Card>` header use its `badge`/`badges` props, and in a
`<Table>` cell the cell's `badge` field — a string attribute is never parsed
for tags, so `"<Badge>lost</Badge>"` inside a prop renders as literal text.

### `<Stats>` — the number strip

The numbers the answer rests on, as large tiles under the lede. Each item is
`{ value, label, detail?, tone?, badge? }`: `value` is the headline figure
(`43 min`, `3 of 4`), `label` names it, `detail` is the one line that makes it
mean something (inline markdown), `tone` colours the figure by what it means
(the six-slot palette; `neutral` stays the text colour), and `badge` adds a
pill after the detail. Three to six tiles read best; eight is the limit.

```mdx
<Stats
  items={[
    {
      value: "43 min",
      label: "Silent deadlock",
      tone: "risk",
      detail: "Child done 12:36; nothing moved until 13:16",
    },
    {
      value: "4 fixes",
      label: "Shipped next day",
      tone: "success",
      detail: "Today: 1 in place · 2 moot · 1 lost",
      badge: { label: "1 lost", tone: "risk" },
    },
  ]}
/>
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

### `<Table>` — a grid of cells, pills and toned rows

Header `columns` + `rows`. Cells are inline markdown — bold, code, links work. A
cell can be an object `{ "md", "badge", "tone" }` to carry a pill (a `BadgeSpec`,
rendered before the text; a bare-string badge takes the cell's tone, else
neutral) or a tint, and a row can be `{ "tone", "cells": […] }` to tint the
whole row — so a status column is a column of pills and the one row that
matters is found before the table is read. `align` sets per-column alignment
(`"right"` for numbers). Optional `density` is `compact | normal | relaxed`;
`filterable` adds a filter box and header-click sort over the cells' text
(badge label + markdown). A GFM table in prose is fine for a quick grid; use the
block for tones, badges, density or a filter, and `<DataModel>` for typed
entities. A string attribute is never parsed for tags, so `<Badge>` inside a
cell renders as literal text — use the cell's `badge` field.

```mdx
<Table
  density="compact"
  columns={["Fix", "Today", "Why"]}
  rows={[
    [
      "Draw the missing edge",
      { badge: "moot", md: "deliberately deleted" },
      "The code is in git history at `468176f710`",
    ],
    {
      tone: "risk",
      cells: [
        "Clear the stale flag",
        { badge: { label: "lost", tone: "risk" }, md: "no decision recorded" },
        "A re-pointed dependent carries `needs_guidance`",
      ],
    },
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
optional `caption`. Drawn by pele, the renderer the chat uses: labels are plain
SVG text, links and images are off, and the output is sanitised.
Use `<Diagram>` for a hand-placed spatial
layout; use `<Mermaid>` when Mermaid's auto-layout of a flow/sequence/ER graph is
enough.

**Node tones, legend.** Colour a node by meaning with Mermaid's own class
syntax and the shared six-tone palette — `W["writer"]:::tone-warning`, or
`class W,C tone-neutral` on its own line — with no `classDef` hexes to invent; the
colours follow the app theme. Tone the two or three nodes the reader should look
at first and leave the rest untoned. `legend` (up to six `{ tone, label }`)
decodes the colours once, under the figure.

**Two-line nodes.** Write a node as `name<br/>status` —
`W["writer<br/>done · unmerged"]:::tone-warning`. The first line renders bold, the
second as a small mono status line in the node's tone colour, so state reads at a
glance without a sentence in the box. Keep each line short: Mermaid wraps a line
past about 28 characters at the rendered size, and a wrapped name spills into
the status style. A label with no `<br/>` stays one style however it wraps.

**Toned edges.** Name the tone as the edge's colour — `linkStyle 0
stroke:tone-risk,color:tone-risk,stroke-width:2.5px` (`n` counts edges in source
order from 0). The path, its arrowhead and (via `color:`) its label take the
palette colour and follow the theme. Edge labels render as small mono text on the
line; keep them to a few words. Tone one edge — the one the figure is about. A
`tone-*` class or edge colour outside the palette lints as a warning — it styles
nothing.

**Layout: order the source so the shape you mean is the shape you get.** Mermaid
(dagre) ranks nodes along the direction and breaks a cycle by reversing the edge
that closes it _in source order_. To show a loop, use `flowchart TB`, declare the
loop's nodes first and its edges in loop order, starting at the node the reader
should start from; the closing edge then routes back up the side and the loop
reads round. Hang everything else off it afterwards. `flowchart LR` suits a
chain; a cycle in `LR` flattens into one row with long crossing curves. If the
figure needs nodes at exact positions (two rows, a grid), use `<Diagram>`.

```mdx
<Mermaid
  caption="The review loop never closes"
  legend={[{ tone: "risk", label: "the edge nobody wrote" }]}
  source={
    'flowchart TB\n  C["coder<br/>ready · blocked"]\n  R["reviewer<br/>waiting"]:::tone-warning\n  C -.->|implied| R\n  R --> C\n  linkStyle 0 stroke:tone-risk,color:tone-risk\n'
  }
/>
```

### `<Image>` — a screenshot or exported image file

Shows an image **file that lives beside the document on disk** — a screenshot of
a real screen, an exported chart, a photo of a whiteboard. `src` is the path
**relative to the document** (`shots/before.png` for
`recaps/<slug>/shots/before.png`); an absolute host path or an `https:` URL
also works. `alt`, `caption`, and `width` (a px cap; the image keeps its aspect
ratio) are optional.

```mdx
<Image
  src="shots/usage-panel-before.png"
  alt="The usage panel with the per-model table collapsed"
  caption="Figure 1 — today's usage panel"
  width={900}
/>
```

Write the image next to the `.mdx` and reference it by relative path. Practical
notes:

- **Markdown image syntax works too**: `![alt](shots/before.png)` resolves the
  same way (same signing, same lint checks). Use `<Image>` when you want a
  caption or a width cap; use the markdown form for a bare inline picture.
- **PNG for UI screenshots, JPEG for photos**, roughly **1200–1600 px wide**:
  the reading column is ~900 px, so anything wider only pays for retina.
- A missing file is a **lint error** (`<Image> file not found: …`) — the linter
  resolves every `src` against the document's directory and checks the disk.
- Do **not** base64 a screenshot into an `html` attribute or a `data:` `src`:
  `<Screen>`/`<Design>`/`<Artboard>` cap `html` at **200,000 characters**,
  `<HtmlBlock>`/`<Prototype>` at **500,000**, and `src` at 2,000 — a real
  screenshot does not fit, and `<Image>` pointing at a file is the supported path.

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
The block's own props are `questions` and `submitLabel`: a block-level
`title` is not rendered (the lint warns of an unknown prop), so the section
name goes in a heading above the block; a question's kind is `mode`, not `type` — a question written
with `type` fails validation and the form renders as an error card.

Every question is answered by someone who only skimmed the body: put the one
line of context it depends on in `subtitle`, and never leave a label the
document coined (slice N, a codename, a section title) in a `title`, `subtitle`,
`label` or `detail` unglossed — see `document-quality.md`. `refs`
(`[{ label, anchor }]`, at most four) chips open the sections a question depends
on, read in place: `label` is the heading as written, `anchor` its slug
(`## Delivery order` → `delivery-order`). A ref is a way to go deeper, never a
substitute for a question that reads on its own; the ref below resolves against
a `## MDX compile pipeline` heading in the body.

```mdx
<QuestionForm
  questions={[
    {
      id: "csp",
      title: "Accept unsafe-eval for the runtime MDX renderer?",
      refs: [{ label: "MDX compile pipeline", anchor: "mdx-compile-pipeline" }],
      subtitle:
        "The renderer compiles MDX in the browser, which needs eval(); the app ships no Content-Security-Policy today.",
      mode: "single",
      options: [
        {
          id: "a",
          label: "Compile and evaluate the MDX in the browser",
          recommended: true,
          detail: "No CSP today; the guard bounds the eval surface.",
        },
        {
          id: "b",
          label: "Compile on the server, load the result as a blob: module",
          detail: "Avoids eval entirely; only worth it if a strict CSP becomes a requirement.",
        },
      ],
    },
  ]}
/>
```

`<VisualQuestions>` is a **deprecated alias** with the same shape — prefer
`<QuestionForm>`; only use `<VisualQuestions>` when porting a plan that already
has one.

### `<Glossary>` — the document's coined terms

A list of `<Term>` entries, rendered where it is placed, conventionally last.
It must sit at the top level: nested in a container it renders but links
nothing, and inside `<Details>` its terms are not registered until the
disclosure is opened. Each `name` is the term as it appears in prose; the body is
a sentence or two of inline markdown. Every occurrence of a name in body prose
(any case, plural too) becomes a dotted link that shows its definition on
hover or tap; headings, tables, code and links are left plain.

```mdx
<Glossary>
  <Term name="reading unit">The span of text the recursion tagged as one thing.</Term>
  <Term name="node">One entry in the document tree; every node has one reading unit.</Term>
</Glossary>
```

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
meaning rides the badge/heading text. The heading is inline markdown, so
`` `code` `` and _emphasis_ in it render.

`eyebrow` is the small line above the heading — `RULE 1`, `OPTION B`, `STAGE 3`
— for a numbered or classified series of cards. `badges` is a list of pills with
their own tones when the single `badge` is not enough:
`badges={[{ "label": "deterministic", "tone": "success" }, "x3 calls"]}` (a bare
string takes the card's tone).

Lengths the schema enforces: `eyebrow` up to 40 characters, `badge` up to 60,
`heading` up to 300, each `meta` chip up to 120 (eight chips at most). A
longer value fails validation and the whole card renders as an error card, so
a question-length heading fits and a sentence-length badge or eyebrow does
not — a long subject goes in the heading or a meta chip, the eyebrow keeps the
label and a short subject (`DECISION B · Leidos`).

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
renderer/test context it renders read-only. State the "an item left undecided takes its
recommendation" convention once in the document — one line on the first screen,
after the verdict — because the widget reports only explicit choices.

```mdx
<ReviewChoice itemId="a1" label="A-1" placeholder="Why, if rejecting…" />
```

## Containers: `<Columns>`, `<TabsBlock>` and `<Steps>`

Containers lay out **other blocks** side by side, in tabs or on a rail. Each
container is one annotatable block; its nested blocks keep their own annotation
ids. The inner slot tags are `<Column>`, `<Tab>` and `<Step>` (the container tag
is `TabsBlock`, not `Tabs`); a per-slot `label` names a column or tab.

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

A `<Columns>` of `<Card>`s needs no `<Column>` wrappers: cards are columns, and
a `<Column label>` around a single headed card stacks a second heading over
its own. Use
`<Column label>` when a side needs a label or holds several blocks (and then use
it for every side). `columns={3}` caps the row at three across; it still
collapses on a narrow panel.

```mdx
<Columns columns={3}>
  <Card eyebrow="Rule 1" heading="A dependent waits for the merge, not just for `done`.">
    …
  </Card>
  <Card eyebrow="Rule 2" heading="A child under review merges exactly once.">
    …
  </Card>
  <Card eyebrow="Rule 3" heading="The cycle check only follows `blockedBy`.">
    …
  </Card>
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

`<Steps>` of `<Step at title tone dashed badge aside>` — moments or stages in
order on a vertical rail: a timeline when `at` is a time, a ladder when it is a
stage, numbered when every step omits it. `at` never wraps, so a range like
`12:36 → 13:16` stays one label. `title` is the bold first line; the body between
the tags is the lighter detail (prose, inline `<Badge>`, code, even nested
blocks). `tone` colours the marker and the `at` label (default: a blue ring;
`risk` and `warning` fill it), and `dashed` makes it a hollow dashed ring for a
moment where nothing happened. `badge` and `aside` (inline markdown) fill a
right-hand column for what someone saw or what it cost — a string badge takes
the step's tone. Put tone on the steps that went wrong and leave the rest
default, so the reader sees where to look before reading a word.

When a step is the moment someone receives something — a tool result, a
notice, a card — quote it in the step body as its own block labelled with the
recipient (a `>` quote opening **Coder receives:**, or `<Code language="text"
wrap>` when the exact characters matter) and keep the step's prose to the one
line of what happened: the reader of a worked example is learning to
recognise that message when it reaches them, and a quote set apart reads as
the artefact where an italic fragment inside a sentence reads as paraphrase.
A title that opens with the actor ("Reviewer submits…", "The control
plane…") lets the rail be read as who-did-what.

The rail is vertical. A horizontal strip of stages with a line of text each —
a pipeline's six steps across the page — is the shape neither this block nor
`<Mermaid>` holds well: a six-wide `LR` chain with two-line nodes shrinks its
text past reading in the column, so the default is this rail, or a names-only
`LR` chain with the descriptions as a list under it.

```mdx
<Steps>
  <Step at="12:21" title="All five children created." aside="A normal workstream.">
    The cycle check passed.
  </Step>
  <Step
    at="12:36"
    tone="risk"
    title="The writer submitted."
    badge="a lie"
    aside="“dependents released” — a fixed string."
  >
    Its branch was never merged.
  </Step>
  <Step at="12:36 → 13:16" tone="neutral" dashed title="Nothing." badge="silence">
    The merge step returned early on every pass.
  </Step>
</Steps>
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
`html` is the self-contained fragment (**capped at 200,000 characters** here and
in `<Design>`/`<Artboard>`, against 500,000 for `<HtmlBlock>`/`<Prototype>` — it
is for authored markup, never a base64 image; use `<Image>` for a real picture);
`caption` is optional. Author with the neutral `--wf-*` tokens / `.wf-*` classes,
not branded styling.

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

Both render author-supplied HTML inside a **sandboxed iframe**. You write a
self-contained document; **nothing remote loads** (the CSP blocks it), so inline
everything. `caption` and `height` (px) are optional. Both frames inherit the
app's theme: write CSS against its variables — `var(--foreground)`,
`var(--muted-foreground)`, `var(--border)`, `var(--card)`, the palette's
`var(--plan-tone-risk)` / `var(--plan-tone-risk-soft)` (and the other five tones),
`var(--font-mono)` — and the frame matches the document around it in light and
dark (the body already takes the app background, text colour and font).

`<Prototype>` — **interactive**: scripts + forms run, so inline `<script>` and
handlers work, in an opaque-origin frame that cannot touch the app. Use it when
the reviewer needs to _operate_ a flow. A reviewer can comment on it **only as a
whole block** — nothing inside the frame is selectable for a comment.

```mdx
<Prototype
  caption="Filter interaction"
  height={360}
  html={"<button onclick=\"document.body.append('clicked')\">Filter</button>"}
/>
```

`<HtmlBlock>` — **static**: no JS runs at all, and the frame loads nothing from
the network or the app. Styles must be inline (`<style>` sheets and `style=""`
both work), images and fonts must be `data:` URLs, and links are inert. A
reviewer can comment on the whole block **or select text inside it to pin a
comment to that spot**, so a grid of option cards in one `<HtmlBlock>` can be
reviewed card by card — give each card some distinctive text to select. Use it
for a static snippet the other blocks don't cover, or a mockup that needs a real
stylesheet (which `<Design>` strips). The frame **sizes itself to its content**
and follows a panel-width change; give `height` only when it should scroll.
(`<Prototype>` cannot be measured — its origin is opaque — so it keeps an
explicit `height`, 420 by default.)

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
- **Evidence of something that already exists** — `<Image>`, pointing at a
  screenshot file beside the document. A wireframe is for UI you are _proposing_;
  a screenshot is for UI that is _already there_.
- **An interaction the reviewer must operate** — `<Prototype>`. Reserve it for
  flows where clicking through beats a static picture; a static layout is a
  `<Screen>`, not a prototype.

Do not reach for a prototype or design artboard when a wireframe or a diagram
says the same thing, and never author a visual surface for a plan that has no UI.
