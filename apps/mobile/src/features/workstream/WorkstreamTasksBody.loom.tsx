/**
 * loom: the Tasks tab's list (§3, §6 of plans/mobile-goal-tasks/plan.mdx): the needs-you cards,
 * the goal block and its To do | All filter, then the rows `goalTaskRows` decides. Read-only.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { LegendList, type LegendListRef } from "@legendapp/list/react-native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useEffect, useRef } from "react";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useNowMinuteMs } from "../../lib/clock";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { appAtomRegistry } from "../../state/atom-registry";
import { goalTaskRows, type TaskFilter, unfoldTo } from "./goalTaskRows.loom";
import { WorkstreamCards } from "./WorkstreamCards.loom";
import { openWorkstreamNodeSheet } from "./WorkstreamNodeSheet.loom";
import { Segment, taskThreadDisplay, WorkstreamTaskRow } from "./WorkstreamTaskRow.loom";
import { goalTasksViewAtom, workstreamTasksStateAtom } from "./workstreamGoal.loom";
import { openWorkstreamChild } from "./workstreamNavigation.loom";
import {
  rememberedScrollOffset,
  rememberScrollOffset,
  workstreamEnvironmentIndexAtom,
  workstreamKey,
  workstreamViewAtom,
} from "./workstreamView.loom";

const MONO_FONT = "Menlo";
const OBJECTIVE_KEY = "objective";

const toggle = (set: ReadonlySet<string>, key: string) => {
  const next = new Set(set);
  if (!next.delete(key)) next.add(key);
  return next;
};

export function WorkstreamTasksBody(props: {
  readonly environmentId: EnvironmentId;
  readonly rootThreadId: ThreadId;
  /** The thread open beside the pane: its task is the marked one. */
  readonly selectedThreadId: string | null;
  readonly split: boolean;
  readonly bottomInset: number;
}) {
  const { environmentId, rootThreadId, split } = props;
  const key = workstreamKey(environmentId, rootThreadId);
  const tasksView = useAtomValue(goalTasksViewAtom(key));
  const view = useAtomValue(workstreamViewAtom(key));
  const state = useAtomValue(workstreamTasksStateAtom(key));
  const setState = useAtomSet(workstreamTasksStateAtom(key));
  const now = useNowMinuteMs();
  const listRef = useRef<LegendListRef>(null);

  const ready = tasksView.status === "ready" ? tasksView : null;
  const selectedId = props.selectedThreadId as ThreadId | null;
  // Unfolded, the open thread's task; on the cover screen, the task arrived at from a header line.
  const markedTaskId = split
    ? ((selectedId && ready?.nodes.get(selectedId)?.anchorTaskId) ?? null)
    : (state.focus?.taskId ?? null);
  const rows = ready
    ? goalTaskRows({
        tasks: ready.goal.tasks,
        filter: state.filter,
        toggled: state.toggled,
        threadsByTask: ready.threadsByTask,
        markedTaskId,
      })
    : [];
  const focus = state.focus;
  const focusIndex = focus?.scroll
    ? rows.findIndex(
        (row) => (row.kind === "task" || row.kind === "caption") && row.taskId === focus.taskId,
      )
    : -1;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the list once to the task a header line jumped to, then marks the scroll spent; a hidden task is unfolded on All first
  useEffect(() => {
    if (!focus?.scroll || !ready) return;
    if (focusIndex >= 0) {
      void listRef.current?.scrollToIndex({
        index: focusIndex,
        animated: false,
        viewPosition: 0.3,
      });
      setState((current) => ({ ...current, focus: { taskId: focus.taskId, scroll: false } }));
      return;
    }
    // The opener could not unfold to it (the goal was not loaded then), or the task is gone.
    setState((current) => {
      const toggled = unfoldTo(ready.goal.tasks, focus.taskId, current.toggled);
      return current.filter === "all" && toggled === current.toggled
        ? { ...current, focus: { taskId: focus.taskId, scroll: false } }
        : { ...current, filter: "all", toggled };
    });
  }, [focus, focusIndex, ready, setState]);

  const onToggle = (toggleKey: string) =>
    setState((current) => ({ ...current, toggled: toggle(current.toggled, toggleKey) }));
  const setFilter = (filter: TaskFilter) => setState((current) => ({ ...current, filter }));
  const onOpenThread = (threadId: ThreadId) =>
    openWorkstreamChild(environmentId, threadId, { split });
  const openSheet = (threadId: ThreadId) =>
    openWorkstreamNodeSheet({ environmentId, rootThreadId, threadId });
  // An owning thread can sit under another workstream of the goal; its sheet reads that root.
  const onLongPressThread = (threadId: ThreadId) => {
    void Haptics.selectionAsync();
    const shell = appAtomRegistry
      .get(workstreamEnvironmentIndexAtom(environmentId))
      ?.threadsById.get(threadId);
    openWorkstreamNodeSheet({
      environmentId,
      rootThreadId: shell?.lineage.rootThreadId ?? rootThreadId,
      threadId,
    });
  };

  const goalBlock = ready ? (
    <View
      className={cn(
        "px-3.5 pt-3 pb-2",
        (view?.needsYou.length ?? 0) > 0 && "mt-3 border-t border-border",
      )}
    >
      <Text className="text-[14.5px] font-t3-bold" numberOfLines={1}>
        <Text className="text-[11px] font-t3-bold tracking-wider text-foreground-tertiary">
          GOAL{"  "}
        </Text>
        {ready.goal.title}
      </Text>
      {ready.goal.description.trim() ? (
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Shows the whole objective"
          onPress={() => onToggle(OBJECTIVE_KEY)}
        >
          <Text
            className="mt-1 text-[13px] leading-[18px] text-foreground-secondary"
            numberOfLines={state.toggled.has(OBJECTIVE_KEY) ? undefined : 2}
          >
            {ready.goal.description.trim()}
          </Text>
        </Pressable>
      ) : null}
      <View className="mt-2.5 flex-row items-center gap-2.5">
        <View className="h-1.5 flex-1 overflow-hidden rounded-full bg-subtle-strong">
          <View
            className="h-full rounded-full bg-adaptive-emerald-600-400"
            style={{ width: `${(100 * ready.count.done) / ready.count.total}%` }}
          />
        </View>
        <Text className="text-xs tabular-nums" style={{ fontFamily: MONO_FONT }}>
          {ready.count.done}/{ready.count.total}
          <Text className="text-xs text-foreground-muted" style={{ fontFamily: MONO_FONT }}>
            {` done · ${ready.count.total - ready.count.done} to go`}
          </Text>
        </Text>
      </View>
      <View className="mt-2.5 flex-row items-center gap-1.5">
        <Segment
          label={`To do ${ready.count.total - ready.count.done}`}
          selected={state.filter === "todo"}
          onPress={() => setFilter("todo")}
        />
        <Segment
          label={`All ${ready.count.total}`}
          selected={state.filter === "all"}
          onPress={() => setFilter("all")}
        />
        <View className="flex-1" />
        {state.filter === "todo" ? (
          <Text className="shrink text-xs text-foreground-tertiary" numberOfLines={1}>
            finished tasks collapsed
          </Text>
        ) : null}
      </View>
    </View>
  ) : null;

  return (
    <LegendList
      ref={listRef}
      renderScrollComponent={NativeScrollView}
      data={rows}
      estimatedItemSize={44}
      getItemType={(row) => row.kind}
      initialScrollOffset={rememberedScrollOffset(`${key}:tasks`)}
      extraData={[ready, view, now, props.selectedThreadId]}
      keyExtractor={(row) => row.key}
      renderItem={({ item }) => {
        const node =
          item.kind === "thread"
            ? (view?.nodes.get(item.threadId) ?? ready?.nodes.get(item.threadId))
            : undefined;
        // Within this workstream the Graph's index, so a sub-orchestrator's progress counts all.
        const byId = node && view?.nodes.has(node.id) ? view.nodes : ready?.nodes;
        return (
          <WorkstreamTaskRow
            row={item}
            thread={node && byId ? taskThreadDisplay(node, byId, now) : null}
            selected={item.kind === "thread" && item.threadId === props.selectedThreadId}
            onToggle={onToggle}
            onOpenThread={onOpenThread}
            onLongPressThread={onLongPressThread}
          />
        );
      }}
      ListHeaderComponent={
        <>
          {view ? (
            <WorkstreamCards
              environmentId={environmentId}
              view={view}
              now={now}
              split={split}
              onOpenSheet={openSheet}
            />
          ) : null}
          {goalBlock}
        </>
      }
      ListEmptyComponent={
        tasksView.status === "missing" ? (
          <Text className="px-4 py-6 text-center text-sm text-foreground-muted">
            This goal could not be loaded.
          </Text>
        ) : ready ? null : (
          <View className="items-center py-8">
            <AppActivityIndicator />
          </View>
        )
      }
      contentContainerStyle={{ paddingBottom: props.bottomInset + 16 }}
      onScroll={(event) => rememberScrollOffset(`${key}:tasks`, event.nativeEvent.contentOffset.y)}
      scrollEventThrottle={100}
    />
  );
}
