/**
 * A workstream thread as every client reads it, and what its row says. No colours or layout; each
 * client adds its own. Three axes, never fused: ONE derived plan column (`deriveBoardColumn`),
 * with activity and attention (stored ∪ derived reasons) as overlays.
 */
import {
  type ContextMenuItem,
  DEFAULT_GATE_MAX_ROUNDS,
  type LoomThreadShellFields,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { gateSourceFor, isWaitingInGate } from "@t3tools/shared/workstreamGraph";
import * as DateTime from "effect/DateTime";

import { attentionReasonsOf, pendingQuestionOf, type WorkstreamAttentionReason } from "./rollup.ts";
import {
  deriveBoardColumn,
  type WorkstreamBoardColumn,
  type WorkstreamIndex,
  workstreamIndexOf,
} from "./workstream.ts";

/**
 * One workstream thread as every surface reads it: the sidecar's fields, the
 * V2 shell's identity/runtime fields, and the derived column and attention.
 * `parentThreadId` is the V2 lineage parent (authoritative).
 */
export interface WorkstreamNode extends LoomThreadShellFields {
  readonly id: ThreadId;
  readonly title: string;
  readonly createdAt: string;
  readonly modelSelection: ModelSelection;
  readonly column: WorkstreamBoardColumn;
  /** Stored ∪ derived attention reasons, highest priority first. */
  readonly reasons: ReadonlyArray<WorkstreamAttentionReason>;
  readonly activity: OrchestrationV2ThreadShell["activityRunStatus"];
  /** The question the thread waits on (S4), or null. */
  readonly pendingQuestion: ReturnType<typeof pendingQuestionOf>;
  /** Since when the thread waits on an approval (upstream's `hasPendingApprovals` kinds), or null. */
  readonly pendingApproval: { readonly since: string } | null;
  /** The latest visible message's text (`shell.latestVisibleMessage`). */
  readonly preview: string | null;
  readonly lastActivityAt: string;
  readonly archived: boolean;
}

export type WorkstreamNodeIndex = ReadonlyMap<ThreadId, WorkstreamNode>;

const iso = (value: DateTime.Utc) => DateTime.formatIso(value);

/**
 * Every sidecar-bearing shell as a `WorkstreamNode`. Pass live AND archived
 * shells (DL-211/DL-422): the dependency index must see an archived unfinished
 * dependency (still gates) and an archived done one (releases). A caller
 * building nodes for a subset of the shells it holds passes the index of all.
 */
export function buildWorkstreamNodes(
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  startIndex: WorkstreamIndex = workstreamIndexOf(shells),
): WorkstreamNodeIndex {
  return new Map(
    shells.flatMap((shell) => {
      const workstream = shell.workstream;
      if (workstream === undefined) return [];
      const lastActivity =
        shell.latestRunCompletedAt ??
        shell.latestRunStartedAt ??
        shell.latestVisibleMessage?.updatedAt ??
        shell.updatedAt;
      const node: WorkstreamNode = {
        ...workstream,
        id: shell.id,
        parentThreadId: shell.lineage.parentThreadId,
        title: shell.title,
        createdAt: iso(shell.createdAt),
        modelSelection: shell.modelSelection,
        column: deriveBoardColumn(workstream, startIndex),
        reasons: attentionReasonsOf(shell, startIndex),
        activity: shell.activityRunStatus ?? null,
        pendingQuestion: pendingQuestionOf(shell),
        pendingApproval:
          shell.pendingRuntimeRequest &&
          shell.pendingRuntimeRequest.kind !== "user_input" &&
          shell.pendingRuntimeRequest.kind !== "auth_refresh"
            ? { since: iso(shell.pendingRuntimeRequest.createdAt) }
            : null,
        preview: shell.latestVisibleMessage?.text.trim() || null,
        lastActivityAt: iso(lastActivity),
        archived: shell.archivedAt !== null,
      };
      return [[shell.id, node] as const];
    }),
  );
}

/** The live (non-archived) threads of `nodes`, oldest first. */
export const liveNodes = (nodes: Iterable<WorkstreamNode>) =>
  [...nodes]
    .filter((node) => !node.archived)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));

/** Settled cards recede on the graph; a query satellite also recedes once archived (superseded). */
export const isReceded = (node: Pick<WorkstreamNode, "column" | "archived">) =>
  node.column === "done" || node.column === "cancelled" || node.archived;

/** A running turn (the activity axis): preparing, starting or running. */
export const isRunning = (node: Pick<WorkstreamNode, "activity">) =>
  node.activity === "preparing" || node.activity === "starting" || node.activity === "running";

// Columns

export const COLUMN_ORDER: ReadonlyArray<WorkstreamBoardColumn> = [
  "held",
  "blocked",
  "ready",
  "in_progress",
  "done",
  "cancelled",
];

export const COLUMN_LABELS = {
  held: "Staged",
  blocked: "Blocked",
  ready: "Ready",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
} satisfies Record<WorkstreamBoardColumn, string>;

export const COLUMN_SHORT_LABELS = {
  held: "Staged",
  blocked: "Blocked",
  ready: "Ready",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
} satisfies Record<WorkstreamBoardColumn, string>;

/** The column a node is drawn in: a gate party parked on the other leg waits like a blocked thread. */
export const displayColumnOf = (
  node: WorkstreamNode,
  byId: WorkstreamNodeIndex,
): WorkstreamBoardColumn =>
  getGateWaitLabel(node, byId)?.active === false ? "blocked" : node.column;

// Attention

export const ATTENTION_LABELS = {
  error: "Error / stalled",
  awaiting_acceptance: "Awaiting acceptance",
  needs_guidance: "Needs guidance",
  awaiting_orchestrator: "Yielded · needs orchestrator",
  "brief-needed": "Brief needed",
} satisfies Record<WorkstreamAttentionReason, string>;

/** The hover card's status-line form: short, so the line's figures never truncate. */
const ATTENTION_SHORT_LABELS = {
  error: "stalled",
  awaiting_acceptance: "needs acceptance",
  needs_guidance: "needs guidance",
  awaiting_orchestrator: "yielded",
  "brief-needed": "needs brief",
} satisfies Record<WorkstreamAttentionReason, string>;

/** A thread's own pending request, named like the attention reasons. */
export const PENDING_REQUEST_LABELS = {
  awaiting_approval: "Awaiting approval",
  awaiting_input: "Awaiting input",
};

export type Tone = "neutral" | "info" | "success" | "warning" | "error";

export interface NodeAttention {
  readonly tone: Extract<Tone, "warning" | "error">;
  readonly label: string;
  readonly shortLabel: string;
}

/**
 * What a node's ring, strip chip and quick facts show, or null. The node's own
 * pending approval or question outranks every reason but `error`, as upstream's
 * row pills do. It is the node's own state, not a rollup reason: upstream
 * carries it to the ancestors (DL-1270), so it never enters `reasons`.
 */
export function nodeAttentionOf(
  node: Pick<WorkstreamNode, "reasons" | "pendingQuestion" | "pendingApproval">,
): NodeAttention | null {
  const reason = node.reasons[0];
  if (reason !== "error" && node.pendingApproval)
    return {
      tone: "warning",
      label: PENDING_REQUEST_LABELS.awaiting_approval,
      shortLabel: "needs approval",
    };
  if (reason !== "error" && node.pendingQuestion)
    return {
      tone: "warning",
      label: PENDING_REQUEST_LABELS.awaiting_input,
      shortLabel: "needs input",
    };
  return reason
    ? {
        tone: reason === "error" ? "error" : "warning",
        label: ATTENTION_LABELS[reason],
        shortLabel: ATTENTION_SHORT_LABELS[reason],
      }
    : null;
}

// Review gates — the verdict chip, the gate-leg label, the loop round cap

export interface Verdict {
  readonly label: string;
  readonly tone: Tone;
}

/**
 * A submitted outcome's verdict: `clean` / `fixed inline` success, `needs
 * rework ⟲n` warning, a yield or cap-breach info. Null for an outcome with no
 * verdict vocabulary. The one source the card chip, graph pill and timeline
 * share.
 */
export function describeOutcomeVerdict(outcome: {
  readonly outcome: string;
  readonly decision: string;
  readonly round: number;
}): Verdict | null {
  if (outcome.decision === "yield" || outcome.decision === "cap-breach")
    return { label: `${outcome.outcome.replaceAll("_", " ")} · yielded`, tone: "info" };
  if (outcome.outcome === "clean") return { label: "clean", tone: "success" };
  if (outcome.outcome === "fixed_inline") return { label: "fixed inline", tone: "success" };
  if (outcome.outcome === "needs_rework")
    return { label: `needs rework ⟲${outcome.round}`, tone: "warning" };
  return null;
}

/** A review gate's source: a thread with a loop route. */
export const isGateSource = (node: Pick<WorkstreamNode, "routes">) =>
  node.routes.some((route) => route.kind === "loop");

/** The gate source's verdict chip from its last submitted outcome. */
export function getVerdictChip(node: WorkstreamNode): Verdict | null {
  return node.lastOutcome && isGateSource(node) ? describeOutcomeVerdict(node.lastOutcome) : null;
}

/** The loop-round cap on a gate source's loop route. */
export const getGateLoopCap = (node: Pick<WorkstreamNode, "routes">) =>
  node.routes.find((route) => route.kind === "loop")?.maxRounds ?? DEFAULT_GATE_MAX_ROUNDS;

export interface GateWait {
  readonly label: string;
  /** The graph node's short state word: `reworking ⟲2`, `reviewing ⟲2`, `waiting ⟲2`. */
  readonly word: string;
  /** True for a leg the party holds now; false for a parked wait. */
  readonly active: boolean;
}

/**
 * The gate-leg label. The target holding an open rework round (`pendingRework`)
 * is reworking it; a running source mid-loop is re-reviewing. Otherwise the
 * shared `isWaitingInGate` names the parked party: the source waiting on
 * rework, the target awaiting re-review.
 */
export function getGateWaitLabel(node: WorkstreamNode, byId: WorkstreamNodeIndex): GateWait | null {
  if (node.outcome !== null) return null;
  const source = isGateSource(node) ? null : gateSourceFor(node.id, [...byId.values()]);
  if (node.pendingRework && source)
    return {
      label: `reworking round ${source.gateRounds}`,
      word: `reworking ⟲${source.gateRounds}`,
      active: true,
    };
  if (isRunning(node) && isGateSource(node) && node.gateRounds > 0)
    return {
      label: `re-reviewing round ${node.gateRounds}`,
      word: `reviewing ⟲${node.gateRounds}`,
      active: true,
    };
  if (!isWaitingInGate(node, byId)) return null;
  return {
    label: isGateSource(node) ? "waiting on rework" : "awaiting re-review",
    word: `waiting ⟲${(source ?? node).gateRounds}`,
    active: false,
  };
}

// Card copy

export const getRoleLabel = (node: Pick<WorkstreamNode, "role" | "parentThreadId">) =>
  node.role?.trim() || (node.parentThreadId === null ? "root" : "sub-thread");

export const getPurpose = (node: Pick<WorkstreamNode, "purpose">) =>
  node.purpose?.trim() || "No purpose captured.";

/** One short phrase for what the thread is doing, attention first. */
export function getActivity(node: WorkstreamNode): string {
  const reason = node.reasons[0];
  if (reason === "error") return "stalled, needs you";
  // Which question waits and for how long (S4), so the card says whether it
  // is a five-second pick or needs real thought. The thread's own state, not
  // an attention reason: upstream rolls it up to the ancestors.
  if (node.pendingQuestion)
    return [
      "waiting for your input",
      node.pendingQuestion.header,
      formatCompactAge(node.pendingQuestion.since),
    ]
      .filter(Boolean)
      .join(" · ");
  if (node.pendingApproval)
    return ["approval required", formatCompactAge(node.pendingApproval.since)].join(" · ");
  if (reason === "needs_guidance") return "stuck, needs guidance";
  if (reason === "awaiting_acceptance") return "awaiting your acceptance";
  if (reason === "awaiting_orchestrator")
    return node.lastOutcome?.synthesised
      ? "went quiet; report synthesised"
      : "yielded to the orchestrator";
  if (reason === "brief-needed") return "no kickoff brief yet";
  if (node.column === "blocked") return "waiting on dependencies";
  if (node.column === "held") return "staged, waits for its launch";
  if (isRunning(node)) return "live turn in progress";
  if (node.activity === "waiting") return "waiting";
  return COLUMN_SHORT_LABELS[node.column].toLowerCase();
}

/** A place in a thread's conversation: the latest row at or before `at`. */
export interface ConversationAnchor {
  readonly threadId: ThreadId;
  readonly at: string;
  /** Land on the latest `consult_thread` card at or before `at` (a consult is
   * recorded when it answers, so `at` trails the card's start). */
  readonly consult?: true;
}

/** A thread's dispatch site: the moment its parent spawned it, in the parent's conversation. */
export const dispatchAnchorOf = (
  node: Pick<WorkstreamNode, "parentThreadId" | "createdAt">,
): ConversationAnchor | null =>
  node.parentThreadId === null ? null : { threadId: node.parentThreadId, at: node.createdAt };

const ageSeconds = (at: string, now: number) => {
  const timestamp = Date.parse(at);
  return Number.isNaN(timestamp) ? null : Math.max(0, Math.floor((now - timestamp) / 1000));
};

/**
 * `23s` / `4m` / `3h` / `2d`; `—` when unparseable. Pass `now` from a clock
 * hook (`useNowMinute`) where the age must tick: the React Compiler caches
 * a render that reads `Date.now()` only behind the call.
 */
// @effect-diagnostics-next-line globalDate:off
export function formatCompactAge(at: string, now = Date.now()): string {
  const seconds = ageSeconds(at, now);
  if (seconds === null) return "-";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

// @effect-diagnostics-next-line globalDate:off
export const formatRelativeAge = (at: string, now = Date.now()) => {
  const compact = formatCompactAge(at, now);
  return compact === "-" ? compact : `${compact} ago`;
};

// Current step — the tool in flight, or the model between tool calls

/** A step this long reads amber: the signature of a stalled tool call or model request. */
export const LONG_STEP_MS = 5 * 60_000;

export interface WorkstreamStep {
  /** The tool's name, or `thinking` between tool calls. */
  readonly label: string;
  readonly since: string;
  readonly detail: string | null;
  readonly long: boolean;
}

/**
 * What a running thread is doing now. Null when nothing runs or a flag takes
 * the activity line — attention always wins. Cards pass a ticking `now`
 * (`useNowMinute`) so `long` advances between shell deltas.
 */
// @effect-diagnostics-next-line globalDate:off
export function getStep(node: WorkstreamNode, now = Date.now()): WorkstreamStep | null {
  const step = node.activeStep;
  if (step === null || !isRunning(node) || node.reasons.length > 0) return null;
  return {
    label: step.kind === "model" ? "thinking" : (step.title ?? "tool"),
    since: step.since,
    detail: step.detail,
    long: now - Date.parse(step.since) >= LONG_STEP_MS,
  };
}

/** A card's step duration (`17m`): null under a minute, since cards tick per minute. */
export function formatStepAge(since: string, now: number): string | null {
  const seconds = ageSeconds(since, now);
  return seconds === null || seconds < 60 ? null : formatCompactAge(since, now);
}

// Controls — the node menu (outcome replaces V1's lane select)

export type WorkstreamNodeMenuAction =
  | "open"
  | "dispatch"
  | "history"
  | "report"
  | "outcome:done"
  | "outcome:cancelled"
  | "outcome:reopen"
  | "clear-flags"
  | "stop";

/**
 * The graph node's right-click menu: navigation first, then the outcome
 * controls, then flags and stop. Items are omitted (not disabled) when they
 * cannot act.
 */
export function buildNodeContextMenuItems(
  node: WorkstreamNode,
): ContextMenuItem<WorkstreamNodeMenuAction>[] {
  return [
    { id: "open", label: "Open thread" },
    ...(node.parentThreadId === null
      ? []
      : [{ id: "dispatch" as const, label: "Show where it was dispatched" }]),
    { id: "history", label: "View timeline" },
    ...(node.reportPath === null ? [] : [{ id: "report" as const, label: "Open report" }]),
    // Each outcome with its reverse: accept done or cancel an open thread, reopen a settled one.
    ...(node.outcome === null
      ? [
          { id: "outcome:done" as const, label: "Accept done" },
          { id: "outcome:cancelled" as const, label: "Cancel" },
        ]
      : [{ id: "outcome:reopen" as const, label: "Reopen" }]),
    ...(node.attention.length > 0 ? [{ id: "clear-flags" as const, label: "Clear flags" }] : []),
    ...(isRunning(node) ? [{ id: "stop" as const, label: "Stop", destructive: true }] : []),
  ];
}
