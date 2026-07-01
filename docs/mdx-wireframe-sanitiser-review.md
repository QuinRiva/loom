---
manager_sessions:
  - id: e3268574-9301-4add-8c3f-50601b039539
    role: review
    authored_at: 2026-07-01T08:55:53.210Z
---

# MDX Wireframe Sanitiser — Independent Security Review

**Scope:** Phase 4 C1 wireframe artboard (`<Screen>`), which renders model/foreign
`.mdx`-authored HTML into the **live authenticated app DOM** via
`dangerouslySetInnerHTML`, guarded by `sanitizeWireframeHtml`. Per decision D9,
foreign `.mdx` is in scope, so this HTML is attacker-controlled and a sanitiser
bypass = XSS in the user's T3 Code session.

**Reviewer:** independent (did not author the code). Adversarial posture.

**Files reviewed**

- `apps/web/src/components/files/mdx-plan/sanitizeWireframeHtml.ts`
- `apps/web/src/components/files/mdx-plan/blocks/screen.tsx`
- `apps/web/src/components/files/mdx-plan/wireframe.test.ts`
- `apps/web/src/index.css` (`.wf-surface` artboard containment)
- Compared against BuilderIO `agent-native` `sanitize-html.ts` (MIT).

**Method:** the port's own tests pass (`10 passed`), but jsdom does **not**
replicate the browser's foreign-content parsing, SVG SMIL, or CSS cascade — the
places mXSS/clickjacking live. So I reimplemented the exact
`sanitizeWireframeHtml → stampWireframeNodes → innerHTML` pipeline **verbatim**
and ran adversarial payloads in **real Chromium** (via the browser tool),
detecting execution with a `window.__PWNED` sink and `getComputedStyle`.

---

## Verdict: 🔴 DON'T SHIP as-is — one confirmed XSS blocker

The DOMParser-based tag/attribute sanitiser is **sound against the classic
mutation-XSS corpus** I threw at it (mathml/svg `<style>` namespace confusion,
`<noscript>`, `<template>`, `annotation-xml`, `<xmp>` — none executed; see
"Cleared" below). The double-parse introduced by `stampWireframeNodes` does
**not** add mXSS risk (serialising an already-parsed, sanitised tree is
idempotent under re-parse).

But there is **one confirmed arbitrary-JS execution path** (SVG SMIL animation
of `href`) and a **defeated clickjacking guard** (three independent bypasses).
The blocker must be fixed before foreign `.mdx` renders in the live session.

---

## 🔴 Blocker

### B1 — SVG `<animate>`/`<set>` rewrites `href` to `javascript:` at runtime → confirmed XSS

`sanitizeWireframeHtml` validates URL schemes only on **static** attributes at
sanitise time (`isSafeUrl` over `URL_ATTRS`). SVG SMIL animation elements
(`<animate>`, `<set>`, `<animateTransform>`, …) are **not** in `BLOCKED_TAGS`,
and their `values`/`to`/`from` attributes are **not** in `URL_ATTRS`. So an
attacker animates a link's `href` into a `javascript:` URL _after_ sanitisation;
clicking the link executes it.

**Payload** (`sanitizeWireframeHtml.ts:BLOCKED_TAGS` / `URL_ATTRS` — the gap is
that neither covers SMIL):

```html
<svg width="300" height="80">
  <a>
    <animate
      attributeName="href"
      to="javascript:/* attacker JS */"
      begin="0s"
      dur="999s"
      fill="freeze"
    />
    <rect width="300" height="80" fill="gray" />
    <text x="20" y="40">Sign in</text>
  </a>
</svg>
```

Real-Chromium result through the full `<Screen>` pipeline
(`sanitizeWireframeHtml` → `stampWireframeNodes` → `innerHTML`): the `<animate>`
survives verbatim, and dispatching a click on the `<a>` produced
**`window.__PWNED = ["ANIMATE-CLICK"]`** — arbitrary JS ran. `<set attributeName="href" to="javascript:…">` is the same class and also survives.

**Impact:** arbitrary JS in the authenticated T3 Code session (session token,
cookies, RPC-as-the-user). Gated only by a single click on attacker-controlled
link text — and the wireframe surface _invites_ clicks (buttons, "Sign in",
"Continue"). This is the highest-severity finding.

**Provenance:** inherited from BuilderIO's original — its `sanitizeWireframeHtml`
has the identical gap (even `sanitizeDiagramHtml`, which additionally strips
`math`/`foreignObject`, does not touch SMIL). It is **not** a port regression,
but it _is_ a live blocker here because D9 puts foreign `.mdx` in scope and this
renders into the live DOM, not a sandbox.

**Fix (cheapest, and correct for a static read surface):** add the SMIL
animation elements to `BLOCKED_TAGS` — they have no legitimate purpose in a
low-fidelity wireframe artboard:

```
…,marquee,portal,animate,set,animatetransform,animatemotion,animatecolor
```

(`querySelectorAll` tag matching is case-insensitive for HTML-parsed content;
verify the selector matches the SVG-namespaced elements — a belt-and-braces
alternative is to also drop, in `sanitizeElementAttributes`, any
`attributeName` whose value is `href`/`xlink:href` on animation elements, but
outright removal is simpler and loses nothing.) Add a regression test with the
payload above asserting `<animate>`/`<set>` are gone.

---

## 🟠 Should-fix

### S1 — Clickjacking / UI-redress guard (`DANGEROUS_VIEWPORT_CSS`) is defeated 3 ways

The module's docstring explicitly claims to strip "viewport escapes
(`position:fixed`/`sticky`, huge `z-index`) that could overlay the host app
(clickjacking / UI-redress)". That guarantee does **not** hold. All three
confirmed in real Chromium via `getComputedStyle` on an element injected through
the pipeline:

1. **CSS comment obfuscation** — `style="position/**/:/**/fixed;inset:0"` is not
   matched by `DANGEROUS_VIEWPORT_CSS` (raw-string regex), survives, and
   **computes to `position: fixed`**.
2. **CSS escape obfuscation** — `style="position:\66\69\78\65\64"` (`= fixed`)
   likewise survives and **computes to `position: fixed`**. (BuilderIO decodes
   CSS escapes via `decodeCssSafetyEscapes`/`cssSafetyText` only in the dropped
   `sanitizeWireframeCss` _CSS-field_ path — the inline-`style` path in **both**
   BuilderIO and this port tests the raw string, so escapes/comments slip past.)
3. **`position:absolute` is not covered at all** — the regex only lists
   `fixed`/`sticky`. `style="position:absolute;inset:0;z-index:9999"` survives
   and computes to `position: absolute`. Because `.wf-surface` is
   **`position: static`** (`index.css:906` — `overflow:hidden` but no
   `position:relative`/`contain`), it is _not_ the containing block for
   absolutely-positioned descendants, so `inset:0` resolves against an ancestor
   /viewport and `overflow:hidden` does **not** clip it. The artboard's
   `overflow:hidden` gives a false sense of containment.

**Impact:** an authored wireframe can paint an invisible/opaque full-region
overlay over host-app chrome to hijack clicks or spoof UI. Lower severity than
B1 (no direct code-exec) but it breaks a stated security property.

**Fix options (defence-in-depth, pick per appetite):**

- Make `.wf-surface` a real containment box: `position: relative` **and**
  `contain: layout paint` (or `transform: translateZ(0)`), so `fixed`/`absolute`
  descendants are trapped and clipped. This is the robust structural fix and
  neutralises escape/comment tricks regardless of regex.
- Additionally decode CSS escapes + strip comments before the inline-style regex
  (port BuilderIO's `cssSafetyText`), and add `absolute` to the position arm.
- Belt-and-braces: parse the `style` value and allowlist properties rather than
  denylisting dangerous ones.

### S2 — `<xmp>` (and other raw-text elements) hide `onerror` from the attribute walker

`<xmp><img src=x onerror=…></xmp>` — inside `<xmp>` (a raw-text element, like
`<textarea>`/`<title>`/`<noembed>`) the `<img>` is **text, not an element**, so
`sanitizeElementAttributes`'s `querySelectorAll("*")` never sees it and the
`onerror` is **not stripped**. Confirmed: the sanitised output retains a live
`onerror=` string. It does **not** execute today because the `<img>` stays inert
text inside `<xmp>` on every re-parse (I verified `__PWNED` stays empty), and
`<xmp>` is not unwrapped anywhere in the pipeline. So it's a **latent** hazard,
not a live exploit — but it is a landmine: any future transform that unwraps or
re-hosts that content (a different injection context, a copy of `innerText` into
`innerHTML`, a serialiser that drops `<xmp>`) turns it into XSS. Recommend adding
`xmp` to `BLOCKED_TAGS` (it has no wireframe use) and noting the raw-text-element
class in a comment.

### S3 — `srcset` is not in `URL_ATTRS`

`<img srcset="… 1x">` / `<source srcset>` bypass URL scheme validation.
`srcset="javascript:… 1x"` survives sanitisation. Modern browsers do **not**
execute `javascript:` from `srcset` (it only accepts image candidate URLs), so
this is not a live exec vector, but it is an inconsistency with the stated
"every URL-bearing attribute is checked" intent and should be added to
`URL_ATTRS` for defence-in-depth (also covers `data:`/exfil-image cases).

---

## 🟡 Nice-to-have

- **N1 — Alpine/runtime directives not stripped in the wireframe path.**
  BuilderIO strips `@click`, `x-on:*`, `:on*`, `x-bind:*`, `:style` only via the
  dropped `stripRuntimeDirectives` (diagram path). Inert unless Alpine.js is
  loaded (T3 Code does not load it), so no live vector — but if any such runtime
  is ever added to `apps/web`, these become exec vectors. Cheap to port the
  directive strip as hardening.
- **N2 — `fallbackStrip` (SSR/no-DOMParser) is regex-only and weaker.** Not the
  live path (browser always has `DOMParser`; even the vitest jsdom SSR tests hit
  the DOM path), and its output is not injected as executing DOM, so low
  priority — but it does not decode entities and would miss the B1/S1/S2 classes
  entirely. Fine to leave, worth a comment that it is best-effort only.
- **N3 — Arbitrary `z-index` threshold (`>= 10000`).** `z-index:9999` passes the
  guard; combined with S1's `position` bypasses, any positive z-index suffices to
  stack over sibling content. Subsumed by the S1 structural containment fix.

---

## Cleared (probed, not exploitable) — so the report is honest about strength

Ran through the real-Chromium pipeline; **none executed** (`__PWNED` empty):

- **mXSS namespace confusion:** `<math><mtext><table><mglyph><style><img onerror>`,
  `<svg><style><img onerror>`, `<svg></p><style>…`, `<form><math><mtext></form>…`,
  `<math><annotation-xml encoding="text/html"><img onerror>`,
  `<svg><foreignObject><img onerror>`, `<svg><title|desc><style><img onerror>`,
  `<svg><p><style><img onerror>`. In Chromium's parser these expose the `<img>`
  as a real element during the sanitiser's walk, so `onerror` is stripped (or the
  node is dropped). The serialise→re-parse in `stampWireframeNodes` did not
  resurrect any of them.
- **`<noscript>`** content → blocked (`noscript` in `BLOCKED_TAGS`, removed with
  its subtree); the residual ends up entity-encoded inside an attribute.
- **`<template>`** content stays inert (and its attributes are recursed by
  `sanitizeElementAttributes`).
- **`<iframe srcdoc>`** → iframe removed entirely.
- **URL scheme obfuscation** (`java\tscript:`, `&#106;avascript:`, `data:text/html`,
  `data:image/svg+xml`) → dropped by `isSafeUrl` (browser-resolved scheme). Raster
  `data:image/png` kept. As tested.
- **Injection timing:** `ScreenRead` computes
  `useMemo(() => stampWireframeNodes(sanitizeWireframeHtml(data.html)), [data.html])`
  — sanitise **always** precedes stamp precedes inject; there is no render/memo
  path where raw `html` reaches the DOM. No TOCTOU window.

## Port vs BuilderIO (did the port weaken anything?)

- **No weakening of the core algorithm** — tag list, `URL_ATTRS`, `isSafeUrl`,
  attribute walk, and `SAFE_DATA_IMAGE` are byte-identical.
- **Port is stronger** on inline style: it applies `DANGEROUS_VIEWPORT_CSS` to
  the `style` attribute (BuilderIO applied it only in the CSS-field path).
- **Dropped, correctly, and confirmed unreachable:** `sanitizeWireframeCss`,
  `scopeDesignCss`, `sanitizeDiagramHtml`, `stripRuntimeDirectives`, and the
  `css`/diagram fields — the `<Screen>` block ships no `css` field and does not
  use the diagram path. **Gate for C3:** the design tier reintroduces
  `preserveThemeClasses` and (if it adds a `css`/`style` field or an SVG diagram
  surface) MUST bring back `sanitizeWireframeCss`/`scopeDesignCss` +
  `decodeCssSafetyEscapes` and the `math`/`foreignObject` strip. Re-review C3.
- **B1 (SMIL) and S1 (inline-style escape/comment) are inherited from BuilderIO,
  not introduced by the port** — but they are live here because of D9 + live-DOM
  injection.

## Test gaps (current `wireframe.test.ts` misses)

Add regression coverage for: (1) SVG `<animate>`/`<set>` href injection [B1];
(2) comment- and escape-obfuscated `position:fixed` and bare `position:absolute`
inline styles [S1]; (3) `<xmp>`/raw-text-element `onerror` retention [S2];
(4) `srcset` scheme validation [S3]. Note: assert these against a **real
browser** or at least document that jsdom under-tests SVG SMIL / CSS cascade /
foreign-content parsing, which is why the passing jsdom suite did not catch B1.

---

## Fix priority for ship

1. **B1** (block SMIL elements) — required before foreign `.mdx` renders live.
2. **S1** (make `.wf-surface` a real containment block; ideally also decode CSS
   escapes/comments + cover `absolute`) — required to honour the stated
   anti-clickjacking property.
3. **S2/S3** — cheap hardening, fold in with the above.
