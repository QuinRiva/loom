/**
 * loom: the long-press sheet for one workstream thread: web's quick facts and node menu, less
 * the timeline. No confirmation dialogs: the sheet is the deliberate step, and every outcome has
 * its reverse in the same menu.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  buildNodeContextMenuItems,
  getGateWaitLabel,
  getPurpose,
  type WorkstreamNode,
  type WorkstreamNodeIndex,
  type WorkstreamNodeMenuAction,
} from "@t3tools/client-runtime/state/loom/workstreamNodes";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { useNowMinuteMs } from "../../lib/clock";
import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { PillButton, runWorkstreamCommand } from "./WorkstreamCards.loom";
import { useWorkstreamCommands } from "./workstreamCommands.loom";
import { lastRoundLine, modelLine, rowCopy } from "./workstreamCopy.loom";
import { openReport, openWorkstreamChild, showWhereDispatched } from "./workstreamNavigation.loom";
import { workstreamKey, workstreamViewAtom } from "./workstreamView.loom";

export type WorkstreamNodeSheetParams = {
  readonly environmentId: string;
  readonly rootThreadId: string;
  readonly threadId: string;
};

export const openWorkstreamNodeSheet = (params: WorkstreamNodeSheetParams) =>
  whenRootNavigationReady(() => rootNavigationRef.navigate("WorkstreamNode", params));

const FAILURE_TITLES: Partial<Record<WorkstreamNodeMenuAction, string>> = {
  "outcome:done": "Couldn't accept",
  "outcome:cancelled": "Couldn't cancel",
  "outcome:reopen": "Couldn't reopen",
  "clear-flags": "Couldn't clear flags",
  stop: "Couldn't stop",
};

export function WorkstreamNodeSheet({ route }: StaticScreenProps<WorkstreamNodeSheetParams>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const view = useAtomValue(
    workstreamViewAtom(workstreamKey(environmentId, ThreadId.make(route.params.rootThreadId))),
  );
  const insets = useSafeAreaInsets();
  const node = view?.nodes.get(ThreadId.make(route.params.threadId));
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <NativeStackScreenOptions options={{ sheetCornerRadius: 28 }} />
      ) : null}
      <ScrollView
        nestedScrollEnabled
        className="flex-1"
        contentContainerClassName="px-5 pt-6"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
      >
        {view && node ? (
          <NodeSheetContent environmentId={environmentId} node={node} nodes={view.nodes} />
        ) : (
          <Text className="py-6 text-center text-sm text-foreground-muted">
            This thread is no longer in the workstream.
          </Text>
        )}
      </ScrollView>
    </View>
  );
}

function NodeSheetContent(props: {
  readonly environmentId: EnvironmentId;
  readonly node: WorkstreamNode;
  readonly nodes: WorkstreamNodeIndex;
}) {
  const { environmentId, node } = props;
  const navigation = useNavigation();
  const { layout } = useAdaptiveWorkspaceLayout();
  const commands = useWorkstreamCommands(environmentId);
  const now = useNowMinuteMs();
  const [running, setRunning] = useState<WorkstreamNodeMenuAction | null>(null);
  const split = { split: layout.usesSplitView };
  const copy = rowCopy(node, props.nodes, now);
  const gate = getGateWaitLabel(node, props.nodes);
  const lastRound = lastRoundLine(node, now);
  const model = modelLine(node);
  const commandFor: Partial<
    Record<WorkstreamNodeMenuAction, () => ReturnType<typeof commands.stop>>
  > = {
    "outcome:done": () => commands.setOutcome(node.id, "done"),
    "outcome:cancelled": () => commands.setOutcome(node.id, "cancelled"),
    "outcome:reopen": () => commands.setOutcome(node.id, null),
    "clear-flags": () => commands.clearAttention(node.id),
    stop: () => commands.stop(node.id),
  };
  const press = async (action: WorkstreamNodeMenuAction) => {
    const command = commandFor[action];
    if (command) {
      setRunning(action);
      const done = await runWorkstreamCommand(
        FAILURE_TITLES[action] ?? "Couldn't do that",
        command,
      );
      setRunning(null);
      if (done) navigation.goBack();
    } else if (action === "open") openWorkstreamChild(environmentId, node.id, split);
    else if (action === "dispatch") showWhereDispatched(environmentId, node, split);
    else if (action === "report" && node.reportPath) {
      navigation.goBack();
      openReport(environmentId, node.id, node.reportPath);
    }
  };
  return (
    <>
      <Text className="text-lg font-t3-bold">{node.title}</Text>
      <Text className="mt-1 text-sm text-foreground-muted">{getPurpose(node)}</Text>
      <View className="mt-3 gap-1">
        <Text className="text-sm">
          <Text className="text-sm font-t3-bold">{copy.role}</Text> · {copy.state}
        </Text>
        {gate ? <Text className="text-sm text-foreground-muted">{gate.label}</Text> : null}
        {lastRound ? <Text className="text-xs text-foreground-muted">{lastRound}</Text> : null}
        {model ? (
          <Text className="text-xs text-foreground-muted" style={{ fontFamily: "Menlo" }}>
            {model}
          </Text>
        ) : null}
      </View>
      <View className="mt-4 flex-row flex-wrap gap-2">
        {buildNodeContextMenuItems(node)
          .filter((item) => item.id !== "history")
          .map((item) => (
            <View key={item.id} style={{ width: "48.5%" }}>
              <PillButton
                label={item.label}
                tone={item.id === "open" ? "primary" : item.destructive ? "danger" : "plain"}
                grow
                busy={running === item.id}
                disabled={
                  (running !== null && running !== item.id) ||
                  (commandFor[item.id] !== undefined && !commands.canOperate)
                }
                onPress={() => void press(item.id)}
              />
            </View>
          ))}
      </View>
    </>
  );
}
