import * as NodeModule from "node:module";
import { describe, expect, it, vi } from "vite-plus/test";

import { registerPresentedRoutes } from "../layout/workspace-overlay-routes";

vi.mock("../../lib/rootNavigation", () => ({
  rootNavigationRef: {},
  whenRootNavigationReady: () => undefined,
}));

const { withWorkstream, withWorkstreamChild, withoutWorkstream } =
  await import("./workstreamNavigation.loom");

// The real stack router, reached without importing React Native (as android-workspace-navigation.test does).
const require = NodeModule.createRequire(import.meta.url);
const requireFromNative = NodeModule.createRequire(
  require.resolve("@react-navigation/native/package.json"),
);
const requireFromCore = NodeModule.createRequire(
  requireFromNative.resolve("@react-navigation/core/package.json"),
);
const { CommonActions, StackActions, StackRouter } = requireFromCore(
  "@react-navigation/routers",
) as {
  readonly CommonActions: typeof import("@react-navigation/native").CommonActions;
  readonly StackActions: typeof import("@react-navigation/native").StackActions;
  readonly StackRouter: typeof import("@react-navigation/native").StackRouter;
};
const router = StackRouter({});
const options = {
  routeNames: ["Home", "Thread", "Workstream", "WorkstreamNode", "ThreadFile"],
  routeParamList: {},
  routeGetIdList: {},
};
type State = ReturnType<typeof router.getInitialState>;
registerPresentedRoutes(["WorkstreamNode"]);

const apply = (state: State, action: Parameters<typeof router.getStateForAction>[1]) => {
  const result = router.getStateForAction(state, action, options);
  if (!result) throw new Error(`Router rejected ${action.type}`);
  return router.getRehydratedState(result, options) as State;
};
const reset = (state: State, next: State) =>
  next === state ? state : apply(state, CommonActions.reset(next));
const stack = (...pushes: Array<readonly [string, object]>) =>
  pushes.reduce(
    (state, [name, params]) => apply(state, StackActions.push(name, params)),
    router.getInitialState(options),
  );
const names = (state: State) =>
  state.routes
    .slice(0, state.index + 1)
    .map((route) =>
      route.name === "Home"
        ? "Home"
        : `${route.name}:${(route.params as { threadId: string }).threadId}`,
    );
const keyOf = (state: State, name: string, threadId: string) =>
  state.routes.find(
    (route) =>
      route.name === name && (route.params as { threadId?: string })?.threadId === threadId,
  )?.key;

const env = "env";
const root = { environmentId: env, threadId: "root" };
const other = { environmentId: env, threadId: "other-root" };
const thread = (threadId: string) => ["Thread", { environmentId: env, threadId }] as const;
const workstream = (params = root) => ["Workstream", params] as const;

describe("tap the badge on Home", () => {
  it("folded: Home, Workstream", () => {
    const home = router.getInitialState(options);
    expect(names(reset(home, withWorkstream(home, root, false)))).toEqual([
      "Home",
      "Workstream:root",
    ]);
  });

  it("split: Home, Workstream, then the page that was open, which keeps its key", () => {
    const before = stack(thread("x"));
    const after = reset(before, withWorkstream(before, root, true));
    expect(names(after)).toEqual(["Home", "Workstream:root", "Thread:x"]);
    expect(keyOf(after, "Thread", "x")).toBe(keyOf(before, "Thread", "x"));
  });
});

describe("the header button or breadcrumb in thread X", () => {
  it("with this workstream directly under X: folded pops back to it, keeping its key", () => {
    const before = stack(workstream(), thread("x"));
    const after = reset(before, withWorkstream(before, root, false));
    expect(names(after)).toEqual(["Home", "Workstream:root"]);
    expect(keyOf(after, "Workstream", "root")).toBe(keyOf(before, "Workstream", "root"));
  });

  it("with this workstream directly under X: split moves nothing", () => {
    const before = stack(workstream(), thread("x"));
    expect(withWorkstream(before, root, true)).toBe(before);
  });

  it("otherwise: folded puts the workstream on top of X", () => {
    const before = stack(thread("x"));
    expect(names(reset(before, withWorkstream(before, root, false)))).toEqual([
      "Home",
      "Thread:x",
      "Workstream:root",
    ]);
  });

  it("otherwise: split slips the workstream in under X, which does not remount", () => {
    const before = stack(thread("x"));
    const after = reset(before, withWorkstream(before, root, true));
    expect(names(after)).toEqual(["Home", "Workstream:root", "Thread:x"]);
    expect(keyOf(after, "Thread", "x")).toBe(keyOf(before, "Thread", "x"));
  });

  it("keeps one workstream on the stack: opening another replaces it", () => {
    const before = stack(workstream(other), thread("x"), thread("y"));
    expect(names(reset(before, withWorkstream(before, root, false)))).toEqual([
      "Home",
      "Thread:x",
      "Thread:y",
      "Workstream:root",
    ]);
    expect(names(reset(before, withWorkstream(before, root, true)))).toEqual([
      "Home",
      "Thread:x",
      "Workstream:root",
      "Thread:y",
    ]);
  });
});

describe("tap a row for child C", () => {
  it("folded: the child over the workstream, and Back returns to the workstream", () => {
    const before = stack(workstream());
    const after = reset(
      before,
      withWorkstreamChild(before, { environmentId: env, threadId: "c" }, false),
    );
    expect(names(after)).toEqual(["Home", "Workstream:root", "Thread:c"]);
    const back = apply(after, StackActions.pop());
    expect(names(back)).toEqual(["Home", "Workstream:root"]);
    expect(keyOf(back, "Workstream", "root")).toBe(keyOf(before, "Workstream", "root"));
  });

  it("split: reuses the page open over the workstream, so the right pane changes in place", () => {
    const before = stack(workstream(), thread("x"), [
      "ThreadFile",
      { environmentId: env, threadId: "x" },
    ]);
    const after = reset(
      before,
      withWorkstreamChild(before, { environmentId: env, threadId: "c" }, true),
    );
    expect(names(after)).toEqual(["Home", "Workstream:root", "Thread:c"]);
    expect(after.routes[2]!.key).toBe(keyOf(before, "Thread", "x"));
  });

  it("from the long-press sheet: the sheet is dismissed", () => {
    const before = stack(workstream(), ["WorkstreamNode", { environmentId: env, threadId: "c" }]);
    const after = reset(
      before,
      withWorkstreamChild(before, { environmentId: env, threadId: "c" }, false),
    );
    expect(names(after)).toEqual(["Home", "Workstream:root", "Thread:c"]);
  });
});

describe("close the left pane", () => {
  it("removes the route and keeps the open thread", () => {
    const before = stack(workstream(), thread("c"));
    const after = reset(before, withoutWorkstream(before));
    expect(names(after)).toEqual(["Home", "Thread:c"]);
    expect(keyOf(after, "Thread", "c")).toBe(keyOf(before, "Thread", "c"));
  });
});
