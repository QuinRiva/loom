import { describe, expect, it } from "vite-plus/test";

import { piToolItemPayload } from "./PiDriver.ts";

type ToolMessage = Parameters<typeof piToolItemPayload>[0];

const start = (toolCallId: string, toolName: string, args: Record<string, unknown>): ToolMessage =>
  ({ type: "tool_execution_start", toolCallId, toolName, args }) as ToolMessage;
const end = (toolCallId: string, toolName: string, result: unknown): ToolMessage =>
  ({ type: "tool_execution_end", toolCallId, toolName, result, isError: false }) as ToolMessage;

describe("piToolItemPayload", () => {
  it("correlates start args into the completed payload (bash command)", () => {
    const toolArgs = new Map<string, Record<string, unknown>>();
    piToolItemPayload(start("c1", "bash", { command: "rg foo src" }), toolArgs);
    const completed = piToolItemPayload(
      end("c1", "bash", { content: [{ text: "out" }] }),
      toolArgs,
    );

    expect(completed.itemType).toBe("command_execution");
    expect(completed.status).toBe("completed");
    const data = completed.data as Record<string, unknown>;
    expect(data.rawInput).toEqual({ command: "rg foo src" });
    // original result is preserved alongside the re-attached args
    expect(data.content).toEqual([{ text: "out" }]);
    // the stash is cleared once correlated, so it cannot leak across calls
    expect(toolArgs.size).toBe(0);
  });

  it("correlates the path for read and edit calls", () => {
    const toolArgs = new Map<string, Record<string, unknown>>();
    piToolItemPayload(start("r1", "read", { path: "src/a.ts" }), toolArgs);
    piToolItemPayload(start("e1", "edit", { path: "src/b.ts", edits: [] }), toolArgs);

    const readDone = piToolItemPayload(end("r1", "read", { content: [] }), toolArgs);
    const editDone = piToolItemPayload(end("e1", "edit", { content: [] }), toolArgs);

    expect((readDone.data as Record<string, unknown>).rawInput).toEqual({ path: "src/a.ts" });
    expect((editDone.data as Record<string, unknown>).rawInput).toEqual({
      path: "src/b.ts",
      edits: [],
    });
  });

  it("leaves the result untouched when no args were stashed", () => {
    const toolArgs = new Map<string, Record<string, unknown>>();
    const completed = piToolItemPayload(end("x", "bash", { content: [{ text: "out" }] }), toolArgs);
    expect(completed.data).toEqual({ content: [{ text: "out" }] });
  });
});
