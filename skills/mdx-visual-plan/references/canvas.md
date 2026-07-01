# Canvas & artboard placement

Read this before authoring or editing a `<DesignBoard>`. The canvas lays several
artboards out in a shared coordinate space to show a **flow**. Its single most
common failure is **overlapping frames** — the spacing numbers below are for our
renderer specifically, so read them before you place anything with explicit
`x`/`y`.

## The coordinate rule

`<Artboard surface>` locks each frame's footprint — never set an artboard's width
or height, and never use coordinates inside the wireframe `html`. Board-level
`x`/`y` on `<Artboard>`/`<Section>` is allowed and is how you build clear lanes.
Let one-row boards fall out of simple increasing `x` values.

## Board-unit spacing defaults (our renderer)

The board coordinate system maps **board units → pixels at `0.5` (≈ 2 board units
per pixel)**: a frame placed at `x={760}` renders `380px` from the board's left.

The catch that makes overlap so easy: **an artboard renders at a fixed pixel
footprint that does NOT scale with the board.** Only the _position_ (`x`/`y`)
scales. So a frame consumes **≈ 2× its pixel width in board units**:

| surface   | pixel width | width in board units |
| --------- | ----------- | -------------------- |
| `browser` | 900         | ≈ 1800               |
| `desktop` | 840         | ≈ 1680               |
| `panel`   | 420         | ≈ 840                |
| `popover` | 360         | ≈ 720                |
| `mobile`  | 300         | ≈ 600                |

So the x-gap between two frames' `x` origins must clear the **left** frame's
board-unit width plus a gutter. Minimum x-gaps between neighbouring frames:

- between two `browser` frames: **≥ 2200** (1800 frame + ~400 gutter)
- between two `desktop` frames: **≥ 2100**
- between two compact frames (`mobile`/`popover`/`panel`): **≥ 1000**
- when a broad frame sits beside a compact one, gap for the **broad** one.
- **row y-gap between any two rows: ≥ 1400** for short frames; a content-filled
  browser/desktop frame runs 400–600 px tall (≈ 800–1200 board units), so add the
  frame's own height (pixel height × 2) on top for tall rows.

When in doubt use larger values — the board auto-grows and auto-fits, so extra
space costs nothing while overlap is a defect. (These numbers are ours: our
frames render at a fixed footprint, so they are roughly double a hosted canvas
that zooms its frames with the board.)

## Lay mixed canvases in lanes

When a board mixes broad `browser`/`desktop` frames with compact `mobile`/
`popover`/`panel` surfaces, do not put everything in one horizontal strip. Use
`x`/`y` to reserve lanes with generous empty space: the main flow on one row,
compact surfaces in their own column or row, loading/error states in a lower row.
Group a lane with a `<Section title x y width height>` frame when it helps a
reviewer read the board.

## Connector discipline

`<Connector from to label?>` draws a dashed arrow between two artboard ids,
connecting their nearest horizontal edges, with the label at the line's
**midpoint**. So:

- Connect only **neighbouring** steps in a real sequence; never draw a long
  connector that skips across unrelated frames.
- Keep connected frames far enough apart (per the x-gaps above) that the midpoint
  label lands in **open space**, not on top of either frame.
- Never mint fake `Step 1 → Step 2` lines between independent states. If two
  frames are alternative states rather than a sequence, place them as neighbours
  and explain the relationship with an `<Annotation>`, not a connector.

## Annotations are designer notes beside the frame

`<Annotation targetId placement?>` parks a short gutter note beside the artboard
it explains (`placement` `left|right|top|bottom`, default `right`); the body is
the prose between the tags. Prefer `targetId` + `placement` over free-floating
`x`/`y` so the renderer positions the note against the live frame rect. Keep each
note short — a heading line and a sentence or two. Use free `x`/`y` only for a
note that belongs in open board space with no owning frame. Do not stack
overlapping notes on one frame.

## Never emit a titled artboard with no interior content

Every `<Artboard>` must carry real `html`. A label-only frame is a defect — if
all you have is a title, write it as a `<Section title>` frame or an
`<Annotation>`, not an empty artboard.

## Storyboards are canvas artifacts, not document diagrams

When the output is a product flow, onboarding journey, or screen-by-screen
storyboard, author it as multiple `<Artboard>`s with real screen content and
neighbouring `<Connector>`s. Keep document-body `<Diagram>`/`<Mermaid>` blocks
for architecture and mechanics that are not themselves user-visible screens. A
storyboard made from a single inline diagram is the wrong surface.

For an abstract product concept, use the canvas for the first "I get it" moment:
one real app state near the top showing how the concept appears to a user,
followed by separate annotations or diagrams for the mechanics. Do not make the
first artboard a hybrid of app UI and architecture notes; the app screen should be
inspectable as product UI on its own.

## Before handoff

Open the board at default zoom and move any frame whose label, connector, or
annotation crosses another frame. Overlap is the defect this reference exists to
prevent.
