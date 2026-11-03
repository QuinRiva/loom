// @effect-diagnostics nodeBuiltinImport:off - reads the repo's skills and AGENTS.md.
/**
 * The fixed text Loom puts in front of a root orchestrator and a coder child every turn (the
 * addendum less per-thread data, Loom's skills, `bg_*` and every resident MCP tool), and the repo's
 * AGENTS.md, each held under its ceiling in `agentContextLimits.json`.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import YAML from "yaml";

import { LOOM_TOOL_DEFS } from "../../mcp/toolkits/workstream/defs.ts";
import { agentToolName } from "../../mcp/toolkits/workstream/families.ts";
import {
  LOOM_TEST_THREAD,
  mcpTestLayer,
  serveMcp,
} from "../../mcp/toolkits/workstream/mcpHttp.testkit.ts";
import { LOOM_TOOL_PROSE } from "../../mcp/toolkits/workstream/prose.ts";
import { ASK_USER_QUESTION_PARAMETERS } from "../../provider/Drivers/Pi/loomExtension.ts";
import {
  BG_START_PARAMETERS,
  BG_WAIT_PARAMETERS,
} from "../../provider/Drivers/Pi/loomExtensionParts/backgroundJobs.ts";
import limits from "./agentContextLimits.json" with { type: "json" };
import { LOOM_PREAMBLE } from "./prose.ts";
import { LOOM_REPO_ROOT } from "./roleOverlay.ts";
import { addendumParts } from "./sessionComposerLive.ts";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const toolBytes = (
  tools: ReadonlyArray<{ name: string; description?: string; inputSchema: unknown }>,
) =>
  tools.length &&
  bytes(
    JSON.stringify(
      tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    ),
  );

// Registered by Loom's pi extension rather than /mcp.
const EXTENSION_TOOLS = [
  {
    name: "ask_user_question",
    description: LOOM_TOOL_PROSE.ask_user_question.description,
    inputSchema: ASK_USER_QUESTION_PARAMETERS,
  },
];
const BG_TOOLS = [
  {
    name: "bg_start",
    description: LOOM_TOOL_PROSE.bg_start.description,
    inputSchema: BG_START_PARAMETERS,
  },
  {
    name: "bg_wait",
    description: LOOM_TOOL_PROSE.bg_wait.description,
    inputSchema: BG_WAIT_PARAMETERS,
  },
];
const LOOM_TOOL_NAMES = new Set([...LOOM_TOOL_DEFS.map((def) => def.name), "ask_user_question"]);

const frontmatter = (skillDir: string) => {
  const file = NodePath.join(skillDir, "SKILL.md");
  const match =
    NodeFS.existsSync(file) && /^---\n([\s\S]*?)\n---/.exec(NodeFS.readFileSync(file, "utf8"));
  return match ? (YAML.parse(match[1]!) as Record<string, unknown>) : undefined;
};

/** pi's listing of the skills deploy installs globally (`pi_global`) plus the role's own. */
const loomSkillsListing = (roleSkills: ReadonlyArray<string>) => {
  const dir = NodePath.join(LOOM_REPO_ROOT, "skills");
  const global = NodeFS.readdirSync(dir)
    .map((name) => NodePath.join(dir, name))
    .filter((skill) => frontmatter(skill)?.pi_global === true);
  return [...new Set([...global, ...roleSkills])]
    .map((skill) => {
      const { name, description } = frontmatter(skill)!;
      return `  <skill>\n    <name>${name}</name>\n    <description>${description}</description>\n    <location>~/.pi/agent/skills/${NodePath.basename(skill)}/SKILL.md</location>\n  </skill>`;
    })
    .join("\n");
};

it.effect("Loom's per-turn agent context stays under its limits", () =>
  Effect.gen(function* () {
    const mcp = yield* serveMcp({}, { threadId: LOOM_TEST_THREAD });
    const registered = [...(yield* mcp.listTools), ...EXTENSION_TOOLS];
    const measure = (role: string, isChild: boolean) => {
      const { overlay, parts } = addendumParts({
        role,
        isChild,
        projectRoot: LOOM_REPO_ROOT,
        mergeAuthorityCeiling: undefined,
        threadIdentity: "",
        goalContext: undefined,
      });
      const resident = registered.filter((tool) =>
        overlay.tools.includes(agentToolName(tool.name)),
      );
      const unmeasured = overlay.tools.filter(
        (name) =>
          name.startsWith("mcp__t3-code__") &&
          !resident.some((tool) => agentToolName(tool.name) === name),
      );
      assert.deepEqual(unmeasured, [], `${role} keeps tools resident that this test cannot find`);
      const loomTools = resident.filter((tool) => LOOM_TOOL_NAMES.has(tool.name));
      const upstreamTools = resident.filter((tool) => !LOOM_TOOL_NAMES.has(tool.name));
      return {
        preamble: bytes(LOOM_PREAMBLE),
        "work model": bytes(parts.workModel),
        "deferred-capabilities clause": bytes(parts.deferredCapabilities ?? ""),
        "child readership clause": bytes(parts.childReadership ?? ""),
        [`role (roles/${role}.md + .t3code/roles/${role}.md)`]: bytes(parts.role ?? ""),
        "shipping policy": bytes(parts.shipPolicy),
        "roles catalogue": bytes(parts.roles ?? ""),
        "Loom skills": bytes(loomSkillsListing(overlay.skills ?? [])),
        "bg_start, bg_wait": toolBytes(BG_TOOLS),
        [`Loom MCP tools (${loomTools.length})`]: toolBytes(loomTools),
        [`upstream MCP tools (${upstreamTools.length})`]: toolBytes(upstreamTools),
      };
    };
    const components: Record<keyof typeof limits, Record<string, number>> = {
      rootOrchestratorBytes: measure("orchestrator", false),
      coderBytes: measure("coder", true),
      agentsMdBytes: {
        "AGENTS.md": bytes(NodeFS.readFileSync(NodePath.join(LOOM_REPO_ROOT, "AGENTS.md"), "utf8")),
      },
    };
    const report = Object.entries(components).map(([key, parts]) => {
      const limit = limits[key as keyof typeof limits];
      const total = Object.values(parts).reduce((sum, size) => sum + size, 0);
      return { key, limit, total, parts };
    });
    const over = report.filter(({ total, limit }) => total > limit);
    if (over.length > 0)
      assert.fail(
        [
          "Loom's per-turn agent context is over its limit (apps/server/src/loom/prompt/agentContextLimits.json):",
          ...over.flatMap(({ key, limit, total, parts }) => [
            `${key}: ${total} bytes, limit ${limit}, over by ${total - limit}`,
            ...Object.entries(parts)
              .filter(([, size]) => size > 0)
              .map(([part, size]) => `  ${part}: ${size}`),
          ]),
          "Raising a limit is Carl's decision, not the agent's.",
        ].join("\n"),
      );
  }).pipe(Effect.scoped, Effect.provide(mcpTestLayer)),
);
