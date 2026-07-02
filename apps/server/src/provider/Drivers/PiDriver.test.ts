import { describe, expect, it } from "vite-plus/test";

import {
  PI_TRANSIENT_PROVIDER_ERROR_RE,
  piBackendFallbackModel,
  piRunOutcome,
  piToolItemPayload,
} from "./PiDriver.ts";

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

describe("PI_TRANSIENT_PROVIDER_ERROR_RE", () => {
  it("matches capacity/plumbing errors that should be retried", () => {
    for (const message of [
      "529 overloaded_error: Overloaded",
      "429 Too Many Requests",
      "rate limit exceeded",
      "503 Service Unavailable",
      "500 internal error",
      "fetch failed",
      "socket hang up",
      "request timed out",
    ])
      expect(PI_TRANSIENT_PROVIDER_ERROR_RE.test(message)).toBe(true);
  });

  it("does not match user-fault errors that should fail immediately", () => {
    for (const message of [
      "401 authentication_error: invalid x-api-key",
      "400 invalid_request_error: max_tokens too large",
      "context length exceeded",
    ])
      expect(PI_TRANSIENT_PROVIDER_ERROR_RE.test(message)).toBe(false);
  });
});

describe("piBackendFallbackModel", () => {
  const catalogue = [
    "anthropic/claude-opus-4-8",
    "google-vertex-claude/claude-opus-4-8",
    "openai-codex/gpt-5.5",
  ];

  it("maps Vertex Claude to the Anthropic-direct pool for the same model", () => {
    expect(piBackendFallbackModel("google-vertex-claude/claude-opus-4-8", catalogue)).toBe(
      "anthropic/claude-opus-4-8",
    );
  });

  it("maps Anthropic-direct to the Vertex pool for the same model", () => {
    expect(piBackendFallbackModel("anthropic/claude-opus-4-8", catalogue)).toBe(
      "google-vertex-claude/claude-opus-4-8",
    );
  });

  it("returns undefined when no other backend hosts the same model", () => {
    expect(piBackendFallbackModel("openai-codex/gpt-5.5", catalogue)).toBeUndefined();
    expect(piBackendFallbackModel(undefined, catalogue)).toBeUndefined();
  });
});

describe("piRunOutcome", () => {
  it("reads the last assistant message's stopReason and errorMessage", () => {
    expect(
      piRunOutcome([
        { role: "user", content: "hi" },
        { role: "assistant", stopReason: "error", errorMessage: "529 overloaded_error" },
      ]),
    ).toEqual({ stopReason: "error", errorMessage: "529 overloaded_error" });
  });

  it("reports a clean stop and tolerates a missing assistant message", () => {
    expect(piRunOutcome([{ role: "assistant", stopReason: "stop" }])).toEqual({
      stopReason: "stop",
      errorMessage: undefined,
    });
    expect(piRunOutcome(undefined)).toEqual({ stopReason: undefined, errorMessage: undefined });
  });
});
