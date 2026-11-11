/**
 * loom: the words on the workstream screen, as pure functions over a node: a row's second line
 * and right-hand chip, wave captions and folds, the needs-you cards, the header and the sheet.
 * The rules come from the shared `workstreamNodes`, so a label reads as it does on web.
 */
import {
  attentionLabel,
  workstreamBadgeOf,
  type WorkstreamRollup,
} from "@t3tools/client-runtime/state/loom/rollup";
import {
  describeOutcomeVerdict,
  formatCompactAge,
  formatRelativeAge,
  formatStepAge,
  getActivity,
  getGateLoopCap,
  getGateWaitLabel,
  getRoleLabel,
  getStep,
  getVerdictChip,
  isGateSource,
  isRunning,
  type NodeAttention,
  nodeAttentionOf,
  type WorkstreamNode,
  type WorkstreamNodeIndex,
} from "@t3tools/client-runtime/state/loom/workstreamNodes";
import { gateSourceFor } from "@t3tools/shared/workstreamGraph";

import type { LaneRow } from "./laneLayout.loom";
import type { NeedsYouCard, NeedsYouKind } from "./workstreamView.loom";

const join = (...parts: ReadonlyArray<string | null | false | undefined>) =>
  parts.filter(Boolean).join(" · ");

export interface RowCopy {
  readonly role: string;
  /** The one state that wins: flag, gate leg, running step, blocked, settled, else activity. */
  readonly state: string;
  /** Set when the state is a flag or a pending request. */
  readonly attention: NodeAttention | null;
  /** A running step past five minutes: amber, as on web. */
  readonly longStep: boolean;
  /** A sub-orchestrator's `2 running · 5 settled`, else null. */
  readonly progress: string | null;
}

const descendantsOf = (node: WorkstreamNode, byId: WorkstreamNodeIndex) => {
  const out: WorkstreamNode[] = [];
  const queue = [node.id];
  for (let at = 0; at < queue.length; at += 1)
    for (const candidate of byId.values())
      if (candidate.parentThreadId === queue[at]) {
        out.push(candidate);
        queue.push(candidate.id);
      }
  return out;
};

/** A row's second line. Pass `now` from `useNowMinuteMs` so ages tick. */
export function rowCopy(node: WorkstreamNode, byId: WorkstreamNodeIndex, now: number): RowCopy {
  const descendants = descendantsOf(node, byId);
  const progress =
    descendants.length === 0
      ? null
      : join(
          `${descendants.filter(isRunning).length} running`,
          `${descendants.filter((child) => child.outcome !== null).length} settled`,
        );
  const copy = (state: string, longStep = false): RowCopy => ({
    role: getRoleLabel(node),
    state,
    attention: null,
    longStep,
    progress,
  });

  const attention = nodeAttentionOf(node);
  if (attention) return { ...copy(getActivity(node)), attention };

  const step = getStep(node, now);
  const stepText = step ? join(step.label, formatStepAge(step.since, now)) : null;
  const wait = getGateWaitLabel(node, byId);
  if (node.outcome === null && isGateSource(node))
    return copy(
      join(
        "gate",
        `round ${Math.max(node.gateRounds, 1)} of ${getGateLoopCap(node)}`,
        wait && !wait.active ? wait.label : stepText,
      ),
      step?.long ?? false,
    );
  if (node.pendingRework) {
    const source = gateSourceFor(node.id, [...byId.values()]);
    return copy(
      join(source ? `rework round ${source.gateRounds}` : "rework", stepText),
      step?.long ?? false,
    );
  }
  if (wait) return copy(wait.label);
  if (step && stepText) return copy(stepText, step.long);

  const holding = node.blockedBy.flatMap((id) => {
    const dep = byId.get(id);
    return dep && dep.outcome !== "done" ? [dep] : [];
  });
  if (node.column === "blocked" && holding.length > 0)
    return copy(
      `waits on ${holding[0]!.title}${holding.length > 1 ? ` +${holding.length - 1}` : ""}`,
    );

  if (node.outcome !== null) {
    const verdict = getVerdictChip(node);
    return copy(
      join(
        node.outcome,
        verdict && (isGateSource(node) ? `gate · ${verdict.label}` : verdict.label),
        node.reportPath !== null && "report",
      ),
    );
  }
  return copy(getActivity(node));
}

/** The first line's right-hand side: a flag chip, else how long since the thread last moved. */
export function rowTrailing(
  node: WorkstreamNode,
  now: number,
): { readonly chip: string; readonly tone: NodeAttention["tone"] } | { readonly age: string } {
  const reason = node.reasons[0];
  if (reason === "error") return { chip: attentionLabel(reason), tone: "error" };
  if (node.pendingApproval) return { chip: "Approval", tone: "warning" };
  if (node.pendingQuestion) return { chip: "Question", tone: "warning" };
  if (reason) return { chip: attentionLabel(reason), tone: "warning" };
  return { age: formatCompactAge(node.lastActivityAt, now) };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** `23:35` today, else `9 Nov 23:35`, in the phone's time zone. */
export function formatWaveTime(at: string, now: number): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return "-";
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return new Date(now).toDateString() === date.toDateString()
    ? time
    : `${date.getDate()} ${date.toLocaleString("en-AU", { month: "short" })} ${time}`;
}

/** A root wave's caption: `23:35 · 1 thread`. */
export const waveCaption = (row: Extract<LaneRow, { kind: "wave" }>, now: number) =>
  join(formatWaveTime(row.at, now), `${row.count} thread${row.count === 1 ? "" : "s"}`);

/** A fold's text: `13:46 · 12 settled · 1 cancelled` on the spine, `2 settled` nested. */
export const foldCaption = (row: Extract<LaneRow, { kind: "fold" }>, now: number) =>
  join(
    row.lane === 0 && formatWaveTime(row.at, now),
    row.settled > 0 && `${row.settled} settled`,
    row.cancelled > 0 && `${row.cancelled} cancelled`,
  );

// Cards

export const CARD_ACTION_LABELS = {
  accept: "Accept done",
  answer: "Answer",
  review: "Review",
  open: "Open",
} satisfies Record<NeedsYouKind, string>;

/** A card's lines under the thread's title. */
export function cardCopy(
  card: NeedsYouCard,
  node: WorkstreamNode,
  now: number,
): { readonly role: string; readonly detail: string } {
  const role = getRoleLabel(node);
  switch (card.kind) {
    case "accept": {
      const last = node.lastOutcome;
      const verdict = last ? describeOutcomeVerdict(last) : null;
      return {
        role,
        detail: join(
          "awaiting your acceptance",
          last && (verdict?.label ?? last.outcome.replaceAll("_", " ")),
          last && formatRelativeAge(last.at, now),
        ),
      };
    }
    case "answer":
      return {
        role,
        detail: join(
          card.question?.title,
          card.question && `asked ${formatRelativeAge(card.question.since, now)}`,
        ),
      };
    case "review":
      return {
        role,
        detail: join(
          "approval required",
          node.pendingApproval && formatRelativeAge(node.pendingApproval.since, now),
        ),
      };
    case "open":
      return { role, detail: getActivity(node) };
  }
}

// Header and sheet

/** `Workstream · 44/51 settled · 3 running · 2 flagged`, with `deadlocked` when it is. */
export const workstreamSubtitle = (rollup: WorkstreamRollup) => {
  const flagged = workstreamBadgeOf(rollup).flagged;
  return join(
    "Workstream",
    `${rollup.plan.columns.done + rollup.plan.columns.cancelled}/${rollup.plan.total} settled`,
    rollup.activity.running > 0 && `${rollup.activity.running} running`,
    flagged > 0 && `${flagged} flagged`,
    rollup.plan.deadlocked !== null && "deadlocked",
  );
};

/** The sheet's last-round line: `round 2 · needs rework ⟲2 · 2 must-fix · 1 nice-to-have`. */
export function lastRoundLine(node: WorkstreamNode, now: number): string | null {
  const last = node.lastOutcome;
  if (!last) return null;
  return join(
    `round ${last.round}`,
    describeOutcomeVerdict(last)?.label ?? last.outcome.replaceAll("_", " "),
    last.counts && `${last.counts.mustFix} must-fix · ${last.counts.niceToHave} nice-to-have`,
    last.synthesised && "report synthesised",
    formatRelativeAge(last.at, now),
  );
}

/** The sheet's model and tool-call line: `cliproxy/claude-opus-5 · 212 tool calls`. */
export const modelLine = (node: WorkstreamNode) =>
  join(
    node.modelSelection.model?.trim() || node.modelSelection.instanceId,
    node.toolCalls > 0 && `${node.toolCalls} tool call${node.toolCalls === 1 ? "" : "s"}`,
  );
