---
manager_sessions:
  - id: 2e36aea1-48d6-4aec-919b-e44a0453eb5b
    role: security-review
    authored_at: 2026-07-01T10:20:36.551Z
---

# MDX iframe surfaces — independent security review (Phase 4 B5 + C4)

**Reviewer:** independent security reviewer sub-thread (did **not** author the code).
**Scope:** `<Prototype>` (C4, interactive) + `<HtmlBlock>` (B5, static) sandboxed
iframe surfaces on `t3code/pivot-plannotator-to-mdx` @ `aa93d143d`.
**Files:** `apps/web/src/components/files/mdx-plan/blocks/sandboxedFrame.tsx`,
`registry.tsx` (2 registry rows), `annotation/anchoring.ts` (NON_PROSE additions),
`sandboxedFrame.test.ts`.

**Threat model (D9):** foreign `.mdx` is in scope, so plan HTML is untrusted. The
iframe `sandbox` + `srcdoc` CSP is the **entire** security boundary for these two
surfaces (unlike the wireframe surface, there is no sanitiser — the content lives
in a separate opaque-origin document, not the live parent DOM). A breakout = JS in
the user's authenticated T3 Code browser session (cookies, RPC-as-you).

---

## Verdict: **SHIP** ✅

Both surfaces hold the boundary. Every breakout, escape, and exfil path I
constructed was blocked in a **real browser** (Chromium via the browser tool). No
Blockers, no Should-fixes. Two Nice-to-haves and one governance note below.

**HtmlBlock no-sanitiser deviation: RATIFY** (technically sound — see §5). One
caveat: D9's user-confirmed line said HtmlBlock = "locked-down iframe + sanitise",
and the build dropped the sanitiser. I assess the drop as correct and _more_ aligned
with the project's minimal-surface rule than keeping it — but because the "+ sanitise"
wording was ratified verbatim with the user, the parent should get a one-line user
acknowledgement of the drop. **Not a ship blocker.**

**Method:** all six probe groups were **run in a real browser** against faithful
reproductions of the exact `buildSrcDoc()` output + the exact `sandbox`/CSP strings
(harness reproduced `sandboxedFrame.tsx` byte-for-byte). A `localhost:9911` sink
server recorded network egress. `postMessage` (allowed even from an opaque origin)
carried each in-frame probe result back to the parent. The only statically-reasoned
claims are the srcDoc attribute-escaping and the absence of a parent `message`
listener, both cross-checked against source + the existing test.

---

## Probe results (all confirmed in a real browser)

### 1. Opaque-origin isolation — Prototype (`sandbox="allow-scripts allow-forms"`, **no** `allow-same-origin`)

From inside the running prototype frame, every parent-reach threw or returned null:

| Attempt                                             | Result                     |
| --------------------------------------------------- | -------------------------- |
| `window.origin`                                     | `"null"` — opaque origin ✓ |
| `parent.document`                                   | `BLOCKED: SecurityError` ✓ |
| `window.top.location.href`                          | `BLOCKED: SecurityError` ✓ |
| `window.parent.__secret` (real value set on parent) | `BLOCKED: SecurityError` ✓ |
| `document.cookie`                                   | `BLOCKED: SecurityError` ✓ |
| `localStorage.setItem`                              | `BLOCKED: SecurityError` ✓ |

The parent's `window.__secret = "TOP-SECRET-PARENT-VALUE"` was never readable. This
reproduces the scoping spike §7.1 result against _this_ component's real srcDoc/CSP.

### 2. Escape via sandbox tokens

With `allow-scripts allow-forms` only (no `allow-same-origin`/`allow-popups`/`allow-top-navigation`):

- **Top navigation:** `window.top.location = …` → `SecurityError`; console: _"The frame
  attempting navigation of the top-level window is sandboxed, but … 'allow-top-navigation' …
  is not set."_ ✓
- **Popups:** `window.open(…)` → returned `null`; console: _"Blocked opening … because …
  'allow-popups' permission is not set."_ ✓
- **Form exfil:** `<form action="http://localhost:9911/…"><…>.submit()` → CSP: _"Sending
  form data … violates … form-action 'none'. The request has been blocked."_ ✓ (no sink hit)

### 3. CSP efficacy (Prototype)

`default-src 'none'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; …`:

- **Remote script** (`<script src=http://localhost:9911/remote.js>`) → CSP-blocked
  (`script-src 'self' 'unsafe-inline'`; no remote origin) — `onerror`, network `FAILED csp`. ✓
- **Remote img exfil** → CSP-blocked (`img-src 'self' data:`), network `FAILED csp`. ✓
- **`fetch()`** → `TypeError` (connect-src via `default-src 'none'`). ✓
- **`XMLHttpRequest`** → `onerror`, network `FAILED csp`. ✓
- **`WebSocket`** → `onerror`. ✓
- **`navigator.sendBeacon`** → returned `true` (the browser's known _optimistic_ return),
  **but nothing reached the sink** — CSP blocked the actual connection. ✓
- **CSP-relaxation bypass** — author body injecting a _second_ `<meta http-equiv="CSP"
content="img-src *; default-src *">` then loading a remote pixel → **still blocked**
  (multiple CSP policies combine as intersection; a later policy cannot loosen the head
  policy). ✓
- **Sink server total hits across all probes: 0.** Nothing left any frame.

**`'unsafe-inline'` assessment (Prototype only):** required — an interactive prototype's
whole point is inline JS/handlers. It is _bounded_: opaque origin (no session reach) +
`script-src` has **no remote origin** (no CDN pull / phone-home) + `default-src 'none'`
(no network egress at all). Inline JS can animate the frame's own DOM and nothing else.
**Acceptable.**

### 4. HtmlBlock zero-JS (`sandbox=""`, CSP with no `script-src`)

Every JS entry point was inert — the parent received **zero** messages from this frame:

- inline `<script>` → _"Blocked script execution … 'allow-scripts' permission is not set."_ ✓
- `<img onerror=…>` → not fired (no JS) ✓
- `<svg><animate onbegin=…>` → not fired ✓
- `javascript:` `<a href>` → cannot auto-fire; `javascript:` navigation is inert under `sandbox=""` ✓
- remote `<img>` → CSP-blocked, network `FAILED csp` ✓

No script, no network, no forms (`sandbox=""` has no `allow-forms`), no navigation.

### 5. Ratify the D9 HtmlBlock no-sanitiser deviation — **RATIFY**

D9's DROP rule ("for a fully-isolated sandbox, drop the redundant sanitise") was written
for the _prototype_, which **runs JS**. `HtmlBlock` is strictly **more** locked down
(`sandbox=""` — no JS at all), so the same rationale applies _a fortiori_. Enumerating
what a sanitiser would have added, against what the sandbox+CSP+iframe-isolation already
neutralise:

| Sanitiser would strip…                                        | Already neutralised by                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<script>` / event handlers / `javascript:`                   | `sandbox=""` + no `script-src` — **zero JS** (§4)                                                                                                                                                                                      |
| remote resources / tracking pixels                            | CSP `default-src 'none'`, `img-src 'self' data:` (§4)                                                                                                                                                                                  |
| forms                                                         | no `allow-forms` + `form-action 'none'`                                                                                                                                                                                                |
| navigation / top redirect                                     | no `allow-top-navigation`                                                                                                                                                                                                              |
| **dangerous CSS clickjacking overlays**                       | content is in a **separate srcdoc document**, clipped to the sized in-flow iframe box — it cannot paint over parent chrome (§6). The wireframe surface needs this because it injects into the **live parent DOM**; HtmlBlock does not. |
| reserved `data-plan-*` / `data-wf-node` pollution (SF1 class) | same — iframe content is isolated from the parent's annotation id namespace, so SF1 cannot recur here                                                                                                                                  |

The sanitiser would be **pure redundancy** — exactly the "over-defensive coding to avoid"
(AGENTS.md minimal-surface). **Ratify the drop.** _Governance caveat:_ the "+ sanitise"
phrasing in D9 was user-confirmed, so surface the drop to the user for a one-line ack;
it is sound regardless.

### 6. Host component (`SandboxedHtmlFrame`) — no capability leak

- **No `postMessage` listener anywhere in `apps/web/src`** trusts these frames (grep:
  no `addEventListener("message"`/`onMessage` handler). A hostile frame's `postMessage`
  falls on the floor — inert. ✓
- **No `ref`/imperative handle** to the iframe is exposed. ✓
- **Sizing ≠ overlay:** the `<iframe>` is `block w-full` in normal document flow with an
  author `height` (zod-capped `≤4000`), inside a `overflow-hidden` `<figure>`. No
  `position:absolute/fixed` anywhere. A tall frame just scrolls in-flow; it cannot float
  over parent UI → **no clickjacking / UI-redress of the parent.** ✓
- **srcDoc injection into the parent context:** `srcDoc` is set via React's `srcDoc`
  prop, which HTML-escapes the attribute value, so author HTML containing `">`/`</iframe>`
  cannot break out of the attribute into the parent document (confirmed by the existing
  test: _"inline `<script>` is confined to the srcdoc, escaped into an attr"_). The CSP
  string is a constant, not author-controlled. ✓

---

## Findings

**Blockers:** none.
**Should-fix:** none.

**Nice-to-have (optional, defense-in-depth — not required to ship):**

- **N1 — Add `referrerpolicy="no-referrer"` to the iframe** (`sandboxedFrame.tsx` ~L106).
  With `default-src 'none'` there is no egress anyway, so this is belt-on-belt; cheap if
  you want it explicit.
- **N2 — Consider an explicit Permissions-Policy `allow=""` on the iframe.** An opaque-origin
  sandboxed frame already cannot obtain camera/geolocation/etc. (they need a secure,
  non-opaque origin + prompt), so this is documentation-as-code more than a real gate.

Both are optional; neither changes the ship decision.

---

## Test run

`vp test apps/web/src/components/files/mdx-plan/` → **6 files, 92 tests passed** (9.1s).
The suite locks the load-bearing invariants (no `allow-same-origin` on prototype; empty
`sandbox` + no `script-src` on HtmlBlock; srcdoc CSP contents; whole-block annotatability;
MDX round-trip; real `plan.mdx` compiles end-to-end). Static assertions are a correct but
_insufficient_ proxy for runtime behaviour — this review adds the real-browser runtime
confirmation the build thread did not drive.

---

_Static-only claims (everything else was run in a real browser): srcDoc attribute-escaping
(source + existing test) and the absence of a parent `message` listener (grep over
`apps/web/src`)._
