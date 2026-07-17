// @effect-diagnostics nodeBuiltinImport:off
// LOOM-ONLY. Generates the pi provider-tool extension from the typed tool-def
// tables. The emitted `.mjs` is a generic POST-and-print shim: it reads
// T3_WORKSTREAM_ENDPOINT + T3_WORKSTREAM_AUTHORIZATION once, and for each
// serialised def registers a tool whose execute() POSTs to endpoint + def.path,
// prints `result.rendered` (server-rendered text; the single source of truth),
// and honours the per-tool errorMode. All 18 tools' metadata lives as data in
// providerToolDefs.ts — no logic is embedded in the string.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  GOAL_TOOL_DEFS,
  WORKSTREAM_TOOL_DEFS,
  withPath,
  type ProviderToolDef,
} from "./providerToolDefs.ts";

const EXTENSION_FILE = "t3-provider-tools-extension.mjs";
// Legacy per-domain files superseded by the single merged extension above.
const LEGACY_EXTENSION_FILES = ["t3-workstream-spawn-extension.mjs", "t3-goal-task-extension.mjs"];

/**
 * Emit the full extension source for the given tool defs. The defs (with their
 * route paths attached) are serialised as JSON; the runtime is a fixed generic
 * shim that closes over that data. Exported so a test can build → import → drive
 * it with a stub `pi`/`fetch`.
 */
export const buildProviderToolExtensionSource = (defs: ReadonlyArray<ProviderToolDef>): string => {
  const serialised = JSON.stringify(defs.map(withPath), null, 2);
  return `import * as NodeFS from "node:fs";

export const TOOL_DEFS = ${serialised};

// Debugging-only effective-prompt capture. On each agent start pi fires
// \`before_agent_start\` carrying the assembled prompt string plus the
// structured options used to build it. We write a per-thread markdown sidecar
// (path from T3_PROMPT_DEBUG_PATH) so a human can inspect the prompt this pi
// thread sent. The sections report the STRUCTURED INPUTS pi was handed
// (systemPromptOptions) — deliberately NOT a reconstruction of pi's assembled
// output: pi applies its own base prompt, guideline injection, skill-inclusion
// and ordering rules, and reproducing those here would be a partial
// reimplementation of pi's assembler that silently drifts as pi changes. The
// verbatim block at the end is the authoritative string AS OBSERVED BY THIS
// handler (pi docs: later before_agent_start handlers could still alter it).
// FIRE-AND-FORGET: the whole body is wrapped in try/catch, never throws, never
// blocks meaningfully, and returns nothing (a returned result would mutate the
// run). Absent env var => silent no-op.
const promptDebugFence = (body) => {
  // Prompt bodies contain markdown and \`\`\` fences; pick a tilde run longer
  // than any tilde run already inside so the block always closes correctly.
  let longest = 0;
  for (const match of String(body ?? "").matchAll(/~+/g)) {
    if (match[0].length > longest) longest = match[0].length;
  }
  const fence = "~".repeat(Math.max(4, longest + 1));
  return fence + "\\n" + String(body ?? "") + "\\n" + fence;
};

// Report the structured inputs pi was handed (see comment above): a
// navigational aid to locate content within the authoritative assembled block,
// NOT a reproduction of pi's inclusion/ordering rules.
const renderPromptDebug = (event, startIndex) => {
  const opts = event.systemPromptOptions ?? {};
  const hasCustom = !!opts.customPrompt;
  const selected = Array.isArray(opts.selectedTools) ? opts.selectedTools : [];
  const skills = Array.isArray(opts.skills) ? opts.skills : [];
  const contextFiles = Array.isArray(opts.contextFiles) ? opts.contextFiles : [];
  const snippets = opts.toolSnippets && typeof opts.toolSnippets === "object" ? opts.toolSnippets : {};
  const guidelines = Array.isArray(opts.promptGuidelines) ? opts.promptGuidelines : [];
  const lines = [];
  lines.push("# Effective prompt \u2014 debug capture");
  lines.push("");
  lines.push("> Fire-and-forget debug sidecar written by the pi capture extension on each");
  lines.push("> agent start. The sections below are the STRUCTURED INPUTS pi assembled the");
  lines.push("> prompt from (systemPromptOptions), captured as seen by THIS before_agent_start");
  lines.push("> handler; pi's own base prompt, guideline/skill inclusion and ordering rules");
  lines.push("> apply on top \u2014 the \\"Full assembled system prompt\\" block at the end is the");
  lines.push("> authoritative bytes. This file is NEVER read back into a turn.");
  lines.push("");
  lines.push("## Metadata");
  lines.push("");
  lines.push("- Captured at: " + new Date().toISOString());
  lines.push("- Agent-start index (this process): " + startIndex);
  lines.push("- cwd: \`" + (opts.cwd ?? "(unknown)") + "\`");
  lines.push("- Custom base prompt: " + (hasCustom ? "yes" : "no (pi built-in base)"));
  lines.push("- Selected tools (" + selected.length + "): " + (selected.length ? selected.join(", ") : "(none)"));
  lines.push("- Skills (" + skills.length + "): " + (skills.length ? skills.map((s) => s && s.name ? s.name : String(s)).join(", ") : "(none)"));
  lines.push("- Context files (" + contextFiles.length + "): " + (contextFiles.length ? contextFiles.map((f) => f && f.path ? f.path : "(unnamed)").join(", ") : "(none)"));
  lines.push("");
  lines.push("## System prompt inputs (structured options \u2014 pi assembles the final bytes)");
  lines.push("");
  lines.push("### Custom base prompt");
  lines.push("");
  lines.push(hasCustom ? promptDebugFence(opts.customPrompt) : "(none \u2014 pi uses its built-in coding-assistant base prompt; see the assembled block)");
  lines.push("");
  lines.push("### Appended system prompt (T3 work-model + role overlay + goal)");
  lines.push("");
  lines.push(opts.appendSystemPrompt ? promptDebugFence(opts.appendSystemPrompt) : "(none)");
  lines.push("");
  lines.push("### Project context files");
  lines.push("");
  if (contextFiles.length) {
    for (const file of contextFiles) {
      lines.push("Path: \`" + (file && file.path ? file.path : "(unnamed)") + "\`");
      lines.push("");
      lines.push(promptDebugFence(file && file.content));
      lines.push("");
    }
  } else {
    lines.push("(none)");
    lines.push("");
  }
  lines.push("### Skills provided");
  lines.push("");
  if (skills.length) {
    lines.push("_pi injects a skill only when a read-capable tool is selected and the skill allows model invocation; see the assembled block for what was actually included._");
    lines.push("");
    for (const s of skills) {
      const name = s && s.name ? s.name : "(unnamed)";
      const loc = s && s.filePath ? " (\`" + s.filePath + "\`)" : "";
      const disabled = s && s.disableModelInvocation ? " \u2014 disable-model-invocation" : "";
      const desc = String(s && s.description ? s.description : "").replace(/\\n/g, " ");
      lines.push("- **" + name + "**" + loc + disabled + ": " + desc);
    }
  } else {
    lines.push("(none)");
  }
  lines.push("");
  lines.push("### Tools + snippets provided");
  lines.push("");
  lines.push("- Selected: " + (selected.length ? selected.join(", ") : "(none)"));
  const snippetKeys = Object.keys(snippets);
  if (snippetKeys.length) {
    lines.push("- Snippets (pi surfaces only snippet-bearing tools in its built-in base list):");
    for (const key of snippetKeys) lines.push("  - \`" + key + "\`: " + String(snippets[key]).replace(/\\n/g, " "));
  }
  lines.push("");
  lines.push("### Prompt guidelines provided");
  lines.push("");
  if (guidelines.length) {
    for (const g of guidelines) lines.push("- " + String(g).replace(/\\n/g, " "));
  } else {
    lines.push("(none)");
  }
  lines.push("");
  lines.push("_pi may add conditional (tool-dependent) and always-on guidelines on top; see the assembled block._");
  lines.push("");
  lines.push("### Working directory");
  lines.push("");
  lines.push("- cwd: \`" + (opts.cwd ?? "(unknown)") + "\` (pi also appends the current date; exact order/values are in the assembled block)");
  lines.push("");
  lines.push("## User prompt (this agent start)");
  lines.push("");
  lines.push(promptDebugFence(event.prompt));
  lines.push("");
  lines.push("## Full assembled system prompt (authoritative \u2014 as observed by this handler)");
  lines.push("");
  lines.push(promptDebugFence(event.systemPrompt));
  lines.push("");
  return lines.join("\\n");
};

export default function(pi) {
  let agentStartIndex = 0;
  pi.on("before_agent_start", (event) => {
    try {
      const path = process.env.T3_PROMPT_DEBUG_PATH;
      if (!path) return;
      agentStartIndex += 1;
      const markdown = renderPromptDebug(event, agentStartIndex);
      // Latest capture: atomic replace (fully written temp + rename).
      const tempPath = path + ".tmp-" + process.pid + "-" + Date.now();
      NodeFS.writeFileSync(tempPath, markdown, "utf8");
      NodeFS.renameSync(tempPath, path);
      // First capture: the original kickoff is the primary artefact, so preserve
      // it WRITE-ONCE at the filesystem level and atomically \u2014 independent of
      // this process's start index. A resumed/restarted pi process starts at
      // index 1 again but must NOT clobber the original: write a fully-formed
      // temp, then hard-link it into place. linkSync is atomic and fails with
      // EEXIST once the first capture exists, so the original is never truncated
      // or overwritten. Every failure (EEXIST or otherwise) is swallowed.
      const firstPath = path.replace(/\\.md$/, ".first.md");
      const firstTemp = firstPath + ".tmp-" + process.pid + "-" + Date.now();
      try {
        NodeFS.writeFileSync(firstTemp, markdown, "utf8");
        try {
          NodeFS.linkSync(firstTemp, firstPath);
        } finally {
          NodeFS.rmSync(firstTemp, { force: true });
        }
      } catch {
        // First capture already durable, or an fs error \u2014 debug data only.
      }
    } catch {
      // Debug capture only \u2014 swallow every error, never affect the run.
    }
    // Intentionally return nothing: a before_agent_start result mutates the run.
  });

  const call = async (path, params, signal, errorMode) => {
    const endpoint = process.env.T3_WORKSTREAM_ENDPOINT;
    const authorization = process.env.T3_WORKSTREAM_AUTHORIZATION;
    if (!endpoint || !authorization) {
      if (errorMode === "throw") {
        throw new Error("T3 Workstream tools are not available in this session.");
      }
      return { ok: false, error: { content: [{ type: "text", text: "T3 Workstream tools are not available in this session." }], details: { ok: false, reason: "missing_endpoint" } } };
    }
    const response = await fetch(endpoint + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify(params ?? {}),
      signal
    });
    const text = await response.text();
    let result;
    try { result = text ? JSON.parse(text) : null; } catch { result = null; }
    if (!response.ok) {
      const message = result?.message ?? (text || ("T3 Workstream request failed (" + response.status + ")."));
      if (errorMode === "throw") throw new Error(message);
      return { ok: false, error: { content: [{ type: "text", text: message }], details: { ok: false, status: response.status, response: result ?? text } } };
    }
    return { ok: true, result };
  };

  for (const def of TOOL_DEFS) {
    pi.registerTool({
      name: def.name,
      label: def.label,
      description: def.description,
      promptSnippet: def.promptSnippet,
      promptGuidelines: def.promptGuidelines,
      parameters: def.parameters,
      async execute(_id, params, signal) {
        const outcome = await call(def.path, params, signal, def.errorMode);
        if (!outcome.ok) return outcome.error;
        const result = outcome.result ?? {};
        const text = result.rendered ?? def.fallbackText ?? "";
        return {
          content: [{ type: "text", text }],
          details: { ok: true, ...result }
        };
      }
    });
  }
}
`;
};

/**
 * Write the single merged extension file (workstream + goal tools) and return
 * its path. Written unconditionally so edits to the tool defs propagate to
 * existing state dirs. Stale legacy per-domain files are removed
 * opportunistically so the state dir has exactly one source of tool truth.
 */
export function ensurePiProviderToolExtension(stateDir: string): string {
  const extensionDir = NodePath.join(stateDir, "pi-extensions");
  const extensionPath = NodePath.join(extensionDir, EXTENSION_FILE);
  const source = buildProviderToolExtensionSource([...WORKSTREAM_TOOL_DEFS, ...GOAL_TOOL_DEFS]);
  NodeFS.mkdirSync(extensionDir, { recursive: true });
  NodeFS.writeFileSync(extensionPath, source, "utf8");
  for (const legacy of LEGACY_EXTENSION_FILES) {
    NodeFS.rmSync(NodePath.join(extensionDir, legacy), { force: true });
  }
  return extensionPath;
}
