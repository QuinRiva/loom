import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ProjectId, ThreadId, ThreadStatus } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  GitBranchIcon,
  LayoutDashboardIcon,
  Loader2Icon,
  NetworkIcon,
  PlusIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "../environmentApi";
import { newCommandId, newThreadId } from "../lib/utils";
import {
  hasRunningSignal,
  resolveBaseColumn,
  type WorkstreamColumnId,
} from "../lib/workstreamGraph";
import { type AppState, useStore } from "../store";
import { buildThreadRouteParams } from "../threadRoutes";
import type { SidebarThreadSummary, Thread } from "../types";

type WorkstreamView = "board" | "graph";

type ChildIndex = ReadonlyMap<ThreadId, SidebarThreadSummary>;

interface WorkstreamStatus {
  readonly column: WorkstreamColumnId;
  readonly label: string;
  readonly textClass: string;
  readonly borderClass: string;
  readonly bgClass: string;
  readonly dotClass: string;
  readonly leftBorderClass: string;
  readonly graphStroke: string;
  readonly graphFill: string;
}

const COLUMN_ORDER: ReadonlyArray<WorkstreamColumnId> = [
  "planned",
  "running",
  "blocked",
  "review",
  "error",
  "done",
];

// Statuses a human may set from the card dropdown. `error` is server-only
// (D-liveness): it is a board lane but never an option the user assigns.
const SETTABLE_STATUSES: ReadonlyArray<WorkstreamColumnId> = COLUMN_ORDER.filter(
  (column) => column !== "error",
);

const COLUMN_LABELS = {
  planned: "Planned / Ready",
  running: "Running",
  blocked: "Blocked / Needs you",
  review: "In review",
  error: "Error / Stalled",
  done: "Done",
} satisfies Record<WorkstreamColumnId, string>;

// Short labels for per-card badges and the status setter.
const STATUS_LABELS = {
  planned: "Planned",
  running: "Running",
  blocked: "Blocked",
  review: "Review",
  error: "Error",
  done: "Done",
} satisfies Record<WorkstreamColumnId, string>;

const STATUS_STYLES = {
  planned: {
    textClass: "text-slate-300",
    borderClass: "border-slate-400/25",
    bgClass: "bg-slate-400/10",
    dotClass: "bg-slate-400",
    leftBorderClass: "border-l-slate-400",
    graphStroke: "#94a3b8",
    graphFill: "rgba(148, 163, 184, 0.15)",
  },
  running: {
    textClass: "text-sky-300",
    borderClass: "border-sky-400/40",
    bgClass: "bg-sky-400/10",
    dotClass: "bg-sky-400",
    leftBorderClass: "border-l-sky-400",
    graphStroke: "#38bdf8",
    graphFill: "rgba(56, 189, 248, 0.16)",
  },
  blocked: {
    textClass: "text-amber-300",
    borderClass: "border-amber-400/40",
    bgClass: "bg-amber-400/10",
    dotClass: "bg-amber-400",
    leftBorderClass: "border-l-amber-400",
    graphStroke: "#f59e0b",
    graphFill: "rgba(245, 158, 11, 0.16)",
  },
  review: {
    textClass: "text-violet-300",
    borderClass: "border-violet-400/40",
    bgClass: "bg-violet-400/10",
    dotClass: "bg-violet-400",
    leftBorderClass: "border-l-violet-400",
    graphStroke: "#a78bfa",
    graphFill: "rgba(167, 139, 250, 0.16)",
  },
  error: {
    textClass: "text-rose-300",
    borderClass: "border-rose-500/45",
    bgClass: "bg-rose-500/10",
    dotClass: "bg-rose-500",
    leftBorderClass: "border-l-rose-500",
    graphStroke: "#f43f5e",
    graphFill: "rgba(244, 63, 94, 0.16)",
  },
  done: {
    textClass: "text-emerald-300",
    borderClass: "border-emerald-400/40",
    bgClass: "bg-emerald-400/10",
    dotClass: "bg-emerald-400",
    leftBorderClass: "border-l-emerald-400",
    graphStroke: "#34d399",
    graphFill: "rgba(52, 211, 153, 0.16)",
  },
} satisfies Record<WorkstreamColumnId, Omit<WorkstreamStatus, "column" | "label">>;

const WAITS_ON_STROKE = "#f59e0b";

const ROLE_ICONS: Record<string, string> = {
  reviewer: "◎",
  review: "◎",
  researcher: "◇",
  implementer: "⚙",
  implementation: "⚙",
  coder: "⚙",
  migration: "↯",
  planner: "▣",
  plan: "▣",
};

function selectWorkstreamChildren(
  state: AppState,
  environmentId: EnvironmentId,
  parentThreadId: ThreadId,
) {
  const environmentState = state.environmentStateById[environmentId];
  if (!environmentState) return [];
  return Object.values(environmentState.sidebarThreadSummaryById)
    .filter((thread) => thread.parentThreadId === parentThreadId)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

/**
 * D1 effective-status precedence:
 *  1. explicit review/done win (human/agent intent)
 *  2. else any unmet `blockedBy` dependency ⇒ blocked
 *  3. else explicit blocked ⇒ blocked
 *  4. else explicit running or a live running session/turn ⇒ running
 *  5. else planned
 * Self-deps are ignored and dangling dep ids (unknown threads) don't gate.
 */
function getEffectiveColumn(
  thread: SidebarThreadSummary,
  childById: ChildIndex,
): WorkstreamColumnId {
  // `error` (server-set liveness failure) wins over everything so a dead/stalled
  // child surfaces in its own lane instead of falling through to running/blocked.
  if (thread.status === "error") return "error";
  if (thread.status === "review" || thread.status === "done") return thread.status;
  const blockedByUnmetDep = thread.blockedBy.some((depId) => {
    if (depId === thread.id) return false;
    const dep = childById.get(depId);
    return dep ? resolveBaseColumn(dep) !== "done" : false;
  });
  if (blockedByUnmetDep) return "blocked";
  return resolveBaseColumn(thread);
}

function getThreadStatus(thread: SidebarThreadSummary, childById: ChildIndex): WorkstreamStatus {
  const column = getEffectiveColumn(thread, childById);
  return { column, label: STATUS_LABELS[column], ...STATUS_STYLES[column] };
}

function getRoleLabel(thread: SidebarThreadSummary): string {
  return thread.role?.trim() || "sub-thread";
}

function getRoleIcon(thread: SidebarThreadSummary): string {
  const normalized = getRoleLabel(thread).toLowerCase();
  return ROLE_ICONS[normalized] ?? "✦";
}

function getPurpose(thread: SidebarThreadSummary): string {
  return thread.purpose?.trim() || "No purpose captured yet.";
}

function getActivity(thread: SidebarThreadSummary, column: WorkstreamColumnId): string {
  if (column === "blocked" && thread.blockedBy.length > 0) return "waiting on dependencies";
  if (thread.hasPendingUserInput) return "paused — waiting for your input";
  if (thread.hasPendingApprovals) return "approval required";
  if (thread.hasActionableProposedPlan) return "proposed plan ready";
  if (thread.latestTurn?.state === "error" || thread.session?.status === "error")
    return "last turn failed";
  if (hasRunningSignal(thread)) return "live turn in progress";
  if (thread.latestTurn?.state === "completed") return "latest turn completed";
  if (thread.archivedAt) return "archived";
  return `${STATUS_LABELS[column].toLowerCase()}`;
}

function getLastActivityAt(thread: SidebarThreadSummary): string {
  return (
    thread.latestTurn?.completedAt ??
    thread.latestTurn?.startedAt ??
    thread.latestUserMessageAt ??
    thread.updatedAt ??
    thread.createdAt
  );
}

function formatRelativeAge(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function truncateLabel(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function groupChildrenByColumn(
  children: ReadonlyArray<SidebarThreadSummary>,
  childById: ChildIndex,
) {
  const groups: Record<WorkstreamColumnId, SidebarThreadSummary[]> = {
    planned: [],
    running: [],
    blocked: [],
    review: [],
    error: [],
    done: [],
  };
  for (const thread of children) groups[getEffectiveColumn(thread, childById)].push(thread);
  return groups;
}

interface WorkstreamPanelProps {
  activeThread: Thread | undefined;
  activeProjectId: ProjectId | undefined;
}

export function WorkstreamPanel({ activeThread, activeProjectId }: WorkstreamPanelProps) {
  const navigate = useNavigate();
  const children = useStore(
    useShallow(
      useMemo(
        () => (state: AppState) =>
          activeThread
            ? selectWorkstreamChildren(state, activeThread.environmentId, activeThread.id)
            : [],
        [activeThread],
      ),
    ),
  );
  const childById = useMemo<ChildIndex>(
    () => new Map(children.map((thread) => [thread.id, thread])),
    [children],
  );
  const [view, setView] = useState<WorkstreamView>("board");
  const [role, setRole] = useState("");
  const [purpose, setPurpose] = useState("");
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

  const openThread = (thread: SidebarThreadSummary) =>
    navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });

  const setStatus = (threadId: ThreadId, status: ThreadStatus) => {
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    void api.orchestration.dispatchCommand({
      type: "thread.status.set",
      commandId: newCommandId(),
      threadId,
      status,
      createdAt: new Date().toISOString(),
    });
  };

  const setDependencies = (threadId: ThreadId, blockedBy: ReadonlyArray<ThreadId>) => {
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    void api.orchestration.dispatchCommand({
      type: "thread.dependencies.set",
      commandId: newCommandId(),
      threadId,
      blockedBy: [...blockedBy],
      createdAt: new Date().toISOString(),
    });
  };

  const spawnChild = async () => {
    const trimmedPurpose = purpose.trim();
    const trimmedRole = role.trim();
    if (!trimmedPurpose || isSpawning) {
      return;
    }
    setIsSpawning(true);
    setError(null);
    const childThreadId = newThreadId();
    const api = readEnvironmentApi(environmentId);
    if (!api) {
      setError("Environment connection is unavailable.");
      setIsSpawning(false);
      return;
    }

    try {
      // A sub-thread is created directly via `thread.create` (rather than the
      // usual draft -> bootstrap path in useHandleNewThread): a draft thread is
      // not a persisted server thread, so it would never surface on this board
      // until promoted by a first turn. Spawning eagerly is what acceptance
      // criterion 3 (children visible in the Workstream board) requires.
      await api.orchestration.dispatchCommand({
        type: "thread.create",
        commandId: newCommandId(),
        threadId: childThreadId,
        projectId: activeProjectId,
        parentThreadId: activeThread.id,
        role: trimmedRole || null,
        purpose: trimmedPurpose,
        goalId: activeThread.goalId ?? null,
        title: trimmedPurpose,
        modelSelection: activeThread.modelSelection,
        runtimeMode: activeThread.runtimeMode,
        interactionMode: activeThread.interactionMode,
        branch: activeThread.branch,
        worktreePath: activeThread.worktreePath,
        createdAt: new Date().toISOString(),
      });
      setRole("");
      setPurpose("");
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, childThreadId)),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to spawn sub-thread.");
    } finally {
      setIsSpawning(false);
    }
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

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {view === "board" ? (
          <WorkstreamBoard
            threads={children}
            childById={childById}
            onOpenThread={openThread}
            onSetStatus={setStatus}
            onSetDependencies={setDependencies}
          />
        ) : (
          <WorkstreamGraph
            activeThread={activeThread}
            threads={children}
            childById={childById}
            onOpenThread={openThread}
          />
        )}
      </div>

      <div className="border-t border-white/10 bg-black/20 px-3 py-3">
        <details className="group rounded-lg border border-white/10 bg-white/[0.03]">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium text-white/80 marker:hidden">
            <span className="inline-flex items-center gap-2">
              <PlusIcon className="size-3.5 text-violet-300" />
              Manual spawn
            </span>
            <span className="text-xs font-normal text-white/35 group-open:hidden">
              role + purpose
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
              disabled={!purpose.trim() || isSpawning}
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
  readonly onSetStatus: (threadId: ThreadId, status: ThreadStatus) => void;
  readonly onSetDependencies: (threadId: ThreadId, blockedBy: ReadonlyArray<ThreadId>) => void;
}

function WorkstreamBoard({
  threads,
  childById,
  onOpenThread,
  onSetStatus,
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
            {items.length === 0 ? (
              <div className="rounded-lg border border-dashed border-white/10 px-3 py-3 text-xs text-white/30">
                — empty —
              </div>
            ) : (
              items.map((thread) => (
                <WorkstreamCard
                  key={thread.id}
                  thread={thread}
                  siblings={threads}
                  childById={childById}
                  onOpenThread={onOpenThread}
                  onSetStatus={onSetStatus}
                  onSetDependencies={onSetDependencies}
                />
              ))
            )}
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
  onSetStatus,
  onSetDependencies,
}: {
  readonly thread: SidebarThreadSummary;
  readonly siblings: ReadonlyArray<SidebarThreadSummary>;
} & CardControls) {
  const status = getThreadStatus(thread, childById);
  const activity = getActivity(thread, status.column);
  const isRunning = status.column === "running";
  const isBlocked = status.column === "blocked";
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
          <span>{getRoleIcon(thread)}</span>
          <span className="truncate">{getRoleLabel(thread)}</span>
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5 font-mono text-[10.5px] text-white/35">
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
        </div>
      </button>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <span
          className={`rounded-full border px-2 py-0.5 text-[11px] ${status.borderClass} ${status.bgClass} ${status.textClass}`}
        >
          {status.label}
        </span>
        {thread.branch ? (
          <span className="rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 font-mono text-[10.5px] text-white/40">
            {thread.branch}
          </span>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/10 pt-3">
        <label className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-white/35">
          Status
          <select
            className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-1 text-[11px] text-white outline-none focus:border-violet-400/60"
            value={thread.status}
            onChange={(event) => onSetStatus(thread.id, event.target.value as ThreadStatus)}
          >
            {SETTABLE_STATUSES.map((column) => (
              <option key={column} value={column}>
                {STATUS_LABELS[column]}
              </option>
            ))}
            {thread.status === "error" ? (
              // Server-set liveness failure: shown (so the select has a matching
              // value) but not user-assignable. Pick another status to recover.
              <option disabled value="error">
                {STATUS_LABELS.error}
              </option>
            ) : null}
          </select>
        </label>
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
  const toggle = (depId: ThreadId) => {
    const next = new Set(selected);
    if (next.has(depId)) next.delete(depId);
    else next.add(depId);
    onSetDependencies(thread.id, [...next]);
  };
  return (
    <details className="mt-2 rounded-md border border-white/10 bg-black/20">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-2.5 py-1.5 text-[11px] text-white/55 marker:hidden">
        <span>Waits on</span>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 text-[10px] tabular-nums text-white/40">
          {thread.blockedBy.length}
        </span>
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

function WorkstreamGraph({
  activeThread,
  threads,
  childById,
  onOpenThread,
}: {
  readonly activeThread: Thread;
  readonly threads: ReadonlyArray<SidebarThreadSummary>;
  readonly childById: ChildIndex;
  readonly onOpenThread: (thread: SidebarThreadSummary) => void;
}) {
  const positions = getGraphPositions(threads, childById);
  const positionById = new Map(positions.map((position) => [position.threadId, position]));
  const root = { x: 342, y: 38 };
  const height = Math.max(260, 128 + Math.max(0, ...positions.map((position) => position.y)));

  return (
    <div className="flex flex-col items-center gap-3">
      <p className="px-2 text-center text-[11px] leading-relaxed text-white/35">
        Lineage edges run orchestrator → sub-thread; dashed amber edges are &ldquo;waits-on&rdquo;
        dependencies. Colour matches board state; click any node to open the thread.
      </p>
      <svg
        className="min-h-[240px] w-full rounded-xl border border-white/10 bg-black/20"
        viewBox={`0 0 684 ${height}`}
        role="img"
        aria-label="Workstream lineage graph"
      >
        <defs>
          <marker
            id="workstream-arrow"
            markerHeight="8"
            markerWidth="8"
            orient="auto"
            refX="6"
            refY="3"
          >
            <path d="M0 0 L6 3 L0 6 z" fill="rgba(255,255,255,0.35)" />
          </marker>
          <marker
            id="workstream-waits-arrow"
            markerHeight="8"
            markerWidth="8"
            orient="auto"
            refX="6"
            refY="3"
          >
            <path d="M0 0 L6 3 L0 6 z" fill={WAITS_ON_STROKE} />
          </marker>
        </defs>
        <RootNode x={root.x} y={root.y} title={activeThread.title} />
        {positions.map((position) => {
          const thread = childById.get(position.threadId);
          if (!thread) return null;
          const parent = getParentPosition(thread, positions, root);
          return (
            <path
              d={`M ${parent.x} ${parent.y + 24} C ${parent.x} ${(parent.y + position.y) / 2}, ${
                position.x
              } ${(parent.y + position.y) / 2}, ${position.x} ${position.y - 25}`}
              fill="none"
              key={`edge-${thread.id}`}
              markerEnd="url(#workstream-arrow)"
              stroke="rgba(255,255,255,0.28)"
              strokeWidth="1.4"
            />
          );
        })}
        {positions.flatMap((position) => {
          const thread = childById.get(position.threadId);
          if (!thread) return [];
          return thread.blockedBy.flatMap((depId) => {
            if (depId === thread.id) return [];
            const depPosition = positionById.get(depId);
            if (!depPosition) return [];
            return [
              <line
                key={`waits-${thread.id}-${depId}`}
                markerEnd="url(#workstream-waits-arrow)"
                stroke={WAITS_ON_STROKE}
                strokeDasharray="4 3"
                strokeWidth="1.3"
                x1={depPosition.x}
                x2={position.x}
                y1={depPosition.y}
                y2={position.y}
              />,
            ];
          });
        })}
        {positions.map((position) => {
          const thread = childById.get(position.threadId);
          return thread ? (
            <GraphNode
              key={thread.id}
              thread={thread}
              childById={childById}
              x={position.x}
              y={position.y}
              onOpenThread={onOpenThread}
            />
          ) : null;
        })}
        {threads.length === 0 ? (
          <text fill="rgba(255,255,255,0.38)" fontSize="13" textAnchor="middle" x="342" y="150">
            No sub-threads yet.
          </text>
        ) : null}
      </svg>
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-1 px-2 pb-1">
        {COLUMN_ORDER.map((column) => (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-white/45" key={column}>
            <span className={`size-2 rounded-full ${STATUS_STYLES[column].dotClass}`} />
            {COLUMN_LABELS[column]}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5 text-[11px] text-white/45">
          <span
            className="inline-block h-0 w-4 border-t border-dashed"
            style={{ borderColor: WAITS_ON_STROKE }}
          />
          waits-on
        </span>
      </div>
    </div>
  );
}

function RootNode({
  x,
  y,
  title,
}: {
  readonly x: number;
  readonly y: number;
  readonly title: string;
}) {
  return (
    <g>
      <rect
        fill="rgba(255,255,255,0.07)"
        height="48"
        rx="11"
        stroke="rgba(255,255,255,0.18)"
        width="160"
        x={x - 80}
        y={y - 24}
      />
      <text
        fill="rgba(255,255,255,0.82)"
        fontSize="12"
        fontWeight="600"
        textAnchor="middle"
        x={x}
        y={y - 2}
      >
        Orchestrator
      </text>
      <text fill="rgba(255,255,255,0.38)" fontSize="9.5" textAnchor="middle" x={x} y={y + 14}>
        {truncateLabel(title, 24)}
      </text>
    </g>
  );
}

function GraphNode({
  thread,
  childById,
  x,
  y,
  onOpenThread,
}: {
  readonly thread: SidebarThreadSummary;
  readonly childById: ChildIndex;
  readonly x: number;
  readonly y: number;
  readonly onOpenThread: (thread: SidebarThreadSummary) => void;
}) {
  const status = getThreadStatus(thread, childById);
  const open = () => onOpenThread(thread);
  return (
    <g
      className="cursor-pointer outline-none"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <title>{`Goal: ${getPurpose(thread)}`}</title>
      <rect
        fill={status.graphFill}
        height="54"
        rx="10"
        stroke={status.graphStroke}
        strokeWidth="1.4"
        width="126"
        x={x - 63}
        y={y - 27}
      />
      <circle cx={x - 48} cy={y - 10} fill={status.graphStroke} r="4" />
      <text fill={status.graphStroke} fontSize="12" x={x - 38} y={y - 6}>
        {getRoleIcon(thread)}
      </text>
      <text fill="rgba(255,255,255,0.9)" fontSize="11" fontWeight="600" x={x - 20} y={y - 6}>
        {truncateLabel(thread.title, 16)}
      </text>
      <text
        fill="rgba(255,255,255,0.45)"
        fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
        fontSize="8.5"
        x={x - 49}
        y={y + 11}
      >
        {truncateLabel(getRoleLabel(thread), 12)} · {status.label}
      </text>
    </g>
  );
}

function getGraphPositions(children: ReadonlyArray<SidebarThreadSummary>, childById: ChildIndex) {
  const groups = groupChildrenByColumn(children, childById);
  return COLUMN_ORDER.flatMap((column, columnIndex) =>
    groups[column].map((thread, rowIndex) => ({
      threadId: thread.id,
      x: 78 + columnIndex * 132,
      y: 125 + rowIndex * 84,
    })),
  );
}

function getParentPosition(
  thread: SidebarThreadSummary,
  positions: ReadonlyArray<{ readonly threadId: ThreadId; readonly x: number; readonly y: number }>,
  root: { readonly x: number; readonly y: number },
) {
  return positions.find((position) => position.threadId === thread.parentThreadId) ?? root;
}
