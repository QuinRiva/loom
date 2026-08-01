# AGENTS.md

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `vp run lint:mobile` must also pass.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.

## Shipping changes (commit, PR, merge)

The canonical procedure (branch → commit → rebase → PR → merge → cleanup, plus
this repo's fork/worktree gotchas) lives in
[`docs/operations/shipping.md`](docs/operations/shipping.md) — the single source
of truth. Run the mechanical sequence with `pnpm ship -m "<summary>"` (it is
encoded in `scripts/ship.ts`); the `ship` skill loads the procedure inline and
`roles/shipper.md` is the delegated path. In a workstream, spawn a `shipper`
child once the work is approved or ship inline via the `ship` skill; outside a
workstream, follow the doc directly. Do not ship until the user has approved
shipping the change.

**Merge authority is per-project**, declared in `.t3code/ship.json` (resolved by
walking up from the working directory) and injected into every thread's system
prompt as the SHIPPING POLICY block. The platform default is `human` — agents
open the PR and stop for a human to review and merge; **loom itself is `agent`**,
so the flow above carries through the merge. Never merge under a `human` policy,
even when a brief's definition of done says "merged". See
[`docs/operations/shipping.md`](docs/operations/shipping.md) for the policy shape
and rationale.

Shipping ends at the merge. **Deploying to the production VM is a separate,
human-initiated act** — never deploy as part of finishing a change unless the
user explicitly asks for a deploy. When asked, the mechanism lives in
`~/loom-releases/RUNBOOK.md` (loom-slack-bridge repo); never run a raw in-place
`pnpm cockpit:build`.

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Database migrations

Migrations run in two independent ledgers. Loom migrations are **numbered `1001+`**
and registered in `apps/server/src/persistence/LoomMigrations.ts`; upstream's
`Migrations.ts` is kept byte-identical to upstream, so never edit it and never
number a fork migration below `1000` (doing so silently disables future upstream
migrations on existing databases). Rationale and the reconciliation design are in
[`docs/upstream-sync/22-migration-lane-split-plan.md`](docs/upstream-sync/22-migration-lane-split-plan.md).

## Loom UI state conventions

Loom UI state belongs to one of four tiers, and automatic surface openers must _seed_ state without ever _overriding_ a user's persisted choice. Before adding client UI state, classify it against [`docs/architecture/loom-ui-state-tiers.md`](docs/architecture/loom-ui-state-tiers.md) (tier table, seed-not-override write policy, the retained plan-auto-open exception, and the orphan-key note).

## Live frontend verification

UI-affecting changes should be verified live in the browser, not just by static checks. Two paths:

- **Full app — dev-verify recipe** ([`docs/dev-site-testing.md`](docs/dev-site-testing.md)): stands up an isolated dev instance, seeds a realistic workstream (`apps/server/src/dev/seedWorkstream.ts`), reads the pairing URL from stdout, and drives the authenticated app in the browser. Briefs can just say "verify live using the dev-verify recipe". Use this for flows that need real threads, auth, or server state.
- **Isolated component — preview harness** ([`docs/web-component-preview.md`](docs/web-component-preview.md)): a dev-only `/preview` route (no backend) that renders presentational components (`ChatMarkdown`, tables, code blocks, …) against fixtures reproducing the real timeline layout chain. Use this for pure render/CSS work — it's a ~seconds loop. Add a fixture in `apps/web/src/preview/fixtures.tsx` for the case you're changing.

## HTML artefacts (mockups, visual reports, explainers)

Standalone HTML produced for a human to view — a mockup, a visual report, an
explainer — goes in the gitignored `.artifacts/` directory at the worktree
root: write it with the ordinary file-write tool and cite the
workspace-relative path (e.g. `.artifacts/quota-mockup.html`) in chat, which
renders it in-app via the file chip's View affordance. Relative subresources
resolve, so a multi-file artefact works — keep all its files under one
subdirectory of `.artifacts/`. Pick a fresh descriptive filename and never
overwrite an existing artefact — the worktree may be shared with other
threads, and a chat chip renders whatever is on disk now. Do not write
renderable HTML to locations outside the worktree (the `visual_explainer`
tool's `~/.agent/diagrams/` default cannot be rendered in-app — write the
HTML to `.artifacts/` instead), and do not commit throwaway HTML under
`experiments/` or `docs/`. For a reviewable plan or recap, prefer the MDX
genres (`plans/<slug>/plan.mdx`, `recaps/<slug>/recap.mdx`) over a standalone
HTML artefact.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vpr sync:repos`; use `vpr sync:repos --repo <id>` to sync one configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.
