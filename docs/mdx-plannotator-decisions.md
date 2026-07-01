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

## Open decisions deferred to their phase

- **Phase 4 full vocab** (wireframe canvas / live prototype / design screens):
  own scoping spike at that gate — Excalidraw for canvas, sandboxed execution for
  live prototype, plus wireframe-node + canvas-coord anchor kinds. Not scoped yet.
- **Mermaid diagrams**: lazy `await import()` per BuilderIO; added when needed.
