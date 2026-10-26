// @effect-diagnostics nodeBuiltinImport:off
/**
 * The bridge's two Loom hunks: a tool listed with Loom's `_meta` prose registers in pi with that
 * snippet and guidelines (none without `_meta`), and no orchestration instructions are appended.
 * The shipped source runs against a stub `pi` and a stub MCP server.
 */
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { assert, it } from "@effect/vitest";

import { PI_T3_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";

interface Registered {
  readonly name: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: ReadonlyArray<string>;
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

it("registers Loom's _meta prose and never forces the system prompt", async () => {
  const registered: Array<Registered> = [];
  const handlers = new Map<string, (event: { systemPrompt: string }) => unknown>();
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  const server = NodeHttp.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk));
    req.on("end", () => {
      const { id, method } = JSON.parse(body) as { id?: number; method: string };
      const result = method === "tools/list" ? { tools: TOOLS } : {};
      res.setHeader("content-type", "application/json");
      res.end(id === undefined ? "" : JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: {
      env: { T3_MCP_URL: `http://127.0.0.1:${port}/mcp`, T3_MCP_BEARER_TOKEN: "token" },
    },
    AbortSignal,
    NodePath,
    Type: { Unsafe: (schema: unknown) => schema },
    httpRequest: NodeHttp.request,
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
  assert.isUndefined(byName.get("mcp__t3-code__delegate_task")?.promptSnippet);
  assert.isUndefined(byName.get("mcp__t3-code__delegate_task")?.promptGuidelines);
  // Any returned systemPrompt, even an unchanged one, makes pi force the prompt and collapse every
  // system message into one head with all current tools: each tool_search load would then resend
  // the tool list and rewrite the prompt cache instead of appending an inline tool addition.
  assert.isUndefined(handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }));
  server.close();
});
