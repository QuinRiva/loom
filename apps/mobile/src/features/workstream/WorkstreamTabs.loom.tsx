/**
 * loom: the workstream screen's body with its Graph | Tasks switch (§6 of
 * plans/mobile-goal-tasks/plan.mdx). A root without a goal that has tasks draws `WorkstreamBody`
 * alone, as before. Only the shown tab is mounted; the choice lives in `workstreamTasksStateAtom`.
 */
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { threadFamilyRead } from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadFamilies } from "../../state/threads";
import { WorkstreamBody } from "./WorkstreamBody.loom";
import { Segment } from "./WorkstreamTaskRow.loom";
import { WorkstreamTasksBody } from "./WorkstreamTasksBody.loom";
import {
  type GoalTaskCount,
  type GoalTasksView,
  goalTasksViewAtom,
  type WorkstreamTab,
  workstreamTasksStateAtom,
} from "./workstreamGoal.loom";
import {
  parseWorkstreamKey,
  sameValue,
  workstreamKey,
  workstreamViewAtom,
} from "./workstreamView.loom";

interface TabsSummary {
  readonly goal: GoalTasksView["status"];
  readonly count: GoalTaskCount | null;
  readonly subThreads: boolean;
  /** The root's family read (a finished workstream's sub-threads) has not answered yet. */
  readonly familyPending: boolean;
}

/** What the switch and the first-open rule read; changes only when one of its values does. */
const tabsSummaryAtom = Atom.family((key: string) => {
  const [environmentId, rootId] = parseWorkstreamKey(key);
  let previous: TabsSummary | null = null;
  return Atom.make((get): TabsSummary => {
    const tasks = get(goalTasksViewAtom(key));
    const next: TabsSummary = {
      goal: tasks.status,
      count: tasks.status === "ready" ? tasks.count : null,
      subThreads: (get(workstreamViewAtom(key))?.rollup.plan.total ?? 0) > 0,
      familyPending:
        threadFamilyRead(get(threadFamilies.familyAtom(environmentId, rootId))) === "pending",
    };
    if (previous === null || !sameValue(previous, next)) previous = next;
    return previous;
  }).pipe(Atom.withLabel(`loom-workstream-tabs:${key}`));
});

/** Takes `WorkstreamBody`'s props; the cover screen and the unfolded left pane both draw it. */
export function WorkstreamTabbedBody(props: {
  readonly environmentId: EnvironmentId;
  readonly rootThreadId: ThreadId;
  readonly selectedThreadId: string | null;
  readonly width: number;
  readonly split: boolean;
  readonly bottomInset: number;
}) {
  const { environmentId, rootThreadId } = props;
  const key = workstreamKey(environmentId, rootThreadId);
  const summary = useAtomValue(tabsSummaryAtom(key));
  const state = useAtomValue(workstreamTasksStateAtom(key));
  const setState = useAtomSet(workstreamTasksStateAtom(key));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the shell leaves out a finished workstream's sub-threads; this keeps its family loaded while the screen shows it, as web's useLoomThreadFamily does
  useEffect(
    () => threadFamilies.mount(appAtomRegistry, environmentId, rootThreadId),
    [environmentId, rootThreadId],
  );

  const known = summary.goal === "ready" || summary.goal === "missing";
  // First open: Graph when there are sub-threads to draw; with none in the shell yet, wait for the
  // family read (a finished workstream's arrive with it) and the goal before choosing Tasks.
  const tab: WorkstreamTab | null =
    state.tab ?? (summary.subThreads ? "graph" : summary.familyPending || !known ? null : "tasks");

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- seeds the first-open choice into the per-workstream store, so a sub-thread spawned while Tasks is showing does not flip the tab
  useEffect(() => {
    if (state.tab === null && tab !== null && known)
      setState((current) => (current.tab === null ? { ...current, tab } : current));
  }, [state.tab, tab, known, setState]);

  const graph = (
    <WorkstreamBody
      environmentId={environmentId}
      rootThreadId={rootThreadId}
      selectedThreadId={props.selectedThreadId}
      width={props.width}
      split={props.split}
      bottomInset={props.bottomInset}
    />
  );
  // No goal with tasks: today's screen. While the goal loads the switch waits, unless the tab is
  // already Tasks (the Home count), whose list shows its own loading line.
  if (summary.goal === "absent") return graph;
  if (!known && state.tab !== "tasks") return tab === null ? <Waiting /> : graph;

  const choose = (next: WorkstreamTab) => setState((current) => ({ ...current, tab: next }));
  return (
    <View className="flex-1">
      <View className="flex-row items-center gap-1.5 border-b border-border px-3 py-2">
        <Segment label="Graph" selected={tab === "graph"} onPress={() => choose("graph")} />
        <Segment
          label={summary.count ? `Tasks ${summary.count.done}/${summary.count.total}` : "Tasks"}
          accessibilityLabel={
            summary.count ? `Tasks, ${summary.count.done} of ${summary.count.total} done` : "Tasks"
          }
          selected={tab === "tasks"}
          onPress={() => choose("tasks")}
        />
      </View>
      {tab === null ? (
        <Waiting />
      ) : tab === "graph" ? (
        graph
      ) : (
        <WorkstreamTasksBody
          environmentId={environmentId}
          rootThreadId={rootThreadId}
          selectedThreadId={props.selectedThreadId}
          split={props.split}
          bottomInset={props.bottomInset}
        />
      )}
    </View>
  );
}

function Waiting() {
  return (
    <View className="flex-1 items-center justify-center">
      <AppActivityIndicator />
    </View>
  );
}
