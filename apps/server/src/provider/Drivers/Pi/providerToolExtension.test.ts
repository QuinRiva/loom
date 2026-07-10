// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { PROVIDER_TOOL_PATHS } from "../../../mcp/toolPaths.ts";
import {
  buildProviderToolExtensionSource,
  ensurePiProviderToolExtension,
} from "./providerToolExtension.ts";
import { GOAL_TOOL_DEFS, WORKSTREAM_TOOL_DEFS } from "./providerToolDefs.ts";

interface RegisteredTool {
  name: string;
  label: string;
  parameters: Record<string, unknown>;
  execute: (
    id: unknown,
    params: unknown,
    signal: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

const ALL_DEFS = [...WORKSTREAM_TOOL_DEFS, ...GOAL_TOOL_DEFS];

const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-ext-test-"));
let extensionCounter = 0;

const loadExtension = async (): Promise<RegisteredTool[]> => {
  const file = NodePath.join(tmpDir, `ext-${extensionCounter++}.mjs`);
  NodeFS.writeFileSync(file, buildProviderToolExtensionSource(ALL_DEFS), "utf8");
  const mod = await import(NodeURL.pathToFileURL(file).href);
  const tools: RegisteredTool[] = [];
  mod.default({ registerTool: (tool: RegisteredTool) => tools.push(tool) });
  return tools;
};

describe("generated provider-tool extension", () => {
  let originalFetch: typeof globalThis.fetch;
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  let response: { ok: boolean; status: number; body: unknown } = {
    ok: true,
    status: 200,
    body: { rendered: "RENDERED" },
  };

  beforeAll(() => {
    originalFetch = globalThis.fetch;
    process.env.T3_WORKSTREAM_ENDPOINT = "http://127.0.0.1:9000";
    process.env.T3_WORKSTREAM_AUTHORIZATION = "Bearer secret";
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      });
      return {
        ok: response.ok,
        status: response.status,
        text: async () => JSON.stringify(response.body),
      };
    }) as unknown as typeof globalThis.fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    delete process.env.T3_WORKSTREAM_ENDPOINT;
    delete process.env.T3_WORKSTREAM_AUTHORIZATION;
    NodeFS.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers all 18 tools with the expected names and schemas", async () => {
    const tools = await loadExtension();
    expect(tools).toHaveLength(18);
    for (const def of ALL_DEFS) {
      const tool = tools.find((t) => t.name === def.name);
      expect(tool).toBeDefined();
      expect(tool!.label).toBe(def.label);
      expect(tool!.parameters).toEqual(def.parameters);
    }
  });

  it("POSTs to the endpoint + table path with the authorization header and prints rendered", async () => {
    calls.length = 0;
    response = { ok: true, status: 200, body: { rendered: "RENDERED", childThreadId: "c1" } };
    const tools = await loadExtension();
    const spawn = tools.find((t) => t.name === "workstream_spawn")!;
    const result = await spawn.execute("id", { title: "T" }, undefined);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://127.0.0.1:9000" + PROVIDER_TOOL_PATHS.workstream_spawn);
    expect(calls[0]!.headers.authorization).toBe("Bearer secret");
    expect(result.content[0]!.text).toBe("RENDERED");
    expect(result.details).toEqual({ ok: true, rendered: "RENDERED", childThreadId: "c1" });
  });

  it("falls back to fallbackText when the server omits rendered", async () => {
    response = { ok: true, status: 200, body: { ok: true } };
    const tools = await loadExtension();
    const list = tools.find((t) => t.name === "workstream_list")!;
    const result = await list.execute("id", {}, undefined);
    expect(result.content[0]!.text).toBe("Workstream: 0 thread(s).");
  });

  it("throws on a 4xx for a throw-mode workstream tool", async () => {
    response = { ok: false, status: 409, body: { message: "gate open" } };
    const tools = await loadExtension();
    const submit = tools.find((t) => t.name === "workstream_submit")!;
    await expect(submit.execute("id", { markdown: "x" }, undefined)).rejects.toThrow("gate open");
  });

  it("returns error content on a 4xx for a soft-mode goal tool", async () => {
    response = { ok: false, status: 400, body: { message: "no goal" } };
    const tools = await loadExtension();
    const add = tools.find((t) => t.name === "goal_task_add")!;
    const result = await add.execute("id", { text: "x" }, undefined);
    expect(result.content[0]!.text).toBe("no goal");
    expect((result.details as { ok: boolean }).ok).toBe(false);
  });
});

describe("ensurePiProviderToolExtension", () => {
  it("writes the merged extension and removes legacy files", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-state-"));
    const extDir = NodePath.join(stateDir, "pi-extensions");
    NodeFS.mkdirSync(extDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(extDir, "t3-workstream-spawn-extension.mjs"), "stale");
    NodeFS.writeFileSync(NodePath.join(extDir, "t3-goal-task-extension.mjs"), "stale");
    const path = ensurePiProviderToolExtension(stateDir);
    expect(NodeFS.existsSync(path)).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(extDir, "t3-workstream-spawn-extension.mjs"))).toBe(
      false,
    );
    expect(NodeFS.existsSync(NodePath.join(extDir, "t3-goal-task-extension.mjs"))).toBe(false);
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  });
});
