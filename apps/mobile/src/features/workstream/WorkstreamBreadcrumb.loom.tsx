/**
 * loom: the thread screen's ways into its workstream (§6-§7 of plans/mobile-workstream-view/plan.mdx):
 * `useWorkstreamEntry` feeds the header's "Open workstream" action, and the breadcrumb under the
 * header shows a sub-thread's root and how many sub-threads wait on the human.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { Pressable, View } from "react-native";

import { RenderErrorBoundary } from "../../components/RenderErrorBoundary";
import type { AppBarAction } from "../../components/ui/AppBar.types";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import { openWorkstream } from "./workstreamNavigation.loom";
import {
  openWorkstreamTasks,
  type WorkstreamCrumb,
  workstreamCrumbAtom,
} from "./workstreamGoal.loom";
import { workstreamKey } from "./workstreamView.loom";

const noCrumbAtom = Atom.make<WorkstreamCrumb | null>(null);

export interface WorkstreamEntry {
  readonly crumb: WorkstreamCrumb;
  readonly open: () => void;
  /** Opens the workstream on Tasks at `taskId`, marked. */
  readonly openTask: (taskId: string) => void;
}

/** The workstream this thread belongs to (as a sub-thread or as its root), or null. */
export function useWorkstreamEntry(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): WorkstreamEntry | null {
  const crumb = useAtomValue(
    environmentId && threadId
      ? workstreamCrumbAtom(workstreamKey(environmentId, threadId))
      : noCrumbAtom,
  );
  const { layout, setPrimarySidebarVisible } = useAdaptiveWorkspaceLayout();
  if (!crumb || !environmentId) return null;
  const split = layout.usesSplitView;
  // Split view draws the workstream in the left pane, so a hidden pane comes back.
  const reveal = () => {
    if (split) setPrimarySidebarVisible(true);
  };
  return {
    crumb,
    open: () => {
      openWorkstream(environmentId, crumb.rootId, { split });
      reveal();
    },
    openTask: (taskId) => {
      openWorkstreamTasks(environmentId, crumb.rootId, { split, taskId });
      reveal();
    },
  };
}

/** The thread header's "Open workstream" action, after Files. */
export function workstreamAppBarAction(entry: WorkstreamEntry): AppBarAction {
  return {
    accessibilityLabel: "Open workstream",
    icon: "point.3.connected.trianglepath.dotted",
    separateBackground: false,
    onPress: entry.open,
  };
}

function Breadcrumb(props: { readonly entry: WorkstreamEntry }) {
  const { rootTitle, flagged, task } = props.entry.crumb;
  return (
    <View className="flex-row items-center gap-1.5 px-4 pb-1.5 pt-0.5">
      <Pressable
        // With a task beside it the root gives way, so the task keeps most of the line.
        className={
          task
            ? "max-w-[50%] shrink-0 flex-row items-center gap-1.5"
            : "shrink flex-row items-center gap-1.5"
        }
        accessibilityRole="button"
        accessibilityLabel={`Open workstream ${rootTitle}${flagged > 0 ? `, ${flagged} flagged` : ""}`}
        onPress={props.entry.open}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <SymbolView
          name="point.3.connected.trianglepath.dotted"
          size={12}
          tintColorClassName="accent-foreground-muted"
        />
        <Text className="shrink text-xs text-foreground-muted" numberOfLines={1}>
          ↑ in {rootTitle}
        </Text>
        {flagged > 0 ? (
          <Text className="text-xs text-warning-foreground">· {flagged} flagged</Text>
        ) : null}
      </Pressable>
      {task ? (
        <Pressable
          className="min-w-0 flex-1"
          accessibilityRole="button"
          accessibilityLabel={`Open tasks at ${task.text}`}
          onPress={() => props.entry.openTask(task.id)}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Text className="text-xs text-primary-text" numberOfLines={1}>
            · on {task.text}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Shown for a sub-thread only; a render failure drops it rather than the thread screen. */
export function WorkstreamBreadcrumb(props: { readonly entry: WorkstreamEntry | null }) {
  if (!props.entry || props.entry.crumb.isRoot) return null;
  return (
    <RenderErrorBoundary renderFallback={() => null}>
      <Breadcrumb entry={props.entry} />
    </RenderErrorBoundary>
  );
}
