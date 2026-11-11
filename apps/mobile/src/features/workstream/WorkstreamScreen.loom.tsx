/**
 * loom: the `Workstream` route. On the cover display it draws the cards and lanes full screen;
 * unfolded on Android, the left pane draws them (`WorkstreamSidebarPane`) and this route shows
 * the placeholder until a child opens over it. It installs no Android workspace Back, so Back pops.
 */
import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { StackActions, type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { Platform, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { WorkstreamBody } from "./WorkstreamBody.loom";
import { workstreamSubtitle } from "./workstreamCopy.loom";
import { openWorkstreamChild, type WorkstreamRouteParams } from "./workstreamNavigation.loom";
import { workstreamKey, workstreamViewAtom } from "./workstreamView.loom";

export function WorkstreamScreen({
  route,
}: StaticScreenProps<Pick<WorkstreamRouteParams, keyof WorkstreamRouteParams>>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const rootThreadId = ThreadId.make(route.params.threadId);
  const view = useAtomValue(workstreamViewAtom(workstreamKey(environmentId, rootThreadId)));
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const split = layout.usesSplitView;
  // The left pane is wired into the Android layout only; elsewhere this route draws the body.
  const inPane = split && Platform.OS === "android";
  return (
    <View className={Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 bg-screen"}>
      <AppBar
        title={view?.root.title ?? "Workstream"}
        subtitle={view ? workstreamSubtitle(view.rollup) : undefined}
        sidebar={split}
        onBack={() =>
          navigation.canGoBack()
            ? navigation.goBack()
            : navigation.dispatch(StackActions.replace("Home"))
        }
        actions={[
          {
            // The root is the graph's spine, not a row: this is the way into its own thread.
            accessibilityLabel: "Open the root thread",
            icon: "text.bubble",
            onPress: () => openWorkstreamChild(environmentId, rootThreadId, { split }),
          },
        ]}
      />
      {inPane ? (
        <WorkspaceEmptyDetail />
      ) : (
        <ScreenContent>
          <WorkstreamBody
            environmentId={environmentId}
            rootThreadId={rootThreadId}
            selectedThreadId={null}
            width={width}
            split={split}
            bottomInset={insets.bottom}
          />
        </ScreenContent>
      )}
    </View>
  );
}
