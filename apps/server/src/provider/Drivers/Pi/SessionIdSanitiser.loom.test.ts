// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { sanitisePiSessionFile, slugRoutesToAnthropic } from "./SessionIdSanitiser.loom.ts";

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "loom-sanitiser-"));
afterAll(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

/** A pi session jsonl with one codex tool call (joined ids) and its result. */
const codexHistoryLines = [
  JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/w" }),
  JSON.stringify({ type: "model_change", provider: "openai-codex", modelId: "gpt-6.1-sol" }),
  JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Reading." },
        { type: "toolCall", id: "call_abc|fc_123", name: "read", arguments: {} },
      ],
    },
  }),
  JSON.stringify({
    type: "message",
    message: { role: "toolResult", toolCallId: "call_abc|fc_123", content: [] },
  }),
];

const writeSession = (name: string, lines: ReadonlyArray<string>) => {
  const path = NodePath.join(dir, name);
  NodeFS.writeFileSync(path, lines.join("\n"));
  return path;
};

describe("sanitisePiSessionFile", () => {
  it("rewrites joined codex ids to Anthropic's pattern, keeping call and result paired", () => {
    const path = writeSession("codex.jsonl", [...codexHistoryLines, ""]);
    expect(sanitisePiSessionFile(path)).toBe(true);
    const lines = NodeFS.readFileSync(path, "utf8").split("\n");
    // The header, the non-message entry and the trailing blank line are byte-identical.
    expect(lines[0]).toBe(codexHistoryLines[0]);
    expect(lines[1]).toBe(codexHistoryLines[1]);
    expect(lines.at(-1)).toBe("");
    const call = JSON.parse(lines[2]!).message.content[1];
    const result = JSON.parse(lines[3]!).message;
    expect(call.id).toBe("call_abc_fc_123");
    expect(result.toolCallId).toBe(call.id);
  });

  it("is idempotent: a clean history is left byte-for-byte untouched", () => {
    const path = writeSession("again.jsonl", codexHistoryLines);
    sanitisePiSessionFile(path);
    const once = NodeFS.readFileSync(path, "utf8");
    expect(sanitisePiSessionFile(path)).toBe(false);
    expect(NodeFS.readFileSync(path, "utf8")).toBe(once);
  });

  it("covers the Anthropic-shape result block keys", () => {
    const path = writeSession("anthropic-shape.jsonl", [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "call_x|fc_y", toolUseId: "a.b" }],
        },
      }),
      "not json {",
    ]);
    expect(sanitisePiSessionFile(path)).toBe(true);
    const [first, second] = NodeFS.readFileSync(path, "utf8").split("\n");
    expect(JSON.parse(first!).message.content[0]).toMatchObject({
      tool_use_id: "call_x_fc_y",
      toolUseId: "a_b",
    });
    expect(second).toBe("not json {");
  });

  it("is a no-op for a missing file", () => {
    expect(sanitisePiSessionFile(NodePath.join(dir, "missing.jsonl"))).toBe(false);
  });
});

describe("slugRoutesToAnthropic", () => {
  it.each([
    ["anthropic/claude-opus-5", true],
    ["google-vertex-claude/claude-opus-4-8", true],
    ["cliproxy/claude-opus-5-5", true],
    ["bedrock/us.anthropic.claude-opus-4-8", true],
    ["openai-codex/gpt-6.1-sol", false],
    ["cliproxy/gpt-6.1-sol", false],
    ["bedrock/meta.llama3", false],
  ])("%s → %s", (slug, expected) => {
    expect(slugRoutesToAnthropic(slug)).toBe(expected);
  });
});
