import { describe, expect, it } from "vite-plus/test";

import * as GoalHandoffHttp from "./GoalHandoffHttp.ts";
import * as GoalTaskHttp from "./GoalTaskHttp.ts";
import {
  DELEGATION_PROVIDER_TOOLS,
  HUMAN_INPUT_PROVIDER_TOOLS,
  LEAF_CORE_PROVIDER_TOOLS,
  PROVIDER_TOOL_PATHS,
  workstreamBaseUrlFromMcpEndpoint,
} from "./toolPaths.ts";
import * as ThreadForkHttp from "./ThreadForkHttp.ts";
import * as UserInputHttp from "./UserInputHttp.ts";
import * as WorkstreamSpawnHttp from "./WorkstreamSpawnHttp.ts";

describe("workstreamBaseUrlFromMcpEndpoint", () => {
  it("strips a trailing /mcp suffix", () => {
    expect(workstreamBaseUrlFromMcpEndpoint("http://127.0.0.1:9000/mcp")).toBe(
      "http://127.0.0.1:9000",
    );
  });

  it("strips a trailing slash when there is no /mcp suffix", () => {
    expect(workstreamBaseUrlFromMcpEndpoint("http://127.0.0.1:9000/")).toBe(
      "http://127.0.0.1:9000",
    );
  });

  it("leaves a bare base untouched", () => {
    expect(workstreamBaseUrlFromMcpEndpoint("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
  });
});

describe("PROVIDER_TOOL_PATHS ↔ registered routes", () => {
  // Every table entry must be a distinct provider-tools path.
  it("has unique paths under /provider-tools/", () => {
    const paths = Object.values(PROVIDER_TOOL_PATHS);
    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) expect(path.startsWith("/provider-tools/")).toBe(true);
  });

  it("maps notify_thread to its /thread/ route (a sibling of consult, tree-unscoped)", () => {
    expect(PROVIDER_TOOL_PATHS.notify_thread).toBe("/provider-tools/thread/notify");
  });

  // The HTTP modules must export a merged layer that registers exactly the
  // table paths. The layer is opaque here, so assert the modules load and the
  // table is complete (22 tools) — the driver env + extension both key off it.
  it("covers all 22 provider tools", () => {
    expect(Object.keys(PROVIDER_TOOL_PATHS)).toHaveLength(22);
    // Touch each module so a missing export/route registration fails to import.
    expect(typeof WorkstreamSpawnHttp.layer).toBe("object");
    expect(typeof GoalTaskHttp.layer).toBe("object");
    expect(typeof GoalHandoffHttp.layer).toBe("object");
    expect(typeof ThreadForkHttp.layer).toBe("object");
    expect(typeof UserInputHttp.layer).toBe("object");
  });
});

describe("provider-tool families partition the path table", () => {
  const families = {
    "leaf-core": LEAF_CORE_PROVIDER_TOOLS,
    delegation: DELEGATION_PROVIDER_TOOLS,
    "human-input": HUMAN_INPUT_PROVIDER_TOOLS,
  } as const;

  // A new provider tool that joins no family would silently ship dormant to
  // every role (unreachable even via enable_toolset); one in two families is a
  // classification bug. Both fail here with a named diff.
  it("covers every routed tool exactly once", () => {
    const assigned = Object.values(families).flat();
    expect([...assigned].sort()).toEqual(Object.keys(PROVIDER_TOOL_PATHS).sort());
    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it("keeps the families pairwise disjoint", () => {
    for (const [aName, a] of Object.entries(families)) {
      for (const [bName, b] of Object.entries(families)) {
        if (aName >= bName) continue;
        expect({
          pair: `${aName} ∩ ${bName}`,
          overlap: a.filter((tool) => (b as ReadonlyArray<string>).includes(tool)),
        }).toEqual({ pair: `${aName} ∩ ${bName}`, overlap: [] });
      }
    }
  });
});
