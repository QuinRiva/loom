/**
 * loom: a workstream's body: the needs-you cards, then the lane graph. Drawn full screen on the
 * cover display and in the left pane when unfolded; both read the same atoms, folds and scroll.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  displayColumnOf,
  getGateLoopCap,
  isRunning,
  type WorkstreamNodeIndex,
} from "@t3tools/client-runtime/state/loom/workstreamNodes";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import * as Haptics from "expo-haptics";
import { useRef } from "react";
import { FlatList, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { useNowMinuteMs } from "../../lib/clock";
import {
  type LaneLayout,
  type LaneRow,
  layoutLanes,
  laneStructureKey,
  toggleFold,
} from "./laneLayout.loom";
import { WorkstreamCards } from "./WorkstreamCards.loom";
import { type LaneRowDisplay, useLanePalette, WorkstreamLaneRow } from "./WorkstreamLaneRow.loom";
import { openWorkstreamNodeSheet } from "./WorkstreamNodeSheet.loom";
import { foldCaption, rowCopy, rowTrailing, waveCaption } from "./workstreamCopy.loom";
import { openWorkstreamChild } from "./workstreamNavigation.loom";
import {
  rememberedScrollOffset,
  rememberScrollOffset,
  workstreamExpandedAtom,
  workstreamKey,
  workstreamViewAtom,
} from "./workstreamView.loom";

/**
 * The lanes for `[workstreamKey, maxGutterWidth]`, re-laid only when the structure or the folds
 * change, so a running step ticking over never re-runs the layout.
 */
const laneLayoutAtom = Atom.family((key: string) => {
  const [viewKey, maxGutterWidth] = JSON.parse(key) as [string, number];
  const rootId = (JSON.parse(viewKey) as [EnvironmentId, ThreadId])[1];
  let previous: {
    readonly structure: string;
    readonly expanded: ReadonlySet<string>;
    readonly layout: LaneLayout;
  } | null = null;
  return Atom.make((get): LaneLayout | null => {
    const view = get(workstreamViewAtom(viewKey));
    const expanded = get(workstreamExpandedAtom(viewKey));
    if (!view) return null;
    const nodes = [...view.nodes.values()];
    const structure = laneStructureKey(nodes);
    if (previous?.structure !== structure || previous.expanded !== expanded)
      previous = {
        structure,
        expanded,
        layout: layoutLanes(nodes, rootId, expanded, maxGutterWidth),
      };
    return previous.layout;
  }).pipe(Atom.withLabel(`loom-workstream-lanes:${key}`));
});

function displayOf(
  row: LaneRow,
  nodes: WorkstreamNodeIndex,
  now: number,
  expanded: ReadonlySet<string>,
  selectedThreadId: string | null,
): LaneRowDisplay | null {
  if (row.kind === "wave")
    return { kind: "wave", text: waveCaption(row, now), collapsible: expanded.has(row.key) };
  if (row.kind === "fold") return { kind: "fold", text: foldCaption(row, now) };
  const node = nodes.get(row.key);
  if (!node) return null;
  const copy = rowCopy(node, nodes, now);
  const trailing = rowTrailing(node, now);
  const running = isRunning(node);
  return {
    kind: "thread",
    title: node.title,
    role: copy.role,
    state: copy.state,
    stateTone: copy.attention?.tone ?? (copy.longStep ? "warning" : null),
    progress: copy.progress,
    trailing:
      "chip" in trailing
        ? { text: trailing.chip, tone: trailing.tone }
        : { text: trailing.age, tone: null },
    shape: row.orchestrator
      ? "square"
      : node.outcome !== null || running
        ? "dot"
        : displayColumnOf(node, nodes) === "blocked"
          ? "ringDot"
          : "ring",
    tone:
      node.reasons[0] === "error"
        ? "error"
        : copy.attention
          ? "warning"
          : node.outcome === "done"
            ? "done"
            : node.outcome === null && running
              ? "running"
              : "idle",
    settled: node.outcome !== null,
    badge: row.gutter.arcs.some((arc) => arc.kind === "gate" && arc.joins === "source")
      ? `⟲${Math.max(node.gateRounds, 1)}/${getGateLoopCap(node)}`
      : null,
    foldOpen: row.fold?.expanded ?? null,
    selected: selectedThreadId === row.key,
  };
}

export function WorkstreamBody(props: {
  readonly environmentId: EnvironmentId;
  readonly rootThreadId: ThreadId;
  /** The child open beside the pane, highlighted. */
  readonly selectedThreadId: string | null;
  /** The list's width: the gutter never takes more than 40% of it. */
  readonly width: number;
  readonly split: boolean;
  readonly bottomInset: number;
}) {
  const { environmentId, rootThreadId, split } = props;
  const key = workstreamKey(environmentId, rootThreadId);
  const view = useAtomValue(workstreamViewAtom(key));
  const expanded = useAtomValue(workstreamExpandedAtom(key));
  const setExpanded = useAtomSet(workstreamExpandedAtom(key));
  const lanes = useAtomValue(laneLayoutAtom(JSON.stringify([key, Math.floor(props.width * 0.4)])));
  const now = useNowMinuteMs();
  const palette = useLanePalette();
  const listRef = useRef<FlatList<LaneRow>>(null);
  const restored = useRef(false);

  if (!view || !lanes)
    return (
      <View className="flex-1 items-center justify-center">
        <AppActivityIndicator />
      </View>
    );

  const displays = new Map(
    lanes.rows.map((row) => [
      row.key,
      displayOf(row, view.nodes, now, expanded, props.selectedThreadId),
    ]),
  );
  const openSheet = (threadId: ThreadId) =>
    openWorkstreamNodeSheet({ environmentId, rootThreadId, threadId });
  const onOpen = (threadId: ThreadId) => openWorkstreamChild(environmentId, threadId, { split });
  const onLongPress = (threadId: ThreadId) => {
    void Haptics.selectionAsync();
    openSheet(threadId);
  };
  const onToggleFold = (row: LaneRow) => setExpanded(toggleFold(expanded, row));
  const { plan, activity } = view.rollup;

  return (
    <FlatList
      ref={listRef}
      data={lanes.rows}
      extraData={displays}
      keyExtractor={(row) => row.key}
      renderItem={({ item }) => {
        const display = displays.get(item.key);
        return display ? (
          <WorkstreamLaneRow
            row={item}
            display={display}
            laneCount={lanes.laneCount}
            slotCount={lanes.slotCount}
            palette={palette}
            onOpen={onOpen}
            onLongPress={onLongPress}
            onToggleFold={onToggleFold}
          />
        ) : null;
      }}
      ListHeaderComponent={
        <>
          <WorkstreamCards
            environmentId={environmentId}
            view={view}
            now={now}
            split={split}
            onOpenSheet={openSheet}
          />
          <Text className="px-4 pt-4 pb-1.5 text-xs text-foreground-muted">
            <Text className="text-xs font-t3-bold tracking-wide text-foreground-muted">GRAPH</Text>
            {`  ${activity.running} running · ${plan.columns.blocked} waiting · ${
              plan.columns.done + plan.columns.cancelled
            }/${plan.total}`}
          </Text>
        </>
      }
      ListEmptyComponent={
        <Text className="px-4 py-6 text-center text-sm text-foreground-muted">
          No sub-threads yet.
        </Text>
      }
      contentContainerStyle={{ paddingBottom: props.bottomInset + 16 }}
      onScroll={(event) => rememberScrollOffset(key, event.nativeEvent.contentOffset.y)}
      scrollEventThrottle={100}
      // The remembered offset is restored once, as soon as the content is tall enough for it.
      onContentSizeChange={(_width, height) => {
        if (restored.current) return;
        const offset = rememberedScrollOffset(key);
        if (offset > 0 && height < offset) return;
        restored.current = true;
        if (offset > 0) listRef.current?.scrollToOffset({ offset, animated: false });
      }}
    />
  );
}
