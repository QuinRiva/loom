import type { VcsStatusResult } from "@t3tools/contracts";
import type { AttentionReason, GraphRollup } from "../lib/workstreamGraph";
import { resolveChangeRequestPresentation } from "../sourceControlPresentation";

export interface PrStatusIndicator {
  label: string;
  colorClass: string;
  tooltip: string;
  url: string;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export type ThreadPr = VcsStatusResult["pr"];

export function prStatusIndicator(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): PrStatusIndicator | null {
  if (!pr) return null;
  const presentation = resolveChangeRequestPresentation(provider);

  if (pr.state === "open") {
    return {
      label: `${presentation.shortName} open`,
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} ${presentation.shortName} open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: `${presentation.shortName} closed`,
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} ${presentation.shortName} closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: `${presentation.shortName} merged`,
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} ${presentation.shortName} merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

export interface WorkstreamGraphBadge {
  readonly tone: "active" | "needs" | "dead" | "done" | "idle";
  /** Badge digit; `null` renders the glyph alone (done / idle). Caps at "99+". */
  readonly count: number | null;
  readonly className: string;
  readonly pulse: boolean;
  readonly title: string;
}

export const ATTENTION_REASON_LABEL: Record<AttentionReason, string> = {
  error: "error / stalled",
  awaiting_approval: "awaiting approval",
  awaiting_input: "awaiting input",
  awaiting_acceptance: "awaiting acceptance",
  needs_guidance: "needs guidance",
  proposed_plan: "plan ready",
};

const BADGE_TONE_CLASS: Record<WorkstreamGraphBadge["tone"], string> = {
  active:
    "border-sky-500/40 bg-sky-500/12 text-sky-700 dark:border-sky-400/40 dark:bg-sky-400/12 dark:text-sky-300",
  needs:
    "border-amber-500/42 bg-amber-500/12 text-amber-700 dark:border-amber-400/42 dark:bg-amber-400/12 dark:text-amber-300",
  dead: "border-rose-500/48 bg-rose-500/14 text-rose-700 dark:border-rose-400/48 dark:bg-rose-400/14 dark:text-rose-300",
  done: "border-emerald-500/38 bg-emerald-500/10 text-emerald-700 dark:border-emerald-400/38 dark:bg-emerald-400/10 dark:text-emerald-300",
  idle: "border-slate-400/30 bg-slate-400/8 text-slate-600 dark:text-slate-300",
};

/**
 * Map a rolled-up graph state to its trailing badge. The number is
 * state-contextual (mirrors docs/design/workstream-sidebar-indicator-mockup.html):
 * active = live worker count, attention = nodes needing you, deadlocked = 0,
 * done/idle = glyph only. Returns `null` for `empty` — a thread with no
 * sub-threads shows no badge at all (absence is the signal).
 */
export function resolveWorkstreamGraphBadge(rollup: GraphRollup): WorkstreamGraphBadge | null {
  switch (rollup.graphState) {
    case "empty":
      return null;
    case "active":
      return {
        tone: "active",
        count: rollup.activeWorkerCount,
        className: BADGE_TONE_CLASS.active,
        pulse: false,
        title: `Workstream · ${rollup.activeWorkerCount} running`,
      };
    case "attention":
      return {
        tone: "needs",
        count: rollup.attentionCount,
        className: BADGE_TONE_CLASS.needs,
        pulse: false,
        title: `Needs you · ${rollup.attentionCount} ${
          rollup.highestAttentionReason
            ? ATTENTION_REASON_LABEL[rollup.highestAttentionReason]
            : "awaiting you"
        }`,
      };
    case "deadlocked":
      return {
        tone: "dead",
        count: 0,
        className: BADGE_TONE_CLASS.dead,
        pulse: true,
        title: "Deadlocked · no path forward",
      };
    case "done":
      return {
        tone: "done",
        count: null,
        className: BADGE_TONE_CLASS.done,
        pulse: false,
        title: `Workstream · all ${rollup.total} done`,
      };
    case "idle":
      return {
        tone: "idle",
        count: null,
        className: BADGE_TONE_CLASS.idle,
        pulse: false,
        title: "Workstream · idle",
      };
  }
}

export function resolveThreadPr(
  threadBranch: string | null,
  gitStatus: VcsStatusResult | null,
): ThreadPr | null {
  if (threadBranch === null || gitStatus === null || gitStatus.refName !== threadBranch) {
    return null;
  }

  return gitStatus.pr ?? null;
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: ReadonlyArray<string>,
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}
