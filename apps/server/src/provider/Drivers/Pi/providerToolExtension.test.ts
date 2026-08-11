// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { PROVIDER_TOOL_PATHS } from "../../../mcp/toolPaths.ts";
import { DELEGATION_PROVIDER_TOOLS } from "../../../mcp/toolPaths.ts";
import {
  buildProviderToolExtensionSource,
  ensurePiProviderToolExtension,
  LOCAL_PROVIDER_TOOL_DEFS,
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

type BeforeAgentStartHandler = (event: unknown) => unknown;

// Build + import the extension and capture both the registered tools and any
// event handlers it registers via `pi.on(...)`.
// Own dir so the sibling describe's afterAll cleanup of `tmpDir` cannot remove
// the .mjs modules out from under these tests.
const handlerTmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-ext-h-"));

const loadExtensionWithHandlers = async (): Promise<{
  tools: RegisteredTool[];
  handlers: Map<string, BeforeAgentStartHandler>;
}> => {
  const file = NodePath.join(handlerTmpDir, `ext-h-${extensionCounter++}.mjs`);
  NodeFS.writeFileSync(file, buildProviderToolExtensionSource(ALL_DEFS), "utf8");
  const mod = await import(NodeURL.pathToFileURL(file).href);
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, BeforeAgentStartHandler>();
  mod.default({
    registerTool: (tool: RegisteredTool) => tools.push(tool),
    on: (event: string, handler: BeforeAgentStartHandler) => handlers.set(event, handler),
  });
  return { tools, handlers };
};

// Representative default-branch event (no customPrompt). The sidecar reports
// these as structured INPUTS; it does not reproduce pi's inclusion/order rules.
const sampleAgentStartEvent = (overrides: { prompt?: string } = {}) => ({
  prompt: overrides.prompt ?? "KICKOFF BRIEF with ```fenced``` content",
  systemPrompt: "FULL ASSEMBLED SYSTEM PROMPT\nwith ~~~ tildes and ``` backticks",
  systemPromptOptions: {
    cwd: "/work/tree",
    selectedTools: ["read", "bash", "workstream_spawn"],
    toolSnippets: { read: "read a file", bash: "run a command" },
    promptGuidelines: ["be concise"],
    appendSystemPrompt: "T3 WORK MODEL + ROLE OVERLAY + GOAL",
    contextFiles: [{ path: "/work/tree/AGENTS.md", content: "AGENTS CONTENT" }],
    skills: [{ name: "pdf", description: "make pdfs", filePath: "/skills/pdf/SKILL.md" }],
  },
});

// Custom-prompt event with a disable-model-invocation skill: exercises the
// custom-base input rendering and the honest skill-input reporting (location +
// disabled flag), without claiming what pi ultimately injects.
const customPromptAgentStartEvent = () => ({
  prompt: "custom kickoff",
  systemPrompt: "CUSTOM ASSEMBLED PROMPT",
  systemPromptOptions: {
    cwd: "/work/tree",
    customPrompt: "MY CUSTOM BASE PROMPT",
    selectedTools: ["bash"],
    toolSnippets: { bash: "run a command" },
    promptGuidelines: ["a provided guideline"],
    appendSystemPrompt: "APPENDED UNDER CUSTOM",
    contextFiles: [],
    skills: [
      { name: "pdf", description: "make pdfs", filePath: "/skills/pdf/SKILL.md" },
      {
        name: "secret",
        description: "hidden",
        filePath: "/skills/secret/SKILL.md",
        disableModelInvocation: true,
      },
    ],
  },
});

const ALL_DEFS = [...WORKSTREAM_TOOL_DEFS, ...GOAL_TOOL_DEFS];

const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-ext-test-"));
let extensionCounter = 0;

const loadExtension = async (): Promise<RegisteredTool[]> => {
  const file = NodePath.join(tmpDir, `ext-${extensionCounter++}.mjs`);
  NodeFS.writeFileSync(file, buildProviderToolExtensionSource(ALL_DEFS), "utf8");
  const mod = await import(NodeURL.pathToFileURL(file).href);
  const tools: RegisteredTool[] = [];
  mod.default({ registerTool: (tool: RegisteredTool) => tools.push(tool), on: () => {} });
  return tools;
};

/**
 * A pi stand-in with the REAL activation-boundary semantics this mechanism
 * depends on (verified against pi 0.83.0 `agent-session.js`):
 * - `getAllTools()` is the definition REGISTRY, fixed at launch;
 * - `setActiveToolsByName` silently DROPS names absent from that registry — so
 *   a tool the launch filtered out can never be activated;
 * - `getActiveTools()` is the selection pi conditions schemas/snippets/
 *   guidelines on.
 * A test that lets `setActiveTools` accept unregistered names cannot catch the
 * defect this fixture exists to pin.
 */
const makeFakePi = (registry: ReadonlyArray<string>) => {
  let active = [...registry];
  const setCalls: Array<Array<string>> = [];
  const handlers = new Map<string, (event: unknown) => unknown>();
  return {
    setCalls,
    handlers,
    registerTool: () => {},
    on: (event: string, handler: (e: unknown) => unknown) => handlers.set(event, handler),
    getAllTools: () => registry.map((name) => ({ name })),
    getActiveTools: () => [...active],
    setActiveTools: (names: Array<string>) => {
      setCalls.push([...names]);
      active = names.filter((name) => registry.includes(name));
    },
  };
};

/** Build + import the extension and run its default export against a fake pi,
 * returning the tools it registered. */
const loadInto = async (pi: ReturnType<typeof makeFakePi>): Promise<RegisteredTool[]> => {
  const tools: RegisteredTool[] = [];
  const file = NodePath.join(tmpDir, `ext-local-${extensionCounter++}.mjs`);
  NodeFS.writeFileSync(file, buildProviderToolExtensionSource(ALL_DEFS), "utf8");
  const mod = await import(NodeURL.pathToFileURL(file).href);
  mod.default({ ...pi, registerTool: (tool: RegisteredTool) => tools.push(tool) });
  return tools;
};

/** A leaf role's launch profile, and the full registry pi is launched with. */
const LEAF_PROFILE = ["read", "bash", "workstream_submit", "enable_toolset"];
const REGISTRY = [
  ...LEAF_PROFILE,
  ...DELEGATION_PROVIDER_TOOLS,
  "ask_user_question",
  "browser_navigate",
  "browser_click",
  "studio_repl_send",
];

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
    delete process.env.T3_ACTIVE_TOOLS;
    NodeFS.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers all 22 routed tools plus the one local tool, with the expected schemas", async () => {
    const tools = await loadExtension();
    expect(tools).toHaveLength(23);
    for (const def of [...ALL_DEFS, ...LOCAL_PROVIDER_TOOL_DEFS]) {
      const tool = tools.find((t) => t.name === def.name);
      expect(tool).toBeDefined();
      expect(tool!.label).toBe(def.label);
      expect(tool!.parameters).toEqual(def.parameters);
    }
  });

  it("applies the T3_ACTIVE_TOOLS profile at session_start, leaving the rest registered", async () => {
    const pi = makeFakePi(REGISTRY);
    await loadInto(pi);
    process.env.T3_ACTIVE_TOOLS = LEAF_PROFILE.join(",");
    pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" });
    // Selection shrank to the profile…
    expect(pi.getActiveTools()).toEqual(LEAF_PROFILE);
    // …while every dormant family is still REGISTERED (the property the launch
    // `--tools` allowlist destroys and enable_toolset depends on).
    expect(pi.getAllTools().map((tool) => tool.name)).toEqual(REGISTRY);
  });

  // Unrestricted/free-text roles keep pi's full active surface. The driver sends
  // an EMPTY T3_ACTIVE_TOOLS for them (it overrides any value inherited from a
  // server started inside a profiled child), so empty and absent must behave
  // identically — both mean "no profile", never "select nothing".
  it.each(["", " , ", undefined])(
    "leaves pi's default active set alone when the profile is %p",
    async (value) => {
      const pi = makeFakePi(REGISTRY);
      await loadInto(pi);
      if (value === undefined) delete process.env.T3_ACTIVE_TOOLS;
      else process.env.T3_ACTIVE_TOOLS = value;
      pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" });
      expect(pi.getActiveTools()).toEqual(REGISTRY);
      expect(pi.setCalls).toEqual([]);
    },
  );

  it("enable_toolset activates a dormant family locally (no HTTP) and returns the delegation digest", async () => {
    calls.length = 0;
    const pi = makeFakePi(REGISTRY);
    const tools = await loadInto(pi);
    process.env.T3_ACTIVE_TOOLS = LEAF_PROFILE.join(",");
    pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" });
    const enable = tools.find((tool) => tool.name === "enable_toolset")!;

    const delegation = await enable.execute("id", { family: "delegation" }, undefined);
    // Local: never POSTs, and the family is genuinely active afterwards.
    expect(calls).toHaveLength(0);
    expect(pi.getActiveTools()).toEqual([...LEAF_PROFILE, ...DELEGATION_PROVIDER_TOOLS]);
    expect(delegation.content[0]!.text).toContain("workstream_spawn");
    expect(delegation.content[0]!.text).toContain("A child inherits NONE of your conversation");

    // Prefix families resolve against the live registry; no digest for them.
    const browser = await enable.execute("id", { family: "browser" }, undefined);
    expect(pi.getActiveTools()).toContain("browser_navigate");
    expect(pi.getActiveTools()).toContain("browser_click");
    expect(browser.content[0]!.text).not.toContain("A child inherits NONE");

    // Re-enabling an active family is a no-op: no redundant setActiveTools call
    // and no digest replay.
    const setCallsBefore = pi.setCalls.length;
    const again = await enable.execute("id", { family: "delegation" }, undefined);
    expect(pi.setCalls).toHaveLength(setCallsBefore);
    expect(again.content[0]!.text).toContain("already active");
  });

  // The defect this whole mechanism exists to prevent: under the old launch
  // `--tools` allowlist pi DELETED unlisted tools from its registry, and
  // enable_toolset reported success anyway. Against pi's real semantics
  // (setActiveToolsByName silently drops unregistered names), an unregisterable
  // family must fail loudly rather than return a success-shaped answer.
  it("enable_toolset FAILS when the family is not in pi's registry", async () => {
    const pi = makeFakePi(LEAF_PROFILE); // registry == profile: nothing dormant
    const tools = await loadInto(pi);
    process.env.T3_ACTIVE_TOOLS = LEAF_PROFILE.join(",");
    pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" });
    const enable = tools.find((tool) => tool.name === "enable_toolset")!;

    await expect(enable.execute("id", { family: "browser" }, undefined)).rejects.toThrow(
      /Could not enable the browser toolset/,
    );
    await expect(enable.execute("id", { family: "delegation" }, undefined)).rejects.toThrow(
      /Could not enable the delegation toolset/,
    );
    expect(pi.getActiveTools()).toEqual(LEAF_PROFILE);
  });

  it("enable_toolset reports partially-registered families honestly", async () => {
    // A renamed/removed provider tool: the family list names it, the registry
    // does not. The result must claim only what pi actually activated.
    const missing = DELEGATION_PROVIDER_TOOLS[0];
    const pi = makeFakePi(REGISTRY.filter((name) => name !== missing));
    const tools = await loadInto(pi);
    process.env.T3_ACTIVE_TOOLS = LEAF_PROFILE.join(",");
    pi.handlers.get("session_start")!({ type: "session_start", reason: "startup" });
    const result = await tools
      .find((tool) => tool.name === "enable_toolset")!
      .execute("id", { family: "delegation" }, undefined);
    const text = result.content[0]!.text;
    expect(text).toContain("NOT enabled (not registered in this session): " + missing);
    expect(text).not.toMatch(new RegExp("Enabled the delegation toolset[^\\n]*" + missing));
    expect(pi.getActiveTools()).not.toContain(missing);
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

  it("long-polls ask_user_question until the broker returns an answer", async () => {
    calls.length = 0;
    let poll = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        headers: init.headers as Record<string, string>,
        body: String(init.body),
      });
      poll += 1;
      const body =
        poll === 1
          ? { pending: true, requestId: "ask-1" }
          : { pending: false, requestId: "ask-1", outcome: "answered", rendered: "ANSWERED" };
      return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    }) as unknown as typeof globalThis.fetch;
    const tools = await loadExtension();
    const ask = tools.find((tool) => tool.name === "ask_user_question")!;
    const result = await ask.execute(
      "id",
      { questions: [{ header: "Choice", question: "Which?", options: [] }] },
      undefined,
    );
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[1]!.body)).toEqual({ requestId: "ask-1" });
    expect(result.content[0]!.text).toBe("ANSWERED");
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

describe("effective-prompt debug capture", () => {
  afterAll(() => {
    delete process.env.T3_PROMPT_DEBUG_PATH;
    NodeFS.rmSync(handlerTmpDir, { recursive: true, force: true });
  });

  it("registers a before_agent_start handler", async () => {
    const { handlers } = await loadExtensionWithHandlers();
    expect(handlers.has("before_agent_start")).toBe(true);
  });

  it("reports the structured prompt inputs and defers exact bytes to the verbatim block", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prompt-debug-"));
    const sidecar = NodePath.join(dir, "thread-1.md");
    process.env.T3_PROMPT_DEBUG_PATH = sidecar;
    const { handlers } = await loadExtensionWithHandlers();
    const result = handlers.get("before_agent_start")!(sampleAgentStartEvent());
    // Must never return a value (a result would mutate the run).
    expect(result).toBeUndefined();
    const md = NodeFS.readFileSync(sidecar, "utf8");
    // Framed honestly as structured INPUTS, not a reconstruction of pi's output.
    expect(md).toContain("# Effective prompt");
    expect(md).toContain("STRUCTURED INPUTS");
    expect(md).toContain("## System prompt inputs");
    // No claim of reproducing pi's assembly (no numbered/embedded-base sections).
    expect(md).not.toContain("assembled order");
    expect(md).not.toContain("embedded in base");
    // Inputs rendered as provided.
    expect(md).toContain("### Custom base prompt");
    expect(md).toContain("(none \u2014 pi uses its built-in coding-assistant base prompt");
    expect(md).toContain("T3 WORK MODEL + ROLE OVERLAY + GOAL");
    expect(md).toContain("/work/tree/AGENTS.md");
    expect(md).toContain("AGENTS CONTENT");
    // Skill input includes its location; description preserved.
    expect(md).toContain("**pdf** (`/skills/pdf/SKILL.md`): make pdfs");
    // Tools + guidelines reported as provided inputs, with honest deferral notes.
    expect(md).toContain("- Selected: read, bash, workstream_spawn");
    expect(md).toContain("`read`: read a file");
    expect(md).toContain("- be concise");
    expect(md).toContain("pi may add conditional (tool-dependent) and always-on guidelines");
    expect(md).toContain("KICKOFF BRIEF with ```fenced``` content");
    // Section presence + order of the INPUT view (a navigational aid).
    const order = [
      "## System prompt inputs",
      "### Custom base prompt",
      "### Appended system prompt",
      "### Project context files",
      "### Skills provided",
      "### Tools + snippets provided",
      "### Prompt guidelines provided",
      "### Working directory",
      "## User prompt (this agent start)",
      "## Full assembled system prompt",
    ].map((h) => md.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Dynamic fence integrity: the systemPrompt contains ``` and ~~~, so the
    // chosen tilde fence must be longer than any tilde run inside it, and the
    // fenced body must round-trip exactly.
    const fenceMatch = md.match(/\n(~{4,})\nFULL ASSEMBLED SYSTEM PROMPT/);
    expect(fenceMatch).not.toBeNull();
    const fence = fenceMatch![1]!;
    expect(fence.length).toBeGreaterThanOrEqual(4);
    expect(md).toContain(
      `${fence}\nFULL ASSEMBLED SYSTEM PROMPT\nwith ~~~ tildes and \`\`\` backticks\n${fence}`,
    );
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("renders custom base prompt and honest skill inputs (location + disabled flag)", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prompt-debug-"));
    const sidecar = NodePath.join(dir, "thread-c.md");
    process.env.T3_PROMPT_DEBUG_PATH = sidecar;
    const { handlers } = await loadExtensionWithHandlers();
    handlers.get("before_agent_start")!(customPromptAgentStartEvent());
    const md = NodeFS.readFileSync(sidecar, "utf8");
    // Custom base prompt shown as an input; no reimplemented base branching.
    expect(md).toContain("- Custom base prompt: yes");
    expect(md).toContain("MY CUSTOM BASE PROMPT");
    expect(md).not.toContain("embedded in base");
    // Skills reported as PROVIDED (not "injected"), with location + disabled flag.
    expect(md).toContain("**pdf** (`/skills/pdf/SKILL.md`): make pdfs");
    expect(md).toContain(
      "**secret** (`/skills/secret/SKILL.md`) \u2014 disable-model-invocation: hidden",
    );
    // We do NOT assert what pi ultimately injects \u2014 that is the verbatim block's job.
    expect(md).toContain("## Full assembled system prompt");
    expect(md).toContain("CUSTOM ASSEMBLED PROMPT");
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("preserves the FIRST capture byte-identically across process restarts while the latest advances", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "prompt-debug-"));
    const sidecar = NodePath.join(dir, "thread-1.md");
    const firstSidecar = NodePath.join(dir, "thread-1.first.md");
    process.env.T3_PROMPT_DEBUG_PATH = sidecar;

    // First pi process: agent start captures the kickoff.
    const ext1 = await loadExtensionWithHandlers();
    ext1.handlers.get("before_agent_start")!(sampleAgentStartEvent({ prompt: "ORIGINAL KICKOFF" }));
    const firstAfterRun1 = NodeFS.readFileSync(firstSidecar, "utf8");
    expect(firstAfterRun1).toContain("ORIGINAL KICKOFF");
    expect(NodeFS.readFileSync(sidecar, "utf8")).toContain("ORIGINAL KICKOFF");

    // A second, fresh extension instance = a restarted/resumed pi process whose
    // in-process index resets to 1. Its capture must NOT clobber .first.md.
    const ext2 = await loadExtensionWithHandlers();
    ext2.handlers.get("before_agent_start")!(
      sampleAgentStartEvent({ prompt: "LATER RESUME PROMPT" }),
    );
    // Latest advanced to the resume prompt.
    expect(NodeFS.readFileSync(sidecar, "utf8")).toContain("LATER RESUME PROMPT");
    // First capture is byte-identical to the original kickoff capture.
    expect(NodeFS.readFileSync(firstSidecar, "utf8")).toBe(firstAfterRun1);
    expect(NodeFS.readFileSync(firstSidecar, "utf8")).not.toContain("LATER RESUME PROMPT");
    // No stray temp siblings left behind.
    const leftovers = NodeFS.readdirSync(dir).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });

  it("no-ops silently when the env var is absent", async () => {
    delete process.env.T3_PROMPT_DEBUG_PATH;
    const { handlers } = await loadExtensionWithHandlers();
    expect(() => handlers.get("before_agent_start")!(sampleAgentStartEvent())).not.toThrow();
  });

  it("swallows a write failure without throwing", async () => {
    // A path under a non-existent directory makes writeFileSync throw ENOENT.
    process.env.T3_PROMPT_DEBUG_PATH = NodePath.join(
      handlerTmpDir,
      "does",
      "not",
      "exist",
      "thread.md",
    );
    const { handlers } = await loadExtensionWithHandlers();
    expect(() => handlers.get("before_agent_start")!(sampleAgentStartEvent())).not.toThrow();
  });
});
