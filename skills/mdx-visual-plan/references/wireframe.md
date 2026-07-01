# Wireframe composition quality bar

Read this in full **before** authoring any `<Screen>`, `<Design>`, or
`<Artboard>` HTML. A mechanically valid wireframe is not the bar — a wireframe
that reads like the real product is. This is the craft that makes an MDX plan
worth annotating instead of a wall of prose.

A wireframe is an **HTML mockup**. The renderer owns the frame, the light/dark
theme, and the `--wf-*` tokens; **you write the content**. You set two things: a
`surface` (the footprint) and an `html` fragment (a self-contained, semantic
screen). You never write `<html>`/`<body>`/`<style>`/`<script>` tags, and — for
a standalone `<Screen>`/`<Design>` — you never set width, height, or
coordinates. Write real product HTML with real labels; the renderer styles it.

## Pick the surface that matches what the user actually sees

`surface` locks the frame's footprint (max-width × min-height floor):

| surface   | footprint | use for                                                 |
| --------- | --------- | ------------------------------------------------------- |
| `browser` | 900 × 200 | a web page that needs a browser chrome frame            |
| `desktop` | 840 × 200 | a full desktop app page or app shell                    |
| `mobile`  | 300 × 360 | a phone screen — only when the work is genuinely mobile |
| `popover` | 360 × 120 | a small floating menu, dropdown, or inline popover      |
| `panel`   | 420 × 200 | a side panel, inspector, or sidebar widget              |

**Never default to a desktop + mobile pair.** Emit `mobile` only when the work
is genuinely a phone screen, and emit both variants only when responsive
behaviour actually changes the layout. A sidebar popover is a `popover`, not a
desktop page plus a phone frame. For a component, show one broader app-context
frame only when placement affects understanding, then the focused component.

## Treat the frame border as part of the design

Wrap the fragment in a root container that creates its own breathing room:
`box-sizing:border-box; height:100%;` at least **14–16 px of padding**, and
`gap` between child rows on the root itself. Do not rely on padding on a nested
section as the first inset — the outermost element must create the inset, or the
first row sits flush against the frame border. Keep text away from borders:
every container, field, button, and menu item needs enough padding and
line-height to read cleanly.

## Fill the frame

Each artboard is a fixed-size surface — compose enough realistic HTML to fill it
top to bottom with even vertical rhythm; never leave a large empty band. On a
desktop/app-shell sidebar, let the nav stack `flex:1` and put any persistent
bottom action/status after it so the rail reads complete. On mobile especially,
flow real rows down the whole screen (status bar, header, then list/detail)
rather than a header floating above a gap.

## Persistent chrome bars span the full frame width

Top bars, app headers, toolbars, and bottom tab/nav bars are full-width chrome,
not centred content. Lay each one out as a single flex row that fills the frame
(`display:flex; align-items:center; width:100%`) and push trailing actions to
the right edge with a flex spacer (`<div style="flex:1"></div>`) between the
leading and trailing groups. Never centre a bar inside a narrow block, and never
let it collapse to the width of its contents.

## Pin bottom bars to the bottom of the frame

For mobile tab bars, footers, and any persistent bottom action row: make the
frame a flex column at `height:100%`
(`display:flex; flex-direction:column; height:100%`), give the scrolling body
`flex:1` so it absorbs the slack, and place the bar as the **last** child (or set
`margin-top:auto` on it). The bar then sits flush at the bottom instead of
floating under the content with an empty band beneath it.

## Don't wrap intentionally single-line rows

For toolbars, tab rails, breadcrumbs, chip/filter rows, branch and file names,
and code filenames — any deliberately single-line row — put `white-space:nowrap`
on the row (and `overflow:hidden; text-overflow:ellipsis` on individual labels
that can grow) so the wireframe shows the real layout behaviour instead of ugly
stacked or vertical text.

## Modify, don't redesign

When the task changes an existing screen, reproduce the current screen's real
layout and footprint **first**, then change only the delta and call it out with a
single annotation. Do not restack the page into a new layout. For a net-new
surface, compose from the real app shell — match the product's sidebar density,
toolbar actions, and chrome unless the plan intentionally changes them.

## Keep product screens pure

A product wireframe shows the app state a user would actually see. Do **not**
embed file contracts, architecture arrows, repo pills, mode explanations, or
implementation callouts inside the screen to explain the plan. Put those in a
`<DesignBoard>` `<Annotation>`, a `<Diagram>`, or the document prose. Secondary
UI (history, sync, export, agent controls) appears where the real product puts
it — an overflow popover, sheet, or panel — not a generic permanent right
inspector unless that inspector is the actual design.

## Zoom in on sub-surfaces, don't redraw the page

For a small sub-surface (a popover, menu, dialog, toast), show the full screen
once, then add a separate `<Screen>`/`<Artboard>` whose `html` contains **only**
that sub-surface. Pick the matching `surface` (e.g. `popover`); never widen a
popover to page width or scale a duplicate of the whole page.

## Before / after must be comparable

When showing a state change, preserve the unchanged controls in **both** states
so the reviewer sees exactly what moved or appeared; do not show an added control
as a generic box floating elsewhere. Place the new affordance where the
implementation puts it (e.g. a new header action in the top-right header slot,
aligned with the title). Use the same frame size, scale, padding, radius, and
density on both sides unless the change itself alters them.

**Name the states with the column header, never inside the frame.** Put the two
states in a `<Columns>` block and set each `<Column label>` to `Before` / `After`
— the renderer draws that label as a heading above each frame. Do **NOT** bake a
`Before`/`After` pill, title, or heading into the wireframe `html`: a label
placed inside reads as part of the product UI, lands in a random corner, and
clutters the comparison. On a canvas, place the two state artboards as neighbours
and name them with `<Artboard caption>` — never encode the state name in the html.

## Use the tokens, never hex; never host/Tailwind classes

For any custom colour — border, background, text — reference a `--wf-*` token via
`var(--wf-…)` in an inline `style`; the renderer flips these on light/dark, so
reading them is what keeps a mockup correct in both themes. Never hard-code a hex
colour and never set `font-family`.

Tokens: `--wf-ink` (text), `--wf-muted` (secondary text), `--wf-line`
(borders/dividers), `--wf-paper` (page background), `--wf-card` (container
surface), `--wf-accent` / `--wf-accent-fg` / `--wf-accent-soft` (brand action),
`--wf-warn`, `--wf-ok`, and `--wf-radius`.

Never use host/Tailwind theme classes (`bg-white`, `text-zinc-950`,
`border-zinc-200`, `shadow-xl`, `bg-[#fff]`, …) in wireframe `html`: the
sanitiser actively strips Tailwind colour/shadow utilities so they can't leak
the host app's CSS into the mockup, and the renderer ships no CSS for any other
class — so an arbitrary class simply styles nothing. Use bare semantic elements,
the `.wf-*` helper classes, and `--wf-*` tokens. Layout via inline flex/grid is
safer and easier to review than layout classes.

## Use literal CSS lengths for spacing

The `--wf-*` tokens are colours and renderer-owned styling, **not** layout
spacing. Do not invent spacing tokens like `var(--wf-space-4)` or use Tailwind
spacing classes; there is no CSS behind them and padding collapses. Use explicit
lengths: `padding:16px`, `gap:12px`, `margin-top:18px`, `minmax(0,1fr)`.

## No decorative shadows

Do not put `box-shadow`, `filter:drop-shadow(...)`, or Tailwind `shadow-*` on a
frame, root container, `.wf-card`/`.wf-box`, or artboard. Mockups read as flat,
bordered surfaces; separate them with spacing, borders, labels, and annotations.
Only show a shadow when the real product UI has that shadow and it is essential
to the change under review.

## Lay children out so they never collide

Use flex/grid with `gap`, `min-width:0`, and sensible overflow. Avoid negative
margins, absolute positioning, or fixed child widths that can collide across
light/dark or different zoom levels.

## What our renderer does NOT do

These BuilderIO wireframe features are not implemented here — do not author for
them:

- **No hand-drawn sketch overlay.** `<Screen>` renders a **clean** frame (rough.js
  is deferred). There is no `data-rough`; it does nothing. (The wireframe-vs-design
  difference is theme-class handling, not a sketch effect — see below.)
- **No icon replacement.** `data-icon` / `.wf-icon` render as an **empty, 1 em
  sized slot** — the SVG replacement is deferred. For a visible glyph use a short
  text label or an inline `<svg>`; do not write `<i data-icon="mail">` expecting
  an icon.
- **No skeleton state.** There is no `skeleton` attribute; build a loading state
  as ordinary neutral geometry (`<div>`s with `background:var(--wf-line)` and
  explicit sizes) inside a normal `<Screen>`.

## `<Screen>` vs `<Design>`

Both use the same `surface` / `html` / `caption` shape and the same
sanitise-then-inject renderer. The only difference is theme-class handling:

- `<Screen>` (wireframe tier) **strips** host/Tailwind theme classes and applies
  the neutral `--wf-*` grey-box look. Author with bare elements + `.wf-*` + tokens.
- `<Design>` (design tier) **preserves** branded theme classes and inline styles
  and renders through a neutral surface — reach for it when the actual branded
  look matters. The `--wf-*` theming does not apply inside a `<Design>`; the
  fragment brings its own styling. There is no `css`/`style` attribute — HTML only.

## Helper classes

Inside a `<Screen>`/`<Artboard>` the renderer auto-themes bare `h1`–`h3`, `p`,
`a`, `small`, `hr`, `strong`, `button`, `input`, `select`, `textarea`, `label` —
no classes needed. On top of that:

- `.wf-card` / `.wf-box` — a bordered, padded container.
- `.wf-pill` / `.wf-chip` — a rounded tag/filter; add `.accent` for the
  accent-filled variant.
- `.wf-btn` — the button look on a non-`<button>` element.
- `.wf-muted` — secondary/muted text (or use `<small>`).
- `button.primary` / `[data-primary]` — the accent-filled primary button.
- `.wf-icon` / `[data-icon]` — a 1 em slot (renders empty today; see above).

## Worked example — a contacts list (`surface="browser"`)

A small, real screen composed from bare elements, helper classes, and tokens;
layout in inline flex; no fonts, no hex, no shadows:

```mdx
<Screen
  surface="browser"
  caption="Contacts — list view"
  html={
    '<div style="display:flex;flex-direction:column;gap:12px;padding:16px;height:100%"><div style="display:flex;align-items:center;justify-content:space-between;white-space:nowrap"><h1>Contacts</h1><button class="primary">New contact</button></div><div style="display:flex;gap:6px;white-space:nowrap"><span class="wf-pill accent">All 128</span><span class="wf-pill">Favourites</span><span class="wf-pill">Archived</span></div><div class="wf-card" style="display:flex;flex-direction:column;gap:0;padding:0"><div style="display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1.4px solid var(--wf-line)"><div style="width:32px;height:32px;border-radius:999px;background:var(--wf-accent-soft)"></div><div style="flex:1;min-width:0"><strong>Jane Cooper</strong><br /><small>jane@acme.co</small></div><span class="wf-pill">Lead</span></div><div style="display:flex;align-items:center;gap:10px;padding:10px 12px"><div style="width:32px;height:32px;border-radius:999px;background:var(--wf-accent-soft)"></div><div style="flex:1;min-width:0"><strong>Marcus Lee</strong><br /><small>marcus@globex.io</small></div><span class="wf-pill">Customer</span></div></div></div>'
  }
/>
```

The renderer applies the browser footprint, the light/dark theme, and the
`--wf-*` colours; the author supplied only real layout and real content.
