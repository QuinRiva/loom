// @effect-diagnostics nodeBuiltinImport:off - enumerates the toolkit directories.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { AttachmentToolkit } from "../attachment/tools.ts";
import { DeviceStandardToolkit } from "../device/tools.ts";
import { EnvironmentToolkit } from "../environment/tools.ts";
import { OrchestratorToolkit } from "../orchestrator/tools.ts";
import { PreviewStandardToolkit } from "../preview/tools.ts";
import { ProjectToolkit } from "../project/tools.ts";
import { PullRequestsToolkit } from "../pullRequests/tools.ts";
import { ThreadToolkit } from "../thread/tools.ts";
import { WorktreeToolkit } from "../worktree/tools.ts";
import { LOOM_TOOL_DEFS } from "./defs.ts";
import {
  agentToolName,
  CAPABILITIES,
  DELEGATION,
  HISTORY,
  DOCUMENT_QUERY,
  HUMAN_INPUT,
  LEAF_CORE,
  PULL_REQUESTS,
  SCHEDULING,
  TOOLSETS,
  UPSTREAM_WITHHELD_TOOLS,
  withheldFrom,
} from "./families.ts";

const namesOf = (toolkit: { readonly tools: Record<string, unknown> }) =>
  Object.keys(toolkit.tools).map(agentToolName);

describe("Loom tool families", () => {
  it("LEAF_CORE, DELEGATION, HISTORY and DOCUMENT_QUERY partition the 24 MCP tools with no overlap", () => {
    const families: ReadonlyArray<string> = [
      ...LEAF_CORE,
      ...DELEGATION,
      ...HISTORY,
      ...DOCUMENT_QUERY,
    ];
    expect(new Set(families).size).toBe(families.length);
    expect(families.toSorted()).toEqual(
      LOOM_TOOL_DEFS.map((def) => agentToolName(def.name)).toSorted(),
    );
    expect(LOOM_TOOL_DEFS).toHaveLength(24);
    expect(HISTORY).toEqual(["mcp__t3-code__thread_search"]);
  });

  it("every registered tool is in exactly one of the core, human-input, query and withheld lists or one CAPABILITIES entry", async () => {
    // Every `<toolkit>/tools.ts` beside this directory, so a toolkit added there is covered unasked.
    const toolkitsDir = NodePath.join(import.meta.dirname, "..");
    const modules = await Promise.all(
      NodeFS.readdirSync(toolkitsDir)
        .filter((dir) => NodeFS.existsSync(NodePath.join(toolkitsDir, dir, "tools.ts")))
        .map((dir) => import(NodePath.join(toolkitsDir, dir, "tools.ts"))),
    );
    const registered = new Set([
      ...modules
        .flatMap((module) => Object.values(module as Record<string, unknown>))
        .filter(
          (value): value is { readonly tools: Record<string, unknown> } =>
            (typeof value === "object" || typeof value === "function") &&
            value !== null &&
            "tools" in value,
        )
        .flatMap(namesOf),
      ...LOOM_TOOL_DEFS.map((def) => agentToolName(def.name)),
    ]);
    const listed: ReadonlyArray<string> = [
      ...LEAF_CORE,
      ...HUMAN_INPUT,
      ...DOCUMENT_QUERY,
      ...UPSTREAM_WITHHELD_TOOLS,
      ...CAPABILITIES.flatMap((capability) => capability.tools),
    ];
    expect(new Set(listed).size).toBe(listed.length);
    // HUMAN_INPUT is the extension's, not a toolkit's.
    expect(listed.toSorted()).toEqual([...registered, ...HUMAN_INPUT].toSorted());
    expect(registered).toContain("mcp__t3-code__html_preview");
  });

  it("HUMAN_INPUT names only the extension's mcp__t3-code__ask_user_question", () => {
    expect(HUMAN_INPUT).toEqual(["mcp__t3-code__ask_user_question"]);
  });

  it("PULL_REQUESTS is upstream's PR toolkit, prefixed", () => {
    expect(PULL_REQUESTS.toSorted()).toEqual(namesOf(PullRequestsToolkit).toSorted());
    expect(PULL_REQUESTS).toContain("mcp__t3-code__link_pull_request");
  });

  it("withholds exactly upstream's six orchestration-shaped toolkits and none of PR, preview or device", () => {
    const expected = [
      OrchestratorToolkit,
      ThreadToolkit,
      ProjectToolkit,
      AttachmentToolkit,
      EnvironmentToolkit,
      WorktreeToolkit,
    ].flatMap(namesOf);
    expect(UPSTREAM_WITHHELD_TOOLS.toSorted()).toEqual(expected.toSorted());
    expect(UPSTREAM_WITHHELD_TOOLS).toContain("mcp__t3-code__delegate_task");
    expect(UPSTREAM_WITHHELD_TOOLS).toContain("mcp__t3-code__t3_background_wait");
    const kept = new Set(
      [PullRequestsToolkit, PreviewStandardToolkit, DeviceStandardToolkit].flatMap(namesOf),
    );
    expect(UPSTREAM_WITHHELD_TOOLS.filter((name) => kept.has(name))).toEqual([]);
    const loom: ReadonlySet<string> = new Set(LOOM_TOOL_DEFS.map((def) => agentToolName(def.name)));
    expect(UPSTREAM_WITHHELD_TOOLS.filter((name) => loom.has(name))).toEqual([]);
  });

  it("SCHEDULING is carved out of the withheld OrchestratorToolkit, and only a profile naming it is spared it", () => {
    expect(SCHEDULING.filter((name) => !namesOf(OrchestratorToolkit).includes(name))).toEqual([]);
    expect(TOOLSETS.scheduling).toBe(SCHEDULING);
    expect(withheldFrom([])).toEqual(UPSTREAM_WITHHELD_TOOLS);
    const spared = withheldFrom([...SCHEDULING, ...LEAF_CORE, "read"]);
    expect(UPSTREAM_WITHHELD_TOOLS.filter((name) => !spared.includes(name))).toEqual(SCHEDULING);
    expect(spared).toContain("mcp__t3-code__delegate_task");
    expect(spared).toContain("mcp__t3-code__request_secret");
  });
});
