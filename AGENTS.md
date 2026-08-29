# T3 Code

T3 Code is a minimal GUI for coding agents. A Node WebSocket server wraps provider CLIs (Codex, Claude Code, Cursor, Grok, OpenCode) and serves web, desktop, and mobile clients.

You can think of T3 Code as an open source "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass and Conductor.

## What makes T3 Code special?

We have over 100,000 users who love T3 Code. It's important we maintain the things they love as we continue to iterate on the product. Here's a brief list of the things we can never compromise on.

### 1. Open at the core

T3 Code is truly open. We share our roadmap, we share how we think about things, and of course we share all our code. A large number of our users run forks. We work in the open, and should strive to stay that way.

### 2. Performance without compromise

Lots of apps have gotten bogged down with bad tech decisions and "slop". We have not, and we're proud of the performance of T3 Code. We regularly audit for performance regressions, often caused by sending too much data over websockets, css animations causing gpu spikes, lists being hard to render, and more. Make sure all changes are considerate of performance impact.

### 3. Remote ready

The architecture of T3 Code's websocket layer (npx t3) enables a lot of awesome remote features. These have become core to the product. Whether users are connecting directly over their local network, using Tailscale, or leaning in fully with T3 Connect (our tunnel solution, also in this repo), we need to make sure new features are properly supported.

### 4. Multi-surface

T3 Code has 3 key app surfaces: **web**, **desktop**, and **mobile**.

**Web** is kind of two surfaces, as we have the public facing "app.t3.codes" as well as locally hosting the web app through the `npx t3` command. Both need to be supported by all new features where reasonable.

**Desktop** is the main surface most users install first. It's a full Electron app that bundles the server runner as well. The desktop app can also be used as the host server, allowing remote connections from app.t3.codes or the mobile app.

**Mobile** is a React Native app for both iOS and Android, available on the App Store and Google Play. The mobile app allows for connecting to any T3 Code server to control work remotely.

## A note from Theo

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

Of note: Most T3 Code contributions will come from T3 Code itself, often controlled remotely. This means you should be careful about accessing data, killing dev servers, and other things that may damage the T3 Code instance that the contributor is using.

## A small glossary

We need to be on the same page with terminology. When communicating, use this language:

- **you** means the agent reading this file and changing T3 Code.
- **we, us, and maintainers** mean Theo, Julius and the people building T3 Code. These are who you are talking to now.
- **user** means the person using T3 Code to direct coding agents.
- **agent** means the coding agent a user runs inside T3 Code. Depending on context, that may also include you.
- **provider** means the agent runtime or harness T3 Code talks to, such as Codex, Claude, Cursor, or OpenCode.
- **client** means the web, desktop, or mobile UI.
- **environment** means one running T3 server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history for a project.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **T3 home** means the base data directory. Runtime state normally lives below its userdata directory.

## Task Completion Requirements (loom)

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `vp run lint:mobile` must also pass.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.

> This supersedes upstream's "Do not run repo-wide checks" bullet under
> [Verifying](#verifying): loom has no CI that owns the full suite, so the gates
> run locally before anything is called done.

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

This supersedes upstream's "Never make a PR unless the developer explicitly asks"
bullet only in the sense that the approval gate is the user's _shipping_ approval;
the PR itself is still never opened unprompted.

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

## Fork-specific notes

- Loom is a **Pi-first fork**: `PI_DEFAULT_MODEL` is the default model and the
  driver registry deliberately ships pi only. Upstream's multi-provider
  guidance ("Providers: Codex, Claude, Cursor, Grok, and OpenCode each have an
  adapter") applies to the adapters that remain, not to the registry.
- Upstream sync doctrine and per-area resolutions live in
  [`docs/upstream-sync/`](docs/upstream-sync/).

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers at once. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** `~/.t3/userdata` is the developer's real T3 Code database, in use while you work. Reading it and copying from it are fine, and a good way to get real test data (see Test data). Never start a server against it, never open it read-write, never clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`
- **Providers.** Codex, Claude, Cursor, Grok, and OpenCode each have an adapter. Provider-shaped features need a decision per adapter, even if the decision is "not supported here".
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** `docs/` splits by audience. Behavior changes that a user would notice belong in `docs/user/` (shipped-product voice, no repo tooling or source paths); architecture and contributor changes in `docs/internals/`; runbooks in `docs/operations/`; new vocabulary in `docs/internals/glossary.md`.

## Dev servers

- `vp i` installs. Worktrees get this from the t3.json setup script; if module resolution looks broken, it probably did not run.
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, paste that full URL (token included) in your reply. Do not wire up `tailscale serve` by hand for this, and do not open the URL yourself.
- The web app requires pairing. Hand over the pairing URL, not the bare origin. A URL without its token is useless to whoever you gave it to. If the token got consumed, mint a fresh one with `node apps/server/src/bin.ts pair` — note it carries standard scopes, while the startup URL carries admin scopes (needed for Settings → Connections management).
- Stop what you started, by the PID you tracked. See rule 1.

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- Copy from `~/.t3/userdata` (the developer's real data, the most realistic test set) or `~/.t3/dev`. Worktree state lives at `<worktree>/.t3/userdata`.
- Snapshot the database with `VACUUM INTO`, which is safe even while a server has the source open and yields one consistent file:

  ```bash
  mkdir -p .t3/userdata
  rm -f .t3/userdata/state.sqlite*  # VACUUM INTO refuses to overwrite
  bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.t3/userdata/state.sqlite'\")"
  ```

  A plain `cp` is only safe when no server has the source open, and must bring the `-wal` and `-shm` siblings along. A live file copy is a corrupt copy.

- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Smallest proof that the change works. `vp test run <files>` for the tests you touched, targeted lint and typecheck for the scope you changed.
- **Do not run repo-wide checks.** No `vp check`, no `vp run -r test`, no `vp run -r typecheck` unless I ask. CI owns the full suite.
- Backend behavior changes ship with focused tests for that behavior.
- The server is event-sourced and its async flows emit typed receipts. Wait on receipts and worker drains, never on sleeps or polling. A test that needs a timeout to pass is wrong.
- Upon request, user-visible frontend changes should get one integrated pass in a real client: `test-t3-app` for web, `test-t3-mobile` for mobile. The primary agent does this once after integrating. Subagents do not launch their own dev servers. Ask permission before doing computer use or spinning up browsers.

## Pull requests

- Never make a PR unless the developer explicitly asks you to do so.
- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video.
- One concern per PR. If the description says "also", split it.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_, a pure _decider_ turns commands into persisted _events_, and a _projector_ derives the read model the UI renders. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Side effects run in queue-backed _reactors_ that emit _receipts_ when milestones land. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Full glossary with file links: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read `.repos/effect-smol/LLMS.md` before writing Effect code.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
