/**
 * loom: the thread screen's ways into its workstream (§6-§7 of plans/mobile-workstream-view/plan.mdx):
 * `useWorkstreamEntry` feeds the header's "Open workstream" action, and the breadcrumb under the
 * header shows a sub-thread's root and how many sub-threads wait on the human.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { Pressable } from "react-native";

import { RenderErrorBoundary } from "../../components/RenderErrorBoundary";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import { openWorkstream } from "./workstreamNavigation.loom";
import { type WorkstreamCrumb, workstreamCrumbAtom, workstreamKey } from "./workstreamView.loom";

const noCrumbAtom = Atom.make<WorkstreamCrumb | null>(null);

export interface WorkstreamEntry {
  readonly crumb: WorkstreamCrumb;
  readonly open: () => void;
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
  return {
    crumb,
    open: () => {
      openWorkstream(environmentId, crumb.rootId, { split: layout.usesSplitView });
      // Split view draws the workstream in the left pane, so a hidden pane comes back.
      if (layout.usesSplitView) setPrimarySidebarVisible(true);
    },
  };
}

function Breadcrumb(props: { readonly entry: WorkstreamEntry }) {
  const { rootTitle, flagged } = props.entry.crumb;
  return (
    <Pressable
      className="flex-row items-center gap-1.5 px-4 pb-1.5 pt-0.5"
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
  );
}

/** Shown for a sub-thread only; a render failure drops it rather than the thread screen. */
export function WorkstreamBreadcrumb(props: { readonly entry: WorkstreamEntry | null }) {
  const { composerKeyboardActive } = useAdaptiveWorkspaceLayout();
  if (!props.entry || props.entry.crumb.isRoot || composerKeyboardActive) return null;
  return (
    <RenderErrorBoundary renderFallback={() => null}>
      <Breadcrumb entry={props.entry} />
    </RenderErrorBoundary>
  );
}
