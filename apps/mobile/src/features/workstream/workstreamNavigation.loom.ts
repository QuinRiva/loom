/**
 * loom: the workstream route on the root stack (§6 of plans/mobile-workstream-view/plan.mdx). It
 * stays on the stack in both postures; posture decides only where it is drawn. Openers dispatch
 * the pure transforms through `rootNavigationRef`, so callers need no navigation prop.
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { fileRoutePathSegments } from "../files/filePath";
import { workspaceRoutesOf } from "../layout/workspace-overlay-routes";

export const WORKSTREAM_ROUTE = "Workstream";

/** The `Workstream` route's params: `threadId` is the root's. */
export interface WorkstreamRouteParams {
  readonly environmentId: string;
  readonly threadId: string;
}

/** A `Thread` route's identity: what a row, card or sheet opens. */
export interface ThreadTarget {
  readonly environmentId: string;
  readonly threadId: string;
}

interface RouteLike {
  readonly name: string;
  readonly key?: string;
  readonly params?: object;
}

interface StackLike {
  readonly index: number;
  readonly routes: readonly RouteLike[];
}

const identity = (route: RouteLike) => route.params as Partial<ThreadTarget> | undefined;
const isWorkstream = (route: RouteLike | undefined) => route?.name === WORKSTREAM_ROUTE;
const shows = (route: RouteLike | undefined, name: string, target: ThreadTarget) =>
  route?.name === name &&
  identity(route)?.environmentId === target.environmentId &&
  identity(route)?.threadId === target.threadId;

const withRoutes = <State extends StackLike>(
  state: State,
  routes: readonly RouteLike[],
): State => ({
  ...state,
  index: routes.length - 1,
  routes,
});

/** The workspace routes up to the focused one; a sheet or modal over them is dismissed. */
const workspaceOf = (state: StackLike) =>
  workspaceRoutesOf(state.routes.slice(0, state.index + 1)).workspace;

/**
 * Opens `target`'s workstream from the badge, the header button or the breadcrumb. Folded: back
 * to it when it sits directly under the open page, else on top. Split: slipped in under the open
 * page (which keeps its key), or nothing moves when it is already there. At most one workstream
 * route is on the stack; opening another replaces it. Returns `state` itself when nothing moves.
 */
export function withWorkstream<State extends StackLike>(
  state: State,
  target: WorkstreamRouteParams,
  split: boolean,
): State {
  const workspace = workspaceOf(state);
  const top = workspace.at(-1);
  const under = workspace.at(-2);
  if (shows(top, WORKSTREAM_ROUTE, target) || (split && shows(under, WORKSTREAM_ROUTE, target)))
    return workspace.length === state.routes.length ? state : withRoutes(state, workspace);
  if (shows(under, WORKSTREAM_ROUTE, target)) return withRoutes(state, workspace.slice(0, -1));
  const kept = workspace.find((route) => shows(route, WORKSTREAM_ROUTE, target));
  const route: RouteLike = kept ?? { name: WORKSTREAM_ROUTE, params: { ...target } };
  const rest = workspace.filter((route) => !isWorkstream(route));
  const page = rest.length > 1 ? rest.at(-1)! : null;
  return withRoutes(state, split && page ? [...rest.slice(0, -1), route, page] : [...rest, route]);
}

/**
 * Opens a child from a row, card or sheet: the workstream, then the child. Split reuses the page
 * already open over the workstream, so the right pane changes in place.
 */
export function withWorkstreamChild<State extends StackLike>(
  state: State,
  child: ThreadTarget,
  split: boolean,
): State {
  const workspace = workspaceOf(state);
  const at = workspace.findIndex(isWorkstream);
  const above = at < 0 ? undefined : workspace[at + 1];
  const route: RouteLike =
    split && above?.name === "Thread"
      ? { ...above, params: { ...child } }
      : { name: "Thread", params: { ...child } };
  return withRoutes(state, [...(at < 0 ? workspace : workspace.slice(0, at + 1)), route]);
}

/** Closes the split view's workstream pane: the route goes, the open page stays. */
export function withoutWorkstream<State extends StackLike>(state: State): State {
  const routes = state.routes.filter((route) => !isWorkstream(route));
  if (routes.length === state.routes.length) return state;
  const removedBelow = state.routes
    .slice(0, state.index + 1)
    .filter((route) => isWorkstream(route)).length;
  return { ...state, routes, index: Math.max(0, state.index - removedBelow) };
}

const dispatchStack = (next: <State extends StackLike>(state: State) => State) =>
  whenRootNavigationReady(() => {
    const state = rootNavigationRef.getRootState();
    if (!state) return;
    const payload = next(state);
    if (payload === state) return;
    // Same shape as `CommonActions.reset`, targeted at the root stack (see `root-stack-reset`).
    rootNavigationRef.dispatch({ type: "RESET", payload, target: state.key });
  });

/** `split` is `useAdaptiveWorkspaceLayout().layout.usesSplitView` where the press happens. */
export const openWorkstream = (
  environmentId: EnvironmentId,
  rootThreadId: ThreadId,
  options: { readonly split: boolean },
) =>
  dispatchStack((state) =>
    withWorkstream(state, { environmentId, threadId: rootThreadId }, options.split),
  );

export const openWorkstreamChild = (
  environmentId: EnvironmentId,
  threadId: ThreadId,
  options: { readonly split: boolean },
) =>
  dispatchStack((state) => withWorkstreamChild(state, { environmentId, threadId }, options.split));

export const closeWorkstream = () => dispatchStack(withoutWorkstream);

/** Opens a sub-thread's report (an absolute path under the T3 home) in the markdown viewer. */
export const openReport = (environmentId: EnvironmentId, threadId: ThreadId, reportPath: string) =>
  whenRootNavigationReady(() =>
    rootNavigationRef.navigate("ThreadFile", {
      environmentId,
      threadId,
      path: fileRoutePathSegments(reportPath),
    }),
  );

// "Show where it was dispatched": the sheet parks a request for the parent thread and opens it;
// the parent's thread screen resolves `at` to the last loaded message at or before it and hands
// that to `requestThreadMessageJump`. A request whose thread never showed lapses, as there.

const PENDING_JUMP_MS = 30_000;
let pendingJump: {
  readonly threadKey: string;
  readonly at: string;
  readonly requestedAt: number;
} | null = null;
const jumpListeners = new Set<() => void>();
const notifyJump = () => {
  for (const listener of jumpListeners) listener();
};

export function requestDispatchJump(threadKey: string, at: string): void {
  pendingJump = { threadKey, at, requestedAt: Date.now() };
  notifyJump();
}

/** The spawn time this thread should open at, if a sheet asked for one. */
export function pendingDispatchJump(threadKey: string): string | null {
  return pendingJump?.threadKey === threadKey &&
    Date.now() - pendingJump.requestedAt < PENDING_JUMP_MS
    ? pendingJump.at
    : null;
}

export function finishDispatchJump(threadKey: string): void {
  if (pendingJump?.threadKey !== threadKey) return;
  pendingJump = null;
  notifyJump();
}

export function subscribeDispatchJump(listener: () => void): () => void {
  jumpListeners.add(listener);
  return () => {
    jumpListeners.delete(listener);
  };
}

/** Opens a child's parent at the moment it spawned the child (over the workstream). */
export function showWhereDispatched(
  environmentId: EnvironmentId,
  node: { readonly parentThreadId: ThreadId | null; readonly createdAt: string },
  options: { readonly split: boolean },
) {
  if (node.parentThreadId === null) return;
  requestDispatchJump(scopedThreadKey(environmentId, node.parentThreadId), node.createdAt);
  openWorkstreamChild(environmentId, node.parentThreadId, options);
}
