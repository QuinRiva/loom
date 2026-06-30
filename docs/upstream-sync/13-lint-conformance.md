# 13 — Lint conformance (Phase 2.6b)

After the upstream merge, `vp check` reported **27 errors + 24 warnings**. These
were upstream's stricter custom lint conventions now applying to pre-existing
Pi-feature fork code that never conformed (the pre-merge fork used the same named
node imports). Conforming the Pi code to upstream's conventions is the intended
outcome — it keeps future upstream pulls low-conflict. This pass was purely
convention conformance: **no runtime behaviour changed.**

Final state: `vp check` **exits 0** (0 errors, 15 non-blocking warnings).
`vp run typecheck` 0 across all 15 packages; `pnpm build` passes.

## Fixed — all 27 errors (`t3code(namespace-node-imports)`)

Converted named `node:*` builtin imports to namespace imports (matching upstream's
idiom, e.g. `import * as NodeFS from "node:fs"` and call sites `NodeFS.readFileSync`).
The `@effect-diagnostics nodeBuiltinImport:off` pragmas already present on some files
suppress a *different* (effect) rule, not this oxlint rule, so they did not help.

Naming used (upstream convention): `node:fs`→`NodeFS`, `node:fs/promises`→`NodeFSP`,
`node:path`→`NodePath`, `node:os`→`NodeOS`, `node:crypto`→`NodeCrypto`,
`node:child_process`→`NodeChildProcess`, `node:string_decoder`→`NodeStringDecoder`,
`node:module`→`NodeModule`.

Files (13): `orchestration/roleOverlay.ts` + `.test.ts`, `orchestration/stallContext.ts`,
`orchestration/threadResolve.ts` + `.test.ts`, `orchestration/workstreamAsk.ts`,
`provider/Drivers/PiDriver.ts`, `provider/Drivers/Pi/GoalTaskExtension.ts`,
`provider/Drivers/Pi/WorkstreamSpawnExtension.ts`, `provider/Layers/Pi/Cli.ts`,
`provider/Layers/Pi/OneShotCompletion.ts`, `provider/Layers/Pi/RpcProcess.ts`,
`vcs/http.ts`. (Array `.join`/Promise `resolve` locals and `.join` inside the
extension `String.raw` templates were deliberately left untouched.)

## Fixed — cheap/unambiguous warnings

- **`t3code(no-inline-schema-compile)` (7)** — hoisted the rebuilt-per-call
  `Schema.decodeUnknownResult(...)` / `Schema.encodeUnknownResult(...)` to
  module-scope consts (upstream idiom). Files: `mobile/connection/catalog-store.ts`
  (2), `mobile/connection/storage.ts` (5).
- **`eslint(no-unused-vars)` (1)** — removed the unused `import * as Layer` in
  `mcp/GoalHandoffHttp.ts`.
- **`eslint(no-unsafe-optional-chaining)` (1)** — `decider.attentionTerminal.test.ts`:
  `list[1]?.payload` → `list[1]!.payload` (the test already asserts the 2-element
  shape; removes the unsafe `?.`-then-member-access).

## Deliberately left — 15 non-blocking warnings (documented)

`vp check` exits 0; these are warnings only.

- **`react(no-unstable-nested-components)` (13)** — `ChatMarkdown.tsx` (7),
  `CommandPalette.tsx` (2), and mobile `ThreadFilesRouteScreen` / `ReviewSheet` /
  `ThreadTerminalRouteScreen` / `ThreadRouteScreen` (4). These are render-prop
  functions (e.g. `icon: (project) => <ProjectFavicon …/>`) and inline renderers
  inside large components. Hoisting them is a non-trivial refactor (threading props
  through, restructuring closures) with real regression risk, and the brief
  authorises leaving them documented when hoisting is risky/large. No behaviour
  impact; revisit opportunistically.
- **`react(no-array-index-key)` (2)** — `chat/ComposerQueuedMessages.tsx`. These map
  over `ReadonlyArray<string>` ephemeral steering/follow-up queues that have **no
  stable id and can contain duplicate strings**. The list index *is* the correct
  positional identity here; keying on the (mutable, possibly-duplicate) message
  content would introduce duplicate-key reconciliation bugs — a behaviour
  regression. (oxlint only flags `.map`, not `Array.from`, which is why the
  equivalent `Array.from(text,(c,i)=>…)` key in `ChatMarkdown.tsx:861` is not
  flagged.) Left as-is per "behaviour-preserving only".

## Verification

| Check | Result |
| --- | --- |
| `vp check` | **exit 0** — 0 errors, 15 warnings (1942 files) |
| `vp run typecheck` | **exit 0** — 0 errors across all 15 packages |
| `pnpm build` | **exit 0** — all builds complete |
