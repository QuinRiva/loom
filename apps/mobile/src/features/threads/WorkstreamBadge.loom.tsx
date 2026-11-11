/**
 * loom: a root row's sub-thread rollup badge, web's `LoomRollupBadge` without its popover: settled
 * over total sub-threads, coloured by `workstreamBadgeTone`, with `· N!` when sub-threads wait on
 * the human. One badge map per environment (`workstreamBadgesAtom`, over the index the workstream
 * screen shares); a row re-renders only when its own badge changes.
 */
import { useAtomValue } from "@effect/atom-react";
import type {
  WorkstreamBadge,
  WorkstreamBadgeTone,
} from "@t3tools/client-runtime/state/loom/rollup";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
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

export function WorkstreamBadgeView(props: {
  readonly badge: WorkstreamBadge;
  readonly selected: boolean;
  readonly mutedTextClassName: string;
  readonly mutedTintClassName: string;
}) {
  const tone = TONE_CLASSES[props.badge.tone];
  return (
    <View className="flex-row items-center gap-1">
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
    </View>
  );
}
