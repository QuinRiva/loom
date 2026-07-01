---
manager_sessions:
  - id: 96fff6d5-c4d3-4ba9-a81d-659b855c1a81
    role: plan
    authored_at: 2026-07-01T09:47:51.200Z
---

# MDX Plannotator — Phase 4 Independent Review

Independent review (reviewer did NOT author the code) of the Phase 4 work on
`t3code/pivot-plannotator-to-mdx`, commit range **`362f3dcd8..HEAD`**:

| Commit | Scope |
| --- | --- |
| `7d337cbfa` | A1 — widen anchor union (`wireframe`/`canvas` kinds) |
| `85096a3e4` | A2 — recursive block ids + nested annotation |
| `0fabe104d` | Wave B — 7 document blocks + D9 posture |
| `6dcea3c1b` | C1 — wireframe artboard renderer + HTML sanitiser |
| `020c294bf` | C1 fix — sanitiser XSS/clickjacking (already security-reviewed) |
| `c4c665473` | C2 canvas + C3 design tier |

Uncommitted working-tree work (`blocks/columns.tsx`, `plan-blocks.schema.json`,
and the "Wave B6" container CSS's consumer) is **out of scope** and was ignored.
Judged against `docs/mdx-plannotator-decisions.md` (D1–D10) and
`docs/mdx-phase4-scoping.md`.

## Verdict: **SHIP** the committed range

The document-block ports, the canvas/design/wireframe groundwork, and the
additive anchor union are solid, faithful to D8/D10, byte-stable, and strongly
tested (72 tests incl. exploit shapes, nested-block cases, and node-pin
round-trips). No blockers. There is **one substantive should-fix** (untrusted
wireframe HTML can pollute the annotation id namespace) that should be closed
before wireframe/canvas annotation is relied upon against foreign `.mdx`; it
does not affect the already-shipped document-first cut. The rest are cleanup.

### Gate results

- `vitest run apps/web/src/components/files/mdx-plan/` → **4 files, 72 passed**.
- `vp run typecheck` → **0 errors** (clean even with the in-flight `columns.tsx`
  present). No failure traced to the in-flight container work.

---

## Blocker

None.

The two classic escalation surfaces are already closed **in earlier ranges** and
re-verified here as untouched by this range: the MDX attribute-expression eval
hole (B1) and the wireframe sanitiser XSS/clickjacking fixes (`020c294bf`, with
its own review in `docs/mdx-wireframe-sanitiser-review.md`). The pre-existing
text/visual anchor branches are logic-unchanged (diff is comments + additive
branches inserted ahead of them), so no regression to the shipped prose path.

---

## Should-fix

### SF1 — Untrusted wireframe HTML can pollute the annotation id namespace (reopens the S1 collision class on a new surface)

`sanitizeWireframeHtml` (`sanitizeWireframeHtml.ts`) strips dangerous tags,
`on*` handlers, unsafe URL attrs, dangerous styles, and theme classes — but it
does **not** strip the app's own reserved annotation attributes
`data-plan-block-type`, `data-plan-block-id`, or a pre-existing `data-wf-node`.
Per **D9 foreign `.mdx` is in scope**, and the fragment is injected into the
**live DOM** (`screen.tsx` `dangerouslySetInnerHTML`), then traversed by the
annotation layer. A wireframe `html` value carrying those attributes therefore
corrupts anchoring:

- **Whole-block id collision (the exact S1 class the prior review closed).**
  `assignBlockIds` (`MdxPlanRenderer.tsx:124`, called at `:182`) recurses into
  the injected fragment and stamps any nested `data-plan-block-type` element;
  an authored `data-plan-block-id` is left untouched and is **not de-duped**
  against real blocks. `resolveAnchor` (`anchoring.ts`) resolves a visual anchor
  via `root.querySelector('[data-plan-block-id="X"]')` → **first match in
  document order**, so an injected id can hijack a legitimate anchor, or a
  legitimate anchor can resolve into wireframe internals.
- **Wireframe node-pin capture defeated.** `enclosingBlock`
  (`anchoring.ts`) uses `closest("[data-plan-block-type]")`; an injected inner
  `data-plan-block-type="code"` is returned instead of the artboard, so
  `anchorFromRange` fails `WIREFRAME_BLOCK_TYPES.has(...)`, skips the pin branch,
  and whole-blocks the fake inner block instead.
- **`data-wf-node` ambiguity/drift.** `stampWireframeNodes` (`screen.tsx`) only
  stamps when the attr is absent, so a pre-existing authored `data-wf-node`
  survives and (a) can collide with a stamped id inside the same artboard
  (`resolveWireframeNode`'s `querySelector` returns the first), and (b) shifts
  the counter for subsequent real nodes.
- **Canvas target hijack.** `rectWithinSurface` / Connector / Annotation
  (`canvas.tsx`) look up targets by `[data-plan-block-id="…"]` within the
  surface; an injected id inside an artboard can capture a connector/annotation
  endpoint.

This is **not** XSS (no script exec, no session escalation), which is why it sits
outside the sanitiser's security-review remit — but it is a real
annotation-correctness/robustness hole introduced by C1, and it re-opens the
same id-collision class the prior review treated as a ship-blocker (S1), just via
a new surface. Accidental collision is unlikely (the names are app-internal), but
a foreign/hostile plan can trigger it deliberately.

**Fix (cheap):** in `sanitizeElementAttributes` (+ the `fallbackStrip` regex
path) drop `data-plan-block-type`, `data-plan-block-id`, and any inbound
`data-wf-node` from the fragment before injection — the renderer owns those
namespaces, exactly as it already strips theme classes so "a mockup can't leak
app CSS" ("…can't inject app annotation ids"). Cover with an exploit-shape test
alongside the existing sanitiser suite.

---

## Nice-to-have

- **NH1 — dead marker attribute.** `data-plan-block-nonprose` is written in
  `blocks/diff.tsx:332,345` but read nowhere in the tree. Remove it, or wire it
  into anchoring if it was meant to (it isn't in `NON_PROSE_BLOCK_TYPES`
  handling — `diff` already is, so the attr is redundant).
- **NH2 — forward-dead CSS in the committed range.** `index.css` (~line 1071,
  "MDX plan container blocks (Wave B6): Columns + Tabs") shipped committed while
  the `columns.tsx`/Tabs components are still uncommitted/in-flight. Harmless
  unused CSS until B6 lands; flag only because it couples committed CSS to
  uncommitted TSX.
- **NH3 — `RegisteredBlock.type` is dead metadata.** `registry.tsx` populates a
  `type` on every entry, but lookups are by `tag` (`planBlockByTag`) and each
  block hardcodes its own `data-plan-block-type`; `type` is never read, and two
  entries even share `type:"wireframe"`. Pre-existing pattern, but this range
  extends it — consider dropping `type` or using it.
- **NH4 — Mermaid SVG sanitiser asymmetry.** `blocks/mermaid.tsx`
  `sanitizeSvgMarkup` is lighter than `sanitizeWireframeHtml` (no CSS
  escape/entity decoding, no `<style>`/containment handling; it removes
  `script`/`foreignObject`/`on*`/`javascript:` hrefs incl. `xlink:href`). It is
  acceptable **defence-in-depth** behind Mermaid `securityLevel:"strict"` (the
  real boundary), but given foreign `.mdx` is in scope the asymmetry is worth a
  comment so a future reader doesn't mistake it for the primary boundary.
- **NH5 — Connector DOM-id hygiene.** `canvas.tsx`
  `plan-connector-arrow-${from}-${to}` embeds raw author ids into a DOM id and a
  `url(#…)` reference; author ids with whitespace/special chars could break the
  `url()` ref, and duplicate `from`/`to` pairs produce duplicate DOM ids. Low
  risk (author ids are slug-like) — consider escaping/hashing.

---

## Observations (verified correct — no action)

- **Anchor union / additive branches (D10).** `plan.ts` widens `anchorKind` by
  literal only (`wireframe`, `canvas`); no other contract change, as designed.
  The `wireframe` and `canvas` resolver branches are pure additions ahead of the
  untouched text/visual branches; both fail closed (malformed selector/ids →
  `null` detached, never throw). Round-trip + detach paths are tested and match
  the spike proof §7.2.
- **Nested-block foundation (A2).** `assignBlockIds` recursion uses one
  document-wide counter incremented only on stamped elements → deterministic,
  collision-free ids across depth (for *authored* content). `enclosingBlock`
  (`closest`, nearest wins) and `sectionFor` (climb to top-level child, then
  scan prior siblings) are correct for nested blocks; the section stays
  document-level. Tested at depth.
- **Block fidelity.** All 9 new tags round-trip byte-stably (mdxPlan/canvas
  tests). Diff's inline LCS differ is a correct standard LCS+backtrack with
  run-coalescing and a `MAX_DIFF_LCS_CELLS` guard; content-stable React keys, no
  array indices. OpenApi `$ref`/cycle handling is robust (per-branch `seen`
  copies + `guard<20` in `deref`, `depth>6` in `schemaExample`), YAML rejected
  with a helpful hint, never throws. Mermaid is genuinely lazy
  (`await import("mermaid")` inside the render fn, not in the base bundle;
  `mermaid` added to `apps/web/package.json`).
- **Canvas/design.** Board→pixel transform is consistent (`origin` via
  `boardToPixel`, region size × `boardScale`); the transform is published on the
  DOM (`data-board-scale`) and rebuildable via `canvasTransformForElement`. The
  design tier is HTML-only through the same sanitised renderer with a fidelity
  flag — no reopened CSS field, and `.plan-design-surface` keeps the S1
  containment box (`position:relative; contain:layout paint; overflow:hidden`),
  same as `.wf-surface`. Free-floating `anchorForCanvasPoint` is intentionally
  not wired into `anchorFromRange` (the canvas overlay layer, a later wave, owns
  capture) — contract-only here, matching §4.1.
- **AGENTS discipline.** No backwards-compat shims / dual-shape cruft (grep for
  compat/legacy/coexist finds only legit OpenAPI `deprecated` and upstream
  context). `ReviewCommentContext`/anchor stay discriminated unions, not
  coexisting optionals. `<QuestionForm>`/`<VisualQuestions>` share one
  `QuestionListRead` (no duplication). Prose is Australian English
  (sanitise/neutralise/behaviour); `sanitize*` identifiers keep the conventional
  wire spelling per project convention.

---

_Reviewer note added to the goal task tree: SF1 (strip reserved
`data-plan-*`/`data-wf-node` from injected wireframe HTML)._
