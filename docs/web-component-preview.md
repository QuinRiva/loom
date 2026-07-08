# Component preview harness (`apps/web`)

A dev-only way to render presentational components in isolation, with fixtures,
**without an authenticated backend**. Use it to iterate on render-heavy
components (markdown, tables, code, diffs) in ~seconds instead of hand-rolling a
throwaway route and driving the full authenticated app.

## Using it

```sh
pnpm --filter @t3tools/web dev
```

Open **`/preview`** (e.g. `http://localhost:5733/preview`). Pick a fixture from
the sidebar. No pairing, no server — the auth gate is skipped for this path.

## How it stays dev-only

- `apps/web/src/routes/__root.tsx`'s `beforeLoad` short-circuits the auth gate for `/preview`
  **only when `import.meta.env.DEV`** is true, returning a synthetic
  `{ status: "preview" }` gate so no HTTP/RPC fires.
- `apps/web/src/routes/preview.tsx` loads the harness UI via a `DEV`-gated dynamic
  `import("../preview/PreviewApp")`. In a production build `import.meta.env.DEV`
  is statically `false`, so the `import()` is dead code and the entire fixture
  graph (including its sample markdown) is tree-shaken out. In production the
  route renders `null`.

This means there is **no permanent auth-gate bypass for real routes** and the
harness never ships in production. (Verified: after `vp build`, no fixture
sentinel strings appear in `dist/`.)

## Reproducing timeline layout faithfully

`ChatMarkdown`'s wide-block bleed (tables escaping the `max-w-3xl` prose measure
on wide displays, shipped in PR #68) keys off `--timeline-available-width`, a
CSS variable `MessagesTimeline` publishes from a `ResizeObserver`. Rendering
`ChatMarkdown` bare would misreport that layout.

`apps/web/src/components/chat/timelineLayout.ts` is the shared source of truth:

- `TIMELINE_AVAILABLE_WIDTH_VAR` — the CSS variable name the bleed CSS reads.
- `publishTimelineAvailableWidth(el, width)` — publishes the rounded width.
- `useTimelineAvailableWidthVar(el, onMeasure)` — the `ResizeObserver` hook.
- `TIMELINE_ROW_CLASS_NAME` — the centred `max-w-3xl` row column.

Both `MessagesTimeline` and the harness's `TimelineLayoutFrame` consume these,
so fixtures reproduce the real bleed chain **by construction**, not by
copy-paste.

## Adding fixtures / components

Edit `apps/web/src/preview/fixtures.tsx`. Append a `PreviewFixture` to an existing group,
or add a new `PreviewGroup` for another component. Each fixture's `render()`
returns the component already wrapped in whatever layout context it needs
(`TimelineLayoutFrame` for timeline-hosted components). No harness wiring
changes are required.

## Tests

- `apps/web/src/components/chat/timelineLayout.test.ts` guards the CSS-variable contract
  the bleed CSS depends on (name + rounding).
- `apps/web/src/preview/fixtures.test.tsx` guards registry integrity (unique ids, every
  fixture renders).

### Visual/DOM regression — deferred, on purpose

A true pixel/computed-width regression test (asserting the table bleeds wider
than the prose column) needs a real layout engine. The repo's vitest projects
run in the `node`/jsdom environment, which has **no layout** (`getBoundingClientRect`
returns zeros), and the Playwright/WebdriverIO browser providers are **opt-in
deps that vite-plus does not ship**. Adding one is a heavyweight, cross-cutting
change disproportionate to this DX task.

The bleed behaviour was instead verified manually against the `/preview`
wide-table fixture (prose column 768px, table container bled to 976px at a
1024px viewport). When a browser-mode test project is next set up for
`apps/web`, the `wide-table` fixture is the ready-made target: assert the
`.chat-markdown-table-container` width exceeds its `[data-timeline-root]`
ancestor's width.
