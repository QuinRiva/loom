import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ProjectId, ThreadId, ThreadPlanLane } from "@t3tools/contracts";
import { rootOf, subtreeOf } from "@t3tools/shared/workstreamGraph";
import { useNavigate } from "@tanstack/react-router";
import {
  GitBranchIcon,
  LayoutDashboardIcon,
  Loader2Icon,
  NetworkIcon,
  PlusIcon,
} from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";

import { selectWorkstreamPanelState, useWorkstreamUiStore } from "../loom/workstreamUiStore";

import { newThreadId } from "../lib/utils";
import { formatCostUsd } from "../lib/contextWindow";
import {
  ATTENTION_STYLES,
  buildNodeContextMenuItems,
  type ChildIndex,
  COLUMN_LABELS,
  COLUMN_ORDER,
  COLUMN_SHORT_LABELS,
  formatContextPercent,
  FAN_IN_CHIP_STYLES,
  formatDiffMetric,
  formatModelLabel,
  formatRelativeAge,
  getActivity,
  getAttentionBadges,
  getFanInChip,
  getGateWaitLabel,
  getLastActivityAt,
  getPurpose,
  getRoleLabel,
  getThreadStatus,
  getVerdictChip,
  groupChildrenByColumn,
  hasRunningSignal,
  SETTABLE_LANES,
  STATUS_STYLES,
  truncateLabel,
} from "../lib/workstreamPresentation";
import { useThreadLifecycle, WorkstreamLifecycleDrawer } from "./WorkstreamTimeline";
import { WorkstreamActiveStrip } from "./WorkstreamActiveStrip";
import { useThreadShells } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import type { SidebarThreadSummary, Thread } from "../types";
import { useLoomScrollStore } from "../loom/loomScrollStore";
import { useRightPanelStore } from "../rightPanelStore";
import { isAbsolutePreviewablePath } from "../markdown-links";
import { readLocalApi } from "../localApi";

type WorkstreamView = "board" | "graph";

// The graph subtree (own SVG renderer + hand-rolled fork–join layout) is
// lazy-loaded so it lands in its own chunk and never bloats the board render path.
const WorkstreamGraph = lazy(() => import("./WorkstreamGraph"));

// The board manages THIS thread's direct children (sibling dependency editing,
// per-lane kanban). The graph instead renders the WHOLE orchestration, so the
// two views read different slices of the same shell list. Both operate over the
// thread shells already filtered to the active environment.
function selectWorkstreamChildren(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  parentThreadId: ThreadId,
): ReadonlyArray<SidebarThreadSummary> {
  return shells
    .filter((thread) => thread.parentThreadId === parentThreadId)
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
}

interface WorkstreamPanelProps {
  activeThread: Thread | undefined;
  activeProjectId: ProjectId | undefined;
}

export function WorkstreamPanel({ activeThread, activeProjectId }: WorkstreamPanelProps) {
  const navigate = useNavigate();
  const allShells = useThreadShells();
  const environmentShells = useMemo(
    () =>
      activeThread
        ? allShells.filter((thread) => thread.environmentId === activeThread.environmentId)
        : [],
    [allShells, activeThread],
  );
  const children = useMemo(
    () => (activeThread ? selectWorkstreamChildren(environmentShells, activeThread.id) : []),
    [environmentShells, activeThread],
  );
  const childById = useMemo<ChildIndex>(
    () => new Map(children.map((thread) => [thread.id, thread])),
    [children],
  );
  // The whole orchestration as seen from the active thread: walk lineage up to
  // the root orchestrator, then return its full descendant subtree,
  // time-ordered. The shell list holds every thread in the environment, so
  // grandchildren are present.
  const rootThreadId = useMemo(
    () => (activeThread ? rootOf(activeThread.id, environmentShells) : null),
    [environmentShells, activeThread],
  );
  const subtree = useMemo(
    () =>
      rootThreadId
        ? subtreeOf(rootThreadId, environmentShells).toSorted((left, right) =>
            left.createdAt.localeCompare(right.createdAt),
          )
        : [],
    [environmentShells, rootThreadId],
  );
  const subtreeById = useMemo<ChildIndex>(
    () => new Map(subtree.map((thread) => [thread.id, thread])),
    [subtree],
  );
  const requestScrollToDispatch = useLoomScrollStore((store) => store.requestScrollToDispatch);
  const spawnThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const setPlanLane = useAtomCommand(threadEnvironment.setPlanLane);
  const interruptTurn = useAtomCommand(threadEnvironment.interruptTurn);
  const clearThreadAttention = useAtomCommand(threadEnvironment.clearAttention);
  const setThreadDependencies = useAtomCommand(threadEnvironment.setDependencies);
  // Durable per-thread panel state (plan W2): view and the half-typed spawn
  // form survive tab switches and navigation like every upstream per-thread
  // surface. `isSpawning`/`error` and everything inside WorkstreamGraph
  // (viewBox, drag refs) stay component-local (tier 4). Node SELECTION no
  // longer exists: the redesign made node-click enter the thread, so the only
  // panel-level per-thread UI state is the drawer target below.
  const panelRef = useMemo(
    () => (activeThread ? scopeThreadRef(activeThread.environmentId, activeThread.id) : null),
    [activeThread],
  );
  const panelState = useWorkstreamUiStore((store) =>
    selectWorkstreamPanelState(store.panelByThreadKey, panelRef),
  );
  const setViewState = useWorkstreamUiStore((store) => store.setView);
  const updateSpawnDraft = useWorkstreamUiStore((store) => store.updateSpawnDraft);
  const clearSpawnDraft = useWorkstreamUiStore((store) => store.clearSpawnDraft);
  const view = panelState.view;
  const setView = (next: WorkstreamView) => {
    if (panelRef) setViewState(panelRef, next);
  };
  // Graph gesture map (redesign): clicking a node ENTERS its thread (the cheapest
  // gesture for the primary need); middle-clicking a node opens its history
  // drawer directly (the frequent "View history" action, no menu round-trip — and
  // middle-clicking a different node re-points the same drawer, switching
  // histories without reselecting); other secondary actions (Open report,
  // Release, Clear flags, Stop) live in a right-click context menu
  // (`handleNodeContextMenu` below). "View history" also opens the right-side
  // lifecycle drawer. `inspectedThreadId` is the drawer target — deliberately
  // component-local (tier 4), a transient inspection, unlike the durable
  // view/spawn-draft state above.
  const [inspectedThreadId, setInspectedThreadId] = useState<ThreadId | null>(null);
  // Lifecycle fetch + per-thread cache lives HERE (panel scope), not in the
  // drawer component, so it survives Board⇄Graph view switches and drawer
  // open/close (the graph subtree unmounts on Board; the panel does not).
  // Guard the drawer against a stale target: when the active workstream or
  // environment changes (or the inspected thread leaves the subtree), the
  // inspected id no longer belongs to what's on screen — reset it so the drawer
  // never opens blank or queries the old thread against a new environment.
  const inspectedInSubtree =
    inspectedThreadId !== null && subtreeById.has(inspectedThreadId) ? inspectedThreadId : null;
  useEffect(() => {
    if (inspectedThreadId !== null && inspectedInSubtree === null) setInspectedThreadId(null);
  }, [inspectedThreadId, inspectedInSubtree]);
  const lifecycleState = useThreadLifecycle(
    activeThread?.environmentId ?? null,
    inspectedInSubtree,
  );
  const { role, title, purpose } = panelState.spawnDraft;
  const setRole = (next: string) => panelRef && updateSpawnDraft(panelRef, { role: next });
  const setTitle = (next: string) => panelRef && updateSpawnDraft(panelRef, { title: next });
  const setPurpose = (next: string) => panelRef && updateSpawnDraft(panelRef, { purpose: next });
  const [isSpawning, setIsSpawning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!activeThread || !activeProjectId) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-white/50">
        Open a thread to manage its workstream.
      </div>
    );
  }

  const environmentId = activeThread.environmentId;
  // Saved-view identity for the graph: every thread of an orchestration shares
  // one graph, so the view follows the user across sibling threads.
  const graphViewKey = scopedThreadKey(
    scopeThreadRef(environmentId, rootThreadId ?? activeThread.id),
  );

  const openThread = (thread: SidebarThreadSummary) =>
    navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });

  // Clicking an orchestrator (bridge) node: route to the dispatching orchestrator
  // thread, then ask its timeline to scroll to the turn that spawned the wave.
  const openDispatch = (
    threadId: ThreadId,
    anchorAtIso: string,
    expandConsultTargetId?: ThreadId,
  ) => {
    requestScrollToDispatch(threadId, anchorAtIso, expandConsultTargetId);
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };

  // Open a sub-thread's completion report (an absolute markdown path outside any
  // worktree) in the read-only file preview surface. Keyed to THIS panel's
  // thread ref — the report belongs to a sub-thread, but the right panel shown
  // is the open (parent) thread's, so its surface is where the artefact lands.
  const openReport = (reportPath: string) => {
    if (panelRef === null || !isAbsolutePreviewablePath(reportPath)) return;
    useRightPanelStore.getState().openFileAbsolute(panelRef, reportPath);
  };

  // Plan axis only (the `workstream_set_lane` enum). `in_progress` is set by the
  // control plane at kickoff and `blocked` is derived from dependencies, so
  // neither is offered here.
  const setLane = (threadId: ThreadId, planLane: ThreadPlanLane) => {
    void setPlanLane({ environmentId, input: { threadId, planLane } });
  };

  // Human stop: interrupting the active turn. The decider raises
  // `needs_guidance` on a human-issued interrupt so the halted thread surfaces
  // immediately (no-silent-halt).
  const stopThread = (threadId: ThreadId) => {
    void interruptTurn({ environmentId, input: { threadId } });
  };

  // Dismiss all stored attention flags on a thread (human/parent acknowledge).
  // An omitted `reason` clears every stored flag.
  const clearAttention = (threadId: ThreadId) => {
    void clearThreadAttention({ environmentId, input: { threadId } });
  };

  const setDependencies = (threadId: ThreadId, blockedBy: ReadonlyArray<ThreadId>) => {
    void setThreadDependencies({ environmentId, input: { threadId, blockedBy: [...blockedBy] } });
  };

  // Graph node right-click / keyboard-menu handler. Reuses the app's canonical
  // context-menu mechanism (`localApi.contextMenu.show` → native desktop menu /
  // DOM fallback with Escape, outside-click, viewport clamp), exactly like
  // ThreadTabsStrip — so there is no bespoke menu component and no menu-open
  // state. Every action maps to a handler this panel already owns.
  const handleNodeContextMenu = async (
    thread: SidebarThreadSummary,
    position: { x: number; y: number },
  ) => {
    const api = readLocalApi();
    if (!api) return;
    const action = await api.contextMenu.show(buildNodeContextMenuItems(thread), position);
    switch (action) {
      case "open":
        openThread(thread);
        break;
      case "history":
        setInspectedThreadId(thread.id);
        break;
      case "report":
        if (thread.reportPath) openReport(thread.reportPath);
        break;
      case "release":
        setLane(thread.id, "ready");
        break;
      case "clear-flags":
        clearAttention(thread.id);
        break;
      case "stop":
        stopThread(thread.id);
        break;
      case null:
        break;
    }
  };

  const spawnChild = async () => {
    const trimmedPurpose = purpose.trim();
    const trimmedRole = role.trim();
    const trimmedTitle = title.trim();
    if (!trimmedPurpose || !trimmedTitle || isSpawning) {
      return;
    }
    setIsSpawning(true);
    setError(null);
    const childThreadId = newThreadId();

    // A sub-thread is created directly via `thread.create` (rather than the
    // usual draft -> bootstrap path in useHandleNewThread): a draft thread is
    // not a persisted server thread, so it would never surface on this board
    // until promoted by a first turn. Spawning eagerly is what acceptance
    // criterion 3 (children visible in the Workstream board) requires.
    const result = await spawnThread({
      environmentId,
      input: {
        threadId: childThreadId,
        projectId: activeProjectId,
        parentThreadId: activeThread.id,
        role: trimmedRole || null,
        purpose: trimmedPurpose,
        goalId: activeThread.goalId ?? null,
        title: trimmedTitle,
        modelSelection: activeThread.modelSelection,
        runtimeMode: activeThread.runtimeMode,
        interactionMode: activeThread.interactionMode,
        branch: activeThread.branch,
        worktreePath: activeThread.worktreePath,
      },
    });
    if (result._tag === "Failure") {
      setError("Failed to spawn sub-thread.");
      setIsSpawning(false);
      return;
    }
    if (panelRef) clearSpawnDraft(panelRef);
    setIsSpawning(false);
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, childThreadId)),
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-gradient-to-b from-[#0d1117] to-[#090d13]">
      <div className="border-b border-white/10 px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <GitBranchIcon className="size-4 text-sky-300" />
              Workstream
              <span className="text-xs font-normal text-white/35">· {activeThread.title}</span>
            </div>
            <p className="mt-1 text-xs text-white/45">
              Sub-threads stay out of the sidebar and live here.
            </p>
          </div>
          <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] tabular-nums text-white/55">
            {children.length} {children.length === 1 ? "sub-thread" : "sub-threads"}
          </span>
        </div>

        <div className="mt-3 inline-flex rounded-lg border border-white/10 bg-black/25 p-1">
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition ${
              view === "board" ? "bg-white/10 text-white" : "text-white/45 hover:text-white/70"
            }`}
            onClick={() => setView("board")}
          >
            <LayoutDashboardIcon className="size-3.5" />
            Board
          </button>
          <button
            type="button"
            className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition ${
              view === "graph" ? "bg-white/10 text-white" : "text-white/45 hover:text-white/70"
            }`}
            onClick={() => setView("graph")}
          >
            <NetworkIcon className="size-3.5" />
            Graph
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="h-full overflow-y-auto px-3 py-3">
          {view === "board" ? (
            <WorkstreamBoard
              threads={children}
              childById={childById}
              onOpenThread={openThread}
              onSetLane={setLane}
              onStop={stopThread}
              onClearAttention={clearAttention}
              onSetDependencies={setDependencies}
            />
          ) : (
            <>
              <WorkstreamActiveStrip
                threads={subtree}
                threadById={subtreeById}
                onOpenThread={openThread}
              />
              <Suspense
                fallback={
                  <div className="flex h-40 items-center justify-center text-xs text-white/40">
                    <Loader2Icon className="size-4 animate-spin" />
                  </div>
                }
              >
                <WorkstreamGraph
                  key={graphViewKey}
                  viewKey={graphViewKey}
                  threads={subtree}
                  threadById={subtreeById}
                  onOpenThread={openThread}
                  onOpenHistory={(thread) => setInspectedThreadId(thread.id)}
                  onNodeContextMenu={(thread, pos) => void handleNodeContextMenu(thread, pos)}
                  onOpenDispatch={openDispatch}
                />
              </Suspense>
            </>
          )}
        </div>
        {view === "graph" ? (
          <WorkstreamLifecycleDrawer
            open={inspectedInSubtree !== null}
            thread={inspectedInSubtree ? subtreeById.get(inspectedInSubtree) : undefined}
            state={lifecycleState}
            onClose={() => setInspectedThreadId(null)}
            onOpenThread={openThread}
            onOpenDispatch={openDispatch}
            onOpenReport={openReport}
          />
        ) : null}
      </div>

      <div className="border-t border-white/10 bg-black/20 px-3 py-3">
        <details className="group rounded-lg border border-white/10 bg-white/[0.03]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium text-white/80 marker:hidden">
            <span className="inline-flex items-center gap-2">
              <PlusIcon className="size-3.5 text-violet-300" />
              Manual spawn
            </span>
            <span className="text-xs font-normal text-white/35 group-open:hidden">
              role + title + purpose
            </span>
          </summary>
          <div className="border-t border-white/10 p-3">
            <label
              className="text-xs font-medium uppercase tracking-wide text-white/40"
              htmlFor="workstream-role"
            >
              Role
            </label>
            <input
              id="workstream-role"
              className="mt-1 w-full rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-violet-400/60"
              placeholder="Reviewer, implementer, researcher…"
              value={role}
              onChange={(event) => setRole(event.target.value)}
            />
            <label
              className="mt-3 block text-xs font-medium uppercase tracking-wide text-white/40"
              htmlFor="workstream-title"
            >
              Title
            </label>
            <input
              id="workstream-title"
              className="mt-1 w-full rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-violet-400/60"
              placeholder="Short label, e.g. Fix spawn title fallback"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <label
              className="mt-3 block text-xs font-medium uppercase tracking-wide text-white/40"
              htmlFor="workstream-purpose"
            >
              Purpose
            </label>
            <textarea
              id="workstream-purpose"
              className="mt-1 min-h-20 w-full resize-none rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-2 text-sm text-white outline-none placeholder:text-white/25 focus:border-violet-400/60"
              placeholder="What should this sub-thread do?"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value)}
            />
            {error ? <div className="mt-2 text-xs text-red-300">{error}</div> : null}
            <button
              type="button"
              className="mt-3 inline-flex items-center gap-2 rounded-md bg-violet-500 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-violet-400 disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!purpose.trim() || !title.trim() || isSpawning}
              onClick={() => void spawnChild()}
            >
              {isSpawning ? (
                <Loader2Icon className="size-3.5 animate-spin" />
              ) : (
                <GitBranchIcon className="size-3.5" />
              )}
              Spawn sub-thread
            </button>
          </div>
        </details>
      </div>
    </div>
  );
}

interface CardControls {
  readonly childById: ChildIndex;
  readonly onOpenThread: (thread: SidebarThreadSummary) => void;
  readonly onSetLane: (threadId: ThreadId, planLane: ThreadPlanLane) => void;
  readonly onStop: (threadId: ThreadId) => void;
  readonly onClearAttention: (threadId: ThreadId) => void;
  readonly onSetDependencies: (threadId: ThreadId, blockedBy: ReadonlyArray<ThreadId>) => void;
}

function WorkstreamBoard({
  threads,
  childById,
  onOpenThread,
  onSetLane,
  onStop,
  onClearAttention,
  onSetDependencies,
}: {
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
} & CardControls) {
  const groups = groupChildrenByColumn(threads, childById);
  return (
    <div className="flex flex-col gap-4">
      {COLUMN_ORDER.map((column) => {
        const items = groups[column];
        const style = STATUS_STYLES[column];
        return (
          <section className="flex flex-col gap-2" key={column}>
            <div className="flex items-center gap-2 px-1">
              <span className={`size-2.5 rounded-full ${style.dotClass}`} />
              <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-white/55">
                {COLUMN_LABELS[column]}
              </h3>
              <span className="ml-auto rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[11px] tabular-nums text-white/35">
                {items.length}
              </span>
            </div>
            {items.length > 0 &&
              items.map((thread) => (
                <WorkstreamCard
                  key={thread.id}
                  thread={thread}
                  siblings={threads}
                  childById={childById}
                  onOpenThread={onOpenThread}
                  onSetLane={onSetLane}
                  onStop={onStop}
                  onClearAttention={onClearAttention}
                  onSetDependencies={onSetDependencies}
                />
              ))}
          </section>
        );
      })}
    </div>
  );
}

function WorkstreamCard({
  thread,
  siblings,
  childById,
  onOpenThread,
  onSetLane,
  onStop,
  onClearAttention,
  onSetDependencies,
}: {
  readonly thread: SidebarThreadSummary;
  readonly siblings: ReadonlyArray<SidebarThreadSummary>;
} & CardControls) {
  const status = getThreadStatus(thread, childById);
  const activity = getActivity(thread, status.column);
  const isRunning = hasRunningSignal(thread);
  const isBlocked = status.column === "blocked";
  const badges = getAttentionBadges(thread);
  // Review-gate overlays (design §10): the gate source's verdict chip from its
  // last submitted outcome, and the "waiting in gate" badge on whichever party
  // is idle-by-design while its counterpart holds the active leg.
  const verdictChip = getVerdictChip(thread);
  const gateWait = getGateWaitLabel(thread, childById);
  const fanInChip = getFanInChip(thread);
  const diffMetric = formatDiffMetric(thread.diffAdditions, thread.diffDeletions);
  // Quiet metadata (model · spend · context) rides in the header next to the age
  // as muted text. Context% is a health signal, not a vanity stat: hidden below
  // 20% (a near-empty window says nothing actionable), shown muted 20-50%, red
  // above 50%. Own spend only; the subtree roll-up belongs in the detail popover.
  const ownCost = formatCostUsd(thread.cumulativeCostUsd);
  const contextPercentRaw =
    thread.usedTokens !== null && thread.maxTokens !== null && thread.maxTokens > 0
      ? (thread.usedTokens / thread.maxTokens) * 100
      : null;
  const contextPercent =
    contextPercentRaw !== null && contextPercentRaw >= 20
      ? formatContextPercent(thread.usedTokens, thread.maxTokens)
      : null;
  const isContextHot = contextPercentRaw !== null && contextPercentRaw > 50;
  const open = () => onOpenThread(thread);
  return (
    <div
      className={`group rounded-lg border border-l-4 ${status.borderClass} ${status.leftBorderClass} bg-[#12171f] p-3 text-left shadow-[0_1px_0_rgba(0,0,0,0.25)] transition hover:border-white/20 hover:bg-[#161c26]`}
      title={`Goal: ${getPurpose(thread)}`}
    >
      <button
        type="button"
        className="flex w-full items-start gap-2 text-left outline-none"
        onClick={open}
      >
        <span
          className={`inline-flex max-w-[9rem] items-center gap-1 rounded-md border px-2 py-1 font-mono text-[10.5px] ${status.borderClass} ${status.bgClass} ${status.textClass}`}
        >
          <span className="truncate">{getRoleLabel(thread)}</span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] text-white/35">
          <span
            className="max-w-[7.5rem] truncate"
            title={`${thread.modelSelection.instanceId} · ${thread.modelSelection.model}`}
          >
            {formatModelLabel(thread.modelSelection)}
          </span>
          {ownCost ? (
            <>
              <span className="text-white/20">·</span>
              <span className="tabular-nums" title="This sub-thread's own spend">
                {ownCost}
              </span>
            </>
          ) : null}
          {contextPercent ? (
            <>
              <span className="text-white/20">·</span>
              <span
                className={`tabular-nums ${isContextHot ? "text-rose-400" : ""}`}
                title="Context window used"
              >
                {contextPercent}
              </span>
            </>
          ) : null}
          <span className="text-white/20">·</span>
          <span>{formatRelativeAge(getLastActivityAt(thread))}</span>
        </div>
      </button>

      <button type="button" className="mt-2 block w-full text-left outline-none" onClick={open}>
        <div className="line-clamp-2 text-sm font-semibold leading-snug text-white">
          {thread.title}
        </div>
        <div className={`mt-2 border-l-2 pl-2 text-xs leading-relaxed ${status.borderClass}`}>
          <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-white/35">
            Goal
          </span>
          <span className="line-clamp-3 text-white/65">{getPurpose(thread)}</span>
        </div>
        {thread.lastActivityPreview ? (
          <div className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-white/45">
            <span aria-hidden className="mt-px shrink-0 text-white/30">
              ›
            </span>
            <span className="line-clamp-1 italic">{thread.lastActivityPreview}</span>
          </div>
        ) : null}
        <div className="mt-2 flex items-center gap-2 text-xs text-white/50">
          {isRunning ? <LiveDots /> : null}
          {isBlocked ? <span className={`size-2 rounded-full ${status.dotClass}`} /> : null}
          <span>{activity}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] tabular-nums text-white/35">
            {diffMetric ? (
              <span title="Lines changed across this sub-thread's checkpoints">{diffMetric}</span>
            ) : null}
            {diffMetric && thread.toolUses && thread.toolUses > 0 ? (
              <span className="text-white/20">·</span>
            ) : null}
            {thread.toolUses && thread.toolUses > 0 ? (
              <span>
                {thread.toolUses} {thread.toolUses === 1 ? "tool" : "tools"}
              </span>
            ) : null}
          </span>
        </div>
      </button>

      {badges.length > 0 || verdictChip || gateWait || fanInChip ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {fanInChip ? (
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] ${FAN_IN_CHIP_STYLES[fanInChip.tone]}`}
              title="Fan-in merge of this isolated child's branch into its parent"
            >
              {fanInChip.label}
            </span>
          ) : null}
          {badges.map(({ reason, label }) => {
            const style = ATTENTION_STYLES[reason];
            return (
              <span
                key={reason}
                className={`rounded-full border px-2 py-0.5 text-[11px] ${style.borderClass} ${style.bgClass} ${style.textClass}`}
              >
                {label}
              </span>
            );
          })}
          {verdictChip ? (
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] ${verdictChip.borderClass} ${verdictChip.bgClass} ${verdictChip.textClass}`}
              title="Latest review verdict submitted by this gate source"
            >
              {verdictChip.label}
            </span>
          ) : null}
          {gateWait ? (
            <span
              className={`rounded-full border px-2 py-0.5 text-[11px] ${
                gateWait.active
                  ? "border-sky-400/40 bg-sky-400/10 text-sky-300"
                  : "border-white/15 bg-white/[0.04] text-white/55"
              }`}
              title={
                gateWait.active
                  ? "This party holds the active gate leg right now"
                  : "Idle by design — the gate counterpart holds the active leg"
              }
            >
              {gateWait.label}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
        <label className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-white/35">
          Lane
          <select
            className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-1 text-[11px] text-white outline-none [color-scheme:dark] focus:border-violet-400/60"
            value={thread.planLane}
            onChange={(event) => onSetLane(thread.id, event.target.value as ThreadPlanLane)}
          >
            {SETTABLE_LANES.map((lane) => (
              <option key={lane} value={lane} className="bg-[#12171f] text-white">
                {COLUMN_SHORT_LABELS[lane]}
              </option>
            ))}
            {thread.planLane === "in_progress" ? (
              // Control-plane-set (kickoff): shown so the select has a matching
              // value, but never user-assignable.
              <option disabled value="in_progress" className="bg-[#12171f] text-white/50">
                {COLUMN_SHORT_LABELS.in_progress}
              </option>
            ) : null}
            {thread.planLane === "yielded" ? (
              // Control-plane-set (submit routing): shown so the select has a
              // matching value, but never user-assignable — a message resumes it.
              <option disabled value="yielded" className="bg-[#12171f] text-white/50">
                {COLUMN_SHORT_LABELS.yielded}
              </option>
            ) : null}
          </select>
        </label>
        {thread.planLane === "planned" ? (
          <button
            type="button"
            className="rounded-md border border-cyan-400/40 bg-cyan-400/10 px-2 py-1 text-[11px] text-cyan-200 transition hover:bg-cyan-400/20"
            onClick={() => onSetLane(thread.id, "ready")}
            title="Release this held sub-thread so it runs once dependencies clear and a kickoff brief is attached"
          >
            Release
          </button>
        ) : null}
        {isRunning ? (
          <button
            type="button"
            className="rounded-md border border-rose-400/40 bg-rose-400/10 px-2 py-1 text-[11px] text-rose-200 transition hover:bg-rose-400/20"
            onClick={() => onStop(thread.id)}
            title="Stop the active turn (flags it needs_guidance so it doesn't sit silently halted)"
          >
            Stop
          </button>
        ) : null}
        {badges.length > 0 ? (
          <button
            type="button"
            className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[11px] text-white/55 transition hover:bg-white/10"
            onClick={() => onClearAttention(thread.id)}
            title="Dismiss the attention flags on this sub-thread"
          >
            Clear flags
          </button>
        ) : null}
      </div>

      <DependencyEditor
        thread={thread}
        siblings={siblings}
        childById={childById}
        onSetDependencies={onSetDependencies}
      />
    </div>
  );
}

function DependencyEditor({
  thread,
  siblings,
  childById,
  onSetDependencies,
}: {
  readonly thread: SidebarThreadSummary;
  readonly siblings: ReadonlyArray<SidebarThreadSummary>;
  readonly childById: ChildIndex;
  readonly onSetDependencies: (threadId: ThreadId, blockedBy: ReadonlyArray<ThreadId>) => void;
}) {
  const options = siblings.filter((sibling) => sibling.id !== thread.id);
  const selected = new Set(thread.blockedBy);
  const deps = thread.blockedBy
    .map((id) => childById.get(id))
    .filter((dep): dep is SidebarThreadSummary => dep !== undefined);
  const toggle = (depId: ThreadId) => {
    const next = new Set(selected);
    if (next.has(depId)) next.delete(depId);
    else next.add(depId);
    onSetDependencies(thread.id, [...next]);
  };
  return (
    <details className="mt-2 rounded-md border border-white/10 bg-black/20">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2.5 py-1.5 text-[11px] text-white/55 marker:hidden">
        <span className="shrink-0">Waits on</span>
        {deps.length === 0 ? (
          <span className="ml-auto rounded-full border border-white/10 bg-white/[0.04] px-1.5 text-[10px] tabular-nums text-white/40">
            0
          </span>
        ) : (
          <span className="flex flex-1 flex-wrap items-center justify-end gap-1">
            {deps.map((dep) => {
              const depStatus = getThreadStatus(dep, childById);
              return (
                <span
                  key={dep.id}
                  className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[10px] text-white/60"
                >
                  <span className={`size-1.5 rounded-full ${depStatus.dotClass}`} />
                  <span className="max-w-[8rem] truncate">{dep.title}</span>
                </span>
              );
            })}
          </span>
        )}
      </summary>
      <div className="flex flex-col gap-1 border-t border-white/10 px-2.5 py-2">
        {options.length === 0 ? (
          <span className="text-[11px] text-white/30">No sibling sub-threads.</span>
        ) : (
          options.map((sibling) => {
            const depStatus = getThreadStatus(sibling, childById);
            return (
              <label
                key={sibling.id}
                className="flex cursor-pointer items-center gap-2 text-[11px] text-white/70"
              >
                <input
                  type="checkbox"
                  checked={selected.has(sibling.id)}
                  onChange={() => toggle(sibling.id)}
                />
                <span className={`size-2 rounded-full ${depStatus.dotClass}`} />
                <span className="truncate">{truncateLabel(sibling.title, 28)}</span>
              </label>
            );
          })
        )}
      </div>
    </details>
  );
}

function LiveDots() {
  return (
    <span className="inline-flex gap-1" aria-label="running">
      <span className="size-1.5 animate-pulse rounded-full bg-sky-300" />
      <span className="size-1.5 animate-pulse rounded-full bg-sky-300 [animation-delay:150ms]" />
      <span className="size-1.5 animate-pulse rounded-full bg-sky-300 [animation-delay:300ms]" />
    </span>
  );
}
