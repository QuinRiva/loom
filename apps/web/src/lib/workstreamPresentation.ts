import {
  type ContextMenuItem,
  DEFAULT_GATE_MAX_ROUNDS,
  type LoomOutcome,
  type LoomThreadOutcome,
  type LoomThreadShellFields,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import {
  attentionReasonsOf,
  type WorkstreamAttentionReason,
} from "@t3tools/client-runtime/state/loom/rollup";
import {
  deriveBoardColumn,
  type WorkstreamBoardColumn,
  workstreamIndexOf,
} from "@t3tools/client-runtime/state/loom/workstream";
import { gateSourceFor, isWaitingInGate } from "@t3tools/shared/workstreamGraph";
import * as DateTime from "effect/DateTime";

/**
 * Pure presentation logic for the Workstream board, graph, timeline, quick
 * facts and active strip (Phase 3 track 3d-2: the V1 module re-hung on the V2
 * shell). JSX-free so the lazily-loaded graph chunk and the board share one
 * vocabulary.
 *
 * Three axes, never fused: a thread sits in ONE derived plan column
 * (`deriveBoardColumn`); activity (`activityRunStatus`) and attention (stored ∪
 * derived reasons) are overlays. Colours are upstream theme tokens only.
 */

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
 * dependency (still gates) and an archived done one (releases).
 */
export function buildWorkstreamNodes(
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
): WorkstreamNodeIndex {
  const startIndex = workstreamIndexOf(shells);
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
        reasons: attentionReasonsOf(shell),
        activity: shell.activityRunStatus ?? null,
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
    .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));

/**
 * The board's members for `threadId`: its lineage children plus the staged
 * (held) roots that continue or fork it — `mcp__t3-code__goal_continue` and `mcp__t3-code__thread_fork`,
 * the two writers of `held` (P3-19b). Staged roots have no parent, so the held
 * column would otherwise never show them.
 */
export const boardMembersOf = (threadId: ThreadId, nodes: WorkstreamNodeIndex) =>
  liveNodes(nodes.values()).filter(
    (node) =>
      node.parentThreadId === threadId ||
      (node.parentThreadId === null &&
        node.id !== threadId &&
        (node.continuesThreadId === threadId || node.forkFromThreadId === threadId)),
  );

/** A running turn (the activity axis): preparing, starting or running. */
export const isRunning = (node: Pick<WorkstreamNode, "activity">) =>
  node.activity === "preparing" || node.activity === "starting" || node.activity === "running";

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export const COLUMN_ORDER: ReadonlyArray<WorkstreamBoardColumn> = [
  "held",
  "blocked",
  "ready",
  "in_progress",
  "done",
  "cancelled",
];

export const COLUMN_LABELS = {
  held: "Held · staged",
  blocked: "Blocked",
  ready: "Ready",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
} satisfies Record<WorkstreamBoardColumn, string>;

export const COLUMN_SHORT_LABELS = {
  held: "Held",
  blocked: "Blocked",
  ready: "Ready",
  in_progress: "In progress",
  done: "Done",
  cancelled: "Cancelled",
} satisfies Record<WorkstreamBoardColumn, string>;

export interface ColumnStyle {
  /** Card left rule. */
  readonly ruleClass: string;
  readonly dotClass: string;
  readonly textClass: string;
  /** The same token as a CSS colour, for SVG strokes and fills. */
  readonly color: string;
}

// Upstream theme tokens only: held/cancelled are neutral, blocked waits amber,
// ready is info, in-progress the primary accent, done success.
export const COLUMN_STYLES = {
  held: {
    ruleClass: "border-l-muted-foreground/60",
    dotClass: "bg-muted-foreground/60",
    textClass: "text-muted-foreground",
    color: "var(--color-muted-foreground)",
  },
  blocked: {
    ruleClass: "border-l-warning",
    dotClass: "bg-warning",
    textClass: "text-warning-foreground",
    color: "var(--color-warning)",
  },
  ready: {
    ruleClass: "border-l-info",
    dotClass: "bg-info",
    textClass: "text-info-foreground",
    color: "var(--color-info)",
  },
  in_progress: {
    ruleClass: "border-l-primary",
    dotClass: "bg-primary",
    textClass: "text-primary",
    color: "var(--color-primary)",
  },
  done: {
    ruleClass: "border-l-success",
    dotClass: "bg-success",
    textClass: "text-success-foreground",
    color: "var(--color-success)",
  },
  cancelled: {
    ruleClass: "border-l-border",
    dotClass: "bg-muted-foreground/40",
    textClass: "text-muted-foreground",
    color: "var(--color-muted-foreground)",
  },
} satisfies Record<WorkstreamBoardColumn, ColumnStyle>;

export function groupByColumn(nodes: ReadonlyArray<WorkstreamNode>) {
  const groups: Record<WorkstreamBoardColumn, WorkstreamNode[]> = {
    held: [],
    blocked: [],
    ready: [],
    in_progress: [],
    done: [],
    cancelled: [],
  };
  for (const node of nodes) groups[node.column].push(node);
  return groups;
}

// ---------------------------------------------------------------------------
// Attention
// ---------------------------------------------------------------------------

export const ATTENTION_LABELS = {
  error: "Error / stalled",
  awaiting_approval: "Awaiting approval",
  awaiting_input: "Awaiting input",
  awaiting_acceptance: "Awaiting acceptance",
  needs_guidance: "Needs guidance",
  awaiting_orchestrator: "Yielded · needs orchestrator",
  "brief-needed": "Brief needed",
} satisfies Record<WorkstreamAttentionReason, string>;

/** Badge variant per reason (`components/ui/badge`). */
export const ATTENTION_BADGE_VARIANTS = {
  error: "error",
  awaiting_approval: "warning",
  awaiting_input: "warning",
  awaiting_acceptance: "info",
  needs_guidance: "warning",
  awaiting_orchestrator: "secondary",
  "brief-needed": "outline",
} as const satisfies Record<WorkstreamAttentionReason, string>;

/** The token colour of a reason, for the graph's attention ring. */
export const ATTENTION_COLORS = {
  error: "var(--color-error)",
  awaiting_approval: "var(--color-warning)",
  awaiting_input: "var(--color-warning)",
  awaiting_acceptance: "var(--color-info)",
  needs_guidance: "var(--color-warning)",
  awaiting_orchestrator: "var(--color-info)",
  "brief-needed": "var(--color-muted-foreground)",
} satisfies Record<WorkstreamAttentionReason, string>;

// ---------------------------------------------------------------------------
// Review gates — the verdict chip, the gate-leg label, the loop round cap
// ---------------------------------------------------------------------------

export type Tone = "neutral" | "info" | "success" | "warning" | "error";

export const TONE_COLORS = {
  neutral: "var(--color-muted-foreground)",
  info: "var(--color-info)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  error: "var(--color-error)",
} satisfies Record<Tone, string>;

export const TONE_DOT_CLASSES = {
  neutral: "bg-muted-foreground/60",
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
} satisfies Record<Tone, string>;

/** Badge variant per tone. */
export const TONE_BADGE_VARIANTS = {
  neutral: "secondary",
  info: "info",
  success: "success",
  warning: "warning",
  error: "error",
} as const satisfies Record<Tone, string>;

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
    return { label: `reworking round ${source.gateRounds}`, active: true };
  if (isRunning(node) && isGateSource(node) && node.gateRounds > 0)
    return { label: `re-reviewing round ${node.gateRounds}`, active: true };
  if (!isWaitingInGate(node, byId)) return null;
  return { label: isGateSource(node) ? "waiting on rework" : "awaiting re-review", active: false };
}

// ---------------------------------------------------------------------------
// Card copy
// ---------------------------------------------------------------------------

export const getRoleLabel = (node: Pick<WorkstreamNode, "role" | "parentThreadId">) =>
  node.role?.trim() || (node.parentThreadId === null ? "root" : "sub-thread");

export const getPurpose = (node: Pick<WorkstreamNode, "purpose">) =>
  node.purpose?.trim() || "No purpose captured.";

/** One short phrase for what the thread is doing, attention first. */
export function getActivity(node: WorkstreamNode): string {
  const reason = node.reasons[0];
  if (reason === "awaiting_input") return "waiting for your input";
  if (reason === "awaiting_approval") return "approval required";
  if (reason === "error") return "stalled — needs you";
  if (reason === "needs_guidance") return "stuck — needs guidance";
  if (reason === "awaiting_acceptance") return "awaiting your acceptance";
  if (reason === "awaiting_orchestrator")
    return node.lastOutcome?.synthesised
      ? "went quiet; report synthesised"
      : "yielded to the orchestrator";
  if (reason === "brief-needed") return "no kickoff brief yet";
  if (node.column === "blocked") return "waiting on dependencies";
  if (node.column === "held") return "staged — waits for its launch";
  if (isRunning(node)) return "live turn in progress";
  if (node.activity === "waiting") return "waiting";
  return COLUMN_SHORT_LABELS[node.column].toLowerCase();
}

const ageSeconds = (at: string) => {
  const timestamp = Date.parse(at);
  return Number.isNaN(timestamp) ? null : Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
};

/** `23s` / `4m` / `3h` / `2d`; `—` when unparseable. */
export function formatCompactAge(at: string): string {
  const seconds = ageSeconds(at);
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

export const formatRelativeAge = (at: string) => {
  const compact = formatCompactAge(at);
  return compact === "—" ? compact : `${compact} ago`;
};

/**
 * A model selection as pill parts: the provider is the model slug's prefix
 * (`cliproxy/opus` → `cliproxy`), never the harness instance id.
 */
export function getProviderModelParts(selection: ModelSelection): {
  provider: string | null;
  model: string;
} {
  const slug = selection.model?.trim() ?? "";
  const slash = slug.indexOf("/");
  if (slash > 0) return { provider: slug.slice(0, slash), model: slug.slice(slash + 1) || slug };
  return { provider: null, model: slug || selection.instanceId };
}

const PROVIDER_TINTS = [
  "var(--color-info)",
  "var(--color-success)",
  "var(--color-warning)",
  "var(--color-primary)",
  "var(--color-error)",
] as const;

/** A stable theme-token tint per provider slug. */
export function getProviderTint(provider: string): string {
  let hash = 0;
  for (const char of provider.trim().toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PROVIDER_TINTS[Math.abs(hash) % PROVIDER_TINTS.length]!;
}

/** A token colour pulled toward the foreground, for legible tinted text. */
export const legibleHue = (color: string) => `color-mix(in srgb, ${color} 60%, var(--foreground))`;

export function truncateLabel(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

/**
 * Greedy word-wrap for the graph card's title: at most `maxLines` lines, a
 * word longer than a line hard-truncated, an ellipsis when it overflows.
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

/** The graph node's one worded state: the gate leg when in a gate, else the column. */
export function getNodeStateWord(node: WorkstreamNode, byId: WorkstreamNodeIndex): string {
  const gate = getGateWaitLabel(node, byId);
  if (gate) return gate.label.replace(" round ", " ⟲");
  return COLUMN_SHORT_LABELS[node.column].toLowerCase();
}

// ---------------------------------------------------------------------------
// Controls — outcome (replaces V1's lane select) and the node menu
// ---------------------------------------------------------------------------

export interface OutcomeAction {
  readonly outcome: LoomOutcome | null;
  readonly label: string;
  readonly hint: string;
}

/**
 * The outcome controls a thread offers, each with its reverse: an open thread
 * can be accepted done or cancelled; a done or cancelled one can be reopened.
 */
export function outcomeActionsOf(node: Pick<WorkstreamNode, "outcome">): OutcomeAction[] {
  if (node.outcome !== null)
    return [
      {
        outcome: null,
        label: "Reopen",
        hint: `Clear the ${node.outcome} outcome so the thread is open again`,
      },
    ];
  return [
    {
      outcome: "done",
      label: "Accept done",
      hint: "Record this thread as done; it releases dependents",
    },
    { outcome: "cancelled", label: "Cancel", hint: "Record this thread as cancelled" },
  ];
}

export type WorkstreamNodeMenuAction =
  | "open"
  | "parent"
  | "history"
  | "report"
  | "outcome:done"
  | "outcome:cancelled"
  | "outcome:reopen"
  | "clear-flags"
  | "stop";

const OUTCOME_MENU_IDS = {
  done: "outcome:done",
  cancelled: "outcome:cancelled",
  reopen: "outcome:reopen",
} as const;

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
    ...(node.parentThreadId === null ? [] : [{ id: "parent" as const, label: "Open parent" }]),
    { id: "history", label: "View timeline" },
    ...(node.reportPath === null ? [] : [{ id: "report" as const, label: "Open report" }]),
    ...outcomeActionsOf(node).map((action) => ({
      id: OUTCOME_MENU_IDS[action.outcome ?? "reopen"],
      label: action.label,
    })),
    ...(node.attention.length > 0 ? [{ id: "clear-flags" as const, label: "Clear flags" }] : []),
    ...(isRunning(node) ? [{ id: "stop" as const, label: "Stop", destructive: true }] : []),
  ];
}

// ---------------------------------------------------------------------------
// Timeline — the journey the sidecar records, plus every submitted outcome
// ---------------------------------------------------------------------------

export interface TimelineRow {
  readonly key: string;
  readonly at: string;
  readonly label: string;
  readonly detail: string | null;
  readonly tone: Tone;
  /** The report this row's submit wrote (outcome rows only), as V1's per-round link. */
  readonly reportPath?: string | null;
}

/**
 * A thread's timeline: from its sidecar, created, held, dependencies set,
 * kicked off and the plan outcome (the latest of each — milestones, not a
 * log); and one row per submitted outcome (verdict, round, counts) linking the
 * report that submit wrote. `outcomes` is the thread's outcome history
 * (`loom.threadOutcomes`); until it arrives, the sidecar's latest outcome
 * stands in with the sidecar's report, which is that submit's. Oldest first.
 */
export function buildTimelineRows(
  node: WorkstreamNode,
  titleOf: (threadId: ThreadId) => string,
  outcomes: ReadonlyArray<LoomThreadOutcome> | null = null,
): TimelineRow[] {
  const rows: Array<TimelineRow | null> = [
    {
      key: "created",
      at: node.createdAt,
      label: node.parentThreadId === null ? "Created" : "Spawned",
      detail: getRoleLabel(node),
      tone: "neutral",
    },
    node.heldSince === null
      ? null
      : { key: "held", at: node.heldSince, label: "Held", detail: "staged", tone: "neutral" },
    node.dependenciesSince === null
      ? null
      : {
          key: "dependencies",
          at: node.dependenciesSince,
          label: node.blockedBy.length === 0 ? "Dependencies cleared" : "Waits on",
          detail: node.blockedBy.map(titleOf).join(", ") || null,
          tone: "neutral",
        },
    node.kickoffAt === null
      ? null
      : { key: "kickoff", at: node.kickoffAt, label: "Started", detail: null, tone: "info" },
    ...(
      outcomes ??
      (node.lastOutcome === null ? [] : [{ ...node.lastOutcome, reportPath: node.reportPath }])
    ).map(outcomeRow),
    node.outcomeAt === null || node.outcome === null
      ? null
      : {
          key: "outcome",
          at: node.outcomeAt,
          label: node.outcome === "done" ? "Done" : "Cancelled",
          detail: null,
          tone: node.outcome === "done" ? "success" : "neutral",
        },
  ];
  return rows
    .filter((row): row is TimelineRow => row !== null)
    .toSorted((left, right) => left.at.localeCompare(right.at));
}

function outcomeRow(outcome: LoomThreadOutcome): TimelineRow {
  const verdict = describeOutcomeVerdict(outcome);
  const detail = [
    `round ${outcome.round}`,
    outcome.counts
      ? `${outcome.counts.mustFix} must-fix · ${outcome.counts.niceToHave} nice-to-have`
      : null,
    outcome.synthesised ? "report synthesised" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    key: `outcome:${outcome.eventId ?? outcome.at}`,
    at: outcome.at,
    label: verdict?.label ?? `Submitted ${outcome.outcome.replaceAll("_", " ")}`,
    detail,
    tone: verdict?.tone ?? "info",
    reportPath: outcome.reportPath,
  };
}

/** A route as one line: `loop → Parser (needs rework, ≤2 rounds)`. */
export function describeRoute(
  route: WorkstreamNode["routes"][number],
  titleOf: (threadId: ThreadId) => string,
): string {
  const on = route.on.map((token) => token.replaceAll("_", " ")).join(" / ");
  if (route.kind === "resolve") return `resolves on ${on}`;
  const target = route.to === undefined ? "?" : titleOf(route.to);
  return `loops to ${target} on ${on} (≤${route.maxRounds ?? DEFAULT_GATE_MAX_ROUNDS} rounds)`;
}
