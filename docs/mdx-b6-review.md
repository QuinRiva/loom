---
manager_sessions:
  - id: 3eea68c0-ed6e-4227-b198-85ac53c74931
    role: review
    authored_at: 2026-07-01T09:56:17.491Z
---

# Wave B6 review — Columns + TabsBlock container blocks

**Reviewer:** independent reviewer sub-thread (did not author the code).
**Commit under review:** `da747b499` — _feat(mdx-plan): Phase 4 B6 — Columns + TabsBlock container blocks_ (latest on `t3code/pivot-plannotator-to-mdx`).
**Files:** `blocks/columns.tsx`, `blocks/tabs.tsx`, `registry.tsx`, `containers.test.ts`, `index.css`, `plans/mdx-plan-annotation/plan.mdx`.
**Judged against:** `docs/mdx-plannotator-decisions.md` D10 (recursion for container blocks) and `docs/mdx-phase4-scoping.md` §5 (MDX-native children, no dispatcher, recurse `assignBlockIds`/`enclosingBlock`/`sectionFor`).

## Verdict: **SHIP** ✅

No blockers. The load-bearing property — nesting must not break annotation — holds and is correctly tested against the real components and the real `plan.mdx`. The all-panels-mounted decision is sound. A11y is WAI-ARIA-correct. Wire deviations are justified. Findings below are all nice-to-have / known-limitation.

Working-tree note: the only uncommitted churn in the tree (`sanitizeWireframeHtml.ts`, `canvas.tsx`, `diff.tsx`, `mermaid.tsx`) belongs to the concurrent fix thread — none are B6 files, so they do not affect this review.

---

## Tests

`vp test apps/web/src/components/files/mdx-plan/` → **5 files passed, 84 tests passed** (13.8s). `containers.test.ts` (235 lines) drives the _real_ components and the _real_ authored `plan.mdx` through the MDX pipeline, covering: distinct-id-per-nested-block, `enclosingBlock` resolving to the nested block (not the container), whole-block anchor resolving to the nested block (not first match), nested-block section = the document heading, all-panels-mounted stamping (incl. the hidden panel), interactive click/keyboard tab switching + aria wiring, the attr round-trip, and end-to-end compile of the demo plan. No failures; none traceable to the concurrent fix's files.

(Commit message says "81 tests"; the suite is now 84 — stale message, not a code issue.)

---

## Blockers

None.

---

## Should-fix

None.

---

## Nice-to-have / known-limitations

- **NH1 — Cross-container selections fall to text-quote, not whole-block.** `"columns"`/`"tabs"` are (correctly) _not_ in `NON_PROSE_BLOCK_TYPES`. A selection _within a nested block_ resolves to that block (the common, load-bearing path — verified). But a selection whose `commonAncestorContainer` is the container chrome itself (e.g. dragging across both columns, or across the tab strip) has `enclosingBlock` = the container, which is prose-classified, so it yields a text-quote anchor over flattened child text rather than a whole-container `visual` anchor. This is an edge case — whole-container annotation is still reachable via the per-block "comment" affordance (`anchorForBlockElement`), which the container's own `data-plan-block-id` supports — so leaving containers prose-classified (so their labels/tab-strip text stay quotable) is a defensible trade. Flag only so the choice is on record; no change needed unless authors report it.
- **NH2 — Hidden-panel text in the text-quote flatten (brief point 2): sound, with one theoretical edge.** `flatten(root)` (both `anchorFromRange` and `resolveAnchor`) walks _all_ text nodes including `hidden` panels, and does so _identically_ on capture and resolve. Because all panels stay mounted, tab switching never changes the flattened text, so offsets stay stable across re-renders → **no mis-resolution**. The only theoretical wrinkle: text that is byte-identical _and_ has identical surrounding context across a visible and a hidden panel is ambiguous — but that is flagged (`ambiguous: true`) and is inherent to text-quote anchoring over any duplicate prose in the doc, not specific to tabs. Acceptable.
- **NH3 — Tab keys embed the array index.** `blocks/tabs.tsx:180,210` key on `` `${baseId}-tab-${i}` `` / `meta[i].panelId` (index-derived), which AGENTS discipline flags. Safe here because the tab list is authored/static (order never mutates), and the positional keying is _deliberate_ — it is what lets a panel learn its active state positionally so a duplicate/omitted author `id` can never mis-target a panel (`tabs.tsx:63-66` docstring). Worth a one-line comment noting the index is intentional, but not a defect.
- **NH4 — `type: "column"` / `type: "tab"` registry metadata never surfaces as a DOM block type.** `registry.tsx:73-75` registers those `type`s, but `ColumnRead`/`TabRead` render structural wrappers (`.plan-column`, `role="tabpanel"`) with **no** `data-plan-block-type` — correct by design (slots are not annotatable blocks; only the container and the real nested blocks are). The `type` string is unused informational metadata (consistent with the existing registry, e.g. two `"wireframe"` entries). Harmless; could drop to `type: ""` or a `slot: true` marker for clarity, but not worth the churn.
- **NH5 — Full nested-tree re-serialisation is not exercised.** The round-trip test covers per-block attr serialise/parse (the wire contract). Container-with-children whole-document re-serialisation relies on MDX-native nesting rather than `serializePlanBlock` (which emits self-closing elements), so it is inherently outside the block-level round-trip. Fine given the prototype's "tests optional" posture and that authored `.mdx` is the source of truth.

---

## Confirmations (the things that had to be right)

1. **Distinct ids across nesting (D10 recurse):** `assignBlockIds` (`MdxPlanRenderer.tsx:124`) descends through structural wrappers and stamps every `data-plan-block-type` element from one document-wide counter — container + each nested block get unique ids. ✓ (`containers.test.ts` "assigns a distinct id to the container and every nested block".)
2. **Anchor resolves to the nested block, not the container or first match:** `enclosingBlock` uses `closest("[data-plan-block-type]")` (nearest ancestor), and whole-block anchors key on the nested block's own unique id via `blockSelector`. ✓
3. **Section is document-level for nested blocks:** `sectionFor` climbs to the top-level child of the plan root _through_ the container before scanning prior siblings for a heading → nesting depth never changes the reported section. ✓ (test asserts `sectionTitle === "Migration"`.)
4. **Slots render in place, never portalled:** `ColumnRead`/`TabRead` render `children` inside the container subtree; `TabsRead` wraps each panel in a `TabPanelSlot` context provider in place. `enclosingBlock`/`sectionFor` DOM-climb therefore stays intact. ✓
5. **All panels mounted (hidden), stamped once:** `TabsRead` maps _every_ panel (inactive → `hidden`), never conditionally unmounts, so `assignBlockIds` (run per compile, not per tab switch) stamps blocks in hidden panels too, and ids stay stable across tab switches. ✓ (test resolves a whole-block anchor on the hidden panel's block.)
6. **A11y:** `role=tablist/tab/tabpanel`, `aria-selected`/`aria-controls`/`aria-labelledby` wired by positional id, `aria-orientation`, roving `tabIndex` (active = 0, others = -1), Arrow/Home/End keyboard nav with `preventDefault` + automatic activation. Correct per WAI-ARIA APG. ✓
7. **Wire fidelity:** `Columns`/`Column`/`Tab` tags + `orientation`/`label` attrs round-trip byte-stably (test). `TabsBlock` deviates from the scoping doc's provisional `<Tabs>` — **justified**: `TabsBlock` is BuilderIO's actual `tabs` `mdxTag`, so fidelity beats the provisional name; `<Column>`/`<Tab>` slot tags are ours because MDX-native nesting needs real child components (BuilderIO models slots as JSON `blocks` arrays). Documented in the docstrings and the parent task tree. ✓
8. **AGENTS discipline:** minimal surface (no custom dispatcher — renders MDX-native `children` per §5), no dead code beyond NH4, CSS uses design tokens (`var(--border)` etc.), `TabPanelSlot` memoisation justified by the linter rule + re-render narrowing. ✓
