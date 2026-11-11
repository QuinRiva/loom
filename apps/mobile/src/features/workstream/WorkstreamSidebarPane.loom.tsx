/**
 * loom: unfolded, the left pane shows the workstream in place of the thread list (which stays
 * mounted underneath) whenever a `Workstream` route is on the root stack. Its close button takes
 * the route off the stack and gives the list back.
 */
import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  AndroidHeaderIconButton,
  AndroidScreenHeader,
} from "../../components/ui/AndroidScreenHeader";
import { RenderErrorBoundary, RenderFailureView } from "../../components/RenderErrorBoundary";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { workspaceRoutesOf } from "../layout/workspace-overlay-routes";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { WorkstreamBody } from "./WorkstreamBody.loom";
import { workstreamSubtitle } from "./workstreamCopy.loom";
import {
  closeWorkstream,
  openWorkstreamChild,
  type ThreadTarget,
  WORKSTREAM_ROUTE,
  type WorkstreamRouteParams,
} from "./workstreamNavigation.loom";
import { workstreamKey, workstreamViewAtom } from "./workstreamView.loom";

type PaneSnapshot = [routeKey: string, environmentId: string, rootId: string, open: string | null];

/** A stable string, so the store only notifies when the pane's own inputs change. */
function readPane(): string {
  const state = rootNavigationRef.isReady() ? rootNavigationRef.getRootState() : undefined;
  if (!state) return "";
  const routes = workspaceRoutesOf(state.routes.slice(0, state.index + 1)).workspace;
  const at = routes.findIndex((route) => route.name === WORKSTREAM_ROUTE);
  const route = routes[at];
  if (!route) return "";
  const params = route.params as WorkstreamRouteParams;
  const above = routes[at + 1];
  const open = above?.name === "Thread" ? ((above.params as ThreadTarget).threadId ?? null) : null;
  return JSON.stringify([
    route.key,
    params.environmentId,
    params.threadId,
    open,
  ] satisfies PaneSnapshot);
}

const subscribe = (listener: () => void) => rootNavigationRef.addListener("state", listener);

export function WorkstreamSidebarPane(props: {
  readonly width: number;
  /** Reveals a hidden left pane. */
  readonly onReveal: () => void;
}) {
  const snapshot = useSyncExternalStore(subscribe, readPane, readPane);
  if (!snapshot) return null;
  const [routeKey, environmentId, rootId, open] = JSON.parse(snapshot) as PaneSnapshot;
  return (
    <RenderErrorBoundary
      resetKeys={[routeKey]}
      renderFallback={(fallback) => (
        <View className="absolute inset-0">
          <RenderFailureView
            {...fallback}
            title="The workstream couldn't be displayed"
            exit={{ label: "Close workstream", onPress: closeWorkstream }}
          />
        </View>
      )}
    >
      <PaneContent
        routeKey={routeKey}
        environmentId={EnvironmentId.make(environmentId)}
        rootThreadId={ThreadId.make(rootId)}
        openThreadId={open}
        width={props.width}
        onReveal={props.onReveal}
      />
    </RenderErrorBoundary>
  );
}

function PaneContent(props: {
  readonly routeKey: string;
  readonly environmentId: EnvironmentId;
  readonly rootThreadId: ThreadId;
  readonly openThreadId: string | null;
  readonly width: number;
  readonly onReveal: () => void;
}) {
  const { environmentId, rootThreadId } = props;
  const view = useAtomValue(workstreamViewAtom(workstreamKey(environmentId, rootThreadId)));
  const insets = useSafeAreaInsets();
  const bottomClearance = useWorkspaceTabs()?.bottomClearance ?? 0;
  const reveal = useEffectEvent((_routeKey: string) => props.onReveal());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a workstream newly put on the stack reveals a hidden left pane once; hiding it afterwards is the user's choice
  useEffect(() => reveal(props.routeKey), [props.routeKey]);
  return (
    <View className="absolute inset-0 bg-header">
      <AndroidScreenHeader
        title={view?.root.title ?? "Workstream"}
        subtitle={view ? workstreamSubtitle(view.rollup) : undefined}
        leading={
          <AndroidHeaderIconButton
            accessibilityLabel="Close workstream"
            icon="xmark"
            onPress={closeWorkstream}
          />
        }
        actions={[
          {
            accessibilityLabel: "Open the root thread",
            icon: "text.bubble",
            onPress: () => openWorkstreamChild(environmentId, rootThreadId, { split: true }),
          },
        ]}
        compact
      />
      <ScreenContent insetHorizontal>
        <WorkstreamBody
          environmentId={environmentId}
          rootThreadId={rootThreadId}
          selectedThreadId={props.openThreadId}
          width={props.width}
          split
          bottomInset={Math.max(insets.bottom, bottomClearance)}
        />
      </ScreenContent>
    </View>
  );
}
