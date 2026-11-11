import {
  DEFAULT_GATE_MAX_ROUNDS,
  type LoomThreadHistoryEntry,
  type LoomThreadOutcome,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ATTENTION_LABELS,
  COLUMN_SHORT_LABELS,
  type ConversationAnchor,
  describeOutcomeVerdict,
  dispatchAnchorOf,
  displayColumnOf,
  getGateWaitLabel,
  getRoleLabel,
  isRunning,
  nodeAttentionOf as sharedNodeAttentionOf,
  type Tone,
  type WorkstreamNode,
  type WorkstreamNodeIndex,
} from "@t3tools/client-runtime/state/loom/workstreamNodes";
import type { WorkstreamAttentionReason } from "@t3tools/client-runtime/state/loom/rollup";
import type { WorkstreamBoardColumn } from "@t3tools/client-runtime/state/loom/workstream";

/**
 * Web's half of the workstream vocabulary: colours (upstream theme tokens only), the 2D graph's
 * label fitting, provider pills and the timeline. The rules every client shares (columns,
 * attention, gate legs, activity, the node menu) live in client-runtime's `workstreamNodes`.
 */

/** A state dot's shape: filled, a ring (not started), or a ring round a dot (waiting on another thread). */
export type StatusShape = "dot" | "ring" | "target";

export interface ColumnStyle {
  /** The state's token as a CSS colour, for dots, SVG strokes and fills. */
  readonly color: string;
  /** `StatusDot`'s shape; on the graph a ring is a dashed border and a target a dotted one. */
  readonly shape: StatusShape;
}

// The one state palette every Loom surface draws from (graph, legend, Active strip, quick facts,
// goal panel, thread mentions). Hue marks what is moving (info running, success done); amber is
// left to attention, what a human or the orchestrator must act on. Resting states differ by shape.
export const COLUMN_STYLES = {
  held: { color: "var(--color-muted-foreground)", shape: "ring" },
  blocked: { color: "var(--color-muted-foreground)", shape: "target" },
  ready: { color: "var(--color-info)", shape: "ring" },
  in_progress: { color: "var(--color-info)", shape: "dot" },
  done: { color: "var(--color-success)", shape: "dot" },
  cancelled: { color: "var(--color-muted-foreground)", shape: "dot" },
} satisfies Record<WorkstreamBoardColumn, ColumnStyle>;

/** A node's style: a gate party parked on the other leg waits like a blocked thread. */
export const nodeStyleOf = (node: WorkstreamNode, byId: WorkstreamNodeIndex): ColumnStyle =>
  COLUMN_STYLES[displayColumnOf(node, byId)];

/** The token colour of a reason, for the graph's attention ring and the goal panel's dot. */
export const ATTENTION_COLORS = {
  error: "var(--color-error)",
  awaiting_acceptance: "var(--color-warning)",
  needs_guidance: "var(--color-warning)",
  awaiting_orchestrator: "var(--color-warning)",
  "brief-needed": "var(--color-warning)",
} satisfies Record<WorkstreamAttentionReason, string>;

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

/** The shared attention with its token colour, for the ring, strip chip and quick facts. */
export function nodeAttentionOf(
  node: Pick<WorkstreamNode, "reasons" | "pendingQuestion" | "pendingApproval">,
): { readonly color: string; readonly label: string; readonly shortLabel: string } | null {
  const attention = sharedNodeAttentionOf(node);
  return attention
    ? {
        color: TONE_COLORS[attention.tone],
        label: attention.label,
        shortLabel: attention.shortLabel,
      }
    : null;
}

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

/** A token colour pulled toward the foreground, for legible tinted text (share per theme in `index.css`). */
export const legibleHue = (color: string) =>
  `color-mix(in srgb, ${color} var(--legible-hue-share), var(--foreground))`;

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

/**
 * The graph node's one worded state, at most 12 characters: the gate leg's
 * short word when in a gate (the full label is on the hover card), else the column.
 */
export function getNodeStateWord(node: WorkstreamNode, byId: WorkstreamNodeIndex): string {
  return getGateWaitLabel(node, byId)?.word ?? COLUMN_SHORT_LABELS[node.column].toLowerCase();
}

/**
 * The node's role strip left of its state word: `Coder · ⚒ 75`, sentence case. The state
 * word and count stay whole and the role yields: at 9.5px the strip's 144px holds ~5.4px
 * per role character and ~5px per state-word character, less 10px for the running dot.
 */
export function getNodeStripLabel(node: WorkstreamNode, stateWord: string): string {
  const count = node.toolCalls > 0 ? ` · ⚒ ${node.toolCalls}` : "";
  const stripChars = (144 - 5 * stateWord.length - (isRunning(node) ? 10 : 0)) / 5.4;
  const roleBudget = Math.max(6, Math.floor(stripChars) - count.length);
  const role = truncateLabel(getRoleLabel(node), roleBudget);
  return `${role.charAt(0).toUpperCase()}${role.slice(1)}${count}`;
}

// Timeline — the sidecar's milestones plus the thread's event history

export interface TimelineRow {
  readonly key: string;
  readonly at: string;
  readonly label: string;
  readonly detail: string | null;
  readonly tone: Tone;
  /** The report this row's submit wrote (outcome rows only), as V1's per-round link. */
  readonly reportPath?: string | null;
  /** "Show me where this happened": the dispatch for the spawn row, else the thread itself. */
  readonly jump?: ConversationAnchor;
}

type RowBody = Pick<TimelineRow, "label" | "detail" | "tone">;

const humanize = (token: string) => token.replaceAll("_", " ");

const attentionLabel = (reason: string) =>
  (ATTENTION_LABELS as Record<string, string>)[reason] ?? humanize(reason);

const ATTENTION_TONES: Record<string, Tone> = {
  error: "error",
  needs_guidance: "warning",
  awaiting_acceptance: "info",
};

/**
 * One history entry's copy: flags (a yield is `awaiting_orchestrator`, and the
 * clear that ends it — usually a clear-all — is its resume), routes, outcomes.
 * `raised` is the set of flags standing before the entry.
 */
function historyRowBody(
  entry: LoomThreadHistoryEntry,
  titleOf: (threadId: ThreadId) => string,
  raised: ReadonlySet<string>,
): RowBody {
  switch (entry.type) {
    case "outcome":
      return outcomeRowBody(entry);
    case "attention-raised":
      return entry.reason === "awaiting_orchestrator"
        ? { label: "Yielded", detail: "handed its turn to the orchestrator", tone: "info" }
        : {
            label: "Flag raised",
            detail: attentionLabel(entry.reason),
            tone: ATTENTION_TONES[entry.reason] ?? "warning",
          };
    case "attention-cleared":
      if (
        (entry.reason ?? "awaiting_orchestrator") === "awaiting_orchestrator" &&
        raised.has("awaiting_orchestrator")
      )
        return { label: "Resumed", detail: "picked back up by the orchestrator", tone: "info" };
      return entry.reason === null
        ? { label: "Flags cleared", detail: null, tone: "neutral" }
        : { label: "Flag cleared", detail: attentionLabel(entry.reason), tone: "neutral" };
    case "route-taken":
      if (entry.kind === "loop")
        return {
          label: `Rework round ${entry.round}`,
          detail: `→ ${titleOf(entry.to)}`,
          tone: "warning",
        };
      return entry.kind === "loop-back"
        ? {
            label: "Back to review",
            detail: `round ${entry.round} → ${titleOf(entry.to)}`,
            tone: "info",
          }
        : { label: "Gate resolved", detail: `→ ${titleOf(entry.to)}`, tone: "success" };
    case "rework-accepted":
      return {
        label: `Rework round ${entry.round}`,
        detail: `from ${titleOf(entry.sourceThreadId)}`,
        tone: "warning",
      };
    case "outcome-set":
      return entry.outcome === null
        ? { label: "Reopened", detail: null, tone: "info" }
        : entry.outcome === "done"
          ? { label: "Done", detail: null, tone: "success" }
          : // loom: cancel reason
            {
              label: "Cancelled",
              detail: entry.reason ? humanize(entry.reason) : null,
              tone: "neutral",
            };
  }
}

function outcomeRowBody(
  outcome: Pick<LoomThreadOutcome, "outcome" | "decision" | "round" | "counts" | "synthesised">,
): RowBody {
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
    label: verdict?.label ?? `Submitted ${humanize(outcome.outcome)}`,
    detail,
    tone: verdict?.tone ?? "info",
  };
}

/**
 * Oldest first: the sidecar's milestones, then the `loom.threadHistory` events. Until the
 * history arrives, the sidecar's latest outcome and plan outcome stand in.
 */
export function buildTimelineRows(
  node: WorkstreamNode,
  titleOf: (threadId: ThreadId) => string,
  history: ReadonlyArray<LoomThreadHistoryEntry> | null = null,
): TimelineRow[] {
  const here = (at: string): ConversationAnchor => ({ threadId: node.id, at });
  const dispatch = dispatchAnchorOf(node);
  const historyRow = (
    key: string,
    at: string,
    body: RowBody,
    reportPath?: string | null,
  ): TimelineRow => ({
    key,
    at,
    ...body,
    ...(reportPath === undefined ? {} : { reportPath }),
    jump: here(at),
  });
  const raised = new Set<string>();
  const historyRows = history?.map((entry) => {
    const row = historyRow(
      `${entry.type}:${entry.eventId ?? entry.at}`,
      entry.at,
      historyRowBody(entry, titleOf, raised),
      entry.type === "outcome" ? entry.reportPath : undefined,
    );
    if (entry.type === "attention-raised") raised.add(entry.reason);
    if (entry.type === "attention-cleared") {
      if (entry.reason === null) raised.clear();
      else raised.delete(entry.reason);
    }
    return row;
  }) ?? [
    ...(node.lastOutcome === null
      ? []
      : [
          historyRow(
            "outcome",
            node.lastOutcome.at,
            outcomeRowBody(node.lastOutcome),
            node.reportPath,
          ),
        ]),
    ...(node.outcomeAt === null || node.outcome === null
      ? []
      : [
          historyRow("outcome-set", node.outcomeAt, {
            label: node.outcome === "done" ? "Done" : "Cancelled",
            detail: null,
            tone: node.outcome === "done" ? "success" : "neutral",
          }),
        ]),
  ];
  const rows: Array<TimelineRow | null> = [
    {
      key: "created",
      at: node.createdAt,
      label: node.parentThreadId === null ? "Created" : "Spawned",
      detail: getRoleLabel(node),
      tone: "neutral",
      ...(dispatch === null ? {} : { jump: dispatch }),
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
      : {
          key: "kickoff",
          at: node.kickoffAt,
          label: "Started",
          detail: null,
          tone: "info",
          jump: here(node.kickoffAt),
        },
    ...historyRows,
  ];
  return rows
    .filter((row): row is TimelineRow => row !== null)
    .toSorted((left, right) => left.at.localeCompare(right.at));
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
