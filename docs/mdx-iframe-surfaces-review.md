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
iframe `sandbox` + `srcdoc` CSP is the security boundary for these two surfaces
(unlike the wireframe surface, there is no sanitiser — the content lives in a
separate document, not the live parent DOM). The Prototype frame has an opaque
origin; the HtmlBlock frame is same-origin with no scripts, which adds a second
threat: a credentialed request to the app made _by the static HTML itself_ (§4).
A breakout = JS in the user's authenticated T3 Code browser session (cookies,
RPC-as-you), or a cookie-carrying request the user did not intend.

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

### 4. HtmlBlock — same-origin, zero JS (`sandbox="allow-same-origin"`, CSP with no `script-src` and no `'self'`)

HtmlBlock is same-origin so the annotation layer can read the frame's DOM and pin
a comment to text inside it (in-frame text-pin comments). That is safe only
because **nothing in the frame executes**: there is no `allow-scripts`, so inline
`<script>`, `on*` handlers, SVG `onbegin` and `javascript:` URLs are all inert, and
the only code touching that origin is the host's, which reads text and geometry.
`allow-same-origin` must never be combined with `allow-scripts` here (frame script
could then reach the parent and remove its own sandbox).

What same-origin does change: the frame's own requests are now same-site and
carry the app's cookies (`Sec-Fetch-Site: same-origin`). So every way static HTML
can issue a request is shut, and each path was confirmed in a real browser with a
cookie set on the parent:

| Path                                                                                                                                                                     | Closed by                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<img>`, `srcset`, `<input type=image>`, `<video>`/`poster`, CSS `url()` / `background`, `@import`, `@font-face`, `<link>`                                               | CSP `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:` — no `'self'`, which would now mean the app (`FAILED csp`, no request sent)  |
| nested frames, `<object>`/`<embed>`, SVG `<use>`/`<image>` (including SMIL-animated `href`)                                                                              | `frame-src 'none'`, `object-src 'none'`, `img-src data:`                                                                                                        |
| `<form action>`                                                                                                                                                          | no `allow-forms` + `form-action 'none'`                                                                                                                         |
| `<meta http-equiv="refresh">`, `<base href>`                                                                                                                             | stripped before load by `inertSrcDoc` (CSP has no navigation directive); `base-uri 'none'`                                                                      |
| link clicks — `<a>`, `<area>`, SVG `<a>`, including an `href` that only appears after parse (declarative shadow DOM, SMIL `<set attributeName="href">`) and middle-click | `blockLinkActivation`: a capture-phase `click`/`auxclick` guard cancels any activation whose composed path crosses an `<a>`/`<area>`; `<details>` still toggles |
| popups / top navigation                                                                                                                                                  | no `allow-popups`, no `allow-top-navigation`                                                                                                                    |

Residual: a click in the few milliseconds between first paint and the frame's
`load`, before the link guard is attached. `<Prototype>` is unchanged: opaque
origin, whole-block comments only.

### 5. Ratify the D9 HtmlBlock no-sanitiser deviation — **RATIFY**

D9's DROP rule ("for a fully-isolated sandbox, drop the redundant sanitise") was
written for the _prototype_, which **runs JS**. `HtmlBlock` runs **no** JS, so the
same rationale applies. A full sanitiser would still add nothing; the two
same-origin paths a sanitiser was never designed to see (an `href` arriving after
parse) are closed at activation instead (§4). Enumerating what a sanitiser would
have added, against what the boundary already neutralises:

| Sanitiser would strip…                                        | Already neutralised by                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<script>` / event handlers / `javascript:`                   | no `allow-scripts` + no `script-src` — **zero JS** (§4)                                                                                                                                                                                |
| remote / same-origin resources, tracking pixels               | CSP `default-src 'none'`, `data:` images and fonts only, no `'self'` (§4)                                                                                                                                                              |
| forms                                                         | no `allow-forms` + `form-action 'none'`                                                                                                                                                                                                |
| navigation / top redirect                                     | meta refresh and `<base>` stripped, link activation cancelled, no `allow-top-navigation` (§4)                                                                                                                                          |
| **dangerous CSS clickjacking overlays**                       | content is in a **separate srcdoc document**, clipped to the sized in-flow iframe box — it cannot paint over parent chrome (§6). The wireframe surface needs this because it injects into the **live parent DOM**; HtmlBlock does not. |
| reserved `data-plan-*` / `data-wf-node` pollution (SF1 class) | same — iframe content is a separate document, so the parent's annotation id namespace cannot be polluted (the host reads the frame; it never imports its nodes)                                                                        |

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
  non-opaque origin + prompt), and the same-origin HtmlBlock frame has no script to
  request them, so this is documentation-as-code more than a real gate.

Both are optional; neither changes the ship decision.

---

## Test run

`vp test apps/web/src/components/files/mdx-plan/` → **6 files, 92 tests passed** (9.1s).
The suite locks the load-bearing invariants (no `allow-same-origin` on prototype;
`allow-same-origin` alone + no `script-src` + no `'self'` on HtmlBlock; srcdoc CSP
contents; the load-time navigation strip and link-activation guard; whole-block annotatability;
MDX round-trip; real `plan.mdx` compiles end-to-end). Static assertions are a correct but
_insufficient_ proxy for runtime behaviour — this review adds the real-browser runtime
confirmation the build thread did not drive.

---

_Static-only claims (everything else was run in a real browser): srcDoc attribute-escaping
(source + existing test) and the absence of a parent `message` listener (grep over
`apps/web/src`)._
