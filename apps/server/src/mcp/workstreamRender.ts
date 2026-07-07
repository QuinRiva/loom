// LOOM-ONLY. Server-side rendering for the provider-tool text surface. The pi
// extension is a dumb POST-and-print shim; every handler returns a `rendered`
// string carrying exactly the text the extension used to build client-side.
// These are pure functions so the rendering (previously reachable only through
// a live MCP session) is unit-testable. The output must be character-identical
// to the historical extension output.

import type { ModelCatalogueEntry, PresetCatalogueEntry } from "./WorkstreamSpawnHttp.ts";

/** Suffix any warnings onto a confirmation line, one `Warning: …` per line. */
export const appendWarnings = (
  text: string,
  warnings: ReadonlyArray<string> | undefined,
): string => {
  const list = Array.isArray(warnings) ? warnings : [];
  return list.length === 0
    ? text
    : text + "\n" + list.map((warning) => "Warning: " + warning).join("\n");
};

export interface WorkstreamListNode {
  readonly id: string;
  readonly parentThreadId: string | null;
  readonly role: string | null;
  readonly title: string | null;
  readonly planLane: string;
  readonly attention?: ReadonlyArray<string>;
  readonly lastActivityAt?: string | null;
  readonly lastActivitySummary?: string | null;
  readonly reportPath?: string | null;
  readonly sessionPath?: string | null;
}

export interface WorkstreamListView {
  readonly callerId?: string;
  readonly nodes?: ReadonlyArray<WorkstreamListNode>;
  readonly waitsOnEdges?: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly modelCatalogue?: ReadonlyArray<ModelCatalogueEntry>;
  readonly modelPresets?: ReadonlyArray<PresetCatalogueEntry>;
}

/**
 * The whole workstream graph as indented text: lineage tree, per-node activity /
 * report / session / waits-on lines, then the model catalogue + presets block.
 * This is the untestable-logic centrepiece the tool-bridge collapse exists for.
 */
export const renderWorkstreamList = (view: WorkstreamListView): string => {
  const nodes = Array.isArray(view.nodes) ? view.nodes : [];
  const waitsOn = new Map<string, string[]>();
  for (const edge of Array.isArray(view.waitsOnEdges) ? view.waitsOnEdges : []) {
    waitsOn.set(edge.from, [...(waitsOn.get(edge.from) ?? []), edge.to]);
  }
  const ids = new Set(nodes.map((node) => node.id));
  const children = new Map<string, WorkstreamListNode[]>();
  const roots: WorkstreamListNode[] = [];
  for (const node of nodes) {
    if (node.parentThreadId !== null && ids.has(node.parentThreadId)) {
      children.set(node.parentThreadId, [...(children.get(node.parentThreadId) ?? []), node]);
    } else {
      roots.push(node);
    }
  }
  const lines = [
    "Workstream: " +
      nodes.length +
      " thread(s). Indentation shows lineage (parent above its children).",
  ];
  const emit = (node: WorkstreamListNode, depth: number): void => {
    const pad = "  ".repeat(depth);
    const attention =
      Array.isArray(node.attention) && node.attention.length > 0
        ? " attention=" + node.attention.join("+")
        : "";
    const you = node.id === view.callerId ? " (you)" : "";
    lines.push(
      pad +
        "- " +
        node.id +
        you +
        " [" +
        (node.role ?? "thread") +
        '] "' +
        (node.title ?? "(untitled)") +
        '" lane=' +
        node.planLane +
        attention,
    );
    if (node.lastActivityAt)
      lines.push(
        pad +
          "    last-activity: " +
          node.lastActivityAt +
          (node.lastActivitySummary ? " — " + node.lastActivitySummary : ""),
      );
    if (node.reportPath) lines.push(pad + "    report: " + node.reportPath);
    if (node.sessionPath) lines.push(pad + "    session: " + node.sessionPath);
    const deps = waitsOn.get(node.id);
    if (deps && deps.length > 0) lines.push(pad + "    waits-on: " + deps.join(", "));
    for (const child of children.get(node.id) ?? []) emit(child, depth + 1);
  };
  for (const root of roots) emit(root, 0);
  const catalogue = Array.isArray(view.modelCatalogue) ? view.modelCatalogue : [];
  const modelPresets = Array.isArray(view.modelPresets) ? view.modelPresets : [];
  if (catalogue.length > 0 || modelPresets.length > 0) {
    lines.push("", "Model selection (for spawning children):");
    for (const entry of catalogue) {
      const models =
        Array.isArray(entry.models) && entry.models.length > 0
          ? entry.models.join(", ")
          : "(catalogue not yet loaded)";
      lines.push('  - instance "' + entry.instanceId + '": ' + models);
    }
    if (modelPresets.length > 0) {
      lines.push("  presets (prefer these):");
      for (const preset of modelPresets) {
        const marker =
          preset.valid === false
            ? " [INVALID — points at an unconfigured instance/model; do not use]"
            : "";
        lines.push(
          '    - "' + preset.name + '" → ' + preset.instanceId + " / " + preset.model + marker,
        );
      }
    } else {
      lines.push("  presets: none configured");
    }
  }
  return lines.join("\n");
};

export interface SubmitOutcomeView {
  readonly disposition?: string;
  readonly outcome?: string;
  readonly leg?: string;
  readonly round?: number | undefined;
  readonly reason?: string;
}

/**
 * The submit disposition → prose mapping (done / needs_human / resolved /
 * routed-rework / routed-reverify / cap-breach / yield-unmatched), lifted
 * verbatim from the extension.
 */
export const renderSubmitOutcome = (result: SubmitOutcomeView): string => {
  const submittedOutcome = result.outcome;
  return result.disposition === "done"
    ? "Work submitted: report recorded, plan advanced to done (dependents released)."
    : result.disposition === "needs_human"
      ? "Work submitted: report recorded and needs_guidance raised — a human has been flagged; your lane is unchanged."
      : result.disposition === "resolved"
        ? "Work submitted with outcome '" +
          submittedOutcome +
          "': the review gate RESOLVED — you and your gate counterpart are both done (dependents released)."
        : result.disposition === "routed"
          ? result.leg === "reverify"
            ? "Work submitted: routed to the reviewer for re-verification (round " +
              result.round +
              ") — you are NOT done yet; the control plane resumes you if further rework is needed."
            : "Work submitted with outcome '" +
              submittedOutcome +
              "': findings routed to the coder for rework (round " +
              result.round +
              ") — you are NOT done; you will be resumed to re-verify the rework."
          : result.reason === "cap-breach"
            ? "Work submitted with outcome '" +
              submittedOutcome +
              "': the review gate's round cap is exhausted, so you YIELDED to your parent orchestrator — you are NOT done; it decides what happens next."
            : "Work submitted with outcome '" +
              submittedOutcome +
              "': no route matched, so you YIELDED to your parent orchestrator — you are NOT done; it will be woken with your report and decides what happens next.";
};

export interface ConsultCandidate {
  readonly threadId: string;
  readonly title?: string | null;
  readonly role?: string | null;
  readonly planLane?: string | null;
  readonly worktreePath?: string | null;
}

/** The candidate-disambiguation text for an unresolved consult_thread response. */
export const renderConsultCandidates = (candidates: ReadonlyArray<ConsultCandidate>): string => {
  const lines = candidates.map(
    (candidate) =>
      "- " +
      (candidate.title ?? "(untitled)") +
      " — " +
      (candidate.role ?? "thread") +
      ", " +
      (candidate.planLane ?? "unknown") +
      (candidate.worktreePath ? " [" + candidate.worktreePath + "]" : "") +
      " (threadId: " +
      candidate.threadId +
      ")",
  );
  return candidates.length > 0
    ? "Multiple threads match that name. Confirm which one with the user, then call consult_thread again with its threadId:\n" +
        lines.join("\n")
    : "No matching thread was found.";
};
