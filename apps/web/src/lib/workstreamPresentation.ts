import { DEFAULT_GATE_MAX_ROUNDS } from "@t3tools/contracts";
import type { ModelSelection, ThreadId, ThreadPlanLane } from "@t3tools/contracts";
import { isWaitingInGate } from "@t3tools/shared/workstreamGraph";

import type { SidebarThreadSummary } from "../types";
import {
  type AttentionReason,
  attentionReasonsOf,
  hasRunningSignal,
  type WorkstreamColumnId,
} from "./workstreamGraph";

/**
 * Pure presentation logic shared by the Workstream board, cards, and the
 * lazily-loaded graph. Kept JSX-free so the graph chunk can import the
 * lane/role/format vocabulary without dragging the board components — or vice
 * versa — into either bundle.
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
// active `in_progress` phase, `yielded` (turn over, needs the orchestrator)
// between `in_progress` and `done`, and `cancelled` last (abandoned).
export const COLUMN_ORDER: ReadonlyArray<WorkstreamColumnId> = [
  "planned",
  "ready",
  "blocked",
  "in_progress",
  "yielded",
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
  yielded: "Yielded · needs orchestrator",
  done: "Done",
  cancelled: "Cancelled",
} satisfies Record<WorkstreamColumnId, string>;

// Short labels for per-card badges and the lane setter.
export const COLUMN_SHORT_LABELS = {
  planned: "Planned",
  ready: "Ready",
  blocked: "Blocked",
  in_progress: "In progress",
  yielded: "Yielded",
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
  // Violet family (review-gates design §10) — distinct from amber `blocked`
  // and sky `in_progress`: the thread yielded its turn to the orchestrator.
  yielded: {
    textClass: "text-violet-300",
    borderClass: "border-violet-400/40",
    bgClass: "bg-violet-400/10",
    dotClass: "bg-violet-400",
    leftBorderClass: "border-l-violet-400",
    graphStroke: "#a78bfa",
    graphFill: "rgba(167, 139, 250, 0.16)",
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

// consult_thread observability: the neutral/informational tint shared by the
// in-chat consult card and the graph's dotted consult cross-edge. Teal is
// deliberately distinct from the spawn/gate violet and the amber waits-on edge.
export const CONSULT_STROKE = "#2dd4bf";

// ---------------------------------------------------------------------------
// Review gates (docs/design/workstream-review-gates.md §10) — the loop-edge
// palette, verdict chip, and gate-waiting badge shared by the board cards and
// the SVG graph.
// ---------------------------------------------------------------------------

// Loop-edge stroke darkens with consumed rework rounds: violet-300 → violet-500.
const LOOP_STROKES = ["#c4b5fd", "#a78bfa", "#8b5cf6"] as const;

export function getLoopStroke(rounds: number): string {
  return LOOP_STROKES[Math.min(Math.max(rounds, 0), LOOP_STROKES.length - 1)]!;
}

/** The loop-round cap declared on a gate source's loop route. */
export function getGateLoopCap(thread: SidebarThreadSummary): number {
  return thread.routes.find((route) => route.kind === "loop")?.maxRounds ?? DEFAULT_GATE_MAX_ROUNDS;
}

/** One verdict chip — Tailwind classes for the board card, hex for the SVG card. */
export interface GateVerdictChip {
  readonly label: string;
  readonly textClass: string;
  readonly borderClass: string;
  readonly bgClass: string;
  readonly stroke: string;
  readonly fill: string;
}

const CHIP_EMERALD = {
  textClass: "text-emerald-300",
  borderClass: "border-emerald-400/45",
  bgClass: "bg-emerald-400/15",
  stroke: "#34d399",
  fill: "#173533",
};
const CHIP_EMERALD_OUTLINE = {
  textClass: "text-emerald-300",
  borderClass: "border-emerald-400/60",
  bgClass: "bg-transparent",
  stroke: "#34d399",
  fill: "#0d1117",
};
const CHIP_AMBER = {
  textClass: "text-amber-300",
  borderClass: "border-amber-400/45",
  bgClass: "bg-amber-400/15",
  stroke: "#f59e0b",
  fill: "#362d1c",
};
const CHIP_VIOLET = {
  textClass: "text-violet-300",
  borderClass: "border-violet-400/45",
  bgClass: "bg-violet-400/15",
  stroke: "#a78bfa",
  fill: "#2a2a42",
};

/**
 * Verdict chip for a gate source's card, from its last submitted outcome:
 * `clean` emerald / `fixed_inline` emerald-outline (reviewer-authored fixes are
 * human-auditable) / `needs_rework ⟲n` amber / a yielded outcome violet.
 * Null for non-gate threads and outcomes with no chip vocabulary.
 */
export function getVerdictChip(thread: SidebarThreadSummary): GateVerdictChip | null {
  const last = thread.lastOutcome;
  if (!last || !thread.routes.some((route) => route.kind === "loop")) return null;
  if (last.decision === "yield" || last.decision === "cap-breach")
    return { label: `${last.outcome.replaceAll("_", " ")} · yielded`, ...CHIP_VIOLET };
  if (last.outcome === "clean") return { label: "clean", ...CHIP_EMERALD };
  if (last.outcome === "fixed_inline") return { label: "fixed inline", ...CHIP_EMERALD_OUTLINE };
  if (last.outcome === "needs_rework")
    return { label: `needs rework ⟲${last.round}`, ...CHIP_AMBER };
  return null;
}

/**
 * Gate-waiting badge (shared `isWaitingInGate` — the same predicate that
 * suppresses the dispatcher's idle nag): the gate source waits on the coder's
 * rework; the target waits on the reviewer's re-verify.
 */
export function getGateWaitLabel(thread: SidebarThreadSummary, byId: ChildIndex): string | null {
  if (!isWaitingInGate(thread, byId)) return null;
  return thread.routes.some((route) => route.kind === "loop")
    ? "waiting on rework"
    : "awaiting re-review";
}

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

/**
 * Short model label for a card chip: the segment after the last `/` of the
 * model slug (e.g. `openai/gpt-5.5` -> `gpt-5.5`,
 * `google-vertex-claude/claude-opus-4-8` -> `claude-opus-4-8`). Falls back to the
 * raw slug, then the instance id, so the chip is never empty.
 */
export function formatModelLabel(selection: ModelSelection): string {
  const slug = selection.model?.trim();
  if (slug) return slug.slice(slug.lastIndexOf("/") + 1) || slug;
  return selection.instanceId;
}

/**
 * Context-window fill as a short percentage string (`38%`, `4.2%`), or null when
 * the snapshot is unknown. Mirrors the chat-header meter's `formatPercentage`.
 */
export function formatContextPercent(used: number | null, max: number | null): string | null {
  if (used === null || max === null || max <= 0) return null;
  const pct = Math.min(100, (used / max) * 100);
  return pct < 10 ? `${pct.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(pct)}%`;
}

/**
 * Compact lines-of-diff label (`+128 −40`) summed across this thread's
 * checkpoint turns, or null when there is no checkpoint yet (both unknown). A
 * settled thread with a real 0/0 diff still renders `+0 −0` so "no changes" is
 * distinguishable from "not measured".
 */
export function formatDiffMetric(
  additions: number | null,
  deletions: number | null,
): string | null {
  if (additions === null && deletions === null) return null;
  return `+${additions ?? 0} −${deletions ?? 0}`;
}

export type FanInChip = {
  readonly label: string;
  readonly tone: "merging" | "merged" | "conflict";
};

/**
 * Fan-in settlement chip for an isolated child's card (design §3), derived from
 * shell state so it updates live off `thread.fanin-set`: an amber "merge
 * conflict" that must not read as success, a subtle "merged", or a "merging…"
 * while a done child's branch is still being folded in. Null for shared threads
 * and un-settled non-terminal ones (nothing to show).
 */
export function getFanInChip(thread: SidebarThreadSummary): FanInChip | null {
  if (thread.isolation !== "isolated" || thread.parentThreadId === null) return null;
  if (thread.fanInState === "conflicted") return { label: "merge conflict", tone: "conflict" };
  if (thread.fanInState === "completed") return { label: "merged", tone: "merged" };
  if (thread.planLane === "done") return { label: "merging…", tone: "merging" };
  return null;
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
    yielded: [],
    done: [],
    cancelled: [],
  };
  for (const thread of children) groups[getEffectiveColumn(thread, childById)].push(thread);
  return groups;
}

/** Whether a thread has any descendant-affecting live runtime signal. */
export { hasRunningSignal };
