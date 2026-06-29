import type { ThreadId, ThreadPlanLane } from "@t3tools/contracts";

import type { SidebarThreadSummary } from "../types";
import {
  type AttentionReason,
  attentionReasonsOf,
  hasRunningSignal,
  type WorkstreamColumnId,
} from "./workstreamGraph";

/**
 * Pure presentation logic shared by the Workstream board, cards, and the
 * lazily-loaded graph. Kept JSX-free so the graph chunk (which pulls in the
 * d3-dag layout engine) can import the lane/role/format vocabulary without
 * dragging the board components — or vice versa — into either bundle.
 *
 * Three axes (design §8): a thread is grouped into ONE plan column; activity
 * (live dots) and attention (badges) are overlays on top of that column.
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

// Board column order: the plan lanes in lifecycle order, with the derived
// `blocked` (ready-but-waiting-on-upstream) sitting between `ready` and the
// active `in_progress` phase, and `cancelled` last (abandoned).
export const COLUMN_ORDER: ReadonlyArray<WorkstreamColumnId> = [
  "planned",
  "ready",
  "blocked",
  "in_progress",
  "done",
  "cancelled",
];

// Plan lanes a human/agent may set from the card (the plan axis only). Mirrors
// the `workstream_set_lane` enum: `in_progress` is control-plane-only (set by
// starting a turn) and `blocked` is derived from dependencies — neither is
// settable here.
export const SETTABLE_LANES: ReadonlyArray<ThreadPlanLane> = [
  "planned",
  "ready",
  "done",
  "cancelled",
];

export const COLUMN_LABELS = {
  planned: "Planned · held",
  ready: "Ready",
  blocked: "Blocked · on upstream",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
} satisfies Record<WorkstreamColumnId, string>;

// Short labels for per-card badges and the lane setter.
export const COLUMN_SHORT_LABELS = {
  planned: "Planned",
  ready: "Ready",
  blocked: "Blocked",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
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
  ready: {
    textClass: "text-cyan-300",
    borderClass: "border-cyan-400/30",
    bgClass: "bg-cyan-400/10",
    dotClass: "bg-cyan-400",
    leftBorderClass: "border-l-cyan-400",
    graphStroke: "#22d3ee",
    graphFill: "rgba(34, 211, 238, 0.14)",
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
  in_progress: {
    textClass: "text-sky-300",
    borderClass: "border-sky-400/40",
    bgClass: "bg-sky-400/10",
    dotClass: "bg-sky-400",
    leftBorderClass: "border-l-sky-400",
    graphStroke: "#38bdf8",
    graphFill: "rgba(56, 189, 248, 0.16)",
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
  cancelled: {
    textClass: "text-slate-400",
    borderClass: "border-slate-500/30",
    bgClass: "bg-slate-500/10",
    dotClass: "bg-slate-500",
    leftBorderClass: "border-l-slate-500",
    graphStroke: "#64748b",
    graphFill: "rgba(100, 116, 139, 0.14)",
  },
} satisfies Record<WorkstreamColumnId, Omit<WorkstreamStatus, "column" | "label">>;

// Attention badge vocabulary (the needs-a-human overlay). Independent of the
// plan column — a badge can co-exist with any lane.
export const ATTENTION_LABELS = {
  error: "Error / stalled",
  awaiting_approval: "Awaiting approval",
  awaiting_input: "Awaiting input",
  awaiting_acceptance: "Awaiting acceptance",
  needs_guidance: "Needs guidance",
  proposed_plan: "Plan ready",
} satisfies Record<AttentionReason, string>;

export const ATTENTION_STYLES = {
  error: {
    textClass: "text-rose-300",
    borderClass: "border-rose-500/45",
    bgClass: "bg-rose-500/12",
  },
  awaiting_approval: {
    textClass: "text-amber-300",
    borderClass: "border-amber-400/45",
    bgClass: "bg-amber-400/12",
  },
  awaiting_input: {
    textClass: "text-amber-300",
    borderClass: "border-amber-400/45",
    bgClass: "bg-amber-400/12",
  },
  awaiting_acceptance: {
    textClass: "text-violet-300",
    borderClass: "border-violet-400/45",
    bgClass: "bg-violet-400/12",
  },
  needs_guidance: {
    textClass: "text-orange-300",
    borderClass: "border-orange-400/45",
    bgClass: "bg-orange-400/12",
  },
  proposed_plan: {
    textClass: "text-violet-300",
    borderClass: "border-violet-400/40",
    bgClass: "bg-violet-400/10",
  },
} satisfies Record<AttentionReason, { textClass: string; borderClass: string; bgClass: string }>;

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
 * The plan column a thread occupies on the board: its plan lane, with the
 * derived `blocked` substituted when a released `ready` thread is still waiting
 * on an unmet (not-`done`) sibling dependency. Self-deps are ignored and
 * dangling dep ids don't gate. A held `planned` thread stays `planned`
 * regardless of deps (it is not released yet); terminal lanes are unaffected.
 */
export function getEffectiveColumn(
  thread: SidebarThreadSummary,
  childById: ChildIndex,
): WorkstreamColumnId {
  if (thread.planLane !== "ready") return thread.planLane;
  const blockedByUnmetDep = thread.blockedBy.some((depId) => {
    if (depId === thread.id) return false;
    const dep = childById.get(depId);
    return dep ? dep.planLane !== "done" : false;
  });
  return blockedByUnmetDep ? "blocked" : "ready";
}

export function getThreadStatus(
  thread: SidebarThreadSummary,
  childById: ChildIndex,
): WorkstreamStatus {
  const column = getEffectiveColumn(thread, childById);
  return { column, label: COLUMN_SHORT_LABELS[column], ...STATUS_STYLES[column] };
}

/** The attention badges to overlay on a thread's card, highest-priority first. */
export function getAttentionBadges(
  thread: SidebarThreadSummary,
): ReadonlyArray<{ reason: AttentionReason; label: string }> {
  return attentionReasonsOf(thread).map((reason) => ({ reason, label: ATTENTION_LABELS[reason] }));
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
  if (thread.attention.includes("error")) return "stalled — needs you";
  if (thread.attention.includes("needs_guidance")) return "stuck — needs guidance";
  if (thread.attention.includes("awaiting_acceptance")) return "awaiting your acceptance";
  if (hasRunningSignal(thread)) return "live turn in progress";
  if (thread.latestTurn?.state === "completed") return "latest turn completed";
  if (thread.archivedAt) return "archived";
  return COLUMN_SHORT_LABELS[column].toLowerCase();
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
    ready: [],
    blocked: [],
    in_progress: [],
    done: [],
    cancelled: [],
  };
  for (const thread of children) groups[getEffectiveColumn(thread, childById)].push(thread);
  return groups;
}

/** Whether a thread has any descendant-affecting live runtime signal. */
export { hasRunningSignal };
