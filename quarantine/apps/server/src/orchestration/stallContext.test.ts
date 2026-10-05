import { describe, expect, it } from "vite-plus/test";

import { extractStallContext, renderStallContext } from "./stallContext.ts";

const toolError = (toolName: string, text: string) =>
  JSON.stringify({
    type: "message",
    message: { role: "toolResult", isError: true, toolName, content: [{ type: "text", text }] },
  });

const assistant = (text: string) =>
  JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

describe("extractStallContext", () => {
  it("returns null for an empty or content-less transcript", () => {
    expect(extractStallContext("")).toBeNull();
    expect(extractStallContext('{"type":"session","id":"x"}\n')).toBeNull();
  });

  it("surfaces the last errored tool result when the error is the last event", () => {
    const jsonl = [
      assistant("working on it"),
      toolError("bash", "Command exited with code 1"),
    ].join("\n");
    const context = extractStallContext(jsonl);
    expect(context?.source).toBe("tool-error");
    expect(context?.toolName).toBe("bash");
    expect(context?.detail).toBe("Command exited with code 1");
  });

  it("prefers the later assistant message when the agent spoke after the error", () => {
    const jsonl = [toolError("bash", "boom"), assistant("recovered and continuing")].join("\n");
    const context = extractStallContext(jsonl);
    expect(context?.source).toBe("last-assistant");
    expect(context?.detail).toBe("recovered and continuing");
  });

  it("does not resurface a stale error buried behind later progress", () => {
    const jsonl = [
      toolError("bash", "old failure"),
      assistant("fixed it"),
      assistant("still going"),
    ].join("\n");
    expect(extractStallContext(jsonl)?.source).toBe("last-assistant");
  });

  it("ignores non-JSON noise lines", () => {
    const jsonl = ["not json at all", toolError("edit", "Validation failed")].join("\n");
    expect(extractStallContext(jsonl)?.toolName).toBe("edit");
  });
});

describe("renderStallContext", () => {
  it("frames a tool error with its tool name", () => {
    expect(
      renderStallContext({ source: "tool-error", toolName: "edit", detail: "nope" }),
    ).toContain("`edit`");
  });

  it("frames a last-assistant account and a null account distinctly", () => {
    expect(
      renderStallContext({ source: "last-assistant", toolName: null, detail: "my last words" }),
    ).toContain("my last words");
    expect(renderStallContext(null)).toContain("no specific error");
  });
});
