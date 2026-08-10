// @effect-diagnostics nodeBuiltinImport:off
// LOOM-ONLY. Generates the pi provider-tool extension from the typed tool-def
// tables. The emitted `.mjs` is a generic POST-and-print shim: it reads
// T3_WORKSTREAM_ENDPOINT + T3_WORKSTREAM_AUTHORIZATION once, and for each
// serialised def registers a tool whose execute() POSTs to endpoint + def.path,
// prints `result.rendered` (server-rendered text; the single source of truth),
// and honours the per-tool errorMode. The routed tools' metadata lives as data in
// providerToolDefs.ts — no logic is embedded in the string. The one LOCAL tool
// (enable_toolset) is defined here and served by the shim itself against pi's
// extension API, with no HTTP route.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { DORMANT_PROVIDER_TOOLSETS, ENABLE_TOOLSET_TOOL } from "../../../mcp/toolPaths.ts";
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
 * A tool the extension serves ITSELF: no route and no errorMode (both are HTTP
 * semantics), and a `local: true` discriminant the generated shim branches on.
 * Deliberately outside PROVIDER_TOOL_PATHS' three-family partition.
 */
export interface LocalProviderToolDef extends Pick<
  ProviderToolDef,
  "label" | "description" | "promptSnippet" | "promptGuidelines" | "parameters"
> {
  readonly name: typeof ENABLE_TOOLSET_TOOL;
  readonly local: true;
}

/** Paid only on use (zero resident cost): the doctrine a leaf needs the moment it
 * becomes a parent, referencing the canonical brief contract rather than
 * restating it. */
const DELEGATION_TOOLSET_DIGEST = `Delegation tools are now active. The essentials before you spawn:

- You are now a parent. A child inherits NONE of your conversation — only the brief you write. The contract on workstream_spawn's \`brief\` parameter says what a child already inherits and what still belongs in the brief — read it before writing your first brief.
- One self-contained sub-task → workstream_spawn (role + title + purpose + brief). More than a couple of dependent pieces → workstream_scaffold lays out the shape (keys + blockedBy/gate edges), then workstream_brief each node in topological order. Pass staged: true to hold a graph for review; workstream_release runs it.
- Review gates: spawn the reviewer with gate: { rework: coderId }; wire anything downstream on the reviewer, never the coder alone.
- Defined roles live in roles/*.md at your project root — list that directory for the catalogue. A free-text role is allowed when none fits.
- Children report back via their own workstream_submit and you are woken when one finishes or needs you. Steer with workstream_prompt, pause with workstream_stop, accept/abandon with workstream_set_lane.
- These tools stay active for the rest of this session; re-enable after a restart if they go dormant.`;

export const LOCAL_PROVIDER_TOOL_DEFS: ReadonlyArray<LocalProviderToolDef> = [
  {
    name: ENABLE_TOOLSET_TOOL,
    label: "Enable Dormant Toolset",
    description:
      "Activate a dormant tool family in THIS session. Your role runs with a " +
      "deliberately lean default tool surface; the full catalogue stays " +
      "registered but inactive until enabled. Families: 'delegation' — the " +
      "workstream graph-authoring and child-management tools (spawn, scaffold, " +
      "brief, gates, release, stop, prompt, lanes, dependencies, plus " +
      "notify_thread, thread_fork and the goal handoff/continue/update tools) " +
      "for when your work genuinely splits into delegated sub-work; " +
      "'human-input' — ask_user_question, for a fork that is genuinely " +
      "irreversible, destructive, or purely the user's preference, where a " +
      "structured question beats a needs_guidance attention flag; 'browser' — " +
      "all browser_* tools, for live web/UI driving and verification; 'studio' — " +
      "the studio_* REPL and export tools; 'all' — every registered tool " +
      "(escape hatch). Activation applies from your next step and adds the " +
      "enabled tools' own usage guidelines to your system prompt, so enable " +
      "first, then act. Enable a family only when the task in front of you " +
      "actually needs it — the lean default is deliberate. Enablement lasts " +
      "until the session restarts; simply re-enable if the tools go dormant.",
    promptSnippet:
      "activate a dormant tool family (delegation / human-input / browser / " +
      "studio / all) when the task genuinely needs it; takes effect from your " +
      "next step.",
    promptGuidelines: [],
    parameters: {
      type: "object",
      properties: {
        family: {
          type: "string",
          enum: ["delegation", "human-input", "browser", "studio", "all"],
        },
      },
      required: ["family"],
      additionalProperties: false,
    },
    local: true,
  },
];

/**
 * Emit the full extension source for the given tool defs: the routed defs (with
 * their route paths attached) plus the local defs, serialised as JSON; the
 * runtime is a fixed generic shim that closes over that data. Exported so a test
 * can build → import → drive it with a stub `pi`/`fetch`.
 */
export const buildProviderToolExtensionSource = (defs: ReadonlyArray<ProviderToolDef>): string => {
  const serialised = JSON.stringify([...defs.map(withPath), ...LOCAL_PROVIDER_TOOL_DEFS], null, 2);
  return `import * as NodeFS from "node:fs";

export const TOOL_DEFS = ${serialised};

// Provider-tool families addressable by enable_toolset; browser/studio/all are
// resolved by prefix over the live registry instead, so they survive the
// upstream extensions adding or renaming their tools.
const TOOLSET_FAMILIES = ${JSON.stringify(DORMANT_PROVIDER_TOOLSETS, null, 2)};
const TOOLSET_DIGESTS = ${JSON.stringify({ delegation: DELEGATION_TOOLSET_DIGEST }, null, 2)};

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
      if (errorMode === "throw") {
        const error = new Error(message);
        error.status = response.status;
        throw error;
      }
      return { ok: false, error: { content: [{ type: "text", text: message }], details: { ok: false, status: response.status, response: result ?? text } } };
    }
    return { ok: true, result };
  };

  const pause = (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Tool call aborted."));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Tool call aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

  const toolResult = (result, fallbackText) => ({
    content: [{ type: "text", text: result.rendered ?? fallbackText ?? "" }],
    details: { ok: true, ...result }
  });

  // Local (unrouted) escalation out of a lean role profile: pi's launch
  // allowlist is a default, not a sandbox, so activating by registry name is
  // enough. pi refreshes tools + system prompt after every model round, so the
  // family is callable WITH its guidelines from the next round of this turn.
  const enableToolset = (family) => {
    const all = pi.getAllTools().map((tool) => tool.name);
    const names = family === "all"
      ? all
      : TOOLSET_FAMILIES[family] ?? all.filter((name) => name.startsWith(family + "_"));
    const active = pi.getActiveTools();
    const added = names.filter((name) => !active.includes(name));
    if (added.length > 0) pi.setActiveTools([...active, ...added]);
    const summary = added.length > 0
      ? "Enabled the " + family + " toolset (" + added.length + "): " + added.join(", ") + ". Callable from your next step, with their own guidelines."
      : names.length > 0
        ? "The " + family + " toolset was already active."
        : "No registered tools matched the " + family + " toolset in this session.";
    const digest = added.length > 0 ? TOOLSET_DIGESTS[family] : undefined;
    return { content: [{ type: "text", text: digest ? summary + "\\n\\n" + digest : summary }] };
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
        if (def.local) return enableToolset(params?.family);
        if (def.mode === "user-input") {
          let request = params;
          while (true) {
            let outcome;
            try {
              outcome = await call(def.path, request, signal, def.errorMode);
            } catch (error) {
              // Once the server has assigned an id, a dropped poll connection is
              // recoverable: the in-memory broker still owns the pending ask.
              if (!request?.requestId || signal?.aborted || error?.status !== undefined) throw error;
              await pause(250, signal);
              continue;
            }
            if (!outcome.ok) return outcome.error;
            const result = outcome.result ?? {};
            if (!result.pending) return toolResult(result, def.fallbackText);
            if (!result.requestId) throw new Error("ask_user_question poll omitted requestId.");
            request = { requestId: result.requestId };
          }
        }
        const outcome = await call(def.path, params, signal, def.errorMode);
        if (!outcome.ok) return outcome.error;
        return toolResult(outcome.result ?? {}, def.fallbackText);
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
