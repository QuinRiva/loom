import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { rootOf, subtreeOf } from "@t3tools/shared/workstreamGraph";
import { useNavigate } from "@tanstack/react-router";
import {
  CheckIcon,
  FileTextIcon,
  GitBranchIcon,
  GitForkIcon,
  HistoryIcon,
  NetworkIcon,
  RotateCcwIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { lazy, type ReactNode, Suspense, useCallback, useMemo, useState } from "react";

import {
  ATTENTION_BADGE_VARIANTS,
  ATTENTION_LABELS,
  boardMembersOf,
  buildNodeContextMenuItems,
  COLUMN_LABELS,
  COLUMN_ORDER,
  COLUMN_STYLES,
  formatRelativeAge,
  getActivity,
  getGateWaitLabel,
  getPurpose,
  getRoleLabel,
  getVerdictChip,
  groupByColumn,
  isRunning,
  liveNodes,
  outcomeActionsOf,
  TONE_BADGE_VARIANTS,
  truncateLabel,
  type WorkstreamNode,
  type WorkstreamNodeIndex,
} from "../lib/workstreamPresentation";
import { readLocalApi } from "../localApi";
import { ThreadLineageBreadcrumb } from "../loom/ThreadLineageBreadcrumb";
import {
  useWorkstreamCommands,
  useWorkstreamNodes,
  type WorkstreamCommands,
} from "../loom/workstreamState";
import { WorkstreamEnvironmentContext, WorkstreamSpendSlot } from "../loom/WorkstreamSpendSlot";
import { isAbsolutePreviewablePath } from "../markdown-links";
import { useRightPanelStore } from "../rightPanelStore";
import { buildThreadLineage } from "../threadRouteLineage";
import { buildThreadRouteParams } from "../threadRoutes";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Spinner } from "./ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { WorkstreamActiveStrip } from "./WorkstreamActiveStrip";
import { WorkstreamModelPill } from "./WorkstreamModelPill";
import { useThreadOutcomes, WorkstreamTimelineDrawer } from "./WorkstreamTimeline";

// The graph (own SVG renderer + fork–join layout) is its own chunk.
const WorkstreamGraph = lazy(() => import("./WorkstreamGraph"));

/** What a board card can do; the container wires navigation and the panel. */
export interface WorkstreamBoardActions {
  readonly commands: WorkstreamCommands;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenTimeline: (node: WorkstreamNode) => void;
  readonly onOpenReport: (reportPath: string) => void;
}

/**
 * The Workstream board for `threadId`: its lineage children plus the staged
 * roots that continue or fork it, one card per thread in its derived column
 * (held | blocked | ready | in progress | done | cancelled). Outcome controls
 * replace V1's lane select; dependency editing stays. Pure: the preview
 * harness renders it from fixture shells.
 */
export function WorkstreamBoard({
  threadId,
  nodes,
  ...actions
}: { readonly threadId: ThreadId; readonly nodes: WorkstreamNodeIndex } & WorkstreamBoardActions) {
  const members = boardMembersOf(threadId, nodes);
  const groups = groupByColumn(members);
  return (
    <div className="flex flex-col gap-4">
      {COLUMN_ORDER.map((column) => (
        <section className="flex flex-col gap-2" key={column} aria-label={COLUMN_LABELS[column]}>
          <div className="flex items-center gap-2 px-1">
            <span className={`size-2.5 rounded-full ${COLUMN_STYLES[column].dotClass}`} />
            <h3 className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">
              {COLUMN_LABELS[column]}
            </h3>
            <Badge className="ml-auto" size="sm" variant="outline">
              {groups[column].length}
            </Badge>
          </div>
          {groups[column].map((node) => (
            <WorkstreamCard
              key={node.id}
              node={node}
              siblings={members.filter(
                (sibling) =>
                  sibling.id !== node.id && sibling.parentThreadId === node.parentThreadId,
              )}
              nodes={nodes}
              {...actions}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function WorkstreamCard({
  node,
  siblings,
  nodes,
  commands,
  onOpenThread,
  onOpenTimeline,
  onOpenReport,
}: {
  readonly node: WorkstreamNode;
  readonly siblings: ReadonlyArray<WorkstreamNode>;
  readonly nodes: WorkstreamNodeIndex;
} & WorkstreamBoardActions) {
  const style = COLUMN_STYLES[node.column];
  const verdict = getVerdictChip(node);
  const gateWait = getGateWaitLabel(node, nodes);
  const running = isRunning(node);
  const open = () => onOpenThread(node.id);
  return (
    <div
      className={`rounded-lg border border-l-4 border-border ${style.ruleClass} bg-card p-3`}
      data-workstream-card={node.id}
    >
      <button type="button" className="flex w-full items-start gap-2 text-left" onClick={open}>
        <Badge size="sm" variant="outline" className="max-w-36">
          <span className="truncate font-mono">{getRoleLabel(node)}</span>
        </Badge>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-2xs text-muted-foreground">
          <WorkstreamModelPill selection={node.modelSelection} />
          <WorkstreamSpendSlot threadId={node.id} />
          <span>{formatRelativeAge(node.lastActivityAt)}</span>
        </span>
      </button>

      <button type="button" className="mt-2 block w-full text-left" onClick={open}>
        <div className="line-clamp-2 text-sm font-semibold leading-snug text-foreground">
          {node.title}
        </div>
        <div className="mt-2 border-l-2 border-border pl-2 text-xs leading-relaxed">
          <span className="mr-1 text-3xs font-semibold uppercase tracking-widest text-muted-foreground">
            Purpose
          </span>
          <span className="line-clamp-3 text-foreground/70">{getPurpose(node)}</span>
        </div>
        {node.preview ? (
          <div className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
            <span aria-hidden className="mt-px shrink-0">
              ›
            </span>
            <span className="line-clamp-1 italic">{node.preview}</span>
          </div>
        ) : null}
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          {running ? (
            <span className={`size-2 rounded-full ${style.dotClass}`} aria-label="running" />
          ) : null}
          <span>{getActivity(node)}</span>
        </div>
      </button>

      {node.reasons.length > 0 || verdict || gateWait || node.forkFromThreadId ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {node.forkFromThreadId ? (
            <Badge size="sm" variant="outline">
              <GitForkIcon />
              <span className="max-w-40 truncate">
                forked from {nodes.get(node.forkFromThreadId)?.title ?? node.forkFromThreadId}
              </span>
            </Badge>
          ) : null}
          {node.reasons.map((reason) => (
            <Badge key={reason} size="sm" variant={ATTENTION_BADGE_VARIANTS[reason]}>
              {ATTENTION_LABELS[reason]}
            </Badge>
          ))}
          {verdict ? (
            <Badge size="sm" variant={TONE_BADGE_VARIANTS[verdict.tone]}>
              {verdict.label}
            </Badge>
          ) : null}
          {gateWait ? (
            <Badge size="sm" variant={gateWait.active ? "info" : "secondary"}>
              {gateWait.label}
            </Badge>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
        {outcomeActionsOf(node).map((action) => (
          <Tooltip key={action.label}>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant={action.outcome === "cancelled" ? "ghost" : "outline"}
                  onClick={() => commands.setOutcome(node.id, action.outcome)}
                />
              }
            >
              {action.outcome === "done" ? (
                <CheckIcon />
              ) : action.outcome === null ? (
                <RotateCcwIcon />
              ) : (
                <XIcon />
              )}
              {action.label}
            </TooltipTrigger>
            <TooltipPopup>{action.hint}</TooltipPopup>
          </Tooltip>
        ))}
        {node.attention.length > 0 ? (
          <Button size="xs" variant="ghost" onClick={() => commands.clearAttention(node.id)}>
            Clear flags
          </Button>
        ) : null}
        {running ? (
          <Button size="xs" variant="destructive-outline" onClick={() => commands.stop(node.id)}>
            <SquareIcon />
            Stop
          </Button>
        ) : null}
        <span className="ml-auto flex items-center gap-1">
          {node.reportPath ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label="Open report"
                    size="icon-xs"
                    variant="ghost"
                    onClick={() => onOpenReport(node.reportPath!)}
                  />
                }
              >
                <FileTextIcon />
              </TooltipTrigger>
              <TooltipPopup>Open this thread&rsquo;s latest report</TooltipPopup>
            </Tooltip>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Open timeline"
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => onOpenTimeline(node)}
                />
              }
            >
              <HistoryIcon />
            </TooltipTrigger>
            <TooltipPopup>Timeline</TooltipPopup>
          </Tooltip>
        </span>
      </div>

      {node.parentThreadId !== null ? (
        <DependencyEditor node={node} siblings={siblings} nodes={nodes} commands={commands} />
      ) : null}
    </div>
  );
}

/**
 * The card's "Waits on" editor: tick a sibling to add a dependency, untick to
 * remove it. Dispatches `thread.dependencies.set` with the full new set.
 */
function DependencyEditor({
  node,
  siblings,
  nodes,
  commands,
}: {
  readonly node: WorkstreamNode;
  readonly siblings: ReadonlyArray<WorkstreamNode>;
  readonly nodes: WorkstreamNodeIndex;
  readonly commands: WorkstreamCommands;
}) {
  const selected = new Set(node.blockedBy);
  const deps = node.blockedBy.flatMap((id) => nodes.get(id) ?? []);
  const toggle = (depId: ThreadId) =>
    commands.setDependencies(
      node,
      selected.has(depId)
        ? node.blockedBy.filter((id) => id !== depId)
        : [...node.blockedBy, depId],
    );
  return (
    <details className="mt-2 rounded-md border border-border bg-muted">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-2xs text-muted-foreground marker:hidden">
        <span className="shrink-0">Waits on</span>
        <span className="flex flex-1 flex-wrap items-center justify-end gap-1">
          {deps.length === 0 ? (
            <Badge size="sm" variant="outline">
              0
            </Badge>
          ) : (
            deps.map((dep) => (
              <Badge key={dep.id} size="sm" variant="outline">
                <span className={`size-1.5 rounded-full ${COLUMN_STYLES[dep.column].dotClass}`} />
                <span className="max-w-32 truncate">{dep.title}</span>
                {dep.archived ? <span className="text-muted-foreground">(archived)</span> : null}
              </Badge>
            ))
          )}
        </span>
      </summary>
      <div className="flex flex-col gap-1.5 border-t border-border px-2.5 py-2">
        {siblings.length === 0 ? (
          <span className="text-2xs text-muted-foreground">No sibling sub-threads.</span>
        ) : (
          siblings.map((sibling) => (
            <label
              key={sibling.id}
              className="flex cursor-pointer items-center gap-2 text-2xs text-foreground/80"
            >
              <Checkbox
                checked={selected.has(sibling.id)}
                onCheckedChange={() => toggle(sibling.id)}
              />
              <span className={`size-2 rounded-full ${COLUMN_STYLES[sibling.column].dotClass}`} />
              <span className="truncate">{truncateLabel(sibling.title, 40)}</span>
            </label>
          ))
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Right-panel surfaces (seam 18): `workstream` (board) and `graph`
// ---------------------------------------------------------------------------

/** What both surfaces share: state, controls, navigation and the timeline. */
function useWorkstreamSurface(threadRef: ScopedThreadRef) {
  const navigate = useNavigate();
  const { nodes, rollupOf } = useWorkstreamNodes(threadRef.environmentId);
  const commands = useWorkstreamCommands(threadRef.environmentId);
  const [timelineId, setTimelineId] = useState<ThreadId | null>(null);
  const onOpenThread = useCallback(
    (threadId: ThreadId) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(threadRef.environmentId, threadId)),
      }),
    [navigate, threadRef.environmentId],
  );
  // Reports are absolute paths outside any worktree: open them read-only in
  // THIS panel (the open thread's right panel).
  const onOpenReport = useCallback(
    (reportPath: string) => {
      if (isAbsolutePreviewablePath(reportPath))
        useRightPanelStore.getState().openFileAbsolute(threadRef, reportPath);
    },
    [threadRef],
  );
  const titleOf = useCallback((id: ThreadId) => nodes.get(id)?.title ?? id, [nodes]);
  const actions: WorkstreamBoardActions = {
    commands,
    onOpenThread,
    onOpenReport,
    onOpenTimeline: (node) => setTimelineId(node.id),
  };
  const timelineNode = timelineId === null ? undefined : nodes.get(timelineId);
  const outcomes = useThreadOutcomes(threadRef.environmentId, timelineNode);
  const timeline = (
    <WorkstreamTimelineDrawer
      node={timelineNode}
      outcomes={outcomes}
      titleOf={titleOf}
      onClose={() => setTimelineId(null)}
      onOpenThread={onOpenThread}
      onOpenReport={onOpenReport}
    />
  );
  return { nodes, rollupOf, titleOf, actions, timeline, setTimelineId };
}

function SurfaceHeader({
  icon,
  title,
  node,
  nodes,
  threadTitle,
  onOpenThread,
  children,
}: {
  icon: ReactNode;
  title: string;
  node: WorkstreamNode | undefined;
  nodes: WorkstreamNodeIndex;
  threadTitle: string;
  onOpenThread: (threadId: ThreadId) => void;
  children?: ReactNode;
}) {
  const lineage = useMemo(() => (node ? buildThreadLineage(nodes, node.id) : []), [nodes, node]);
  const forkedFrom = node?.forkFromThreadId
    ? {
        threadId: node.forkFromThreadId,
        title: nodes.get(node.forkFromThreadId)?.title ?? node.forkFromThreadId,
      }
    : null;
  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
        {icon}
        {title}
        <span className="min-w-0 truncate text-xs font-normal text-muted-foreground">
          · {threadTitle}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1.5">{children}</span>
      </div>
      <ThreadLineageBreadcrumb
        lineage={lineage}
        forkedFrom={forkedFrom}
        onNavigateToThread={onOpenThread}
      />
    </div>
  );
}

/** The `workstream` surface: the board for the open thread. */
export function WorkstreamPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { nodes, actions, timeline } = useWorkstreamSurface(threadRef);
  const node = nodes.get(threadRef.threadId);
  const members = boardMembersOf(threadRef.threadId, nodes);
  return (
    <WorkstreamEnvironmentContext value={threadRef.environmentId}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <SurfaceHeader
          icon={<GitBranchIcon className="size-4 text-muted-foreground" />}
          title="Workstream"
          node={node}
          nodes={nodes}
          threadTitle={node?.title ?? "this thread"}
          onOpenThread={actions.onOpenThread}
        >
          <Badge size="sm" variant="outline">
            {members.length} {members.length === 1 ? "sub-thread" : "sub-threads"}
          </Badge>
        </SurfaceHeader>
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div className="h-full overflow-y-auto px-3 py-3">
            {members.length === 0 ? (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground">
                No sub-threads. Children this thread spawns appear here.
              </div>
            ) : (
              <WorkstreamBoard threadId={threadRef.threadId} nodes={nodes} {...actions} />
            )}
          </div>
          {timeline}
        </div>
      </div>
    </WorkstreamEnvironmentContext>
  );
}

/** The `graph` surface: the whole orchestration the open thread belongs to. */
export function WorkstreamGraphPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const { nodes, rollupOf, titleOf, actions, timeline, setTimelineId } =
    useWorkstreamSurface(threadRef);
  const live = useMemo(() => liveNodes(nodes.values()), [nodes]);
  const rootId = nodes.has(threadRef.threadId) ? rootOf(threadRef.threadId, live) : null;
  const subtree = useMemo(() => (rootId ? subtreeOf(rootId, live) : []), [live, rootId]);
  const rollup = rootId ? rollupOf(rootId) : null;
  const root = rootId ? nodes.get(rootId) : undefined;
  const { commands, onOpenThread, onOpenReport } = actions;

  // Right-click / keyboard menu on a node: the app's canonical context menu.
  const onNodeContextMenu = async (node: WorkstreamNode, position: { x: number; y: number }) => {
    const action = await readLocalApi()?.contextMenu.show(
      buildNodeContextMenuItems(node),
      position,
    );
    if (action === "open") onOpenThread(node.id);
    else if (action === "parent" && node.parentThreadId) onOpenThread(node.parentThreadId);
    else if (action === "history") setTimelineId(node.id);
    else if (action === "report" && node.reportPath) onOpenReport(node.reportPath);
    else if (action === "outcome:done") commands.setOutcome(node.id, "done");
    else if (action === "outcome:cancelled") commands.setOutcome(node.id, "cancelled");
    else if (action === "outcome:reopen") commands.setOutcome(node.id, null);
    else if (action === "clear-flags") commands.clearAttention(node.id);
    else if (action === "stop") commands.stop(node.id);
  };

  return (
    <WorkstreamEnvironmentContext value={threadRef.environmentId}>
      <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
        <SurfaceHeader
          icon={<NetworkIcon className="size-4 text-muted-foreground" />}
          title="Graph"
          node={nodes.get(threadRef.threadId)}
          nodes={nodes}
          threadTitle={root?.title ?? "this thread"}
          onOpenThread={onOpenThread}
        >
          {rollup ? (
            <Badge size="sm" variant="outline">
              {rollup.plan.columns.done + rollup.plan.columns.cancelled}/{rollup.plan.total} settled
            </Badge>
          ) : null}
          {rollup?.plan.deadlocked ? (
            <Badge size="sm" variant="error">
              deadlocked
            </Badge>
          ) : null}
        </SurfaceHeader>
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
                    nodes={subtree.filter((node) => node.id !== rootId)}
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
                    onOpenTimeline={(node) => setTimelineId(node.id)}
                    onNodeContextMenu={(node, position) => void onNodeContextMenu(node, position)}
                  />
                </Suspense>
              </>
            )}
          </div>
          {timeline}
        </div>
      </div>
    </WorkstreamEnvironmentContext>
  );
}
