import { DEFAULT_GATE_MAX_ROUNDS } from "@t3tools/contracts";
import type {
  ContextMenuItem,
  ModelSelection,
  OrchestrationEvent,
  ThreadId,
  ThreadPlanLane,
} from "@t3tools/contracts";
import { gateSourceFor, isWaitingInGate } from "@t3tools/shared/workstreamGraph";

import type { SidebarThreadSummary } from "../types";
import {
  type AttentionReason,
  attentionReasonsOf,
  hasRunningSignal,
  type WorkstreamColumnId,
} from "./workstreamRollup";

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
  "awaiting_brief",
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
  awaiting_brief: "Awaiting brief · no kickoff yet",
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
  awaiting_brief: "Awaiting brief",
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
  // Indigo family — a scaffolded node released but still awaiting its kickoff
  // brief: distinct from slate `planned` (deliberately held) and cyan `ready`
  // (briefed, about to run), signalling "needs a brief before it can dispatch".
  awaiting_brief: {
    textClass: "text-indigo-300",
    borderClass: "border-indigo-400/35",
    bgClass: "bg-indigo-400/10",
    dotClass: "bg-indigo-400",
    leftBorderClass: "border-l-indigo-400",
    graphStroke: "#818cf8",
    graphFill: "rgba(129, 140, 248, 0.15)",
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
  // v2 palette (plans/graph-view-metadata-enhancement.md §7): a passive
  // dependency wait reads COOL steel, not warm amber — warm hues are now
  // reserved for the human-attention overlay. `#9fb4cf` is the lighter steel
  // TEXT tint (legibility on dark); `#6d86a6` the stroke/fill/dot hue, bluer
  // than planned-slate `#94a3b8` and darker than ready-cyan so the three cool
  // states stay separable. The board card inherits this through STATUS_STYLES.
  blocked: {
    textClass: "text-[#9fb4cf]",
    borderClass: "border-[#6d86a6]/40",
    bgClass: "bg-[#6d86a6]/10",
    dotClass: "bg-[#6d86a6]",
    leftBorderClass: "border-l-[#6d86a6]",
    graphStroke: "#6d86a6",
    graphFill: "rgba(109, 134, 166, 0.16)",
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

// v2: the waits-on edge follows `blocked` to steel (was amber `#f59e0b`). The
// graph's waits-arrow marker fill, dashed edge stroke, and legend swatch all
// read this constant, so they recolour automatically.
export const WAITS_ON_STROKE = "#6d86a6";

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

/**
 * Loop-edge stroke tinted by the gate's LATEST verdict so the ambient edge tells
 * the exact same story as the card's verdict chip — amber while `needs_rework`,
 * emerald once `clean`/`fixed_inline`, violet for a yielded/cap-breach outcome —
 * by reusing `getVerdictChip`'s stroke rather than re-deriving (and re-ordering)
 * the verdict precedence. Falls back to the neutral round-depth violet when no
 * verdict has been recorded yet.
 */
export function getLoopEdgeStroke(thread: SidebarThreadSummary): string {
  return getVerdictChip(thread)?.stroke ?? getLoopStroke(thread.gateRounds);
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

// Dot-tone vocabulary shared by the lifecycle timeline. Declared here (rather
// than beside the timeline builder) so the event-level verdict primitive below
// can carry a tone without a forward reference.
export type LifecycleTone = "neutral" | "sky" | "violet" | "amber" | "emerald" | "rose" | "cyan";

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
 * One resolved verdict: the card/graph chip (label + colours) plus the timeline
 * dot tone. THE single source of the verdict vocabulary (label + colour + tone)
 * so the board card, SVG pill, and lifecycle row can never drift — the
 * `fixed_inline` emerald-outline distinction lives here once.
 */
export interface OutcomeVerdict {
  readonly chip: GateVerdictChip;
  readonly tone: LifecycleTone;
}

/**
 * Classify a submitted outcome into its verdict presentation, event-level (no
 * thread required): `clean` emerald / `fixed_inline` emerald-outline
 * (reviewer-authored fixes are human-auditable) / `needs_rework ⟲n` amber / a
 * yielded (yield/cap-breach) outcome violet. Null for outcomes with no verdict
 * vocabulary (terminal/attention/resolve decisions on a non-verdict token).
 */
export function describeOutcomeVerdict(outcome: {
  readonly outcome: string;
  readonly decision: string;
  readonly round: number;
}): OutcomeVerdict | null {
  if (outcome.decision === "yield" || outcome.decision === "cap-breach")
    return {
      chip: { label: `${outcome.outcome.replaceAll("_", " ")} · yielded`, ...CHIP_VIOLET },
      tone: "violet",
    };
  if (outcome.outcome === "clean")
    return { chip: { label: "clean", ...CHIP_EMERALD }, tone: "emerald" };
  if (outcome.outcome === "fixed_inline")
    return { chip: { label: "fixed inline", ...CHIP_EMERALD_OUTLINE }, tone: "emerald" };
  if (outcome.outcome === "needs_rework")
    return { chip: { label: `needs rework ⟲${outcome.round}`, ...CHIP_AMBER }, tone: "amber" };
  return null;
}

/**
 * Verdict chip for a gate source's card, from its last submitted outcome.
 * Delegates the vocabulary to `describeOutcomeVerdict`; only adds the gate-source
 * guard (needs a loop route + a recorded outcome). Null otherwise.
 */
export function getVerdictChip(thread: SidebarThreadSummary): GateVerdictChip | null {
  const last = thread.lastOutcome;
  if (!last || !thread.routes.some((route) => route.kind === "loop")) return null;
  return describeOutcomeVerdict(last)?.chip ?? null;
}

/** One gate-leg badge: a live leg (re-reviewing/reworking) or a parked wait. */
export interface GateWait {
  readonly label: string;
  /** True for an in-flight leg (never "idle by design"), false for a parked wait. */
  readonly active: boolean;
}

/**
 * Gate-leg badge for a card. Inside an active rework loop (rounds > 0), an
 * executing party ALWAYS reads as holding the live leg — re-reviewing /
 * reworking its round, never "waiting" (2026-07-07 incident). This is what
 * breaks the contradictory pair: during a round hand-off both parties' stored
 * state can still read waiting (`isWaitingInGate` true on both — the reviewer
 * looped and the coder routed back, both carrying `lastOutcome.decision ===
 * "loop"`), but whichever side has already picked the round back up runs, so it
 * shows active and at most one card is left with a parked waiting badge. The
 * round-0 initial review/coding is silent as before (no loop has happened).
 *
 * Otherwise falls back to the shared `isWaitingInGate` (the same predicate that
 * suppresses the dispatcher's idle nag): the gate source waits on the coder's
 * rework; the target waits on the reviewer's re-verify.
 */
export function getGateWaitLabel(thread: SidebarThreadSummary, byId: ChildIndex): GateWait | null {
  const isTerminal = thread.planLane === "done" || thread.planLane === "cancelled";
  const isGateSource = !isTerminal && thread.routes.some((route) => route.kind === "loop");
  if (hasRunningSignal(thread) && !isTerminal) {
    // A running source mid-loop (>=1 round consumed) is re-reviewing that round.
    if (isGateSource && thread.gateRounds > 0)
      return { label: `re-reviewing round ${thread.gateRounds}`, active: true };
    // A running target whose source has opened a rework round is reworking it.
    const source = isGateSource ? null : gateSourceFor(thread.id, [...byId.values()]);
    if (source && source.gateRounds > 0)
      return { label: `reworking round ${source.gateRounds}`, active: true };
  }
  if (!isWaitingInGate(thread, byId)) return null;
  return { label: isGateSource ? "waiting on rework" : "awaiting re-review", active: false };
}

/**
 * A scaffolded child that has been released (`ready`) but has no kickoff brief
 * yet, so it cannot dispatch even once its dependencies clear (plan §5). Roots
 * carry their kickoff as the `brief` string, never a `kickoffBriefPath`, so only
 * children qualify; a held `planned` node stays `planned` (the deliberate hold
 * dominates during the shape-review window).
 */
export function isAwaitingBrief(thread: SidebarThreadSummary): boolean {
  return (
    thread.parentThreadId !== null &&
    thread.kickoffBriefPath === null &&
    thread.planLane === "ready"
  );
}

/**
 * The plan column a thread occupies on the board: its plan lane, with the
 * derived `blocked` substituted when a released `ready` thread is still waiting
 * on an unmet (not-`done`) sibling dependency, and `awaiting_brief` when a
 * released thread has no kickoff brief yet. Self-deps are ignored and dangling
 * dep ids don't gate. Unmet deps win over the brief gate (matching the
 * control-plane's deps-satisfied eligibility for the brief-needed wake). A held
 * `planned` thread stays `planned` regardless of deps/brief (it is not released
 * yet); terminal lanes are unaffected.
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
  if (blockedByUnmetDep) return "blocked";
  if (isAwaitingBrief(thread)) return "awaiting_brief";
  return "ready";
}

export function getThreadStatus(
  thread: SidebarThreadSummary,
  childById: ChildIndex,
): WorkstreamStatus {
  const column = getEffectiveColumn(thread, childById);
  return { column, label: COLUMN_SHORT_LABELS[column], ...STATUS_STYLES[column] };
}

// The three STORED, human-blocking attention reasons that earn an animated node
// pulse on the graph (the projected `awaiting_*`/`proposed_plan` overlays are
// board-only). Hex strokes so the SVG ring can reuse the board's colour
// families: rose error, orange needs-guidance, violet awaiting-acceptance.
const ATTENTION_PULSE_STROKES: Partial<Record<AttentionReason, string>> = {
  error: "#fb7185",
  needs_guidance: "#fb923c",
  awaiting_acceptance: "#a78bfa",
};

export interface AttentionPulse {
  readonly reason: AttentionReason;
  readonly stroke: string;
  readonly label: string;
}

/**
 * The single attention pulse to animate a graph node's stroke with, or null when
 * nothing human-blocking is flagged. Picks the highest-priority stored reason
 * (`attentionReasonsOf` already sorts) that has a pulse colour, so one clear
 * pulsing affordance wins rather than stacking rings.
 */
export function getAttentionPulse(thread: SidebarThreadSummary): AttentionPulse | null {
  for (const reason of attentionReasonsOf(thread)) {
    const stroke = ATTENTION_PULSE_STROKES[reason];
    if (stroke) return { reason, stroke, label: ATTENTION_LABELS[reason] };
  }
  return null;
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

// Fan-in chip palette: conflict is amber and must not read as success; merged is
// a subtle green; merging is a neutral in-flight grey.
export const FAN_IN_CHIP_STYLES: Record<FanInChip["tone"], string> = {
  merging: "border-white/15 bg-white/[0.04] text-white/55",
  merged: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200/80",
  conflict: "border-amber-400/40 bg-amber-400/10 text-amber-200",
};

// THE single source of the settled fan-in vocabulary (label + chip tone +
// timeline dot tone) so the card chip, graph badge, and lifecycle row agree.
// Only the two SETTLED states have a shared label; "merging…" (a done child
// still folding in) and the reset-to-"none" case stay caller-specific.
export const FAN_IN_SETTLEMENT: Record<
  "completed" | "conflicted",
  { readonly label: string; readonly chipTone: FanInChip["tone"]; readonly tone: LifecycleTone }
> = {
  completed: { label: "merged", chipTone: "merged", tone: "emerald" },
  conflicted: { label: "merge conflict", chipTone: "conflict", tone: "amber" },
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
  if (thread.fanInState === "conflicted")
    return {
      label: FAN_IN_SETTLEMENT.conflicted.label,
      tone: FAN_IN_SETTLEMENT.conflicted.chipTone,
    };
  if (thread.fanInState === "completed")
    return { label: FAN_IN_SETTLEMENT.completed.label, tone: FAN_IN_SETTLEMENT.completed.chipTone };
  if (thread.planLane === "done") return { label: "merging…", tone: "merging" };
  return null;
}

// SVG corner-badge vocabulary for the fan-in state, parallel to the card's
// `FAN_IN_CHIP_STYLES`: a warning glyph for an amber merge conflict, a tick for
// a subtle merged confirmation, and an ellipsis for an in-flight merge.
const FAN_IN_BADGE: Record<FanInChip["tone"], { glyph: string; stroke: string }> = {
  merging: { glyph: "⋯", stroke: "rgba(255,255,255,0.5)" },
  merged: { glyph: "✓", stroke: "#34d399" },
  conflict: { glyph: "!", stroke: "#f59e0b" },
};

export interface FanInBadge {
  readonly glyph: string;
  readonly stroke: string;
  readonly label: string;
}

/**
 * Corner-glyph presentation for a node's fan-in settlement, derived from the
 * same `getFanInChip` vocabulary so the graph badge and the card chip stay in
 * lockstep. Null whenever the chip is (shared threads, un-settled).
 */
export function getFanInBadge(thread: SidebarThreadSummary): FanInBadge | null {
  const chip = getFanInChip(thread);
  if (!chip) return null;
  return { ...FAN_IN_BADGE[chip.tone], label: chip.label };
}

export function getRoleLabel(thread: SidebarThreadSummary): string {
  return thread.role?.trim() || "sub-thread";
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

/**
 * Compact age for the tight node footer — `23s` / `4m` / `3h` / `2d`, `—` for
 * unparseable. Same bucketing as `formatRelativeAge` minus the ` ago` suffix
 * (the board + hover card keep the long form; do not fold these together).
 */
export function formatCompactAge(iso: string): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * Tool-use count for the node footer, capped at `999+` so it can never overflow
 * the card into the bottom-right badge corner.
 */
export function formatToolUses(n: number): string {
  return n > 999 ? "999+" : `${n}`;
}

// Per-provider tint for the model pill's dot/border/background. Same model on a
// different provider is materially different, so the tint carries the provider
// at a glance. Keyed case-insensitively on the provider slug parsed from the
// model slug prefix (e.g. `cliproxy`, `google-vertex-claude`, `anthropic`) —
// NOT the harness instance id (`pi`), which the user does not care about.
const PROVIDER_TINTS: Record<string, string> = {
  anthropic: "#d9895a",
  "claude-agent": "#d9895a",
  bedrock: "#d9895a",
  cliproxy: "#e879a6",
  vertex: "#60a5fa",
  "google-vertex": "#60a5fa",
  "google-vertex-claude": "#60a5fa",
  "openai-codex": "#19c37d",
  openai: "#19c37d",
  gemini: "#a78bfa",
};

// Deterministic fallback palette for unknown providers — the load-bearing path,
// since provider slugs are open-ended. A slug always hashes to the same hue, so
// the pill colour is stable across renders.
const PROVIDER_FALLBACK_TINTS = [
  "#60a5fa",
  "#e879a6",
  "#19c37d",
  "#d9895a",
  "#a78bfa",
  "#2dd4bf",
] as const;

/** Hex tint for a provider's pill dot (known map, else stable hash). */
export function getProviderTint(provider: string): string {
  const key = provider.trim().toLowerCase();
  const mapped = PROVIDER_TINTS[key];
  if (mapped) return mapped;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return PROVIDER_FALLBACK_TINTS[Math.abs(hash) % PROVIDER_FALLBACK_TINTS.length]!;
}

/**
 * Split a model selection into its pill parts. The real provider (cliproxy /
 * vertex / anthropic …) lives in the model slug PREFIX (`cliproxy/opus`,
 * `google-vertex-claude/claude-opus-4-8`); the harness instance id (`pi`) is not
 * the provider and is deliberately ignored. When the slug carries no `/` prefix
 * there is no provider to show, so `provider` is null and the model reuses the
 * untouched `formatModelLabel` (which the board card header still uses directly).
 */
export function getProviderModelParts(selection: ModelSelection): {
  provider: string | null;
  model: string;
} {
  const slug = selection.model?.trim() ?? "";
  const slash = slug.indexOf("/");
  if (slash > 0) return { provider: slug.slice(0, slash), model: slug.slice(slash + 1) || slug };
  return { provider: null, model: formatModelLabel(selection) };
}

/**
 * THE single state rule for the always-on node footer (plan §3.2/§3.3): only
 * running/yielded nodes carry it; not-yet-run nodes stay clean and terminal
 * nodes recede with no footer. `toolLabel` is null when the provider reports no
 * count (distinct from 0); `live` tracks an in-flight turn (the pulse dot). The
 * render is a dumb consumer so the rule stays unit-testable.
 */
export function getNodeFooter(
  thread: SidebarThreadSummary,
  column: WorkstreamColumnId,
): { toolLabel: string | null; age: string; live: boolean } | null {
  if (column !== "in_progress" && column !== "yielded") return null;
  return {
    toolLabel: thread.toolUses !== null ? formatToolUses(thread.toolUses) : null,
    age: formatCompactAge(getLastActivityAt(thread)),
    live: hasRunningSignal(thread),
  };
}

export type WorkstreamNodeMenuAction =
  | "open"
  | "history"
  | "report"
  | "release"
  | "clear-flags"
  | "stop";

/**
 * State-aware right-click action set for a graph node (plan §4), replacing the
 * removed ⓘ affordance. Conditions are PRESENCE conditions (item omitted when
 * it can't be actioned) rather than disabled flags, so the menu stays short.
 * Navigation first (open/history/report), then controls (release/clear/stop).
 * Pure so it is unit-testable; the panel switches on the resolved id.
 */
export function buildNodeContextMenuItems(
  thread: SidebarThreadSummary,
): ContextMenuItem<WorkstreamNodeMenuAction>[] {
  const items: ContextMenuItem<WorkstreamNodeMenuAction>[] = [
    { id: "open", label: "Open thread" },
    { id: "history", label: "View history" },
  ];
  if (thread.reportPath !== null) items.push({ id: "report", label: "Open report" });
  if (thread.planLane === "planned") items.push({ id: "release", label: "Release" });
  if (attentionReasonsOf(thread).length > 0)
    items.push({ id: "clear-flags", label: "Clear flags" });
  if (hasRunningSignal(thread)) items.push({ id: "stop", label: "Stop", destructive: true });
  return items;
}

export function truncateLabel(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/**
 * Greedy word-wrap for the graph card's title (SVG has no native wrapping):
 * at most `maxLines` lines of `maxCharsPerLine`, a word longer than a line
 * hard-truncated, and an ellipsis on the last line when the title overflows.
 */
export function wrapLabel(value: string, maxCharsPerLine: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of value.trim().split(/\s+/).filter(Boolean)) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (candidate.length <= maxCharsPerLine) {
      line = candidate;
    } else {
      if (line !== "") lines.push(line);
      line = truncateLabel(word, maxCharsPerLine);
    }
  }
  if (line !== "") lines.push(line);
  if (lines.length <= maxLines) return lines;
  const clipped = lines.slice(0, maxLines);
  const last = clipped[maxLines - 1]!;
  clipped[maxLines - 1] =
    last.length >= maxCharsPerLine ? `${last.slice(0, maxCharsPerLine - 1)}…` : `${last}…`;
  return clipped;
}

/**
 * The single worded state for a graph node's header strip — the gate leg when
 * the thread is in a review gate (`reworking ⟲1`, `waiting on rework`), else
 * the plan-column label. One slot, one telling: this is what absorbed the old
 * meta line's status text and the straddling gate-wait pill (design C2,
 * docs/design/workstream-graph-node-redesign.html §3d).
 */
export function getNodeStateWord(thread: SidebarThreadSummary, byId: ChildIndex): string {
  const gate = getGateWaitLabel(thread, byId);
  if (gate) return gate.label.replace(" round ", " ⟲");
  return COLUMN_SHORT_LABELS[getEffectiveColumn(thread, byId)].toLowerCase();
}

export function groupChildrenByColumn(
  children: ReadonlyArray<SidebarThreadSummary>,
  childById: ChildIndex,
) {
  const groups: Record<WorkstreamColumnId, SidebarThreadSummary[]> = {
    planned: [],
    awaiting_brief: [],
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

// ---------------------------------------------------------------------------
// Per-thread lifecycle timeline (WorkstreamPanel) — the ordered journey the
// latest-state read model collapses away, derived from the scoped
// `getThreadLifecycle` event pull. Pure + JSX-free so it stays testable and the
// panel just maps rows to markup. `LifecycleTone` is declared up beside
// `GateVerdictChip` so the shared verdict/fan-in primitives can carry it.
// ---------------------------------------------------------------------------

export interface LifecycleRow {
  /** Stable key — the source event id. */
  readonly key: string;
  /** ISO timestamp of the transition. */
  readonly at: string;
  /** Terse primary copy. */
  readonly label: string;
  /** Optional secondary copy (verdict, reason, round). */
  readonly detail: string | null;
  readonly tone: LifecycleTone;
  /**
   * Whether the row maps cleanly to a message/turn in the thread's chat so it
   * can deep-link via `requestScrollToDispatch`. Only set where the mapping is
   * unambiguous (a turn boundary: start/resume/yield, and each submitted
   * outcome) — control-plane-only rows (route-taken, fan-in) are not linked.
   */
  readonly deepLink: boolean;
  /**
   * Absolute path to the completion report this row's submit wrote, when one
   * exists. Set only on outcome rows: a `thread.report-set` event is emitted in
   * the same transaction immediately before its `thread.outcome-recorded`, so
   * the fold carries the pending path onto the next outcome row — exposing each
   * rework round's own handoff, not just the thread's latest pointer.
   */
  readonly reportPath?: string;
}

// Dot + text colour per tone, drawn from the same board/graph families.
export const LIFECYCLE_TONE_STYLES: Record<
  LifecycleTone,
  { readonly dotClass: string; readonly textClass: string }
> = {
  neutral: { dotClass: "bg-white/40", textClass: "text-white/70" },
  sky: { dotClass: "bg-sky-400", textClass: "text-sky-300" },
  violet: { dotClass: "bg-violet-400", textClass: "text-violet-300" },
  amber: { dotClass: "bg-amber-400", textClass: "text-amber-300" },
  emerald: { dotClass: "bg-emerald-400", textClass: "text-emerald-300" },
  rose: { dotClass: "bg-rose-400", textClass: "text-rose-300" },
  cyan: { dotClass: "bg-cyan-400", textClass: "text-cyan-300" },
};

const ATTENTION_TONES: Record<AttentionReason, LifecycleTone> = {
  error: "rose",
  needs_guidance: "amber",
  awaiting_acceptance: "violet",
  awaiting_approval: "amber",
  awaiting_input: "amber",
  proposed_plan: "violet",
};

type LifecycleRowBody = Omit<LifecycleRow, "key" | "at">;

const humanizeToken = (token: string): string => token.replaceAll("_", " ");

const isTerminalLane = (lane: ThreadPlanLane | null): boolean =>
  lane === "done" || lane === "cancelled";

// A `plan-lane-set` to `in_progress` reads as: a resume when it directly follows
// a `yielded`; a REOPEN when it follows a terminal lane (done/cancelled) — the
// common `in_progress → done → in_progress` gate-rework shape, whose reopening
// `in_progress` carries no `spawnGeneration`; otherwise the kickoff start.
// `spawnGeneration` on a re-open to ready/planned marks a terminal thread being
// re-run in a fresh generation.
function describeLaneTransition(
  lane: ThreadPlanLane,
  previousLane: ThreadPlanLane | null,
  reopened: boolean,
): LifecycleRowBody {
  switch (lane) {
    case "in_progress":
      if (previousLane === "yielded")
        return {
          label: "Resumed",
          detail: "picked back up by orchestrator",
          tone: "sky",
          deepLink: true,
        };
      if (isTerminalLane(previousLane))
        return { label: "Reopened", detail: "re-run for rework", tone: "sky", deepLink: true };
      return { label: "Started", detail: null, tone: "sky", deepLink: true };
    case "yielded":
      return {
        label: "Yielded",
        detail: "handed the turn back to the orchestrator",
        tone: "violet",
        deepLink: true,
      };
    case "done":
      return { label: "Done", detail: null, tone: "emerald", deepLink: false };
    case "cancelled":
      return { label: "Cancelled", detail: null, tone: "neutral", deepLink: false };
    case "ready":
      return reopened
        ? {
            label: "Reopened",
            detail: "re-run in a fresh generation",
            tone: "cyan",
            deepLink: false,
          }
        : { label: "Released", detail: "ready to run", tone: "cyan", deepLink: false };
    case "planned":
      return reopened
        ? { label: "Reopened · held", detail: null, tone: "neutral", deepLink: false }
        : { label: "Held", detail: null, tone: "neutral", deepLink: false };
  }
}

// Delegates the verdict vocabulary (label + tone) to the shared
// `describeOutcomeVerdict`, so the timeline row and the card/graph chip can
// never drift and `fixed_inline` keeps its distinct label. Only the row-specific
// bits (round/counts detail, deep-linkability) live here.
function describeOutcome(payload: {
  readonly outcome: string;
  readonly decision: string;
  readonly round: number;
  readonly counts?: { readonly mustFix: number; readonly niceToHave: number } | undefined;
}): LifecycleRowBody {
  const roundLabel = `round ${payload.round}`;
  const detail =
    payload.outcome === "needs_rework" && payload.counts
      ? `${payload.counts.mustFix} must-fix · ${payload.counts.niceToHave} nice-to-have`
      : roundLabel;
  const verdict = describeOutcomeVerdict(payload);
  if (verdict) return { label: verdict.chip.label, detail, tone: verdict.tone, deepLink: true };
  // Outcomes with no verdict vocabulary (e.g. a terminal/resolve decision on a
  // non-verdict token): still a submitted turn boundary, so keep it deep-linked.
  return { label: humanizeToken(payload.outcome), detail: roundLabel, tone: "sky", deepLink: true };
}

// Reuses the shared `FAN_IN_SETTLEMENT` vocabulary (label + tone) that the card
// chip and graph badge draw from; only "none" (a reset) is row-specific.
function describeFanIn(state: "none" | "completed" | "conflicted"): LifecycleRowBody {
  if (state === "completed")
    return {
      label: FAN_IN_SETTLEMENT.completed.label,
      detail: "fan-in complete",
      tone: FAN_IN_SETTLEMENT.completed.tone,
      deepLink: false,
    };
  if (state === "conflicted")
    return {
      label: FAN_IN_SETTLEMENT.conflicted.label,
      detail: "fan-in needs resolution",
      tone: FAN_IN_SETTLEMENT.conflicted.tone,
      deepLink: false,
    };
  return { label: "fan-in reset", detail: null, tone: "neutral", deepLink: false };
}

/**
 * Fold the scoped, ordered lifecycle events for one thread into terse timeline
 * rows. Lane transitions carry context (yield→resume), each outcome its verdict
 * + round, attention raise/clear its reason, route-takens the rework round, and
 * fan-in its settlement. Non-lifecycle events are ignored defensively.
 */
export function buildThreadLifecycleRows(
  events: ReadonlyArray<OrchestrationEvent>,
): ReadonlyArray<LifecycleRow> {
  const rows: LifecycleRow[] = [];
  let previousLane: ThreadPlanLane | null = null;
  // A submit emits `thread.report-set` immediately before its
  // `thread.outcome-recorded` (same transaction); hold that path and hand it to
  // the next outcome row so each round links to the report it produced.
  let pendingReportPath: string | null = null;
  for (const event of events) {
    const key = event.eventId;
    const at = event.occurredAt;
    switch (event.type) {
      case "thread.report-set":
        pendingReportPath = event.payload.reportPath;
        break;
      case "thread.plan-lane-set": {
        const body = describeLaneTransition(
          event.payload.planLane,
          previousLane,
          event.payload.spawnGeneration !== undefined,
        );
        previousLane = event.payload.planLane;
        rows.push({ key, at, ...body });
        break;
      }
      case "thread.attention-raised":
        rows.push({
          key,
          at,
          label: "Attention raised",
          detail: ATTENTION_LABELS[event.payload.reason],
          tone: ATTENTION_TONES[event.payload.reason],
          deepLink: false,
        });
        break;
      case "thread.attention-cleared":
        rows.push({
          key,
          at,
          label: "Attention cleared",
          detail: event.payload.reason ? ATTENTION_LABELS[event.payload.reason] : "all flags",
          tone: "neutral",
          deepLink: false,
        });
        break;
      case "thread.outcome-recorded":
        rows.push({
          key,
          at,
          ...describeOutcome(event.payload),
          ...(pendingReportPath !== null ? { reportPath: pendingReportPath } : {}),
        });
        pendingReportPath = null;
        break;
      case "thread.route-taken":
        rows.push({
          key,
          at,
          label: `Rework round ${event.payload.round} opened`,
          detail: null,
          tone: "amber",
          deepLink: false,
        });
        break;
      case "thread.fanin-set":
        rows.push({ key, at, ...describeFanIn(event.payload.fanInState) });
        break;
      default:
        break;
    }
  }
  return rows;
}

/** Whether a thread has any descendant-affecting live runtime signal. */
export { hasRunningSignal };
