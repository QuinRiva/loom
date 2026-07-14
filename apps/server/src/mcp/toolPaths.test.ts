import { describe, expect, it } from "vite-plus/test";

import * as GoalHandoffHttp from "./GoalHandoffHttp.ts";
import * as GoalTaskHttp from "./GoalTaskHttp.ts";
import { PROVIDER_TOOL_PATHS, workstreamBaseUrlFromMcpEndpoint } from "./toolPaths.ts";
import * as ThreadForkHttp from "./ThreadForkHttp.ts";
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

  // The HTTP modules must export a merged layer that registers exactly the
  // table paths. The layer is opaque here, so assert the modules load and the
  // table is complete (21 tools) — the driver env + extension both key off it.
  it("covers all 21 provider tools", () => {
    expect(Object.keys(PROVIDER_TOOL_PATHS)).toHaveLength(21);
    // Touch each module so a missing export/route registration fails to import.
    expect(typeof WorkstreamSpawnHttp.layer).toBe("object");
    expect(typeof GoalTaskHttp.layer).toBe("object");
    expect(typeof GoalHandoffHttp.layer).toBe("object");
    expect(typeof ThreadForkHttp.layer).toBe("object");
  });
});
