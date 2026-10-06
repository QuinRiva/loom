// loom: Loom extension part (plan track 3c, seams 3 and 5) — quarantine's prompt-debug
// capture (providerToolExtension.ts `before_agent_start`) carried over unchanged, with the
// sidecar path read from the session profile instead of T3_PROMPT_DEBUG_PATH.
//
// As a part: `source` is a function body run once per pi process as `(pi, ctx) => { … }` by
// Loom's extension assembler (3a). It imports nothing (`node:fs` comes from
// `process.getBuiltinModule`) and needs `ctx.profile()` → `{ promptDebugPath: string | null }`;
// a null path makes the part a no-op.
import type { LoomExtensionPart } from "../loomExtension.ts";

export const promptDebugPart: LoomExtensionPart = {
  name: "prompt-debug",
  source: `
const NodeFS = process.getBuiltinModule("node:fs");

// Debugging-only effective-prompt capture. On each agent start pi fires
// \`before_agent_start\` carrying the assembled prompt string plus the
// structured options used to build it. We write a per-thread markdown sidecar
// (path from the session profile's promptDebugPath) so a human can inspect the prompt this pi
// thread sent. The sections report the STRUCTURED INPUTS pi was handed
// (systemPromptOptions) — deliberately NOT a reconstruction of pi's assembled
// output: pi applies its own base prompt, guideline injection, skill-inclusion
// and ordering rules, and reproducing those here would be a partial
// reimplementation of pi's assembler that silently drifts as pi changes. The
// verbatim block at the end is the authoritative string AS OBSERVED BY THIS
// handler (pi docs: later before_agent_start handlers could still alter it).
// FIRE-AND-FORGET: the whole body is wrapped in try/catch, never throws, never
// blocks meaningfully, and returns nothing (a returned result would mutate the
// run). A null path => silent no-op.
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

let agentStartIndex = 0;
// The sidecar path comes from the session profile, fetched once per session (a failed
// fetch is retried at the next agent start).
let debugPath;
const promptDebugPath = () =>
  (debugPath ??= ctx.profile().then(
    (profile) => profile?.promptDebugPath ?? null,
    () => {
      debugPath = undefined;
      return null;
    },
  ));
pi.on("session_start", () => {
  debugPath = undefined;
});
const capture = (event, path) => {
  try {
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
};
pi.on("before_agent_start", (event) => {
  // The inputs as THIS handler sees them, captured before the path resolves.
  const seen = {
    prompt: event.prompt,
    systemPrompt: event.systemPrompt,
    systemPromptOptions: event.systemPromptOptions,
  };
  void promptDebugPath().then((path) => path && capture(seen, path));
  // Intentionally return nothing: a before_agent_start result mutates the run.
});
`,
};
