---
manager_sessions:
  - id: fd205f96-eb32-488d-9fa4-742d7383cea8
    role: plan
    authored_at: 2026-07-01T03:41:29.786Z
---

# MDX Plannotator — Decision Log

Running record of decisions taken while building first-party MDX plan support
(rendering + plannotator-style annotation) in T3 Code. The user gave a green
light to run end-to-end and decide on their behalf, provided decisions are
documented here. All decisions are revisitable before shipping.

Grounding docs:

- `docs/mdx-plannotator-research.md` — current (line-based) annotation anatomy.
- `docs/agent-native-wrap-assessment.md` — wrap-vs-reimplement assessment.
- `docs/mdx-spike-findings.md` — feasibility spike + extracted contracts (the build spec).

---

## D1 — Reimplement, not wrap _(ratified by user)_

Reimplement the MDX renderer + annotation as first-party React in `apps/web`,
adopting only BuilderIO's MDX **block schema** + anchor **shapes**. Keeps the
feedback loop native (comment is already in our React state; no MCP, no iframe,
no forked ~12k-line app). Self-host+iframe (W2) remains a fallback.

## D2 — Runtime MDX via `@mdx-js/mdx` `evaluate()` in-browser; CSP **Option A**

Compile+render MDX at runtime in the browser with a fixed component registry +
a remark guard replacing `rehype-sanitize`. This uses the `Function` constructor,
which under a strict CSP needs `script-src 'unsafe-eval'`.
**Decision: Option A (accept `unsafe-eval` for the plan renderer) for the first
cut.** Rationale: the app sets **no CSP today** (nothing breaks); the remark
guard + closed registry bound the eval surface to our own trusted components — a
_stronger_ guarantee than the current tag allow-list. Option B (server-side
`compile()` RPC + `blob:` module load, no `unsafe-eval`) is documented in the
spike and is the escape hatch **if a strict CSP ever becomes a requirement**.
Revisit before ship if a CSP is planned.

**Correction (review B1 — the guard now actually bounds the eval surface).** The
first cut of the guard only rejected `import`/`export` (`mdxjsEsm`) and raw
`{expression}` bodies (`mdxFlow`/`TextExpression`) — it walked `node.children`
only and never inspected **attribute-value expressions**
(`mdxJsxAttributeValueExpression`, e.g. `code={…}`), which `evaluate()` compiles
straight to executable JS. That falsified this decision's load-bearing premise:
`<Code code={((globalThis.__pwned=true),"x")} />` and
`code={fetch('/steal'+document.cookie)}` executed for **any `.mdx` opened in the
preview panel**. The guard now also visits `node.attributes` and rejects any
attribute-value expression that is **not a static literal** (reusing the estree
literal shapes the parse path already accepts, via
`assertLiteralAttributeExpression` in `mdxAttrs.ts`; it fails closed on a missing/
non-single-expression estree). The JSON-literal wire format the blocks depend on
— `entities={[…]}`, `data={{…}}`, `code={"…"}`, `={123}`, `={true}` — still
compiles; calls, sequences, IIFEs, member access, and arbitrary identifiers throw
at compile. Option A's rationale ("the guard + closed registry bound the eval
surface to our own trusted components") is now true rather than aspirational.
Regression tests in `mdxPlan.test.ts` pin both the rejected exploit shapes and
the still-allowed legitimate block expressions.

## D3 — Port a curated block subset; do **not** depend on `@agent-native/core`

The spike overturned the "reuse their npm blocks" hope: `@agent-native/core` is
one monolithic ~200-dependency framework package with no per-block entry and an
eager barrel. **Decision: port** the Read renderer + zod schema + MDX
`toAttrs`/`fromAttrs` config for each block into `apps/web`. Adopt their zod
schemas + `BlockMdxConfig` **verbatim** as the byte-stable MDX round-trip wire
contract (regenerate with `npx @agent-native/core plan blocks --format schema`,
offline/no-auth). First cut = 8 document-only blocks (see spike §3.2).

## D4 — Own Range-precise anchor resolver; extensible tagged-union anchor model

Adopt BuilderIO's anchor _serialiser shape_ (`textQuote` + `contextBefore/After`

- section/block) but write our **own resolver** that re-binds to an exact
  character `Range` (BuilderIO only re-find the block element for a pin marker,
  which is too coarse for highlight redraw). The anchor type is a **tagged union**
  (`anchorKind: text | visual | point`, plus a `targetKind` enum) so Phase 4 adds
  anchor _kinds_ (wireframe node pins, canvas coords) without rewriting the layer.
  Detached (quote deleted) → `null` → clean "detached comment" state.

## D5 — Comments live in the composer store; no `comments.json` sidecar (first cut)

Reuse the existing composer `reviewComments` → `appendReviewCommentsToPrompt` →
user-turn injection plumbing. The `comments.json` sidecar (BuilderIO local-files
interop) is deferred — only needed if we want their tools to consume our comments.

## D6 — Evolve the injection payload to a discriminated union (no dual-shape cruft)

`ReviewCommentContext` currently carries line indices + a source diff fence
(used for code/diff review — that path stays). Add an **MDX-anchor variant**
carrying the anchor's agent-facing details (section, quoted passage,
before/after, block type, ambiguity, resolver target) via BuilderIO's
`planCommentAnchorDetails` formatting. Model as a discriminated union
(`kind: "line" | "mdx-anchor"`), not two coexisting optional shapes.

---

## D7 — Phase 1-Core interfaces established (walking skeleton)

The walking skeleton is built and both gates pass (`vp check`, `vp run typecheck`,
plus a focused unit test and a successful `apps/web` production build). The
following interfaces are now fixed and the parallel wave should build against
them:

- **Shared contracts** (`packages/contracts/src/plan.ts`, effect/Schema,
  schema-only): `PlanCommentAnchor`, `PlanComment`, `PlanCommentMention`,
  `PlanCommentResolutionTarget`, `PlanCommentTargetKind` (+ kind/status/author
  literals). Text-quote subset populated first; visual/canvas fields reserved.
- **Block registration** (`apps/web/src/components/files/mdx-plan/blockTypes.ts`):
  a **slim** `PlanBlock<TData> = { schema: ZodType<TData>; mdx: BlockMdxConfig<TData>;
Read: FC<PlanBlockReadProps<TData>> }`. `BlockMdxConfig<TData>` is
  `{ tag; toAttrs; fromAttrs; childrenField? }` (BuilderIO's shape, verbatim).
  `PlanBlockReadProps<TData> = { data: TData; blockId: string }`. Deliberately
  drops BuilderIO's `BlockSpec` editor/container/placement/icon machinery — a
  read surface does not need it (porting the remaining 6 blocks should mirror
  this slim shape, not the full `BlockSpec`).
- **MDX round-trip** (`mdx-plan/mdxAttrs.ts`): `prop`/`escapeAttr`/`jsonExpression`
  (serialize) + `createAttrReader`/`attributeValue`/estree walker +
  `parseFirstJsxBlock` (parse, via `remark-parse`+`remark-mdx`), ported verbatim
  so authored `.mdx` round-trips byte-stably. `serializePlanBlock`/`parsePlanBlock`
  in `registry.tsx`.
- **Renderer public API** (`mdx-plan/MdxPlanRenderer.tsx`):
  `<MdxPlanRenderer source={string} className? />` and
  `compilePlanMdx(source): Promise<Component>`. Render path is MDX `evaluate` →
  evaluated props → per-block zod `safeParse` → `Read`; `fromAttrs` is the
  _authoring/import_ parse path, not the render path (MDX decodes attrs itself).
- **Annotation hook (for Phase 2)**: the rendered output is wrapped in ONE stable
  container `<div data-plan-root class="plan-mdx">` (ref-exposed), and every
  top-level block carries a stable `data-plan-block-id` — the authored `id` when
  present, else an assigned `plan-block-N` (a post-render pass fills prose blocks
  too). Custom blocks also expose `data-plan-block-type`. That is the Range root
  - block-level fallback anchor; Phase 2 attaches the resolver here without
    touching the renderer.
- **Security model** (implements D2): closed registry (`PLAN_BLOCK_COMPONENTS`)
  - a remark guard rejecting `mdxjsEsm`/`mdxFlowExpression`/`mdxTextExpression`
    at compile + MDX's own `_missingMdxReference` unknown-component trap (caught by
    an error boundary). JSON-literal **attribute** expressions (`entities={[…]}`)
    remain allowed — that is the block wire format — so the guard only rejects
    _body_ expressions and imports.
- **`ReviewCommentContext` union** (`apps/web/src/reviewCommentContext.ts`,
  implements D6): now `LineReviewCommentContext (kind:"line")` |
  `MdxAnchorReviewCommentContext (kind:"mdx-anchor")` over a shared base
  (`id, sectionId, sectionTitle, filePath, rangeLabel, text`). Line variant =
  the unchanged existing fields (`startIndex, endIndex, diff, fenceLanguage?`);
  mdx-anchor variant carries `anchor: PlanCommentAnchor` + `quotedText: string`.
  All existing consumers narrow on `kind`. Runtime anchor→prompt helpers
  (`planCommentAnchorDetails`, `formatPlanCommentAnchorForAgent`) live in
  `apps/web/src/planCommentAnchor.ts` (trimmed to the text-quote subset).

**Coordination note for Phase 1-Fan (server + injection):** nothing constructs
the `mdx-anchor` variant yet (Phase 2 will). `formatReviewCommentContext` has a
first-cut `mdx-anchor` branch so the union is exhaustive today, but the
**authoritative** agent-prompt serialisation AND the parse side
(`parseReviewCommentMessageSegments` currently emits only `kind:"line"`) are
yours to own/refine — extend `planCommentAnchor.ts` for the visual/canvas tiers.

**Deps added to `apps/web`:** `@mdx-js/mdx`, `zod`, `@tabler/icons-react` (for the
ported DataModel), plus `remark-mdx`/`remark-parse`/`unified` (the non-eval parse
path that makes `fromAttrs` real + the round-trip testable). The `<Code>` block
reuses the app's existing Shiki (`@pierre/diffs` `getSharedHighlighter`) — no
second highlighter.

## D8 — Phase 4 scoped; wireframes are sanitised HTML, not Excalidraw

The Phase 4 scoping spike (`docs/mdx-phase4-scoping.md`, signed) returned GO on
all rich surfaces, and **revises the D7 note**: wireframes/canvas are **not**
Excalidraw/roughjs. A wireframe is a self-contained **semantic HTML fragment**
(`data.html` + a `surface` preset) that BuilderIO render into the **live DOM**
(so annotation geometry stays one model via `getClientRects()`), guarded by a
DOM-parser sanitiser. **Decision: port BuilderIO's `sanitizeWireframeHtml`
verbatim** (drop dangerous tags, `on*` handlers, unsafe URL schemes, dangerous
inline styles; strip host theme classes for wireframe / keep them for design
fidelity) as the security boundary for this surface, and cover it with
exploit-shape regression tests like the MDX guard. This is a **second trust
boundary the MDX guard does NOT cover** — the HTML arrives as a passed-through
string literal attribute, so it must be sanitised at the block render point.
rough.js sketch overlay is optional polish, deferred. Design-fidelity screens are
a styling tier over the same renderer (a fidelity flag), not a separate renderer.

## D9 — Live prototype: sandboxed iframe is the boundary (wire format pending user)

The live interactive prototype runs in `<iframe sandbox="allow-scripts
allow-forms">` with `srcdoc` + a strict CSP and **no `allow-same-origin`** →
opaque origin. Proven in a real browser: it cannot read the parent window, DOM,
or cookies, yet stays interactive; its only channel is `postMessage`, treated as
hostile. **Recommended (pending explicit user confirmation before C4 builds):**
sandbox is the primary boundary + sanitise the prototype HTML as defence-in-depth

- **no remote script** (`script-src 'self'`/`'unsafe-inline'` only) unless a plan
  explicitly opts in; wire shape = a single `<Prototype html="…">` block. **v1
  annotation = whole-prototype (block-level `visual` anchor)**; in-prototype node
  pins need a postMessage geometry bridge and are a separate, gated follow-on
  (C5) — not v1. This is the one Phase-4 decision flagged for a human.

## D10 — Extend the anchor union additively; recursion for container blocks

Widen `anchorKind` to add `"wireframe"` (node pin: `targetSelector` artboard +
`targetNodeId`/`targetNodePath`) and `"canvas"` (board coords) as **pure additive
branches** in `anchoring.ts` — the text/visual paths are untouched (proven by a
real-browser round-trip). No contract change beyond the literal widening; the
visual/canvas fields were already reserved (D4/D7). Container blocks
(`Columns`/`Tabs`) require `assignBlockIds` + `enclosingBlock`/`sectionFor` to
**recurse** into nested blocks (currently top-level only); `Columns` de-risks
nesting and lands before design screens.

## Open decisions deferred to their phase

- **C4 prototype wire format + remote-script policy** — flagged for the human
  (see D9). C4 does not build until confirmed.
- **Mermaid diagrams**: lazy `await import()` per BuilderIO; added when needed.
- **rough.js wireframe sketch overlay**: optional polish, deferred past C1.
- **C5 in-prototype pin annotation**: postMessage geometry bridge; separate gated
  tier, only if demanded.
