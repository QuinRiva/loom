/**
 * Server-side rendering of the text Loom's tools return, ported from V1's
 * `mcp/workstreamRender.ts` onto the V2 shell and its `workstream` sidecar
 * fields. Pure, so every surface is unit-tested. Plan lanes are gone: a node's
 * status is derived the way the board derives its column.
 *
 * @module mcp/toolkits/workstream/render
 */
import type {
  GoalTaskId,
  LoomThreadShellFields,
  OrchestrationV2ThreadShell,
  ThreadId,
  WorkOutcomeDecision,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { dependenciesSatisfied } from "@t3tools/shared/workstreamStart.loom";

import { agentToolName as t } from "./families.ts";

/** Suffix any warnings onto a confirmation line, one `Warning: …` per line. */
export const appendWarnings = (text: string, warnings: ReadonlyArray<string> = []): string =>
  warnings.length === 0
    ? text
    : [text, ...warnings.map((warning) => `Warning: ${warning}`)].join("\n");

// ---------------------------------------------------------------------------
// Report excerpts (wake and digest messages; P3-22)
// ---------------------------------------------------------------------------

/** Report characters a wake or digest item carries inline; the path carries the rest. */
export const REPORT_EXCERPT_LIMIT = 400;

/** The trimmed report, cut at the limit with an ellipsis; undefined when empty. */
export const boundedExcerpt = (report: string | null | undefined): string | undefined => {
  const trimmed = report?.trim() ?? "";
  if (trimmed.length === 0) return undefined;
  return trimmed.length > REPORT_EXCERPT_LIMIT
    ? `${trimmed.slice(0, REPORT_EXCERPT_LIMIT)}…`
    : trimmed;
};

/** The inline excerpt block appended after a report reference; empty when no report. */
export const formatReportExcerpt = (report: string | null | undefined): string => {
  const excerpt = boundedExcerpt(report);
  if (excerpt === undefined) return "";
  const truncated = (report?.trim().length ?? 0) > REPORT_EXCERPT_LIMIT;
  return truncated
    ? `\n\n${excerpt}\n\n_[excerpt truncated — read the full report via the reference above]_`
    : `\n\n${excerpt}`;
};

// ---------------------------------------------------------------------------
// mcp__t3-code__workstream_list
// ---------------------------------------------------------------------------

/** What the list reads from one thread: the V2 shell joined with its sidecar fields. */
export type WorkstreamListThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "updatedAt" | "latestVisibleMessage" | "pendingRuntimeRequest"
> & { readonly workstream: LoomThreadShellFields };

export interface PresetCatalogueEntry {
  readonly name: string;
  readonly instanceId: string;
  readonly model: string;
  readonly valid: boolean;
}

export interface ProfileSummaryEntry {
  readonly name: string;
  readonly agentic: string;
  readonly usableContext?: number;
  readonly valid: boolean;
  readonly spawnable: boolean;
}

export interface WorkstreamListView {
  readonly callerId: ThreadId;
  /** The caller's whole tree, archived threads included. */
  readonly threads: ReadonlyArray<WorkstreamListThread>;
  readonly sessionPaths?: ReadonlyMap<ThreadId, string>;
  /** Live text of each anchor task; an anchor missing here was deleted. */
  readonly anchorTexts?: ReadonlyMap<GoalTaskId, string>;
  readonly modelPresets?: ReadonlyArray<PresetCatalogueEntry>;
  readonly taskShapes?: ReadonlyArray<string>;
  readonly modelProfiles?: ReadonlyArray<ProfileSummaryEntry>;
}

const TASK_SHAPE_HINTS: Record<string, string> = {
  explore: "open-ended/prototype work, vague objective, plan likely to change",
  thorough:
    "edge cases, migrations, hardening, review gates — missing a real issue is worse than noise",
  mechanical: "bounded, self-contained, high-volume work: extraction, renames, formatting",
};

const INVALID = " [INVALID — points at an unconfigured instance/model; do not use]";

type StatusNode = LoomThreadShellFields & { readonly id: ThreadId };

/**
 * The board column as a word: the outcome when terminal, else held, started
 * (in_progress), waiting on a sibling (blocked), waiting for its brief
 * (needs_brief) or ready.
 */
export const workstreamStatus = (
  node: StatusNode,
  byId: ReadonlyMap<ThreadId, StatusNode>,
): string =>
  node.outcome ??
  (node.held
    ? "held"
    : node.kickoffAt !== null
      ? "in_progress"
      : !dependenciesSatisfied(node, byId)
        ? "blocked"
        : node.parentThreadId !== null && node.kickoffBriefPath === null
          ? "needs_brief"
          : "ready");

/** Stored attention plus the pending-request reasons the shell derives (seam 9). */
const attentionOf = (thread: WorkstreamListThread): ReadonlyArray<string> => [
  ...thread.workstream.attention,
  ...(thread.pendingRuntimeRequest === null
    ? []
    : [
        thread.pendingRuntimeRequest.kind === "user_input" ? "awaiting_input" : "awaiting_approval",
      ]),
];

const firstLine = (text: string) => {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > 160 ? `${line.slice(0, 160)}…` : line;
};

/**
 * The whole workstream as indented text: the lineage tree with each node's
 * status, attention, purpose, anchor, last activity, report, session and
 * waits-on lines, then the model-selection block.
 */
export const renderWorkstreamList = (view: WorkstreamListView): string => {
  const nodes = view.threads.map((thread) => ({ ...thread.workstream, id: thread.id }));
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const parentOf = (thread: WorkstreamListThread) => {
    const parent = thread.workstream.parentThreadId;
    return parent !== null && byId.has(parent) ? parent : null;
  };
  const children = Map.groupBy(view.threads, parentOf);
  const lines = [
    `Workstream: ${view.threads.length} thread(s). Indentation shows lineage (parent above its children).`,
  ];
  const emit = (thread: WorkstreamListThread, depth: number): void => {
    const ws = thread.workstream;
    const pad = "  ".repeat(depth);
    const attention = attentionOf(thread);
    lines.push(
      `${pad}- ${thread.id}${thread.id === view.callerId ? " (you)" : ""} [${ws.role ?? "thread"}] "${thread.title || "(untitled)"}"` +
        (ws.graphKey ? ` key=${ws.graphKey}` : "") +
        ` status=${workstreamStatus(byId.get(thread.id)!, byId)}` +
        (attention.length > 0 ? ` attention=${attention.join("+")}` : ""),
    );
    if (ws.purpose) lines.push(`${pad}    purpose: ${ws.purpose}`);
    if (ws.anchorTaskId) {
      const text = view.anchorTexts?.get(ws.anchorTaskId);
      lines.push(
        `${pad}    anchor: ${ws.anchorTaskId}` +
          (text === undefined ? " (task no longer in the tree)" : ` "${text}"`),
      );
    }
    const preview = thread.latestVisibleMessage ? firstLine(thread.latestVisibleMessage.text) : "";
    lines.push(
      `${pad}    last-activity: ${DateTime.formatIso(thread.updatedAt)}${preview ? ` — ${preview}` : ""}`,
    );
    if (ws.reportPath)
      lines.push(
        `${pad}    report: ${ws.reportPath}` +
          (ws.lastOutcome?.synthesised === true ? " (went quiet; report synthesised)" : ""),
      );
    const sessionPath = view.sessionPaths?.get(thread.id);
    if (sessionPath) lines.push(`${pad}    session: ${sessionPath}`);
    const deps = ws.blockedBy.filter((id) => byId.has(id));
    if (deps.length > 0) lines.push(`${pad}    waits-on: ${deps.join(", ")}`);
    for (const child of children.get(thread.id) ?? []) emit(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) emit(root, 0);

  const presets = view.modelPresets ?? [];
  const shapes = view.taskShapes ?? [];
  const profiles = view.modelProfiles ?? [];
  if (presets.length > 0 || shapes.length > 0 || profiles.length > 0) {
    lines.push("", "Model selection (for spawning children):");
    if (shapes.length > 0) {
      lines.push("  task shapes (pass one as taskShape; the server picks the model):");
      for (const shape of shapes) {
        const hint = TASK_SHAPE_HINTS[shape];
        lines.push(`    - "${shape}"${hint ? ` — ${hint}` : ""}`);
      }
    }
    if (presets.length === 0) lines.push("  presets: none configured");
    else {
      lines.push("  presets (prefer these):");
      for (const preset of presets)
        lines.push(
          `    - "${preset.name}" → ${preset.instanceId} / ${preset.model}${preset.valid ? "" : INVALID}`,
        );
    }
    if (profiles.length > 0) {
      lines.push("  profiles (what taskShape resolves among):");
      for (const profile of profiles)
        lines.push(
          `    - "${profile.name}"` +
            (profile.spawnable
              ? ` [${profile.agentic}]`
              : ` [${profile.agentic} — not spawnable; consultation only]`) +
            (profile.usableContext === undefined ? "" : ` usableContext=${profile.usableContext}`) +
            (profile.valid ? "" : INVALID),
        );
    }
  }
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// mcp__t3-code__workstream_submit echo
// ---------------------------------------------------------------------------

export interface SubmitOutcomeView {
  readonly decision: WorkOutcomeDecision;
  readonly outcome: string;
  readonly round?: number;
  /** For a `loop`: rework (a reviewer's verdict to the coder) or reverify (the coder back). */
  readonly leg?: "rework" | "reverify";
}

/** The routing echo: what the submit did and whether the caller is done. */
export const renderSubmitOutcome = (view: SubmitOutcomeView): string => {
  const withOutcome = `Work submitted with outcome '${view.outcome}'`;
  switch (view.decision) {
    case "terminal":
      return "Work submitted: report recorded, outcome done (dependents released).";
    case "attention":
      return "Work submitted: report recorded and needs_guidance raised — a human has been flagged; you are not done.";
    case "resolve":
      return `${withOutcome}: the review gate RESOLVED — you and your gate counterpart are both done (dependents released).`;
    case "loop":
      return view.leg === "reverify"
        ? `Work submitted: routed to the reviewer for re-verification (round ${view.round}) — you are NOT done yet; the control plane resumes you if further rework is needed.`
        : `${withOutcome}: findings routed to the coder for rework (round ${view.round}) — you are NOT done; you will be resumed to re-verify the rework.`;
    case "cap-breach":
      return `${withOutcome}: the review gate's round cap is exhausted, so you YIELDED to your parent orchestrator — you are NOT done; it decides what happens next.`;
    case "yield":
      return `${withOutcome}: no route matched, so you YIELDED to your parent orchestrator — you are NOT done; it will be woken with your report and decides what happens next.`;
  }
};

// ---------------------------------------------------------------------------
// mcp__t3-code__workstream_scaffold rejections
// ---------------------------------------------------------------------------

/**
 * A graph-validation message (spawn dialect, "Nothing was spawned.") relabelled
 * for one scaffold node with the scaffold's "Nothing was created." suffix.
 */
export const scaffoldNodeRejectionMessage = (nodeKey: string, graphMessage: string): string =>
  `node "${nodeKey}": ${graphMessage.replace(/Nothing was spawned\.$/, "Nothing was created.")}`;

// ---------------------------------------------------------------------------
// mcp__t3-code__consult_thread / mcp__t3-code__notify_thread
// ---------------------------------------------------------------------------

export interface ThreadCandidate {
  readonly threadId: string;
  readonly title?: string | null;
  readonly role?: string | null;
  readonly status?: string | null;
  readonly worktreePath?: string | null;
}

const renderThreadCandidates = (candidates: ReadonlyArray<ThreadCandidate>, tool: string) =>
  candidates.length === 0
    ? "No matching thread was found."
    : [
        `Multiple threads match that name. Confirm which one with the user, then call ${t(tool)} again with its threadId:`,
        ...candidates.map(
          (candidate) =>
            `- ${candidate.title ?? "(untitled)"} — ${candidate.role ?? "thread"}, ${candidate.status ?? "unknown"}` +
            (candidate.worktreePath ? ` [${candidate.worktreePath}]` : "") +
            ` (threadId: ${candidate.threadId})`,
        ),
      ].join("\n");

export const renderConsultCandidates = (candidates: ReadonlyArray<ThreadCandidate>) =>
  renderThreadCandidates(candidates, "consult_thread");

export const renderNotifyCandidates = (candidates: ReadonlyArray<ThreadCandidate>) =>
  renderThreadCandidates(candidates, "notify_thread");

/**
 * What a mcp__t3-code__notify_thread delivery did (steer-or-start): `started` an idle
 * target's turn, `steered` into its running turn, or `queued` behind a turn
 * that cannot take a steer yet. Never claims the recipient acted.
 */
export const renderNotifyDisposition = (input: {
  readonly disposition: "started" | "steered" | "queued";
  readonly targetThreadId: string;
  readonly targetTitle: string;
}): string => {
  const target = `thread «${input.targetTitle}» (${input.targetThreadId})`;
  const noReply = `No reply arrives through ${t("notify_thread")}.`;
  switch (input.disposition) {
    case "started":
      return `Notification delivered to ${target}: its next turn is starting with it. ${noReply}`;
    case "steered":
      return `Notification steered into ${target}'s running turn. ${noReply}`;
    case "queued":
      return `Notification queued for ${target}: it is delivered when its current turn can take it. ${noReply}`;
  }
};
