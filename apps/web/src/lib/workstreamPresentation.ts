import type { ThreadId } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../types";
import { hasRunningSignal, resolveBaseColumn, type WorkstreamColumnId } from "./workstreamGraph";

/**
 * Pure presentation logic shared by the Workstream board, cards, and the
 * lazily-loaded graph. Kept JSX-free so the graph chunk (which pulls in the
 * d3-dag layout engine) can import the status/role/format vocabulary without
 * dragging the board components — or vice versa — into either bundle.
 */

export type ChildIndex = ReadonlyMap<ThreadId, SidebarThreadSummary>;

export interface WorkstreamStatus {
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

export const COLUMN_ORDER: ReadonlyArray<WorkstreamColumnId> = [
  "planned",
  "running",
  "blocked",
  "review",
  "error",
  "done",
];

// Statuses a human may set from the card dropdown. `error` is server-only
// (D-liveness): it is a board lane but never an option the user assigns.
export const SETTABLE_STATUSES: ReadonlyArray<WorkstreamColumnId> = COLUMN_ORDER.filter(
  (column) => column !== "error",
);

export const COLUMN_LABELS = {
  planned: "Planned / Ready",
  running: "Running",
  blocked: "Blocked / Needs you",
  review: "In review",
  error: "Error / Stalled",
  done: "Done",
} satisfies Record<WorkstreamColumnId, string>;

// Short labels for per-card badges and the status setter.
export const STATUS_LABELS = {
  planned: "Planned",
  running: "Running",
  blocked: "Blocked",
  review: "Review",
  error: "Error",
  done: "Done",
} satisfies Record<WorkstreamColumnId, string>;

export const STATUS_STYLES = {
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

export const WAITS_ON_STROKE = "#f59e0b";

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

/**
 * D1 effective-status precedence:
 *  1. explicit review/done win (human/agent intent)
 *  2. else any unmet `blockedBy` dependency ⇒ blocked
 *  3. else explicit blocked ⇒ blocked
 *  4. else explicit running or a live running session/turn ⇒ running
 *  5. else planned
 * Self-deps are ignored and dangling dep ids (unknown threads) don't gate.
 */
export function getEffectiveColumn(
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

export function getThreadStatus(
  thread: SidebarThreadSummary,
  childById: ChildIndex,
): WorkstreamStatus {
  const column = getEffectiveColumn(thread, childById);
  return { column, label: STATUS_LABELS[column], ...STATUS_STYLES[column] };
}

export function getRoleLabel(thread: SidebarThreadSummary): string {
  return thread.role?.trim() || "sub-thread";
}

export function getRoleIcon(thread: SidebarThreadSummary): string {
  return ROLE_ICONS[getRoleLabel(thread).toLowerCase()] ?? "✦";
}

export function getPurpose(thread: SidebarThreadSummary): string {
  return thread.purpose?.trim() || "No purpose captured yet.";
}

export function getActivity(thread: SidebarThreadSummary, column: WorkstreamColumnId): string {
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

export function getLastActivityAt(thread: SidebarThreadSummary): string {
  return (
    thread.latestTurn?.completedAt ??
    thread.latestTurn?.startedAt ??
    thread.latestUserMessageAt ??
    thread.updatedAt ??
    thread.createdAt
  );
}

export function formatRelativeAge(iso: string): string {
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

export function truncateLabel(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

export function groupChildrenByColumn(
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
