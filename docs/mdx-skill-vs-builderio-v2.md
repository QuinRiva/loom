# MDX visual-plan skill vs. BuilderIO — v2 (post-expansion re-review)

**Objective.** Re-run the [v1 comparison](./mdx-skill-vs-builderio.mdx) against
the **just-expanded** skill — `skills/mdx-visual-plan/SKILL.md` plus the four new
`references/{wireframe,canvas,document-quality,exemplar}.md` — and give a fresh
verdict on whether v1's gaps are closed, judged at BuilderIO's quality level.

Read-only review. Compared against BuilderIO's `visual-plan` skill
(`SKILL.md`, `README.md`, `references/*.md`) at
`/tmp/pi-github-repos/BuilderIO/skills@main/`. Canvas spacing numbers and the
sanitiser wording were verified against the actual renderer
(`apps/web/src/components/files/mdx-plan/blocks/{canvas,screen}.tsx`,
`sanitizeWireframeHtml.ts`, `canvas.test.ts`, `wireframe.test.ts`, `index.css`).

---

## Verdict

**The skill is now at parity with BuilderIO's authoring quality, modulo the
correct-by-design first-party differences.** The expansion closed the one HIGH
gap (v1 Gap 1) and all four secondary gaps. The composition quality bar — the
crux — is now taught in full: `wireframe.md` and `canvas.md` port essentially all
of BuilderIO's HTML-mockup craft, and `exemplar.md` adds a good/bad skeleton with
named anti-patterns that BuilderIO's own `exemplar.md` (62 lines) does not match
in depth.

The canvas spacing numbers are **renderer-correct, not mis-ported** (verified
below) — they are deliberately ~2× BuilderIO's because our `<Artboard>` renders
at a fixed pixel footprint while only its position scales.

**Two new issues the expansion introduced**, both in the _examples_ (not the
references' rules), both small and both a self-inflicted contradiction of the new
canvas spacing rule:

1. **[SHOULD-FIX]** The flagship `<DesignBoard>` example in `SKILL.md` places its
   two mobile artboards **400 board units apart — they overlap by ~100 px** in
   our renderer, violating the ≥1000 compact-frame gap that `canvas.md` (added in
   the same expansion) now mandates.
2. **[MINOR]** `exemplar.md`'s overlap anti-pattern quotes BuilderIO's stale
   `<1100` threshold as the illustrative overlap case, which reads as a safe
   boundary when our real no-overlap threshold is ≥1800 (≥2200 with gutter).

Neither is a correctness bug in the _guidance_; they are stale numbers in two
authored examples. Fix both and the skill has no known accuracy defects.

---

## Per-gap scorecard

| v1 gap                                                      | Severity | v2 status                              | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------------------- | -------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Wireframe/canvas composition quality (the crux)**      | HIGH     | **Closed** (with 1 should-fix example) | `wireframe.md` now teaches surface choice, full-width chrome, pinned bottom bars, fill-the-frame rhythm, before/after comparability via `<Column label>` (never baked-in pills), modify-don't-redesign, keep-product-screens-pure, zoom sub-surfaces, no shadows, tokens-not-hex, single-line `nowrap`, collision-safety, + a worked contacts example. `canvas.md` teaches lanes, connector discipline, annotation placement, no-empty-artboard, storyboards, before-handoff overlap check. Only miss: the `SKILL.md` `<DesignBoard>` example overlaps (issue 1). |
| **1a. Canvas board-unit spacing (most actionable sub-gap)** | HIGH     | **Closed + corrected**                 | `canvas.md` gives per-surface board-unit widths (browser ≈1800, desktop ≈1680, panel ≈840, popover ≈720, mobile ≈600) and x-gaps (browser ≥2200, desktop ≥2100, compact ≥1000, row y-gap ≥1400). **Verified renderer-correct** — see "Canvas numbers" below.                                                                                                                                                                                                                                                                                                      |
| **2. Worked exemplar**                                      | MED      | **Closed**                             | New `exemplar.md`: a good UI-plan skeleton, a good backend skeleton, and 8 named anti-patterns (hex-not-tokens, forced desktop+mobile, mockup-in-`<HtmlBlock>`, marketing headings, baked-in Before/After, overlapping artboards, polluted product screen, mid-doc questions wall, changelog-style plan). Deeper than BuilderIO's exemplar.md.                                                                                                                                                                                                                    |
| **3. Concrete first read**                                  | MED      | **Closed**                             | `SKILL.md` "Make the first read concrete" bullet; `document-quality.md` "Make abstract plans instantly legible (concrete first read)" section; `exemplar.md` UI skeleton step 1 leads with one `<Screen>` snapshot. Matches BuilderIO's rule.                                                                                                                                                                                                                                                                                                                     |
| **4. `<Diagram>` expressiveness note**                      | LOW      | **Closed**                             | `SKILL.md` `<Diagram>` section now states it is "a constrained nodes/edges model with no HTML/CSS diagram mode — for a rich layered, matrix, or swimlane picture reach for `<Mermaid>` … instead of forcing it here." `document-quality.md` repeats the steer.                                                                                                                                                                                                                                                                                                    |
| **5. Sanitiser wording accuracy**                           | LOW      | **Closed + verified**                  | `SKILL.md`/`wireframe.md` now say the sanitiser "strips Tailwind colour/shadow utilities (`bg-*`, `text-*`, `shadow-*`, `bg-[…]`)" and that the renderer "ships no CSS" for other classes — no longer overstated as a general allowlist. Confirmed against `sanitizeWireframeHtml.ts` (`TAILWIND_THEME_COLORS`/`TAILWIND_ARBITRARY_THEME_COLOR`/`TAILWIND_SHADOW`) and `wireframe.test.ts` (`wf-card bg-white text-zinc-950 shadow-xl` → `wf-card`).                                                                                                              |

---

## Canvas numbers — renderer-correctness check (fairness rule 2)

Confirmed **our larger numbers are correct for our renderer, not a mis-port**:

- `CANVAS_BOARD_SCALE = 0.5` (`canvas.tsx:40`), asserted by `canvas.test.ts`
  (`boardToPixel({x:760}) === 380`; board `data-board-scale="0.5"`).
- An `<Artboard>` positions its wrapper at `boardToPixel({x,y})` (scaled ×0.5) but
  renders the inner screen via `<ScreenRead … flow={false}>`, which sets
  `width: preset.width` — a **fixed pixel footprint that does not scale**
  (`canvas.tsx:262-284`, `screen.tsx:129`). So a `browser` frame is 900 px wide
  and consumes 900 / 0.5 = **1800 board units** — exactly `canvas.md`'s figure.
- `SURFACE_PRESETS` (`screen.tsx:56-60`): browser 900, desktop 840, mobile
  300×360, popover 360×120, panel 420×200 — matches `wireframe.md` and BuilderIO.

Worked check: two `browser` frames at x-gap 2200 → pixel gap 1100 px > 900 px
width ⇒ ~200 px clear gutter (no overlap). At BuilderIO's ≥1100 they would overlap
by 350 px in our renderer. **Our numbers are right; do not flag them as a
deviation.** All correct-by-design divergences from fairness rule 1 (hosted MCP
layer, kit-tree, deferred rough.js/`data-icon`/skeleton, JSON-only `<OpenApi>`,
constrained `<Diagram>`, locked `<HtmlBlock>` sandbox, in-skill self-review at the
orchestration layer) are respected and **not** counted as gaps.

Deferred-feature claims are also accurate: `screen.tsx`/`sanitizeWireframeHtml.ts`
implement **no** rough.js overlay, **no** `data-icon` SVG replacement, and **no**
`skeleton` state, and the skill correctly marks all three as "NOT done" rather
than claiming them. `.wf-icon` is documented as an empty slot; `index.css`
confirms it carries no glyph.

---

## New issues introduced by the expansion

### 1. [SHOULD-FIX] SKILL's `<DesignBoard>` example overlaps its own frames

`SKILL.md:535-546` places two `surface="mobile"` artboards at `x={40}` and
`x={440}` — a **400 board-unit gap**. A mobile frame is 300 px = 600 board units
wide, so frame 1 spans pixels 20–320 and frame 2 spans 220–520: **~100 px
overlap**. This violates `canvas.md`'s own rule ("between two compact frames
(`mobile`/`popover`/`panel`): ≥ 1000") and is the exact "overlapping artboards"
defect `exemplar.md` lists as an anti-pattern. Because the expansion is what
introduced the authoritative spacing numbers, the canonical example should comply
with them. **Fix:** move the second artboard to `x ≥ 1040` (and widen the board /
section accordingly).

### 2. [MINOR] `exemplar.md` overlap threshold uses a stale BuilderIO number

`exemplar.md` anti-pattern: _"Placing `browser` frames `<1100` board units apart —
they overlap by ~350 px in our renderer."_ The ~350 px figure is arithmetically
true **at** 1100, but framed as a threshold it misleads: our frames overlap for
any gap `<1800` (they only clear with a gutter at ≥2200, which the same sentence
correctly cites). The `<1100` looks like BuilderIO's un-corrected number left in.
**Fix:** reword to `<1800` (frames touch) / `<2200` (no gutter) so the illustrative
threshold matches `canvas.md`.

---

## Bottom line

Ship-quality. The composition quality bar that v1 flagged as the single
high-value gap is now taught at BuilderIO's level (arguably above it on the
exemplar axis), the canvas spacing is corrected for our renderer and verified, and
the accuracy nits are fixed. The only follow-ups are the two stale example numbers
above — a one-line edit each, neither blocking.
