# T3 Code

Loom is a fork of T3 Code, a GUI for coding agents: a Node WebSocket server wraps provider CLIs (pi is the default and the only provider loom maintains) and serves web, desktop and mobile clients, locally or over a tailnet or tunnel. The maintainer is Carl. Three constraints bind every change: performance (too much data over the socket, repainting animations and heavy lists are the usual regressions), remote use (a feature must work over the relay and tunnel, not only on localhost), and more than one client (web, the Electron desktop shell that wraps it, and the React Native mobile app). Terms: an _environment_ is one running server with its machine, files and state; a _project_ is a workspace record rooted at a directory; a _thread_ is a project's durable conversation and work history; a _turn_ is one user-to-agent cycle including its checkpoint; _T3 home_ is the base data directory, with runtime state under `userdata/`.

## Task Completion Requirements (loom)

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `vp run lint:mobile` must also pass.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.
- Pass test paths directly (`vp test run <path>` / `vpr test <path>`), never after `--`: `vpr test -- <dir>` turns the path into passthrough and runs the whole suite.

## Shipping changes (commit, PR, merge)

The canonical procedure (branch → commit → rebase → PR → merge → cleanup, plus
this repo's fork/worktree gotchas) lives in
[`docs/operations/shipping.md`](docs/operations/shipping.md) — the single source
of truth. Run the mechanical sequence with `pnpm ship -m "<summary>"` (it is
encoded in `scripts/ship.ts`); the `ship` skill loads the procedure inline and
the `shipper` role is the delegated path. In a workstream, spawn a `shipper`
child once the work is approved or ship inline via the `ship` skill; outside a
workstream, follow the doc directly. Do not ship until the user has approved
shipping the change.

Merge authority is per-project (`.t3code/ship.json`; policy shape in the
shipping doc). Loom's is `agent`, so the flow above carries through the merge;
in a workstream the SHIPPING POLICY block in your prompt states it.

Shipping ends at the merge. **Deploying to the production VM is a separate,
human-initiated act** — never deploy as part of finishing a change unless the
user explicitly asks for a deploy. When asked, the mechanism lives in
`~/loom-releases/RUNBOOK.md` (loom-slack-bridge repo); never run a raw in-place
`pnpm cockpit:build`.

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

- **Full app — dev-verify recipe** ([`docs/dev-site-testing.md`](docs/dev-site-testing.md)): stands up an isolated dev instance, seeds a realistic workstream (`vp run dev:seed`, `apps/server/src/dev/seedWorkstream.ts`), reads the pairing URL from stdout, and drives the authenticated app in the browser. Briefs can just say "verify live using the dev-verify recipe". Use this for flows that need real threads, auth, or server state.
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
threads, and a chat chip renders whatever is on disk now. Write it under
`.artifacts/`, not outside the worktree (nothing outside renders in-app,
including `visual_explainer`'s default directory) and not under
`experiments/` or `docs/`. For a reviewable plan or recap, prefer the MDX
genres (`plans/<slug>/plan.mdx`, `recaps/<slug>/recap.mdx`,
`explainers/<slug>/explainer.mdx` for "help me understand" requests) over a standalone
HTML artefact.

## Fork-specific notes

- Loom is a **Pi-first fork**: `PI_DEFAULT_MODEL` is the default model, and
  pi is the only provider loom maintains; the other adapters remain as
  upstream ships them.
- Upstream sync doctrine and per-area resolutions live in
  [`docs/upstream-sync/`](docs/upstream-sync/).
- **Mark every loom hunk.** Any hunk you add to a file that also exists
  upstream carries a `// loom:` comment; larger additions belong in a
  `*.loom.ts` module or `apps/web/src/loom/`. Unmarked hunks are invisible to
  the lost-feature audit and are silently dropped at the next upstream pull.
  The `pnpm ship` gate enforces this
  (`docs/upstream-sync/pull7-tools/unmarkedsweep.sh`); the convention is in
  [`docs/upstream-sync/23-sidebar-v2-rehome.md`](docs/upstream-sync/23-sidebar-v2-rehome.md).
- **Never `git stash` in this repo.** Every worktree shares one `.git`, so the
  stash stack is global across all concurrent threads and a `pop` can hand you
  another thread's work and drop yours. Commit a WIP (`--no-verify`) or use
  `git diff > patch` / `git apply` instead.

## The three ways to hurt yourself

1. **Killing by pattern.** Never `pkill -f`, `pgrep | kill`, or `kill` a PID you found by matching a name, path, or worktree string. This machine runs other threads' dev servers and tool shells at once, and a tool shell's argv is the whole command it runs, so a loose pattern matches their work too. <!-- loom: pgrep-self-match --> Loom runs any bash call that names `pgrep` or `pkill` base64-encoded, so the pattern no longer matches your own tool shell, but it still matches everyone else's processes. Kill only a PID you captured at spawn, or the owner of your port from `ss -H -ltnp` after confirming `/proc/<pid>/cwd` is your worktree.
2. **Writing to the live install.** <!-- loom: live cockpit database --> The live database is `$T3CODE_HOME/userdata/statev2.sqlite` (on the cockpit VM `~/.t3/cockpit/userdata/statev2.sqlite`, over 10 GB, in WAL mode and written to while you work; `state.sqlite` beside it is the frozen pre-V2 database). Query it in place, read-only, which is cheap and safe: `sqlite3 "file:$T3CODE_HOME/userdata/statev2.sqlite?mode=ro" "…"`. Never use `immutable=1` (it ignores the WAL and reads stale data), never open it read-write, never start a server against it, never clean it up.

   Do not copy the whole file. For a dev instance use `vp run migrate-dev-db` (see Test data; `--root <thread>` keeps one workstream tree). For analysis, query in place, or `ATTACH 'file:…?mode=ro'` (`file:` is required: without it sqlite creates a stray empty file beside the live database) and `CREATE TABLE … AS SELECT` only the rows you need. Only a migration test needs a full copy: `sqlite3 -readonly <live> "VACUUM INTO '<dest>'"`, run in the background and deleted afterwards. Never `.backup` (it restarts on every server write and never finishes) and never `cp` (a torn copy).

3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting them bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the path you tested and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behaviour reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web, adds Electron shell/IPC), and mobile (React Native, separate navigation). Shared logic lives in `packages/client-runtime`.
- **Providers.** Loom runs pi; the other adapters stay as upstream ships them and are not maintained or verified here. A provider-shaped feature is built for pi and left working, or explicitly unsupported, for the rest.
- **Agents.** A capability a user can trigger is usually one an agent should reach through MCP tools, and scheduled tasks run the same paths. That only works when it is a service method, not handler code.
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. Change the schema and the server, web, mobile, and desktop all follow.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, remote/relay, and tunnel behave differently. Multi-device and multi-environment cases are real.
- **Docs.** Check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Dev servers

- `vp i` installs. Worktrees get this from the project's worktree setup script (Loom's runs `scripts/bootstrap-worktree.sh`); if module resolution looks broken, it probably did not run.
- Setup runs in the background. Read `"$(git rev-parse --git-dir)/t3code-setup-state.json"`: `ready`, proceed; `pending`, wait and re-check, and do not run `vp i`; `failed`, read its `detail` and fix or report rather than reinstalling. With no file at all, no setup script ran here, so run `vp i` yourself. <!-- loom: setup state file -->
- `vp run dev` starts server and web. In a worktree, state defaults to that worktree's gitignored `.t3`, which deliberately outranks an ambient `T3CODE_HOME` so you cannot land on shared state by accident. An explicit `--home-dir` still wins. The server enforces the same default: a checkout provisioned under `<home>/worktrees/` runs on its own `.t3` even when booted by hand as `node apps/server/src/bin.ts serve`, and one INFO line at startup names the rule that chose the home. Passing `--base-dir "$PWD/.t3"` still says it explicitly, and remains the habit worth keeping. A boot also refuses outright when another live server already holds that home's database (`statev2.sqlite`); clear it by deleting `<stateDir>/server-runtime.json` only when you know that pid is not a server.
- Ports derive from the worktree path and are stable across restarts, but read the real ones from the `[dev-runner]` line since occupied ports shift.
- Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, then give that full URL to an unpaired browser. Do not wire up `tailscale serve` by hand, open the URL yourself, or consume the user's pairing link. A browser with the reusable dev cookie can use the bare origin. If a normal one-time token was consumed, mint a fresh one with `node apps/server/src/bin.ts pair`. It carries standard scopes, while the startup URL carries admin scopes needed for Connections settings.
- To reuse web dev auth across worktrees, configure one fixed `T3CODE_DEV_AUTH_TOKEN` in the main checkout's gitignored `.env`. The `t3.json` setup links that file into worktrees. Never commit or publish the token or a startup URL. See [Reusable dev credential](docs/operations/development.md#reusable-dev-credential).
- Stop what you started, by the PID you tracked. See rule 1.
- Need a second checkout? `git worktree add` it next to this worktree, not in `/tmp`. Remove it when done.

## Test data

An empty database is a bad test. Seed your worktree's `.t3` with a copy of real data instead of pointing at live state:

- The first `vp run dev` in a worktree does this for you when its database is missing. `--no-seed` or `T3CODE_DEV_SEED=0` skips it.
- Run `vp run migrate-dev-db --base-dir <baseDir>` with your dev server stopped, where `<baseDir>` is the port-scoped home the `[dev-runner]` line prints (`<worktree>/.t3/dev-instances/<port>`); without `--base-dir` it rebuilds `<worktree>/.t3`, which `vp run dev` does not read. <!-- loom: dev-instance home --> It rebuilds that home's `userdata/statev2.sqlite` from a read-only slice of `$T3CODE_HOME/userdata/statev2.sqlite`, the developer's real data, with no `--source` needed (it falls back to `~/.t3` when `T3CODE_HOME` is unset). <!-- loom: $T3CODE_HOME source --> It keeps recent projects and their stopped threads, and drops scheduled tasks, pending work, and auth sessions, so your dev server never runs the developer's agents. Raise `--projects` and `--threads-per-project` for more data.
- Refresh `statev2.sqlite`, not `state.sqlite`. The server copies the V1 `state.sqlite` only when `statev2.sqlite` is missing.
- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Before you push, run `vp run check:changed`. It runs CI's fast checks for changed files: format, lint, knip, typecheck of affected packages and dependents, and tests beside changes. CI still runs the full test suites.
- Smallest proof that the change works: `vp test run <files>` for the tests you touched, targeted lint and typecheck for the scope you changed, then the completion gates above.
- Test meaningful logic or observable behaviour. Do not render components to static markup to assert props or attributes, or add tests that merely assert callback wiring or mirror the implementation.
- Backend behaviour changes ship with focused tests for that behaviour.
- The server is event-sourced, and side effects run after the command commits. In tests, drain the effect worker (`OrchestrationEffectWorkerV2.drain`) or await the specific persisted event or `Deferred` that marks the milestone. Never wait on sleeps or polling. A test that needs a timeout to pass is wrong.
  - `it.effect` runs on a `TestClock`; `Effect.sleep` only advances through `TestClock.adjust`. `it.live` is wall-clock and only for subprocess or network fixtures.
  - No `yieldNow` or `sleep` polling loops. Await the `Deferred`, take from the `Queue`, or drain the worker.
  - No per-test timeout argument or `retry`. The project timeout is the ceiling, and flaky tests are fixed, not retried.
  - No `performance.now()` or `Date.now()` deltas. Assert on events and counts, not elapsed time.
  - Browser tests assert through `expect.element` or `vi.waitFor`, never `requestAnimationFrame` or `transitionend`.
  - `vi.mock` factories must not spread a real module that pulls in Shiki or the diff workers.
  - `it.skip` and friends need a tracking issue on the line above: `// quarantine: #1234 <why>`.
  - Lint enforces this: `t3code/no-test-timeout-or-unreasoned-skip`, `t3code/no-frame-waits-in-browser-tests`, `t3code/no-wall-clock-in-tests`, `t3code/no-real-time-wait-in-tests`, `t3code/no-polling-loop-in-tests`.
- Web browser tests are `*.browser.test.tsx` or `*.browser.test.ts` and render with `await using screen = await render(...)` from `apps/web/test/render.tsx`. `t3code/require-disposable-render` errors on the old patterns.
  - Acquire what the test drives after mounting (fake timers it advances, spies it sets up after mounting) after the render, so it disposes before the unmount. Anything the first render reads comes before it.
  - A helper that renders and then waits or clicks puts the screen in an `AsyncDisposableStack` and `move()`s it out only on success, so a failed wait still unmounts.
  - `rerender` needs a fresh element on every call.
  - No lifecycle hooks and no module-level mutable state. Shared mock state that `vi.mock` factories read is reset by a `setup()` call at the top of the test.
  - `router` is on by default. Pass `router: false` only with a one-line comment saying why.

  ```tsx
  it("saves on Enter", async () => {
    const onSave = vi.fn();
    using _now = vi.spyOn(Date, "now").mockReturnValue(0);
    await using screen = await render(<TitleEditor onSave={onSave} />, { router: "/threads/1" });
    await userEvent.type(screen.getByRole("textbox"), "Title{Enter}");
    expect(onSave).toHaveBeenCalledWith("Title");
  });
  ```

- User-visible frontend changes get one live pass: web via the dev-verify recipe or the preview harness (Live frontend verification, above), mobile via `test-t3-mobile`. Subagents do not launch their own dev servers unless their brief says to.

For authorized mobile verification, a missing or outdated native client is an install step, not a blocker. Run `vp run mobile:install <ios|android> [device-id]` on the device host before starting Metro; it targets the only booted simulator or connected Android device when the id is omitted. It installs the dev client for this checkout's native fingerprint from the shared cache in seconds and builds only when no machine has built it yet, so prefer it over `expo run:*`, `xcodebuild`, or `gradlew`, which rebuild from scratch. Its stdout is one JSON line; build output goes to the log it names. See `test-t3-mobile` for the full workflow.

## Pull requests

- Conventional commit titles, plain language: `fix(web): new threads no longer spike CPU`.
- Body: the problem in a sentence or two, then how you fixed it. End with the model and harness that did the work.
- UI changes need before/after images. Motion or timing needs a short video. Upload PR evidence to GitHub; never commit PR-only screenshots or assets.
- One request is one PR. Split it only when the maintainer asks.
- When babysitting: poll checks and comments newer than the last push, verify each bot finding against the source, fix real ones, dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## Documentation

Most code changes do not need an internal documentation change. Agents can read the code.

- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- Do not document every feature, enumerate fields or methods, narrate control flow, maintain file catalogs, or append PR summaries. Types, tests, and code already record the implementation. The glossary defines shared vocabulary; it is not a feature index.
- A local reason the code can't show goes in a short nearby code comment. Use an internal doc when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new internal page needs a distinct, durable reason to exist.
- `docs/user/` helps users accomplish tasks. Give each major feature a concise section explaining what it does, how to start, and anything unintuitive. A settings path is useful; descriptions of visible buttons, icons, layouts, animations, or every UI state are not. Before adding text, ask what task or decision it helps the user with.
- Keep user docs in the shipped product's voice, without implementation details or contributor tooling. Update the relevant feature section when how to use it changes. A UI tweak does not need a documentation entry, and a new control does not need its own page.
- `docs/operations/` holds maintainer setup, release, and debugging procedures. Keep instructions for operating an installed T3 Code server in the user guides.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- Track active maintainer work in the GitHub issue or project item that owns it. External proposals follow `CONTRIBUTING.md` and belong in Ideas discussions.
- A merged PR is the implementation record. Close or update its tracking item when the work lands; do not preserve a second checklist in the repository.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_. The _orchestrator_ (`apps/server/src/orchestration-v2/Orchestrator.ts`) serializes commands and decides _events_ without doing any I/O. The _event sink_ commits those events, the _projections_ the UI reads, the _command receipt_, and _outbox_ effects in one transaction. The _effect worker_ then runs the effects, such as starting a provider turn or capturing a checkpoint, and feeds results back as commands. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Architecture and its constraints: `docs/internals/overview.md`. Glossary: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read [Effect services](docs/internals/effect-services.md) before adding server code, and `.repos/effect-smol/LLMS.md` for the Effect library itself.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency. If it is missing (sparse checkout), read a file with `git show origin/main:.repos/<path>`.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Client mutations use `createEnvironmentRpcCommand`. Add protected methods to `CLIENT_GUARDED_RPC_SCOPES` in contracts and use the command's `permissionAtom` for UI availability. Grants are checked at execution against the destination environment; the server remains authoritative. Keep raw RPC clients inside `rpc/`, and extend the permission behavior tests when adding a protected method.
- Server features are services; transports stay thin. A `ws.ts` RPC handler, HTTP route, or MCP tool decodes input, calls one service method, and maps errors. See [Effect services](docs/internals/effect-services.md).
- `apps/web/src/components/ui` exports own their look. Pick a `variant` or `size`; do not restyle one with `className`. If none fits and the look is a generic concept, add a variant to the component; a look that belongs to one feature stays in that feature's own component, not in `components/ui`. Layout classes (width, flex, margin, position) belong on the parent. `shadcn/no-restyle` fails lint on violations. See [Web UI](docs/internals/web-ui.md).
- Reusable Effect functions use `Effect.fn("Service.operation")` with a stable span name, not a
  function wrapping `Effect.gen`. Keep `Effect.gen` for inline programs and layer construction.
  Use `Effect.fnUntraced` only when spans would be too frequent (stream chunks, per-event
  projection, tight loops) or duplicate an existing tracing boundary; explain that choice nearby.
  Named `Effect.fn` creates a span; the unnamed form does not. Preserve existing span names and
  options, and pass combinators as additional function-builder arguments.
- Inferred types over annotations. `any` is the enemy.
- Default to no comment. Write one only for a constraint, an external quirk, or an invariant the code can't show, in one line where you can and four at most. Don't restate names or signatures, narrate steps, record history, or explain the fix you just made; the PR carries that. `t3code/no-low-value-comments` enforces the length cap and the mechanical cases.
- React effects are a last resort: derive in render, act in handlers, reset with `key`, or use a ref callback or store. The `t3code/react-effect-budget` lint rule holds each file to its entry in `scripts/effect-budget.json`; raise an entry only in the PR that needs the effect, and lower it when you remove one.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Computer use (driving a human's browser or desktop) needs the user's agreement; the dev-verify recipe and the preview harness are not that.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
