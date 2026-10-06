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
  DELEGATION,
  HUMAN_INPUT,
  LEAF_CORE,
  PULL_REQUESTS,
  UPSTREAM_WITHHELD_TOOLS,
} from "./families.ts";

const namesOf = (toolkit: { readonly tools: Record<string, unknown> }) =>
  Object.keys(toolkit.tools).map(agentToolName);

describe("Loom tool families", () => {
  it("LEAF_CORE and DELEGATION partition the 21 MCP tools with no overlap", () => {
    const families: ReadonlyArray<string> = [...LEAF_CORE, ...DELEGATION];
    expect(new Set(families).size).toBe(families.length);
    expect(families.toSorted()).toEqual(
      LOOM_TOOL_DEFS.map((def) => agentToolName(def.name)).toSorted(),
    );
    expect(LOOM_TOOL_DEFS).toHaveLength(21);
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
    const kept = new Set(
      [PullRequestsToolkit, PreviewStandardToolkit, DeviceStandardToolkit].flatMap(namesOf),
    );
    expect(UPSTREAM_WITHHELD_TOOLS.filter((name) => kept.has(name))).toEqual([]);
    const loom: ReadonlyArray<string> = new Set(
      LOOM_TOOL_DEFS.map((def) => agentToolName(def.name)),
    );
    expect(UPSTREAM_WITHHELD_TOOLS.filter((name) => loom.has(name))).toEqual([]);
  });
});
