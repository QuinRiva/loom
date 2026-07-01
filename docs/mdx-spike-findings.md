---
manager_sessions:
  - id: 592443da-c766-4d6a-892f-7d321b0d49c4
    role: plan
    authored_at: 2026-07-01T03:39:08.523Z
---

# MDX Plan Spike — Findings & Extracted Contracts

Feasibility spike for **first-party MDX plan rendering + plannotator-style span
annotation** inside `apps/web`. Three risky bits were proven with real code
(scratch harness in `scratch-mdx-spike/`, throwaway — not wired in, not
committed to app). Verdicts are backed by executable experiments and by reading
BuilderIO's real source (`github.com/BuilderIO/agent-native`, MIT).

**Bottom line: GO on all three.** The build is de-risked. The one genuine
gotcha is a CSP/`unsafe-eval` decision for runtime MDX compile, with two clean
options. The one strong recommendation-change vs. the prior assessment: **PORT a
curated subset of block renderers — do NOT depend on `@agent-native/core/blocks`**
(it is one monolithic ~200-dependency package with no per-block entry).

---

## Verdict 1 — Runtime MDX rendering: **GO**

**Approach: `@mdx-js/mdx` `evaluate()` at runtime, in the browser, with a fixed
component registry + a remark guard, replacing `rehype-sanitize`.**

Proven in `experiment1-mdx-runtime.mjs` (7/7 assertions pass). The `evaluate`
code path is isomorphic — identical in Node and browser — so a headless run is a
faithful proof. It:

- compiled a small MDX doc containing 3 custom components (`DataModel`,
  `ApiEndpoint`, `FileTree`) resolved **only** from a fixed registry, alongside
  normal GFM markdown (`**bold**` etc.);
- **rejected** every escape hatch: `import`/`export` (`mdxjsEsm`), raw
  `{expressions}` (`mdxFlow/TextExpression`), and unknown components (`<Malicious/>`
  throws before render).

### Security model (the part that replaces `rehype-sanitize`)

Three layers, all demonstrated:

1. **Closed component registry** — MDX resolves JSX names only from a
   `Record<string, React.ComponentType>` we pass as `components` /
   `useMDXComponents`. Nothing else is reachable.
2. **remark guard** rejecting `mdxjsEsm`, `mdxFlowExpression`,
   `mdxTextExpression` at compile time → no `import`, no arbitrary JS expressions
   in plan source. (~10 lines; see experiment.)
3. **Unknown-component trap** — MDX itself throws "Expected component X to be
   defined" for any tag not supplied; a Proxy over the registry makes that a hard
   error rather than a silent gap.

With (1)+(2)+(3) the only executable surface is the finite block set we author.
This is a _stronger_ guarantee than the current tag/attribute allow-list, because
the component implementations are our own trusted code.

### ⚠️ The one real gotcha: `new Function` / CSP

`@mdx-js/mdx` `evaluate` (and `run`) execute compiled code via the `Function`
constructor. Under a strict CSP this needs `script-src 'unsafe-eval'`.
**Current app sets no CSP** (grep of `apps/server`, `index.html`, vite config →
none), so nothing breaks today. Decide deliberately before shipping:

- **Option A (simplest): compile+run in-browser, accept `'unsafe-eval'`** for the
  plan renderer. The remark guard + closed registry mean the eval'd code is
  heavily bounded (it can only call our components; it cannot import or run free
  expressions). Lowest complexity; recommended for the first cut.
- **Option B (strict-CSP): compile on the server, run a real ES module.** Add a
  `plans.compileMdx` RPC that runs `@mdx-js/mdx` `compile()` in Node (no CSP
  constraint) and returns JS; the browser loads it via a `blob:` module import
  (`script-src blob:`), avoiding `Function`. More moving parts; only needed if a
  strict CSP becomes a requirement. Plans are read at runtime via the existing
  `projects.readFile`, so pure build-time compile is **not** an option — it must
  be runtime or server-on-demand.

**Deps to add:** just `@mdx-js/mdx` (pulls the standard remark/rehype/unified
graph; all browser-safe, Vite-bundleable — it is the canonical MDX-in-Vite
setup). Keep `remark-gfm`. Drop `rehype-raw`/`rehype-sanitize` from this path.

---

## Verdict 2 — Block renderers: **GO, but PORT — do not reuse the package**

**Recommendation: port a curated subset of Read renderers + their MDX/schema
configs into `apps/web`. Do NOT add `@agent-native/core` as a dependency.**

This overturns the "best case: depend on `@agent-native/core/blocks`" hope in
`agent-native-wrap-assessment.md §6`. The decisive dependency evidence:

- **There is no blocks-only npm package.** `@agent-native/core` (v0.84.2) is
  **one monolithic package** whose `exports` map exposes `./blocks` as
  `./dist/client/blocks/index.js`. Installing it to get blocks pulls the **entire
  framework's dependency list** — sampled from `npm view`: `@tiptap/*` (20+
  packages), `@react-router/dev`, `drizzle-orm`, `better-auth`, `better-sqlite3`,
  `@codemirror/*`, `@uiw/react-codemirror`, `recharts`, `i18next`/`react-i18next`,
  `@sentry/*`, `@amplitude/*`, `@anthropic-ai/sdk`, `@modelcontextprotocol/sdk`,
  `shiki`, `mermaid`, `roughjs`, `@libsql/client`, `nitro`, `h3`, … ~200 deps.
  This is a framework, not a widget library.
- **The `./blocks` barrel is eager over everything** — `index.ts` re-exports
  `wireframe-kit` (eager `roughjs`) and `MermaidBlock` in the same module, so
  even tree-shaking a document-only subset out of the _barrel_ is fragile, and
  the export map offers **no per-block subpath** to import cleanly.

But porting is genuinely tractable, because the block **source files are clean**:

- The document-subset Read components import only small local helpers
  (`cn`, `code-block-direction`, `block-copy`, `dev-doc-ui`, `AiEditableFieldLabel`,
  `types`) plus `zod` and `@tabler/icons-react`. They do **not** import
  `core/client` (i18n `useT`) or `react-router` (grep confirmed empty) — the §6
  "open risk" does not materialise for these blocks.
- Heavy deps are isolated and lazy: `mermaid` + `@excalidraw/mermaid-to-excalidraw`
  are **dynamic `await import()`** inside `MermaidBlock` only; `roughjs` is only in
  the wireframe kit. Neither is in our first-cut document subset.
- Size: the 8 document blocks (renderer **+ config + Edit + specs**) total ~7,400
  LOC. Our first cut needs only the **Read** renderer + the **zod schema** + the
  **MDX `toAttrs`/`fromAttrs`** per block — a fraction of that. Rough order: a
  simple block (Code, FileTree, Json) is ~100–250 LOC ported; a rich one
  (DataModel, ApiEndpoint, AnnotatedCode, Diagram) ~300–500 LOC.

**What to adopt as-is (copy the contract, not the package):** the zod schemas
and the `BlockMdxConfig` (`tag` + `toAttrs`/`fromAttrs` + optional
`childrenField`) for each block — that is the byte-stable MDX round-trip spec.
Re-generate the authoritative list any time with
`npx @agent-native/core plan blocks --format schema` (offline, no auth).

**Deps the port adds to `apps/web`:** `zod`, `@tabler/icons-react`, plus
per-block leaf libs only if/when we port that block (`shiki` or reuse the app's
existing Shiki for code; `mermaid` lazily if we add Mermaid later). Tiny next to
adopting the framework.

---

## Verdict 3 — Sub-span anchoring round-trip: **GO**

**Approach: text-quote + contextBefore/After anchor (BuilderIO's shape), with a
resolver that re-binds to an exact character `Range` — a step beyond BuilderIO,
who only re-find the block element for a pin marker.**

Proven in `anchoring.mjs` + `experiment3-anchoring.mjs` (7/7 pass) over **real
rendered MDX DOM** (jsdom, MDX compiled through `evaluate`):

1. **Round-trip on identical DOM** — Selection→anchor→re-resolve returns the same
   text (`"rotating secret"`), same section.
2. **Survives re-render with edits elsewhere** — after inserting paragraphs that
   shift the quote down the document, the anchor still resolves to the exact same
   span (context-anchored, not offset-anchored).
3. **Ambiguity** — when the identical quote appears twice, context-scoring
   (`suffixOverlap(contextBefore)` + `prefixOverlap(contextAfter)`) decisively
   picks the correct occurrence (asserted, not just "no throw").
4. **Detached** — when the quoted text is deleted, the resolver returns `null`,
   the clean "detached comment" state.

**Key design decisions this proves:**

- **BuilderIO's resolver is coarser than we need.** Their `resolveAnchorTarget`
  (`PlansPage.tsx:11575`) matches `textContent.includes(needle)` to find the
  containing **block element**, then positions a % pin — it does not rebuild a
  character Range. For plannotator highlight-redraw we want the actual Range, so
  we **port their serialiser shape but write our own resolver** (done — ~120 LOC
  in `anchoring.mjs`). Consider `@apache-annotator/dom` (TextQuote selector) if
  we want a battle-tested matcher instead of the hand-rolled one; the hand-rolled
  one is small and sufficient.
- **Whitespace:** we match on raw concatenated text-node content (exact offsets);
  BuilderIO normalise whitespace for their coarse match. For Range precision keep
  raw; add normalisation only if real docs show whitespace churn.
- **Granularity:** text-quote handles all prose. Non-prose blocks (diagram,
  wireframe) fall back to whole-block anchoring via a `data-plan-block-id` / the
  `blockType`+`targetKind` fields already in the anchor shape — a later tier.

---

## Extracted contracts (the spec for the real build)

### 3.1 Comment + anchor (adopt BuilderIO's shapes verbatim)

Transcribed from `templates/plan/shared/{comment-context.ts,types.ts}`. Adopt
the anchor as-is; **trim `PlanComment` to what the local-files flow uses** (drop
DB/org/hosted fields). The anchor's `formatPlanCommentAnchorForAgent` /
`planCommentAnchorDetails` helpers are a ready-made spec for rendering an anchor
into the agent prompt — port them.

```ts
export type PlanCommentResolutionTarget = "agent" | "human";

// The rich anchor. First cut populates the text-quote subset; the visual/canvas
// fields are reserved for the deferred wireframe/canvas tier.
export type PlanCommentAnchor = {
  anchorKind?: "text" | "visual" | "point";
  // --- text-quote (first cut) ---
  textQuote?: string;
  snippet?: string;
  contextBefore?: string;
  contextAfter?: string;
  sectionId?: string;
  sectionTitle?: string;
  blockType?: string;
  ambiguous?: boolean;
  targetSelector?: string; // CSS fallback locator
  tagName?: string;
  x?: number;
  y?: number; // document-% pin position (marker placement)
  // --- routing + mentions ---
  resolutionTarget?: PlanCommentResolutionTarget;
  mentions?: { email: string; label: string; role?: string }[];
  // --- deferred tiers (wireframe node / canvas / visual) ---
  targetKind?:
    | "text"
    | "image"
    | "diagram"
    | "table"
    | "code"
    | "block"
    | "wireframe"
    | "canvas"
    | "prototype"
    | "control"
    | "unknown";
  targetNodeId?: string;
  targetNodePath?: string;
  targetX?: number;
  targetY?: number;
  canvasX?: number;
  canvasY?: number;
  canvasWidth?: number;
  canvasHeight?: number;
};

// comments.json is a JSON array of these (local-files contract). Our first cut
// can keep comments in the composer store instead of a sidecar — see below.
export type PlanComment = {
  id: string;
  planPath: string; // our field: the .mdx path (replaces planId)
  parentCommentId?: string | null;
  kind: "comment" | "draft";
  status: "open" | "resolved";
  anchor?: PlanCommentAnchor | null;
  message: string;
  createdBy: "human" | "agent";
  resolutionTarget?: PlanCommentResolutionTarget;
  mentions?: { email: string; label: string; role?: string }[];
  createdAt: string;
  updatedAt: string;
};
```

**Anchoring API (ours, proven in `anchoring.mjs`):**

```ts
function anchorFromRange(range: Range, root: Element, doc: Document): PlanCommentAnchor;
function resolveAnchor(anchor: PlanCommentAnchor, root: Element, doc: Document): Range | null; // null = detached
```

### 3.2 MDX block-schema subset (first cut)

Document-only blocks; canvas/wireframe/prototype deferred. Each block = a zod
`schema` + a `BlockMdxConfig`. The MDX contract per block:

```ts
export interface BlockMdxConfig<TData> {
  tag: string; // JSX name in MDX — stable, never rename
  toAttrs: (data: TData) => Record<string, string | number | boolean | undefined>;
  fromAttrs: (attrs: BlockAttrReader, children: string) => TData;
  childrenField?: keyof TData & string; // prose body between tags (callout/rich-text)
}
```

First-cut tags (MDX component names are the stable wire contract):

| Block          | MDX tag           | Notable schema fields                                                                         |
| -------------- | ----------------- | --------------------------------------------------------------------------------------------- |
| Data model     | `<DataModel>`     | entities[] → fields[] `{name,type,pk,fk,nullable,default,note}`, relations[]                  |
| API endpoint   | `<Endpoint>`      | `method`, `path`, params[] `{name,in:path/query/header/body,type,required}`, request/response |
| File tree      | `<FileTree>`      | entries[] `{path,change:added/modified/removed/renamed,note,snippet,language}`                |
| Code           | `<Code>`          | `code`, `language`, `filename`, `caption`, `maxLines`                                         |
| Annotated code | `<AnnotatedCode>` | `code`, `language`, `filename`, annotations[] `{label,note}`                                  |
| Diagram        | `<Diagram>`       | nodes[] `{label,detail,x,y}`, edges[], notes[]                                                |
| Question form  | `<QuestionForm>`  | questions[] `{title,subtitle,mode:single/multi/freeform,options[]}`                           |
| JSON explorer  | `<Json>`          | `title`, `json` (string)                                                                      |

Multiline/whitespace-sensitive content (`code`, `json`) is encoded as a JSON
**string attribute** (`prop()` string-vs-JSON heuristic) — matches BuilderIO so
authored plans round-trip. (Full remaining tags for later: `Callout`, `Checklist`,
`Table`, `Tabs`, `Columns`, `Diff`, `Mermaid`, `OpenApi`, `HtmlBlock`,
`WireframeBlock`, `VisualQuestions`.)

### 3.3 Injection contract (evolve the existing `<review_comment>`)

The current line-based `ReviewCommentContext` (`startIndex`/`endIndex` + source
diff fence) does not fit rich anchors. Extend it to carry the anchor's
agent-facing rendering (from `planCommentAnchorDetails`): section, quote,
text-before/after, block type, ambiguity, resolver target. The **injection
plumbing is fully reusable** (composer `reviewComments` →
`appendReviewCommentsToPrompt` → normal user turn); only the _evidence payload_
changes from "source lines" to "anchor details + quoted passage".

---

## What the real build still has to do (thread-sizing)

1. **MDX runtime renderer** — `evaluate` wrapper + remark guard + registry
   provider; decide CSP option A vs B (A recommended). Replace the
   react-markdown path for `.mdx` in `FilePreviewPanel`. _(small–med)_
2. **Port block renderers** — the 8 document blocks: zod schema + `BlockMdxConfig`
   - Read component each, into `apps/web`. Reuse the app's Shiki for code.
     _(med–large; parallelisable per block)_
3. **Annotation layer** — the `anchoring.mjs` module productionised
   (`anchorFromRange`/`resolveAnchor`), a selection toolbar over the rendered
   surface, highlight overlays, detached-comment handling. _(med)_
4. **Comment store + UI** — draft→comment lifecycle keyed to anchors (reuse
   composer `reviewComments`, not `@pierre/diffs` line annotations); comment
   thread/rail UI. _(med)_
5. **Injection schema** — extend `ReviewCommentContext` + format/parse to carry
   anchor details instead of line indices. _(small)_
6. **Wire into panel** — new "annotate rendered MDX" surface in `FilePreviewPanel`
   (this is net-new; today's rendered view has no annotation). _(small–med)_
7. **Deferred tiers** — Mermaid (lazy), canvas/wireframe/prototype (Excalidraw),
   whole-block anchoring for non-prose blocks, `comments.json` sidecar if we want
   BuilderIO tool interop. _(later)_

## Surprises / risks that reshape the plan

- **`@agent-native/core/blocks` is not reusable in practice** (monolith, ~200
  deps, no per-block entry) → the plan must budget for **porting** blocks, not
  importing them. This is the biggest delta from the prior assessment.
- **CSP/`unsafe-eval`** is the only real security wrinkle for runtime MDX; decide
  A vs B explicitly. No CSP exists today so it won't surprise us mid-build, but
  it should be a conscious call.
- **BuilderIO resolve to an element, not a Range** — we needed (and wrote) a
  stronger resolver; don't expect their `resolveAnchorTarget` to give
  highlight-precise ranges.
- **Good news:** the document block components are cleanly layered (no i18n /
  router / collab coupling), heavy deps are lazy, and the whole feedback→user-turn
  plumbing already exists — so the risky bits were exactly these three, and all
  three are green.

---

_Scratch harness (throwaway, not committed to app): `scratch-mdx-spike/` —
`experiment1-mdx-runtime.mjs`, `anchoring.mjs`, `experiment3-anchoring.mjs`. Run
with `bun install && node <file>`._
