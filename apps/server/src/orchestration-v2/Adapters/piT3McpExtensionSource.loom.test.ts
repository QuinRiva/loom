/**
 * The bridge's two Loom hunks: a tool listed with Loom's `_meta` prose is
 * registered in pi with that snippet and those guidelines (an upstream tool
 * keeps the generic ones), and no orchestration instructions are appended.
 * The shipped source runs against a stub `pi` and a stub MCP server.
 */
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, it } from "@effect/vitest";

import { PI_T3_MCP_EXTENSION_SOURCE } from "./piT3McpExtensionSource.ts";

interface Registered {
  readonly name: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: ReadonlyArray<string>;
}

const TOOLS = [
  {
    name: "workstream_submit",
    description: "Submit your report.\nMore.",
    inputSchema: { type: "object" },
    _meta: {
      "loom/promptSnippet": "hand back a report",
      "loom/promptGuidelines": "Rule one.\nRule two.",
    },
  },
  {
    name: "workstream_set_outcome",
    description: "Set an outcome.",
    inputSchema: { type: "object" },
    _meta: { "loom/promptSnippet": "set the plan outcome", "loom/promptGuidelines": "" },
  },
  { name: "delegate_task", description: "Delegate.\nDetails.", inputSchema: { type: "object" } },
];

it("registers Loom's _meta prose and appends no orchestration instructions", async () => {
  const registered: Array<Registered> = [];
  const handlers = new Map<string, (event: { systemPrompt: string }) => unknown>();
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace('import { Type } from "typebox";', "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: { T3_MCP_URL: "http://127.0.0.1:4100/mcp", T3_MCP_BEARER_TOKEN: "token" } },
    AbortSignal,
    Type: { Object: () => ({}) },
    fetch: async (_url: string, init: { body: string }) => {
      const { id, method } = JSON.parse(init.body) as { id?: number; method: string };
      const result = method === "tools/list" ? { tools: TOOLS } : {};
      return {
        ok: true,
        status: 200,
        headers: { get: (name: string) => (name === "content-type" ? "application/json" : null) },
        text: async () => (id === undefined ? "" : JSON.stringify({ jsonrpc: "2.0", id, result })),
      };
    },
    pi: {
      on: (name: string, handler: (event: { systemPrompt: string }) => unknown) =>
        handlers.set(name, handler),
      registerTool: (tool: Registered) => registered.push(tool),
    },
  });

  const byName = new Map(registered.map((tool) => [tool.name, tool]));
  assert.equal(byName.get("mcp__t3-code__workstream_submit")?.promptSnippet, "hand back a report");
  assert.deepEqual(byName.get("mcp__t3-code__workstream_submit")?.promptGuidelines, [
    "Rule one.",
    "Rule two.",
  ]);
  assert.deepEqual(byName.get("mcp__t3-code__workstream_set_outcome")?.promptGuidelines, []);
  assert.equal(byName.get("mcp__t3-code__delegate_task")?.promptSnippet, "Delegate.");
  assert.equal(byName.get("mcp__t3-code__delegate_task")?.promptGuidelines.length, 1);
  assert.deepEqual(handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }), {
    systemPrompt: "BASE\n\n",
  });
});
