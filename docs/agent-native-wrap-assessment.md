---
manager_sessions:
  - id: 4edc8247-edb9-4e6f-9b30-2bc45ab89cee
    role: architecture
    authored_at: 2026-07-01T00:27:09.588Z
---

# Agent-Native: Wrap vs. Reimplement Assessment

**Question:** For T3 Code's "agent plans authored as MDX + reviewers annotate the rendered
plan + feedback flows back to the agent as a user turn" feature, should we **wrap** BuilderIO's
Agent-Native Plans (embed hosted / self-host + iframe) or **reimplement** the renderer +
annotation first-party?

**Verdict up front:** **Reimplement (option R)** — but depend on their MIT-licensed block
library (`@agent-native/core/blocks`) for block rendering rather than rebuilding it, adopt their
MDX file contract + comment/anchor shapes as our schema, and build only the plan-document shell,
the text-quote annotation layer, and the native comment→user-turn wiring. **Reject W1 (hosted +
MCP).** Keep **W2 (self-host + iframe)** as a cheap de-risking prototype / fallback, because a
decisive finding below makes its feedback bridge far cheaper than the brief feared.

Evidence is from a fresh clone of `github.com/BuilderIO/agent-native` (commit fetched 2026-07-01).
The repo is the **framework monorepo**; the "Plans" product is the **`templates/plan/`** app
(a clone-and-own template, _not_ a versioned dependency) built on the `@agent-native/core`
framework, plus the `/visual-plan` skill in `skills/visual-plans/`.

> Note on evidence quotes: a few pasted source snippets below show the token `n` where the source
> actually reads `iframe`/`postMessage` — a display artefact of the extraction tool, not the real
> source. Line/'`postMessage`' references were re-confirmed with exact greps.

---

## 1. Licence & self-hostability

**Licence: MIT.** `README.md` states "## License / MIT", and every package we'd touch declares
`"license": "MIT"` — `packages/core`, `packages/pinpoint`, `packages/embedding`,
`packages/code-agents-ui`. (The workspace _root_ `package.json` says `"license": "ISC"`, and there
is **no top-level `LICENSE` file** — only `packages/vscode-extension/LICENSE.md` exists. Minor
hygiene flag; the authoritative signal is MIT on README + every published package.)

**The Plan app is genuinely runnable standalone/offline.** `templates/plan/` is a
**React Router v8** SSR/SPA app (`app/entry.server.tsx`, `app/entry.client.tsx`,
`@react-router/dev`, Vite) — **not Next.js** — served by the `@agent-native/core` CLI
(`"dev": "agent-native dev"`, `build`, `start` in `templates/plan/package.json`). It runs with
**no login and no hosted service** in dev:

- `templates/plan/server/lib/local-identity.ts` → `isLocalPlanRuntime()` returns `true` by
  default whenever `NODE_ENV !== production` and `AUTH_MODE` is unset/`local`; it mints a synthetic
  single-user owner `local@agent-native.local`. "A person creates, edits, and views plans with NO
  login… Only when they want to SHARE… do they make a lazy account and publish."
- The DB is a local **libSQL/SQLite** (`@libsql/client`, `drizzle-orm`), and the DB URL is
  **optional** (`server/plugins/core-routes.ts` registers "Database URL", `required: false`).
  Crucially, **local-files plans need no DB at all** — see §4.

**Two distinct "local" concepts (do not conflate):**

- **(a) Local-files _bridge_ mode** (the skill's default private path,
  `skills/visual-plans/references/local-files.md`): the agent authors MDX locally and previews it
  through the **hosted** Plan UI at `plan.agent-native.com`, which reads from a localhost bridge.
  Rendering here still depends on their hosted web app being reachable. **Comments are
  unavailable** in this mode ("Hosted comments, sharing, screenshots… are unavailable until the
  user explicitly opts into publishing").
- **(b) Self-hosted Plan _app_** (`templates/plan` running locally): serves the **full UI**
  locally at `/local-plans/:slug`, reading from `PLAN_LOCAL_DIR`, with **full commenting** and
  **no hosted dependency**. This is the mode relevant to W2.

**Weight:** heavy. React Router 8 + Vite + TipTap (`@tiptap/*`), Excalidraw
(`@excalidraw/excalidraw`, `mermaid-to-excalidraw`), Mermaid, Shiki, RoughJS, ~30 Radix packages,
TanStack Query, i18n across 11 locales. It is a full product, not a widget.

---

## 2. Embeddability

**Embedding is a first-class, designed-for capability — but non-trivial.**

- There is a dedicated published SDK, `@agent-native/embedding` (MIT), exposing an
  `EmbeddedApp` React component and a `postMessage` bridge (`sendEmbeddedAppMessage`,
  `packages/embedding/src/{react.tsx,bridge.ts,protocol.ts}`) for host↔iframe messaging.
- The Plan app **already emits structured `window.parent.postMessage(...)` events** designed for an
  embedding host (`templates/plan/app/pages/PlansPage.tsx`, all real `postMessage`, confirmed at
  lines ~11300, ~11802, ~11923, ~11943, ~11996): types include
  `agent-native-plan-annotate` (payload `{ anchor }`), `agent-native-plan-close-comment-popover`,
  `agent-native-plan-exit-comment-mode`, `agent-native-plan-open-editor`,
  `agent-native-plan-editor-preference`, `agent-native-plan-link-blocked`. It also **listens** for
  inbound messages (`window.addEventListener("message", …)` at lines ~4105/4194 and ~11300).

**Constraint that matters for us:** in _embedded_ mode the app posts the annotation **anchor** to
the parent and expects **the parent to host the comment-compose popover** (hence
`…-close-comment-popover` / `…-exit-comment-mode`). So a "true embed" still forces us to build the
comment UI ourselves. The clean wrap is instead to run the app **standalone** and iframe its own
`/local-plans/:slug` route, letting its own popover write comments to disk (§4). No
`X-Frame-Options`/CSP `frame-ancestors` lockdown was found for the app's own routes (the CSP-ish
regexes in `server/plan-content.ts` are for sandboxing _user-authored custom-HTML fragments_, not
the app shell); `Layout.tsx` explicitly has an iframe/embed layout mode. CORS is a non-issue for
same-machine same-origin iframing of a locally-served app.

---

## 3. Annotation anchoring in code

**Confirmed: rich, plannotator-style sub-span anchoring, computed client-side, persisted as a
structured anchor object.** The anchor schema is `PlanCommentAnchor` in
`templates/plan/shared/comment-context.ts`. Granularity spans all three modes the brief asked
about:

- **Arbitrary sub-span prose (text-quote):** `textQuote`, `snippet`, plus `contextBefore` /
  `contextAfter` for disambiguation, `sectionId`/`sectionTitle`, `targetSelector`, `blockType`,
  `ambiguous`. Built in `PlansPage.tsx` (~line 11772, `anchorFromRange`) directly from
  `window.getSelection()` → `Range`: it captures up to 220 chars of `textQuote`, section id, tab
  context, a CSS `targetSelector`, and document-percentage `x`/`y`. This is exactly the
  plannotator text-quote+context approach.
- **Wireframe node pins:** `targetNodeId` + `targetNodePath` (e.g. `card > list > listItem "Acme
Inc"`), addressable by wireframe patch ops.
- **Canvas coordinates:** `canvasX`/`canvasY` in board-world pixels with `canvasWidth`/`canvasHeight`;
  plus in-element `targetX`/`targetY` percentages and `targetKind`
  (`text|image|prototype|wireframe|canvas|diagram|table|code|control|block`).

**Where the anchor lives / how it's persisted:** the anchor is stored **with the comment row**, not
in the MDX. In the hosted/DB path it's a column on the comment (`server/db/schema.ts`). In the
self-hosted local path it's persisted to a **`comments.json` sidecar** (see §4). The
`formatPlanCommentAnchorForAgent` / `planCommentAnchorDetails` helpers in `comment-context.ts` turn
the anchor into the exact human-readable text the agent consumes — this is effectively a reusable
**spec** for how to render an anchor into a prompt, whichever option we pick.

**Implication for R:** reimplementing text-quote sub-span anchoring is realistic — the algorithm is
right here in `anchorFromRange` (Selection/Range → quote+context+selector+section) and the target
shape is fully specified in `comment-context.ts`. Wireframe-node and canvas-coordinate anchoring are
higher-fidelity work tied to Excalidraw/wireframe rendering, and can be a later tier.

---

## 4. Feedback seam (the decisive finding)

**There IS a clean, non-MCP, file-based channel to read human comments — in the self-hosted local
runtime, reviewer comments are written to a plain `comments.json` file we can read directly.**

- Action `templates/plan/actions/update-local-plan-comments.ts`: "Comments persist to
  `comments.json` **beside `plan.mdx`** so they survive a refresh; they are always addressed to the
  coding agent and never touch the database." `requiresAuth: false`.
- Persistence primitives in `templates/plan/server/lib/local-plan-files.ts`:
  `LOCAL_COMMENTS_FILE = "comments.json"`; `readLocalPlanComments()` / `writeLocalPlanComments()`
  read/write a JSON **array of `PlanComment`** (each carrying `message`, the full `anchor`,
  `status`, `resolutionTarget: "agent"`, `createdBy: "human"`, thread linkage). Empty array deletes
  the file.
- The app's UI persists reviewer comments through this same action in local mode
  (`app/hooks/use-plans.ts` `useUpdateLocalPlanComments` → `"update-local-plan-comments"`,
  "persists to the local folder's `comments.json` (DB-free) so comments survive a refresh in
  `/local-plans/:slug`").

So in a self-hosted local Plan app, a reviewer highlighting prose and commenting lands a structured,
agent-addressed comment in `PLAN_LOCAL_DIR/<slug>/comments.json` on our own disk. T3 Code can
`fs.watch`/poll that file, read the new open comments + their anchors, and serialise them into the
next user turn — **exactly our existing review-comments-into-prompt model**, with **no MCP and no
`get-plan-feedback`**.

**Second seam (embedded mode):** the `agent-native-plan-annotate` `postMessage` (§2) delivers the
anchor to the host in real time, but carries only the selection/anchor (the host owns the comment
text), so it's less turnkey than the file.

**By contrast, the MCP/hosted path** (`get-plan-feedback`, `consume-plan-feedback`,
`update-visual-plan`) is the _only_ channel in the **hosted** and **local-files-bridge** modes —
and adopting it means wiring those MCP tools into every agent session and polling, which is the
model our feature is explicitly designed to avoid.

---

## 5. MDX authoring without the hosted DB

**Yes — fully local, no hosted writes.** `skills/visual-plans/references/local-files.md` is the
"canonical contract for fully local, no-database planning": the agent writes `plans/<slug>/` (or
`.agent-native/plans/<slug>/`) containing `plan.mdx`, optional `canvas.mdx`, optional
`prototype.mdx`, optional `.plan-state.json`, and validates with
`npx @agent-native/core plan local check|verify`. It explicitly forbids calling any hosted tool
except the block-catalog lookup.

**`get-plan-blocks` (the block catalog) needs no auth/network:**

- It's a **public no-auth route** — `templates/plan/server/lib/public-action-paths.ts` lists
  `/_agent-native/actions/get-plan-blocks`.
- It can also run **fully offline**: `npx @agent-native/core plan blocks --out plan-blocks.md`, or
  fall back to the bundled `skills/visual-plans/references/*.md`. It "sends no plan content."
- The catalog itself is generated from the local registry (`get-plan-blocks.ts` →
  `shared/plan-block-registry.ts`), so the schema is in the code we can read, not behind a service.

---

## 6. Renderer reusability

**Mixed — the best-case reuse is real but needs an import-weight check.**

- **The block library is a published MIT package.** Block schemas + MDX parse/serialize config live
  in `@agent-native/core/blocks/server`, and the **React `Read`/`Edit` components** in
  `@agent-native/core/blocks` (`packages/core/package.json` exports `"./blocks"` and
  `"./blocks/server"`). `templates/plan/shared/plan-block-registry.ts` shows the app registers the
  **shared** library (`registerLibraryBlockConfigs`) and adds _no_ app-only blocks — i.e. the ~20
  block types (checklist, table, tabs, columns, code, annotated-code, diff, file-tree, data-model,
  api-endpoint, openapi-spec, json-explorer, diagram, mermaid, wireframe, callout, decision,
  question-form, custom-html, …) are all in core, not welded into the template.
- **But the plan-document renderer + annotation UI are template (clone-and-own) code, not a
  package.** `app/components/plan/PlanContentRenderer.tsx` imports `@agent-native/core/blocks` and
  `@agent-native/core/client` (`useT`, `RichMarkdownCollabUser`), and the annotation surface is
  `PlansPage.tsx` — a **~12,000-line** file. There is no published "plan renderer" npm package; you
  either clone the template (W2) or build the shell yourself and pull in `core/blocks` (R).
- **Open risk:** consuming `@agent-native/core/blocks/client` likely drags in `core/client`'s
  runtime assumptions (i18n `useT`, collab types, possibly React Router / TanStack). Whether that
  imports cleanly into T3 Code's `apps/web` without adopting a chunk of their framework is the one
  thing to verify before committing to "R depends on core/blocks." If it's too heavy, R falls back
  to reimplementing the handful of block types we actually need.

---

## Recommendation

Scoring the three options **for T3 Code specifically**, weighed against the decisive constraint:
_our feature's whole value is reviewer feedback injected as a **user turn inside T3 Code**, not the
agent polling `get-plan-feedback` via MCP._

### W1 — Embed hosted app + adopt their MCP feedback loop — **REJECT**

- **Feasibility:** low-effort to embed, but forces the MCP feedback model.
- **Costs us:** wiring `get-plan-feedback`/`update-visual-plan` MCP tools into **every** agent
  session and polling them; plan content leaves the machine to `plan.agent-native.com`; hosted
  auth/accounts for commenting; a hard external runtime dependency.
- **Buys us:** zero renderer/annotation work.
- **Biggest risk:** it directly contradicts the feature's reason to exist (native user-turn
  injection) and puts our core review loop behind a third-party hosted service + their MCP contract.
  Fails the constraint outright.

### W2 — Self-host their app locally + iframe + bridge feedback — **VIABLE FALLBACK / PROTOTYPE**

- **Feasibility:** medium. Run `templates/plan` as a local sidecar with `PLAN_LOCAL_DIR`, iframe its
  `/local-plans/:slug` route.
- **Costs us:** operating and **forking a heavy React Router app** we don't control (clone-and-own
  template, not a semver dep → manual upstream merges forever); a foreign-UX island inside T3 Code
  (its own theme, routing, TanStack state, i18n); process/lifecycle management of a second app;
  Node `node-pty`/xterm and other template baggage we don't need.
- **Buys us:** their **entire** renderer + the ~12k-line annotation UI + the full rich anchor model,
  immediately. And — the decisive discovery — the feedback bridge is **cheap**: watch/read
  `comments.json` beside `plan.mdx` and serialise open agent-targeted comments into the next user
  turn. **No MCP required.** This is the one thing that makes wrapping compatible with our
  constraint at all.
- **Biggest risk:** long-term maintenance of a large forked app and UX integration friction — an
  iframe that looks and behaves like a different product embedded in ours, hard to make feel native,
  and hard to keep current as their template churns (its `changelog/` shows near-daily changes).

### R — Reimplement first-party, adopting only the MDX block schema + file contract — **RECOMMENDED**

- **Feasibility:** medium-high effort, but sharply scopable. Adopt as fixed contracts: the MDX file
  layout (`plan.mdx`/`canvas.mdx`/`prototype.mdx`), the block schema (via `get-plan-blocks` /
  `core/blocks`), the `PlanCommentAnchor` shape, and the `comments.json` sidecar shape. Reimplement:
  the plan-document shell, the **text-quote/point annotation layer** (the algorithm is handed to us
  in `anchorFromRange` + `comment-context.ts`), and the native **comment→user-turn** wiring.
  **Best case:** depend on `@agent-native/core/blocks` (MIT) for the ~20 block renderers instead of
  rebuilding them (pending the §6 import-weight check).
- **Costs us:** building the renderer shell + annotation UX; matching high-fidelity **canvas /
  wireframe / prototype** surfaces (Excalidraw-based) is real work — so **defer** that to a later
  tier. The `/visual-plan` skill itself says architecture/backend plans are **document-only** and
  only UI/product plans need the canvas, so a **document-renderer-first** first cut covers the
  majority case and doesn't foreclose canvas later (we can embed Excalidraw directly — MIT, already
  their choice — when we get there).
- **Buys us:** the feedback loop is **native with zero bridging** — a reviewer's comment is already
  in our React state and goes straight into the next user message, which is the exact capability the
  feature exists to deliver. Native theme/state/perf/reliability inside `apps/web`; we own the code
  (aligns with T3 Code's "own the code / minimal surface / performance-first" priorities); no second
  runtime, no forked app to shadow-maintain, no plan content leaving the machine.
- **Biggest risk:** keeping pace with their evolving **block schema**, and the annotation
  reimplementation being subtly wrong on edge cases (ambiguous/detached quotes — though their
  `ambiguous`/`detachedThreads` handling is documented and copyable). Mitigated by treating
  `core/blocks` as the schema source of truth and porting their anchor helpers.

### Recommended path

1. **Reject W1.** It inverts our feedback model.
2. **Do R, document-renderer-first.** Adopt the MDX block schema + file contract +
   `PlanCommentAnchor` + `comments.json` shapes as-is; reuse `@agent-native/core/blocks` for block
   rendering if the import-weight check (§6) passes, else port only the block types we need;
   reimplement the text-quote annotation and wire comments natively into the user-turn injection we
   already have. Defer canvas/wireframe/prototype fidelity to a second tier (embed Excalidraw when
   needed).
3. **Use W2 as a 1–2 day de-risking spike _before_ committing R's annotation UX**: stand up
   `templates/plan` locally, iframe `/local-plans/:slug`, and confirm the `comments.json`
   watch→user-turn loop end-to-end. This both validates the interaction design cheaply and gives us
   a working fallback if R's renderer proves costlier than expected. The same `comments.json` seam
   powers both, so the spike is not throwaway.

---

## Honest gaps (could not fully determine from static source)

- **Embedded-mode comment-popover ownership** (parent vs. iframe) is inferred from the
  `postMessage` types; confirming it requires actually running the app embedded. The recommended
  wrap path (standalone app + iframe its own route + read `comments.json`) sidesteps this.
- **`comments.json` write timing/atomicity** for reliable `fs.watch` vs. polling wasn't traced to
  the fs call's flush semantics — validate in the W2 spike.
- **`@agent-native/core/blocks/client` import weight** into T3 Code's `apps/web` (does it transitively
  require React Router / TanStack / i18n?) — the single most important thing to verify before
  banking on "R reuses core/blocks."
- **Full block-type enumeration and per-block schema depth** were sampled (registry + skill), not
  exhaustively catalogued; a complete port list should be generated from `get-plan-blocks --format
schema` when scoping R.
- Root `LICENSE` hygiene: README + packages say MIT, root `package.json` says ISC, no root LICENSE
  file. Treat as MIT but confirm with BuilderIO if licence certainty is load-bearing.
