---
manager_sessions:
  - id: ee68e5ec-38df-406a-9b8d-77020823d408
    role: plan
    authored_at: 2026-07-01T06:13:55.006Z
---

# MDX Plans — Phase 4 Scoping (full BuilderIO block vocabulary)

Feasibility + scoping spike for Phase 4: the **rich** BuilderIO `/visual-plan`
surfaces (wireframe canvas, live prototype, design-fidelity screens) plus the
remaining document blocks — all on top of the shipped document-first cut
(secure runtime MDX renderer + 8 document blocks + rendered-plan annotation).

The cross-cutting requirement is unchanged from D4: **annotation must work
across every new surface**, not just prose. The reserved tagged-union anchor
model (`anchorKind`/`targetKind`) exists precisely so Phase 4 adds anchor _kinds_
without rewriting the annotation layer.

Grounding (read for context, not re-derived here): `docs/mdx-spike-findings.md`
(§3.2 remaining tags), `docs/mdx-plannotator-decisions.md` (D1–D7, esp. D2/D4).
BuilderIO authority: `github.com/BuilderIO/agent-native` (MIT) +
`github.com/BuilderIO/skills` → `skills/visual-plan/references/{wireframe,canvas}.md`.

**Verdict: GO on all Phase-4 surfaces**, with one adjust (wireframe is
HTML-fragment-in-live-DOM, not Excalidraw) and one hard security gate (the
prototype iframe + the wireframe untrusted-HTML surface). The two riskiest
mechanics were proven with throwaway browser experiments (see §7). The prior
"Excalidraw for canvas, sandboxed execution for live prototype" note in D7 is
**revised**: Excalidraw is not needed for wireframes/canvas.

---

## 1. Wireframe / canvas rendering — GO (adjust: HTML fragments, not Excalidraw)

**What BuilderIO actually renders.** Confirmed from source
(`packages/core/src/client/blocks/library/wireframe.tsx` + `sanitize-html.ts`)
and the canonical quality doc (`references/wireframe.md`):

- A wireframe is a **self-contained semantic HTML fragment** (`data.html`) plus a
  `data.surface` preset (`browser`/`desktop`/`mobile`/`popover`/`panel`). The
  author writes plain HTML (`<h1>`, `<button>`, `.wf-card`, `.wf-pill`) using
  `--wf-*` color tokens; the **renderer owns** the surface footprint/aspect, the
  light/dark theme, the sketch font, a rough.js sketch overlay, and `data-icon`
  → Tabler-SVG replacement.
- The kit tree (`<FrameScreen>/<Card>/<Row>/<Btn>` nodes; `roughjs` per node) is
  **explicitly legacy** — "a new canvas artboard with kit-tree children is a
  defect." New plans emit `html`. So we do **not** port `wireframe-kit.tsx`
  (~1,800 LOC) and do **not** need Excalidraw/roughjs-as-a-canvas-lib.
- A **canvas** is a positioned set of artboards: board-level `x`/`y`
  (~2 board-units per pixel; `browser` ≈ 700×600, `desktop` ≈ 900×700 units),
  each artboard rendering a wireframe (inline `html` or a `blockId` reference),
  plus annotations (gutter notes anchored by `targetId`+`placement`, or freeform
  markup) and connectors. Authoring surface: `canvas.mdx` with
  `<DesignBoard>/<Section>/<Artboard>/<Screen surface html>/<Annotation>/<Connector>`.

**Recommended approach: sanitised HTML fragments in positioned artboards.**
This is the lighter path and it is what BuilderIO ships. rough.js is optional
polish (a thin SVG overlay measured against the laid-out DOM) — ship v1 **without
rough** (clean render) and add the overlay later; it is not on the critical path.

### 1.1 The new untrusted-HTML surface vs. our MDX security model — the key wrinkle

This is a genuine **second trust boundary**, distinct from the MDX-component
path, and it must be understood precisely:

- Our MDX guard (D2 correction B1) bounds the _MDX_ eval surface: it rejects
  non-literal attribute expressions, so `<Screen html={fetch(...)} />` throws at
  compile. **But** the legitimate wire form is a JSON **string literal**:
  `<Screen surface="browser" html="<div>…</div>" />`. The guard passes that
  string through unread — correctly, it is data — and the block then injects it
  via `dangerouslySetInnerHTML`. So the MDX guard does **not** protect this path;
  the HTML string is raw untrusted content that must be sanitised **at the block
  render point**.
- BuilderIO inject wireframe HTML into the **live DOM** (not an iframe) precisely
  because the rough.js overlay must measure laid-out elements — and they
  compensate with a DOM-based sanitiser (`sanitizeWireframeHtml`): parse via
  `DOMParser`, drop blocked tags (`script,style,iframe,object,embed,link,meta,
base,form,noscript,frame,frameset,applet,marquee,portal`), strip every `on*`
  handler, strip URL attributes whose **browser-resolved** scheme isn't safe
  (defeats `java\tscript:` / entity obfuscation), strip dangerous inline styles
  (`expression()`, `position:fixed`, huge `z-index`), and strip host/Tailwind
  theme classes so the mockup can't leak app CSS.

**Decision for our port (D8, proposed): reuse BuilderIO's `sanitizeWireframeHtml`
verbatim as a ported module and render wireframe HTML into the live DOM** (so we
keep the option of the rough overlay and get scroll-accurate annotation
geometry — `range.getClientRects()` over live elements, exactly as the current
annotation layer already does). This keeps ONE annotation geometry model across
all surfaces. The sanitiser is ~340 LOC, self-contained, browser-parser-based,
and is the security-critical piece — it must be ported as-is and covered by the
same kind of exploit-shape regression tests as the MDX guard (`mdxPlan.test.ts`),
NOT reimplemented. If we ever adopt a strict CSP (D2 Option B territory), the
live-DOM injection is unaffected (it carries no executable payload post-sanitise);
only the MDX `evaluate` path needs the server-compile escape hatch.

**Alternative considered & rejected for wireframes:** iframe-sandbox each
artboard (like HtmlBlock, §5). Rejected because it breaks the single annotation
geometry model (you can't `getClientRects()` across an opaque-origin iframe
boundary, so wireframe-node pins would need a postMessage geometry bridge per
artboard) and blocks the rough overlay. Sanitise-into-live-DOM is the right
trade for the _wireframe_ surface specifically.

---

## 2. Live interactive prototype — GO (sandboxed iframe; highest-risk, proven safe)

**What BuilderIO represents.** The prototype is a functional, operable
mock stored as its own artefact (`prototype.mdx` / `content.prototype`), surfaced
as a "Prototype" tab beside "Wireframes." Interactive content runs in a
**sandboxed iframe** — confirmed from their extension/embed viewers
(`EmbeddedExtension.tsx`, `ExtensionViewer.tsx`, `AgentNativeExtensionFrame.tsx`)
which all use `sandbox="allow-scripts allow-forms"` (**no `allow-same-origin`**)
plus a strict `srcdoc` CSP (`html-shell.ts`: `default-src 'none'; script-src
'self' … ; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action
'none'`), and a postMessage bridge with a path/method allowlist for any
parent-mediated capability.

**Safe execution model for our app: `<iframe sandbox="allow-scripts allow-forms">`
with `srcdoc`, no `allow-same-origin`.** This is the one correct shape. Under it
the iframe is an **opaque (`null`) origin**: it cannot read the parent window,
the parent DOM, or cookies/localStorage; it stays fully interactive; its only
channel to the app is `postMessage`, which the app treats as hostile (validate +
allowlist). No parent-app capability should be exposed to the prototype in v1 —
render it as a pure, self-contained interactive doc.

**Proven (see §7.1).** A real-browser experiment loaded an interactive prototype
that tried to break out on load. Results: `window.parent.__secret` →
`BLOCKED: SecurityError`; `window.parent.document...` → `BLOCKED: SecurityError`;
`document.cookie` → `BLOCKED: SecurityError`; `location.origin` → `"null"`;
button click → `postMessage` delivered to parent. Isolation holds; interactivity
holds.

**Cost, honestly.** The _sandbox_ is cheap and de-risked (a few lines: iframe +
`srcdoc` + CSP `<meta>`). The real cost is everything around it:

- **Authoring format + renderer.** What exactly is a `prototype`? BuilderIO's is
  a self-contained HTML/JS doc. We must decide the wire shape (a single
  `<Prototype html="…">` block? a referenced file? multi-file with an import
  map?) and whether the prototype gets sanitised (defence-in-depth) or relies on
  sandbox alone. Recommend: **sandbox is the primary boundary; also run the
  prototype HTML through a sanitiser as defence-in-depth**, and forbid `srcdoc`
  from loading remote script (`script-src 'self'`/`'unsafe-inline'` only, no
  arbitrary CDNs unless a plan opts in). This is a design decision to confirm
  with the user (see §6 gate).
- **Annotation across the boundary (the hard part).** You cannot
  `getClientRects()` into an opaque-origin iframe. Annotating _inside_ a
  prototype requires a **postMessage geometry bridge**: a tiny injected agent in
  the iframe reports element rects/ids on selection, the parent draws overlays in
  its own coordinate space. This is net-new machinery and the single largest
  Phase-4 annotation risk. **v1 fallback: whole-prototype (block-level)
  anchoring** (comment on "the prototype" via `targetSelector` on the iframe
  host, exactly the existing `visual` path) — ships immediately, no bridge. The
  in-prototype pin bridge is a follow-on tier.

**Verdict:** GO on the sandbox; GO on whole-prototype annotation in v1; treat
in-prototype pin annotation as a separate, gated follow-on (needs the bridge).

---

## 3. Design-fidelity screens — GO (a fidelity tier over the artboard path, scope only)

Design-fidelity ("Design tab", `create-plan-design`) screens are **full-fidelity,
branded** renders — the difference from a wireframe is styling tier, not a
different renderer. Evidence: the same sanitiser carries a `preserveThemeClasses`
option (wireframes strip host/Tailwind theme classes to force the sketch look;
design screens **keep** them for real branded styling) and the render path
disables the rough/sketch overlay for a clean render.

**Recommended approach:** one artboard/HTML renderer with a **fidelity flag**
(`wireframe` = strip theme classes + rough overlay; `design` = preserve theme
classes + clean render). No separate renderer, no new anchor kind — design
screens reuse the wireframe-node-pin anchor (§4) unchanged. **Scope: small once
the wireframe artboard renderer exists** (it is the same code with two style
tiers). Sequence it _after_ the wireframe renderer lands.

---

## 4. The two new anchor kinds — GO (extend the reserved union; wireframe-node proven)

The contract already reserves every field needed
(`packages/contracts/src/plan.ts`): `anchorKind` (add `"wireframe"`, `"canvas"`),
`targetKind` (`wireframe`/`canvas`/`prototype` already present), plus
`targetNodeId`, `targetNodePath`, `targetX`/`targetY`, `canvasX`/`canvasY`,
`canvasWidth`/`canvasHeight`. **No contract change is needed beyond widening the
`anchorKind` literal** — the Phase-1 tagged union was designed for exactly this.

How BuilderIO capture/resolve (grounding): canvas annotations anchor to a frame
by `targetId` + `placement` (gutter parking), and freeform markup uses `x`/`y`
/`points` in board space. Their in-frame resolution finds the **element**; they
don't rebuild a Range (same coarseness we already improved on for prose). We
mirror the _shape_, keep our own resolver.

### 4.1 Proposed extended anchor model (dispatch on `anchorKind` — no change to text/visual)

The resolver in `annotation/anchoring.ts` already dispatches on `anchorKind`
(`text` → Range via text-quote; `visual` → whole-block via `targetSelector`).
Add two branches; the existing branches are untouched:

- **`anchorKind: "wireframe"` (node pin).** Capture on a click/selection inside a
  `[data-plan-block-type=wireframe|design]` artboard:
  - `targetSelector` = the enclosing artboard (`[data-plan-block-id="…"]`),
  - `targetNodeId` = the target element's stable node id (renderer stamps a
    `data-wf-node` id per meaningful element during the sanitise/assign pass —
    analogous to `assignBlockIds`),
  - `targetNodePath` = a structural nth-child chain scoped to the artboard, as a
    **fallback** when the node id is absent/regenerated.
    Resolve: find artboard → prefer `data-wf-node` match → else walk the path →
    else `null` (detached). Overlay geometry via `getClientRects()` on the resolved
    element (same as prose), because the artboard lives in the live DOM (§1.1).
- **`anchorKind: "canvas"` (board coordinate).** For annotations placed in open
  canvas space (not pinned to a node): `canvasX`/`canvasY` in board units (+
  optional `canvasWidth`/`canvasHeight` for a region), resolved by the canvas
  layout's board→pixel transform. Node-pinned canvas notes use the `wireframe`
  branch with the artboard as `targetSelector`; only truly free-floating markup
  needs the raw-coordinate branch.

**Proven (see §7.2).** A real-browser round-trip of the `wireframe` node-pin
branch over a rendered artboard: capture → resolve to the exact element ✓;
survive a re-render that inserts a field above the target (id match still
resolves the same node) ✓; detach cleanly (`null`) when the node id is removed
_and_ the structural path is broken ✓. This confirms the new kind slots in as a
pure additive branch without touching the working text/visual paths.

`prototype` in-frame pins are the exception: they need the postMessage bridge
(§2), so they are **not** just an `anchoring.ts` branch — defer to the follow-on
tier. Whole-prototype comments use the existing `visual` branch today.

---

## 5. Remaining document blocks — triage + sizing

All mirror the shipped slim `PlanBlock` pattern (zod `schema` + `BlockMdxConfig`

- `Read`). Sizes are the ported Read+config subset (BuilderIO LOC in parens is
  the full editor+spec source, much larger than our port). "Trivial" = same shape
  as the 8 shipped blocks; "risk" = new machinery.

| Block           | Tag                 | Port size                  | Risk / note                                                                                                                                                                                   |
| --------------- | ------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Callout         | `<Callout>`         | trivial (~120)             | Prose `childrenField` body; mirrors existing pattern.                                                                                                                                         |
| Checklist       | `<Checklist>`       | trivial (~150)             | Static list; trivial.                                                                                                                                                                         |
| Table           | `<Table>`           | small (~250)               | Data rows; trivial-ish.                                                                                                                                                                       |
| Diff            | `<Diff>`            | medium (~400)              | BuilderIO inline **LCS differ, no jsdiff dep** — port the differ + unified/split Read. Self-contained.                                                                                        |
| Mermaid         | `<Mermaid>`         | medium (~150 + lazy dep)   | **Lazy** `await import("mermaid")` only when a Mermaid block renders; heavy dep isolated, never in the base bundle. Confirmed lazy in source.                                                 |
| OpenApi         | `<OpenApi>`         | medium–large (~500)        | Rich spec renderer (998 LOC full); port a read subset. No new risk class, just volume.                                                                                                        |
| HtmlBlock       | `<HtmlBlock>`       | medium (~150)              | **Untrusted HTML** — BuilderIO render it in an `sandbox="allow-same-origin"` iframe (no `allow-scripts`) + optional sanitise. Second untrusted surface; ship as sandboxed-iframe + sanitiser. |
| VisualQuestions | `<VisualQuestions>` | small (~150)               | Variant of the shipped `<QuestionForm>`; near-trivial.                                                                                                                                        |
| Columns         | `<Columns>`         | **medium — new machinery** | **Container block**: nests child blocks (esp. Before/After wireframe pairs).                                                                                                                  |
| Tabs            | `<Tabs>`            | **medium — new machinery** | **Container block**: tabbed child blocks.                                                                                                                                                     |

**The one structural item:** `Columns`/`Tabs` are **container** blocks. BuilderIO
dispatch children through a `ctx.renderBlock` block-dispatcher; our slim registry
has no nesting context. **Good news:** in MDX, nesting is native — nested JSX
children already resolve through the component registry, so a container block can
simply render its React `children` (which the MDX evaluate path already produced)
rather than needing a custom dispatcher. This likely makes containers _simpler_
for us than for BuilderIO's JSON model. It still needs: (a) `childrenField`-style
handling for structured child slots, (b) `assignBlockIds`/annotation to descend
into nested blocks (the current pass only stamps top-level children — must
recurse), and (c) anchor `sectionFor`/`enclosingBlock` to work for nested blocks.
Treat `Columns` as the block that de-risks nesting; do it before design-screens
(which use Before/After columns).

---

## 6. Hard risks & mitigations (summary)

1. **Prototype iframe escape** → mitigated: `sandbox="allow-scripts allow-forms"`
   (no `allow-same-origin`) + strict `srcdoc` CSP; opaque origin proven to block
   parent/DOM/cookie access (§7.1). **Gate:** confirm with the user the prototype
   wire format + whether remote script is ever allowed (recommend no).
2. **Wireframe/HtmlBlock untrusted HTML** → mitigated: port
   `sanitizeWireframeHtml` verbatim (DOM-parser sanitise: drop dangerous tags,
   `on*`, unsafe URL schemes, dangerous styles) at the block render point;
   exploit-shape regression tests like the MDX guard's. This is a **new trust
   boundary the MDX guard does not cover** (the HTML arrives as a passed-through
   string literal) — call it out loudly in review. **Gate:** security review of
   the ported sanitiser before the wireframe surface ships.
3. **In-prototype annotation** → the one thing the current geometry model can't
   reach (opaque-origin iframe). v1 = whole-prototype block anchor (existing
   `visual` path); in-frame pins need a postMessage geometry bridge → separate
   gated tier, not v1.
4. **Container blocks (Columns/Tabs)** → annotation must recurse into nested
   blocks (`assignBlockIds` + `enclosingBlock`/`sectionFor` currently top-level
   only). Medium; de-risk with `Columns` first.
5. **Bundle weight** → Mermaid stays lazy (`await import`); rough overlay is
   optional/deferred; no Excalidraw. Base bundle unaffected.
6. **CSP interaction (D2)** → live-DOM sanitised wireframe HTML carries no
   executable payload, so it's CSP-neutral; only the MDX `evaluate` path is the
   `unsafe-eval` consumer. The prototype iframe needs its own `srcdoc` CSP,
   independent of the host page CSP. No conflict; note for the ship gate.

---

## 7. Proofs (throwaway; `scratch-phase4-spike/`, not wired in, not committed)

### 7.1 Prototype sandbox isolation (`iframe-sandbox-proof.html`, real browser)

Interactive prototype in `sandbox="allow-scripts allow-forms"` srcdoc iframe.
On-load escape attempts, reported via the only open channel (postMessage):

```
parentWindow: "BLOCKED: SecurityError"
parentDom:    "BLOCKED: SecurityError"
cookie:       "BLOCKED: SecurityError"
origin:       "null"        (opaque origin)
button click → postMessage delivered to parent  (interactivity intact)
```

### 7.2 Wireframe-node-pin anchor round-trip (`wireframe-anchor-proof.html`, real browser)

Additive `anchorKind:"wireframe"` branch over a rendered artboard:

```
captured: {anchorKind:"wireframe", targetSelector:'[data-plan-block-id="wf-1"]',
           targetNodeId:"submit-btn", targetNodePath:"0/2"}
(1) round-trip            → BUTTON 'Sign in'                 ✓
(2) re-render (insert field above) → same BUTTON via id match ✓
(3) node id removed + path broken  → null (detached)         ✓
RESULT {r1:true, r2_isSame:true, r3_detached:true}
```

---

## 8. Proposed Phase-4 thread breakdown

All children share **one worktree** (serialise anything that edits the same
files; parallelise only disjoint files). Review gates marked ⛔ are where a
separate reviewer thread + a human security sign-off belong.

**Wave A — foundations (serial-ish, they touch shared renderer/contract):**

- **A1. Widen anchor union** (`contracts/plan.ts` `anchorKind` +
  `anchoring.ts` `wireframe`/`canvas` branches + tests). Small; unblocks all
  annotation-bearing surfaces. Lands the §7.2 branch productionised.
- **A2. Recursive block ids + nested annotation** (`assignBlockIds` recurse;
  `enclosingBlock`/`sectionFor` for nested blocks). Small–medium; unblocks
  containers. Touches renderer + anchoring → sequence with A1 (same files).

**Wave B — parallel document blocks (disjoint files, fully parallel after A):**

- **B1.** Callout, Checklist, Table, VisualQuestions (trivial ports) — one thread.
- **B2.** Diff (port LCS differ + Read) — one thread.
- **B3.** OpenApi (read subset) — one thread.
- **B4.** Mermaid (lazy dep) — one thread.
- **B5.** ⛔ **HtmlBlock** — sandboxed-iframe + **ported sanitiser**; security
  review gate. Shares the sanitiser module with Wave C, so land the sanitiser
  here (or in C1) once and import.
- **B6.** Columns + Tabs (container/nesting) — depends on **A2**; do `Columns`
  first. One thread.

**Wave C — rich surfaces (serial by dependency; each is a review gate):**

- **C1. ⛔ Wireframe artboard renderer** — port `sanitizeWireframeHtml`
  (security review), `<Screen>`/`<WireframeBlock>` block, surface presets,
  live-DOM injection, `data-wf-node` stamping (feeds A1's pin). rough overlay
  deferred. Blocks C2/C3.
- **C2. Canvas layout** — `<DesignBoard>/<Section>/<Artboard>/<Connector>` +
  board→pixel transform + gutter annotations; the `canvas` anchor branch. Depends
  on C1 + A1.
- **C3. Design-fidelity tier** — fidelity flag over C1 (preserve theme classes +
  clean render). Small; depends on C1.
- **C4. ⛔ Live prototype** — sandboxed-iframe renderer + wire format
  (**human decision gate** on format/remote-script policy) + whole-prototype
  (`visual`) annotation. Depends on nothing in C but its own gate.
- **C5. In-prototype pin annotation (follow-on, separate gate)** — postMessage
  geometry bridge; do NOT bundle into C4. Highest annotation risk; ship only if
  demanded.

**Gates:** ⛔ = separate reviewer thread + human security sign-off (C1 sanitiser,
C4 prototype execution/format, B5 HtmlBlock). A human decision is required for
C4's prototype wire format and remote-script policy before C4 starts.

**Parallelism summary:** A1→A2 serial (shared files); then all of Wave B parallel
(disjoint block files) except B6 waits on A2; Wave C serial along
C1→{C2,C3}, C4 independent of C-chain but gated, C5 deferred. The document
blocks (B) and the rich surfaces (C) can run concurrently since they touch
different files, with the shared sanitiser landed once (C1/B5) and imported.
