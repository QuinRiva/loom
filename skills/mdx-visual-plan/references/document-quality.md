# Document quality bar

The `SKILL.md` "Discipline" and "Shape of a good plan" sections are the summary;
this is the depth. Read it before authoring the prose body of a plan.

## A serious technical plan, not marketing

Write it the way a strong implementation plan reads: **outcome-first,
prose-first, self-contained, specific.** State the objective and what "done"
means, the scope and non-goals, the approach with the key decisions and their
rationale, ordered steps that name real files/symbols/actions/data shapes, the
risks, and a closing verification step. Replace vague prose with specifics —
never a step like "make it work". No hero headings, gradients, logos, nav bars,
slogans, value props, or marketing cards.

## Prose first; blocks earn their place

The default surface is Markdown (GFM) prose, headings, and lists. Reach for a
block only where structure genuinely beats a sentence, and place it **directly
next to the prose it supports** — not in a block gallery at the end:

- `<AnnotatedCode>` for the file map: when a load-bearing file is worth reading,
  carry the real syntax-highlighted code and anchor a few high-signal margin
  notes to the lines that actually change (the new action, the changed schema,
  the wiring point) — not one note per line, not an exhaustive list of every
  touched file. Drop to a plain `<Code>` only for a throwaway snippet with
  nothing to call out. When several files matter, group them in a vertical
  `<TabsBlock>`.
- `<DataModel>` for typed entities/fields/relations (not `<Table>`); `<Endpoint>`
  / `<OpenApi>` for API operations; `<FileTree>` for the change map; `<Diff>`
  when the change itself is the point.
- `<Diagram>` / `<Mermaid>` for genuine two-dimensional relationships (layers,
  before/after panels, data flow, state) — not a default left-to-right chain, and
  only when it clarifies something real. Our `<Diagram>` is a constrained
  `nodes`/`edges` + `x`/`y`% model; reach for `<Mermaid>` when auto-layout of a
  flow/sequence/ER graph is enough, and for a rich layered/matrix architecture
  picture prefer `<Mermaid>` or prose over forcing it into `<Diagram>`.
- `<Columns>` for side-by-side before/after or current/target where each side
  needs real nested blocks; label the columns.
- `<Table>`, `<Checklist>`, `<Callout>` for scannable structure.

A committed decision is settled **prose** or a `<Callout tone="decision">`
(optionally with a `<Columns>` weighing the options) — not a mid-document form
for a question you have already answered.

## Make abstract plans instantly legible (concrete first read)

If the idea is broad, strategic, or aimed at a reviewer who was not in the chat,
put **one concrete product snapshot near the top** before dense architecture,
mode tables, or roadmaps. For UI-capable work that snapshot is usually a single
`<Screen>` (or one top `<DesignBoard>` artboard) plus a short paragraph saying
what the user sees and what changes under the hood. Then put mechanics, data
flow, and implementation detail in later sections. A reviewer should get the idea
from the top snapshot before reading the technical plan.

## Preserve the user's level of abstraction

A motivating use case is not automatically the architecture. When the prompt
describes a broader framework, product mode, or reusable primitive, separate the
reusable core from specific apps/providers/examples. Use the concrete example to
make the plan understandable, then make clear which parts are core, which are
app-specific adapters, and which are future examples.

## Visuals and prose never duplicate each other

For UI work, the UI story lives in the visual surface (`<Screen>`/`<DesignBoard>`,
plus `<Prototype>` when the flow must be operable); the prose carries the depth
the visuals can't show — file/symbol maps, API and data contracts, code, phases,
risks, validation. Repeat a wireframe in the body only for a genuinely new detail
view or comparison. For a non-visual plan, skip visual surfaces entirely and
write a clean rich document.

## One open-questions block, at the bottom

Surface answerable unresolved decisions in a single final `<QuestionForm>` — that
is the **only** place that enumerates open questions. Never add a second
questions list or a parallel "decisions" wall earlier in the document (a one-line
pointer in the overview is fine). Use `single`/`multi` for clear choices,
`freeform` for constraints, and mark the option you would pick
`recommended: true`. A write-in field always renders, so never add an "Other"
option yourself. A complex plan with no open questions is fine only when every
meaningful decision has been explicitly made.

## Verification exercises the real workflow

When the plan changes UI, files, providers, or multi-step flows, include at least
one end-to-end smoke that matches the user journey — a real repo/folder, real
fixture, browser interaction, save/sync action, and an on-disk assertion — and
name the command or manual path when known. Not just "typecheck passes".

## `<HtmlBlock>` / `<Prototype>` are bounded escape hatches

Prefer native blocks for normal plans. `<HtmlBlock>` (static, no JS) and
`<Prototype>` (interactive) are for a snippet the other blocks don't cover — never
the primary home for a UI mockup that belongs in a `<Screen>`/`<DesignBoard>`, and
never a "proof that custom HTML works" density demo. Author their HTML against the
sandbox theme tokens so it reads in dark mode too.

## Before handoff, open the plan and check it

Fix overlap, excessive whitespace, clipped fragments, misleading inactive
controls, poor contrast, and unreadable diagrams before asking for approval.
Check the visual surfaces in dark mode especially: a white mockup panel or
low-contrast muted text is a defect — rewrite the HTML with `--wf-*` tokens and
semantic helper classes before surfacing the plan.
