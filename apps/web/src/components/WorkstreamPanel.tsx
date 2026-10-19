import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { rootOf, subtreeOf } from "@t3tools/shared/workstreamGraph";
import { useNavigate } from "@tanstack/react-router";
import { NetworkIcon } from "lucide-react";
import { lazy, Suspense, useState } from "react";

import {
  buildNodeContextMenuItems,
  type ConversationAnchor,
  dispatchAnchorOf,
  liveNodes,
  type WorkstreamNode,
} from "../lib/workstreamPresentation";
import { readLocalApi } from "../localApi";
import { useConversationJumpStore } from "../loom/conversationJump";
import { PromptCaptureMenu } from "../loom/PromptCaptureMenu";
import { ThreadLineageBreadcrumb } from "../loom/ThreadLineageBreadcrumb";
import { useOpenHandoffOrigin } from "../loom/ThreadStart"; // loom: "Started by" lands at the handoff
import { useWorkstreamCommands, useWorkstreamNodes } from "../loom/workstreamState";
import { WorkstreamEnvironmentContext, WorkstreamTotalSpend } from "../loom/WorkstreamSpendSlot";
import { isAbsolutePreviewablePath } from "../markdown-links";
import { useRightPanelStore } from "../rightPanelStore";
import { useThreadShell } from "../state/entities"; // loom: agent-started origin title
import { threadStartOriginOf } from "@t3tools/client-runtime/state/loom/threadOrigin"; // loom: agent-started origin
import { buildThreadLineage } from "../threadRouteLineage";
import { buildThreadRouteParams } from "../threadRoutes";
import { Badge } from "./ui/badge";
import { Spinner } from "./ui/spinner";
import { WorkstreamActiveStrip } from "./WorkstreamActiveStrip";
import { useThreadHistory, WorkstreamTimelineDrawer } from "./WorkstreamTimeline";

// The graph (own SVG renderer + fork–join layout) is its own chunk.
const WorkstreamGraph = lazy(() => import("./WorkstreamGraph"));

/**
 * The `workstream` right-panel surface (seam 18): the graph of the whole
 * orchestration the open thread belongs to, with its active strip, header
 * (total spend, settled count, lineage) and the node timeline drawer.
 */
const startOriginIdOf = (node: WorkstreamNode | undefined) =>
  (node ? threadStartOriginOf(node)?.threadId : null) ?? null;

export function WorkstreamPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const { nodes, rollupOf } = useWorkstreamNodes(threadRef.environmentId);
  const commands = useWorkstreamCommands(threadRef.environmentId);
  const [timelineId, setTimelineId] = useState<ThreadId | null>(null);
  const onOpenThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(threadRef.environmentId, threadId)),
    });
  // Reports are absolute paths outside any worktree: open them read-only in
  // THIS panel (the open thread's right panel).
  const onOpenReport = (reportPath: string) => {
    if (isAbsolutePreviewablePath(reportPath))
      useRightPanelStore.getState().openFileAbsolute(threadRef, reportPath);
  };
  const titleOf = (id: ThreadId) => nodes.get(id)?.title ?? id;
  // Park the anchor, then open its thread: that timeline scrolls to it (loom/conversationJump).
  const onJump = (anchor: ConversationAnchor) => {
    useConversationJumpStore.getState().setRequest(anchor);
    onOpenThread(anchor.threadId);
  };
  const timelineNode = timelineId === null ? undefined : nodes.get(timelineId);
  const history = useThreadHistory(threadRef.environmentId, timelineNode);

  // loom: the thread a started root came from (a handoff's origin, a continuation's
  // predecessor); archived origins resolve through `nodes`.
  const originId = startOriginIdOf(nodes.get(threadRef.threadId));
  const originTitle = useThreadShell(
    originId ? scopeThreadRef(threadRef.environmentId, originId) : null,
  )?.title;
  const openHandoffOrigin = useOpenHandoffOrigin(threadRef.environmentId); // loom

  // Derived after the last hook call: a value still in use across a hook call
  // is one the compiler will not cache.
  const node = nodes.get(threadRef.threadId);
  const forkedFrom = node?.forkFromThreadId
    ? { threadId: node.forkFromThreadId, title: titleOf(node.forkFromThreadId) }
    : null;
  const startOrigin = node ? threadStartOriginOf(node) : null;
  const live = liveNodes(nodes.values());
  const rootId = node ? rootOf(node.id, live) : null;
  const subtree = rootId ? subtreeOf(rootId, live) : [];
  const rollup = rootId ? rollupOf(rootId) : null;
  const lineage = node ? buildThreadLineage(nodes, node.id) : [];
  // The whole workstream, archived threads included: its root and every descendant.
  const all = [...nodes.values()];
  const workstream = node ? subtreeOf(rootOf(node.id, all), all).map((member) => member.id) : [];
  const startedBy = startOrigin && {
    ...startOrigin,
    title: nodes.get(startOrigin.threadId)?.title ?? originTitle ?? "an archived thread",
  };

  // Right-click / keyboard menu on a node: the app's canonical context menu.
  const onNodeContextMenu = async (target: WorkstreamNode, position: { x: number; y: number }) => {
    const action = await readLocalApi()?.contextMenu.show(
      buildNodeContextMenuItems(target),
      position,
    );
    if (action === "open") onOpenThread(target.id);
    else if (action === "dispatch") {
      const dispatch = dispatchAnchorOf(target);
      if (dispatch) onJump(dispatch);
    } else if (action === "history") setTimelineId(target.id);
    else if (action === "report" && target.reportPath) onOpenReport(target.reportPath);
    else if (action === "outcome:done") commands.setOutcome(target.id, "done");
    else if (action === "outcome:cancelled") commands.setOutcome(target.id, "cancelled");
    else if (action === "outcome:reopen") commands.setOutcome(target.id, null);
    else if (action === "clear-flags") commands.clearAttention(target.id);
    else if (action === "stop") commands.stop(target.id);
  };

  return (
    <WorkstreamEnvironmentContext value={threadRef.environmentId}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <NetworkIcon className="size-4 text-muted-foreground" />
            Workstream
            <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">
              · {(rootId && nodes.get(rootId)?.title) ?? "this thread"}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              <WorkstreamTotalSpend threadIds={workstream} />
              {/* The root renders only as graph bridges, so its prompt is reached here. */}
              {rootId ? (
                <PromptCaptureMenu
                  threadId={rootId}
                  refreshKey={nodes.get(rootId)?.lastActivityAt ?? ""}
                  onOpen={onOpenReport}
                />
              ) : null}
              {rollup ? (
                <Badge size="sm" variant="outline">
                  {rollup.plan.columns.done + rollup.plan.columns.cancelled}/{rollup.plan.total}{" "}
                  settled
                </Badge>
              ) : null}
              {rollup?.plan.deadlocked ? (
                <Badge size="sm" variant="error">
                  deadlocked
                </Badge>
              ) : null}
            </span>
          </div>
          <ThreadLineageBreadcrumb
            lineage={lineage}
            forkedFrom={forkedFrom}
            startedBy={startedBy}
            onNavigateToThread={onOpenThread}
            // loom: the agent-started chip opens its origin at the handoff
            onOpenStartedBy={() => originId && openHandoffOrigin(originId, threadRef.threadId)}
          />
        </div>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div className="h-full overflow-y-auto px-3 py-3">
            {rootId === null ? (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                This thread is not part of a workstream.
              </div>
            ) : (
              <>
                {rollup ? (
                  <WorkstreamActiveStrip
                    nodes={subtree.filter((member) => member.id !== rootId)}
                    rollup={rollup}
                    onOpenThread={onOpenThread}
                  />
                ) : null}
                <Suspense
                  fallback={
                    <div className="flex h-40 items-center justify-center">
                      <Spinner />
                    </div>
                  }
                >
                  <WorkstreamGraph
                    key={rootId}
                    viewKey={scopedThreadKey(scopeThreadRef(threadRef.environmentId, rootId))}
                    nodes={subtree}
                    byId={nodes}
                    rollupOf={rollupOf}
                    titleOf={titleOf}
                    onOpenThread={onOpenThread}
                    onJump={onJump}
                    onOpenTimeline={(member) => setTimelineId(member.id)}
                    onNodeContextMenu={(member, position) =>
                      void onNodeContextMenu(member, position)
                    }
                  />
                </Suspense>
              </>
            )}
          </div>
          <WorkstreamTimelineDrawer
            node={timelineNode}
            history={history}
            titleOf={titleOf}
            onClose={() => setTimelineId(null)}
            onOpenThread={onOpenThread}
            onOpenReport={onOpenReport}
            onJump={onJump}
          />
        </div>
      </div>
    </WorkstreamEnvironmentContext>
  );
}
