# Testing conventions (loom)

The test rules that lint enforces, with the reasons the lint messages cannot carry, plus the
browser-test render contract that lint can only partly see. Read this before writing a server or
browser test; [`AGENTS.md`](../../AGENTS.md#verifying) carries only the gist and the commands. What
to test, and where test doubles are allowed, is the
[orchestration testing strategy](../orchestration-v2/testing-strategy.md).

## Server tests: await the milestone, never the clock

The server is event-sourced, and side effects run after the command commits (see
[durable intent and side effects](./overview.md#durable-intent-and-side-effects)). A test that
sleeps or polls is racing the effect worker, and one that needs a timeout to pass is wrong. Drain
the effect worker (`OrchestrationEffectWorkerV2.drain`) or await the specific persisted event or
`Deferred` that marks the milestone. Concretely:

- `it.effect` runs on a `TestClock`; `Effect.sleep` only advances through `TestClock.adjust`.
  `it.live` is wall-clock and only for subprocess or network fixtures.
- No `yieldNow` or `sleep` polling loops. Await the `Deferred`, take from the `Queue`, or drain the
  worker.
- No per-test timeout argument or `retry`. The project timeout is the ceiling, and flaky tests are
  fixed, not retried.
- No `performance.now()` or `Date.now()` deltas. Assert on events and counts, not elapsed time.
- `vi.mock` factories must not spread a real module that pulls in Shiki or the diff workers.
- `it.skip` and friends need a tracking issue on the line above: `// quarantine: #1234 <why>`.

Lint enforces this: `t3code/no-test-timeout-or-unreasoned-skip`,
`t3code/no-frame-waits-in-browser-tests`, `t3code/no-wall-clock-in-tests`,
`t3code/no-real-time-wait-in-tests`, `t3code/no-polling-loop-in-tests` (rules live in
`oxlint-plugin-t3code/rules/`).

## Web browser tests: the disposable render

In `apps/web`, a test that renders React or touches the DOM is `*.browser.test.tsx` or
`*.browser.test.ts` and runs in headless Chromium, never jsdom
([Checks](../operations/development.md#checks)). Render with `await using screen = await render(...)` from
[`apps/web/test/render.tsx`](../../apps/web/test/render.tsx), which owns the React root and unmounts
it on dispose. `t3code/require-disposable-render` errors on the old patterns (`react-dom/client`,
a bare `act`, lifecycle hooks). Assert through `expect.element` or `vi.waitFor`, never
`requestAnimationFrame` or `transitionend` (`t3code/no-frame-waits-in-browser-tests`). The
conventions lint cannot see:

- Acquire what the test drives after mounting (fake timers it advances, spies it sets up after
  mounting) after the render, so it disposes before the unmount. Anything the first render reads
  comes before it.
- A helper that renders and then waits or clicks puts the screen in an `AsyncDisposableStack` and
  `move()`s it out only on success, so a failed wait still unmounts.
- `rerender` needs a fresh element on every call.
- No lifecycle hooks and no module-level mutable state. Shared mock state that `vi.mock` factories
  read is reset by a `setup()` call at the top of the test.
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

## Running tests

`vp test run <path>` runs one file or directory (the path goes directly after `run`; see
[`AGENTS.md`](../../AGENTS.md#task-completion-requirements-loom) for the `--` trap). For big files
add `-t "<name>"`. `vp run check:changed` runs the test files beside your changes along with CI's
other fast checks; see [Checks](../operations/development.md#checks).
