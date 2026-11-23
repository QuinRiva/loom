/**
 * loom: a root row's sub-thread rollup badge, web's `LoomRollupBadge` without its popover: settled
 * over total sub-threads, coloured by `workstreamBadgeTone`, with `· N!` when sub-threads wait on
 * the human. One badge map per environment (`workstreamBadgesAtom`, over the index the workstream
 * screen shares); a row re-renders only when its own badge changes. Also the goal's tasks count.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  WorkstreamBadge,
  WorkstreamBadgeTone,
} from "@t3tools/client-runtime/state/loom/rollup";
import type { EnvironmentId, GoalId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { Pressable, View } from "react-native";

import { RenderErrorBoundary } from "../../components/RenderErrorBoundary";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import { openWorkstreamTasks, useGoalTaskCount } from "../workstream/workstreamGoal.loom";
import { openWorkstream } from "../workstream/workstreamNavigation.loom";
import { workstreamBadgesAtom } from "../workstream/workstreamView.loom";
import {
  THREAD_LIST_V2_MONO_FONT as MONO_FONT,
  selectedThreadRowColors,
} from "./thread-list-v2-row-appearance";

const badgeAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, ThreadId];
  let previous: WorkstreamBadge | null = null;
  return Atom.make((get) => {
    const badge = get(workstreamBadgesAtom(environmentId)).get(threadId) ?? null;
    const next = badge === null || badge.total === 0 ? null : badge;
    if (
      next?.tone !== previous?.tone ||
      next?.settled !== previous?.settled ||
      next?.total !== previous?.total ||
      next?.flagged !== previous?.flagged
    ) {
      previous = next;
    }
    return previous;
  }).pipe(Atom.withLabel(`loom-workstream-badge:${key}`));
});

/** The root's badge, or null for a thread with no live sub-threads. */
export const useWorkstreamBadge = (environmentId: EnvironmentId, threadId: ThreadId) =>
  useAtomValue(badgeAtom(JSON.stringify([environmentId, threadId])));

const TONE_CLASSES: Record<WorkstreamBadgeTone, { text: string; tint: string } | null> = {
  failed: { text: "text-danger-foreground", tint: "accent-danger-foreground" },
  needs_you: { text: "text-warning-foreground", tint: "accent-warning-foreground" },
  working: { text: "text-adaptive-sky-600-400", tint: "accent-adaptive-sky-600-400" },
  done: null,
  waiting: null,
};

/** Pressing the badge opens the root's workstream screen. */
export function WorkstreamBadgeView(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly badge: WorkstreamBadge;
  readonly selected: boolean;
  readonly mutedTextClassName: string;
  readonly mutedTintClassName: string;
}) {
  const tone = TONE_CLASSES[props.badge.tone];
  const { layout } = useAdaptiveWorkspaceLayout();
  return (
    <Pressable
      // Padding cancelled by negative margin grows the touch target, as the PR badge does.
      className="-m-2.5 flex-row items-center gap-1 p-2.5"
      accessibilityRole="button"
      accessibilityLabel={`Open workstream, ${props.badge.settled} of ${props.badge.total} settled${
        props.badge.flagged > 0 ? `, ${props.badge.flagged} need you` : ""
      }`}
      onPress={() =>
        openWorkstream(props.environmentId, props.threadId, { split: layout.usesSplitView })
      }
      // Handle long-press so opening the row menu cannot also open the workstream on release.
      onLongPress={() => undefined}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <SymbolView
        name="point.3.connected.trianglepath.dotted"
        size={12}
        tintColorClassName={
          props.selected
            ? selectedThreadRowColors.mutedIconTintClassName
            : (tone?.tint ?? props.mutedTintClassName)
        }
      />
      <Text
        className={cn(
          "text-xs tabular-nums",
          props.selected
            ? selectedThreadRowColors.mutedForegroundClassName
            : (tone?.text ?? props.mutedTextClassName),
        )}
        style={{ fontFamily: MONO_FONT }}
      >
        {props.badge.settled}/{props.badge.total}
        {props.badge.flagged > 0 ? ` · ${props.badge.flagged}!` : null}
      </Text>
    </Pressable>
  );
}

/** The goal's `done/total` in a bordered pill, green when all are done; opens the screen on Tasks. */
function GoalTasksCountView(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly goalId: GoalId;
  readonly selected: boolean;
  readonly mutedTextClassName: string;
  readonly mutedTintClassName: string;
}) {
  const count = useGoalTaskCount(props.environmentId, props.goalId);
  const { layout } = useAdaptiveWorkspaceLayout();
  if (!count) return null;
  const all = count.done === count.total;
  return (
    <Pressable
      // Grown only vertically, and spaced past the badge's grown touch area, so the two never overlap.
      className="-my-2.5 ml-1 py-2.5"
      accessibilityRole="button"
      accessibilityLabel={`Open tasks, ${count.done} of ${count.total} done`}
      onPress={() =>
        openWorkstreamTasks(props.environmentId, props.threadId, { split: layout.usesSplitView })
      }
      // Handle long-press so opening the row menu cannot also open the tasks on release.
      onLongPress={() => undefined}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <View
        className={cn(
          "flex-row items-center gap-1 rounded-full border px-2 py-px",
          all ? "border-adaptive-emerald-600-400" : "border-border",
        )}
      >
        <SymbolView
          name="checkmark.circle"
          size={12}
          tintColorClassName={
            props.selected
              ? selectedThreadRowColors.mutedIconTintClassName
              : all
                ? "accent-adaptive-emerald-600-400"
                : props.mutedTintClassName
          }
        />
        <Text
          className={cn(
            "text-xs tabular-nums",
            props.selected
              ? selectedThreadRowColors.mutedForegroundClassName
              : all
                ? "text-adaptive-emerald-600-400"
                : props.mutedTextClassName,
          )}
          style={{ fontFamily: MONO_FONT }}
        >
          {count.done}/{count.total}
        </Text>
      </View>
    </Pressable>
  );
}

/**
 * A Home row's ways into its workstream: the sub-thread badge and the goal's tasks count (a
 * top-level row whose goal the snapshot holds and has a task). A count that fails to render drops
 * itself, not the row.
 */
export function WorkstreamRowEntries(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly badge: WorkstreamBadge | null;
  /** The row's Loom goal when it is a top-level thread, else null. */
  readonly goalId: GoalId | null | undefined;
  readonly selected: boolean;
  readonly mutedTextClassName: string;
  readonly mutedTintClassName: string;
}) {
  return (
    <>
      {props.badge ? (
        <WorkstreamBadgeView
          environmentId={props.environmentId}
          threadId={props.threadId}
          badge={props.badge}
          selected={props.selected}
          mutedTextClassName={props.mutedTextClassName}
          mutedTintClassName={props.mutedTintClassName}
        />
      ) : null}
      {props.goalId ? (
        <RenderErrorBoundary renderFallback={() => null}>
          <GoalTasksCountView
            environmentId={props.environmentId}
            threadId={props.threadId}
            goalId={props.goalId}
            selected={props.selected}
            mutedTextClassName={props.mutedTextClassName}
            mutedTintClassName={props.mutedTintClassName}
          />
        </RenderErrorBoundary>
      ) : null}
    </>
  );
}
