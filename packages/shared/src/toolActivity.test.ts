import { describe, expect, it } from "vite-plus/test";

import { deriveToolActivityPresentation } from "./toolActivity.ts";

describe("toolActivity", () => {
  it("normalizes command tools to a stable ran-command label", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "Terminal",
        detail: "Terminal",
        data: {
          command: "bun run lint",
        },
        fallbackSummary: "Terminal",
      }),
    ).toEqual({
      summary: "Ran command",
      detail: "bun run lint",
    });
  });

  it("uses structured file paths for read-file tools when available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          locations: [{ path: "/tmp/app.ts" }],
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
      detail: "/tmp/app.ts",
    });
  });

  // Pi-provider fixtures: after the PiDriver merges the stashed tool args back
  // into the `item.completed` payload under `data.rawInput`, the title is the
  // bare tool name and `detail` is absent. bash, read AND edit must each recover
  // a distinct detail (the read/"other" branch was PR #12's blind spot).
  it("recovers the command for a pi bash call", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "command_execution",
        title: "bash",
        detail: null,
        data: { content: [{ text: "..." }], rawInput: { command: "rg foo src" } },
      }),
    ).toEqual({ summary: "Ran command", detail: "rg foo src" });
  });

  it("recovers the path for a pi read call (the read/other branch)", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "read",
        detail: null,
        data: {
          content: [{ text: "..." }],
          rawInput: { path: "packages/shared/src/toolActivity.ts" },
        },
      }),
    ).toEqual({ summary: "Read file", detail: "packages/shared/src/toolActivity.ts" });
  });

  it("recovers the path for a pi edit call", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "file_change",
        title: "edit",
        detail: null,
        data: {
          content: [{ text: "..." }],
          rawInput: { path: "apps/server/src/x.ts", edits: [{ oldText: "a", newText: "b" }] },
        },
      }),
    ).toEqual({ summary: "Changed files", detail: "apps/server/src/x.ts" });
  });

  it("yields distinct signatures across pi bash/read/edit calls", () => {
    const present = (
      itemType: "command_execution" | "dynamic_tool_call" | "file_change",
      title: string,
      rawInput: Record<string, unknown>,
    ) => deriveToolActivityPresentation({ itemType, title, detail: null, data: { rawInput } });
    const signatures = [
      present("command_execution", "bash", { command: "rg foo" }),
      present("dynamic_tool_call", "read", { path: "src/a.ts" }),
      present("file_change", "edit", { path: "src/b.ts" }),
    ].map((p) => `${p.summary}\u0000${p.detail ?? ""}`);
    expect(new Set(signatures).size).toBe(3);
  });

  it("drops duplicated generic read-file detail when no path is available", () => {
    expect(
      deriveToolActivityPresentation({
        itemType: "dynamic_tool_call",
        title: "Read File",
        detail: "Read File",
        data: {
          kind: "read",
          rawInput: {},
        },
        fallbackSummary: "Read File",
      }),
    ).toEqual({
      summary: "Read file",
    });
  });
});
