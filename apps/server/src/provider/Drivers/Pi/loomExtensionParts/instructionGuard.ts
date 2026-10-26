// loom: Loom extension part: an `edit` or `write` of a file a model reads as instructions gets a
// note naming the `llm-instruction-change` skill, once per file per session. Ambient prose saying
// "load it first" was read before 24 of 63 such edits; a note at the edit lands. Never blocks; a
// session that read the skill, or whose prompt does not list it, gets no note.
import type { LoomExtensionPart } from "../loomExtension.ts";

const NOTE =
  "[t3 instruction guard] A model reads FILE, so this edit changes an LLM instruction. The protocol for that is the llm-instruction-change skill at SKILL.";

export const instructionGuardPart: LoomExtensionPart = {
  name: "instruction-guard",
  source: String.raw`
const path = process.getBuiltinModule("node:path");
const os = process.getBuiltinModule("node:os");
const NOTE = ${JSON.stringify(NOTE)};
// Files a model reads as instructions: roles, skills, agent context files, and loom's prompt builders.
const MODEL_READ = [
  /\/roles\/[^/]+\.md$/,
  /\/skills\/[^/]+\/SKILL\.md$/,
  /\/(AGENTS|CLAUDE)\.md$/,
  /\/apps\/server\/src\/loom\/prompt\/(prose|goalContext|provenance)\.ts$/,
  /\/apps\/server\/src\/mcp\/toolkits\/workstream\/(prose|defs)\.ts$/,
  /\/apps\/server\/src\/loom\/handoff\/(retroDraft|handoffDraft)\.ts$/,
  /\/apps\/server\/src\/loom\/goals\/goalTaskMarkdown\.ts$/,
];
const SKILL_LOCATION = /<name>llm-instruction-change<\/name>[\s\S]*?<location>([^<]+)<\/location>/;
const resolve = (cwd, file) => path.resolve(cwd, file.replace(/^@/, "").replace(/^~(?=\/|$)/, os.homedir()));
const noted = new Set();
let skillRead = false;
pi.on("tool_result", (event, ctx) => {
  try {
    const file = event.input?.path;
    if (skillRead || event.isError || typeof file !== "string" || !["read", "edit", "write"].includes(event.toolName)) return undefined;
    const resolved = resolve(ctx.cwd, file);
    const skill = SKILL_LOCATION.exec(ctx.getSystemPrompt())?.[1];
    if (skill === undefined) return undefined;
    if (event.toolName === "read") {
      skillRead = resolved === path.resolve(skill);
      return undefined;
    }
    if (noted.has(resolved) || !MODEL_READ.some((re) => re.test(resolved))) return undefined;
    noted.add(resolved);
    const text = NOTE.replace("FILE", "\x60" + file + "\x60").replace("SKILL", "\x60" + skill + "\x60");
    return { content: [...(event.content ?? []), { type: "text", text: "\n\n" + text }], structuredContent: event.structuredContent };
  } catch {
    return undefined;
  }
});
`,
};
