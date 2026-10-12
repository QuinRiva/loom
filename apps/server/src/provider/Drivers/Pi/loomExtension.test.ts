// @effect-diagnostics nodeBuiltinImport:off
/**
 * Loom's pi extension, built from its parts and run against a stub `pi` and a
 * stub `fetch` (the pattern of `piT3McpExtensionSource.test.ts`): the profile
 * at `session_start`, the per-turn re-assertion (P3-4) keeping `tool_search` discoveries,
 * the deny-list and the human-input rule, `mcp__t3-code__ask_user_question` across a
 * dropped poll, and 3c's parts assembled in (the prompt-debug capture).
 */
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import { HUMAN_INPUT_REFUSAL } from "../../../loom/prompt/prose.ts";
import { assembleLoomExtensionSource, LOOM_EXTENSION_PARTS } from "./loomExtension.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;
type Exposure = "direct" | "deferred" | "hidden";
interface StubTool {
  readonly name: string;
  readonly exposure?: Exposure;
  readonly execute: (
    id: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{
    readonly content: ReadonlyArray<{ readonly text: string }>;
  }>;
}

const SUBMIT = "mcp__t3-code__workstream_submit";
const SPAWN = "mcp__t3-code__workstream_spawn";
const ASK = "mcp__t3-code__ask_user_question";
const DELEGATE = "mcp__t3-code__delegate_task";
const THREAD_SEND = "mcp__t3-code__t3_thread_send";

const profile = (overrides: Record<string, unknown> = {}) => ({
  activeTools: ["read", SUBMIT],
  humanEngaged: false,
  hasParent: true,
  denyList: [DELEGATE, THREAD_SEND],
  promptDebugPath: null,
  ...overrides,
});

const response = (status: number, body: unknown) => ({
  ok: status < 400,
  status,
  text: async () => JSON.stringify(body),
});

/** Loads the assembled extension into a stub pi with `fetch` answering per request. */
const load = async (
  fetchImpl: (url: string, init: { method: string; body?: string }) => unknown,
  // As upstream's bridge registers them: t3-code tools deferred, withheld ones hidden.
  registered: Readonly<Record<string, Exposure>> = {
    read: "direct",
    bash: "direct",
    tool_search: "direct",
    [SUBMIT]: "deferred",
    [DELEGATE]: "hidden",
    [SPAWN]: "deferred",
  },
) => {
  const handlers = new Map<string, Array<Handler>>();
  const tools = new Map<string, StubTool>();
  const all = new Map(Object.entries(registered));
  let active = new Set(
    [...all].flatMap(([name, exposure]) => (exposure === "direct" ? [name] : [])),
  );
  const notices: Array<string> = [];
  // pi activates a direct tool on registration and never declares a hidden one.
  const register = (name: string, exposure: Exposure = "direct") => {
    all.set(name, exposure);
    if (exposure === "direct") active.add(name);
    if (exposure === "hidden") active.delete(name);
  };
  const pi = {
    on: (name: string, handler: Handler) =>
      handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    registerTool: (tool: StubTool) => {
      tools.set(tool.name, tool);
      register(tool.name, tool.exposure);
    },
    getAllTools: () => [...all].map(([name, exposure]) => ({ name, exposure })),
    getActiveTools: () => [...active],
    setActiveTools: (names: ReadonlyArray<string>) => {
      active = new Set(names.filter((name) => all.has(name) && all.get(name) !== "hidden"));
    },
  };
  const source = NodeModule.stripTypeScriptTypes(
    assembleLoomExtensionSource(LOOM_EXTENSION_PARTS).replace(
      "export default function",
      "function",
    ),
  );
  NodeVM.runInNewContext(`${source}\nloomExtension(pi)`, {
    pi,
    process: {
      env: { T3_MCP_URL: "http://127.0.0.1:4100/mcp", T3_MCP_BEARER_TOKEN: "token-1" },
      pid: 1,
      getBuiltinModule: (name: string) =>
        ({ "node:fs": NodeFS, "node:os": NodeOS, "node:path": NodePath })[name],
    },
    fetch: async (url: string, init: { method: string; body?: string }) => fetchImpl(url, init),
    URL,
    setTimeout: (resume: () => void) => {
      resume();
      return 0;
    },
    clearTimeout: () => undefined,
  });
  const emit = async (name: string, event: unknown = {}) => {
    for (const handler of handlers.get(name) ?? [])
      await handler(event, { ui: { notify: (message: string) => notices.push(message) } });
  };
  return {
    emit,
    register,
    // What pi's tool_search does with a match: setActiveTools([...active, ...matches]).
    search: (name: string) => pi.setActiveTools([...active, name]),
    exposure: (name: string) => all.get(name),
    active: () => [...active].toSorted(),
    notices,
    call: (name: string, params: unknown) => tools.get(name)!.execute(`call-${name}`, params),
  };
};

const serving = (current: () => unknown) => (url: string) =>
  url.endsWith("/loom/agent/session-profile") ? response(200, current()) : response(404, {});

describe("Loom pi extension", () => {
  it("applies the session profile at session_start, with tool_search", async () => {
    const pi = await load(serving(() => profile()));
    await pi.emit("session_start");
    assert.deepEqual(pi.active(), ["read", SUBMIT, "tool_search"].toSorted());
  });

  it("re-asserts the profile every turn and keeps what tool_search activated", async () => {
    const pi = await load(serving(() => profile()));
    await pi.emit("session_start");
    pi.search(SPAWN);
    pi.register(THREAD_SEND); // a late direct registration outside the profile
    assert.include(pi.active(), THREAD_SEND);

    await pi.emit("before_agent_start");

    assert.deepEqual(pi.active(), ["read", SUBMIT, SPAWN, "tool_search"].toSorted());
  });

  it("hides mcp__t3-code__ask_user_question on a child nobody has written to, and offers it once a person has", async () => {
    let current = profile();
    const pi = await load(serving(() => current));
    await pi.emit("session_start");
    assert.equal(pi.exposure(ASK), "hidden");
    assert.notInclude(pi.active(), ASK);
    const refusal = await pi.call(ASK, { questions: [] }).then(
      () => undefined,
      (error: Error) => error.message,
    );
    assert.equal(refusal, HUMAN_INPUT_REFUSAL);

    current = profile({ humanEngaged: true });
    await pi.emit("before_agent_start");
    assert.equal(pi.exposure(ASK), "direct");
    assert.include(pi.active(), ASK); // the human-engaged cue is the tool itself (P3-5)
  });

  it("keeps pi's default surface and warns once when the profile is unavailable", async () => {
    const pi = await load(() => response(500, { message: "boom" }));
    const before = pi.active();
    await pi.emit("session_start");
    await pi.emit("before_agent_start");
    assert.deepEqual(pi.active(), before);
    assert.equal(pi.notices.length, 1);
    assert.include(pi.notices[0]!, "boom");
  });

  it("mcp__t3-code__ask_user_question re-attaches after a dropped poll and returns the answer", async () => {
    const posts: Array<unknown> = [];
    const polls = [
      () => {
        throw new TypeError("fetch failed");
      },
      () => response(200, { pending: true }),
      () => response(200, { pending: false, rendered: "The user answered:\n- Ship?: Yes" }),
    ];
    let polled = 0;
    const pi = await load((url, init) => {
      if (url.endsWith("/loom/agent/session-profile"))
        return response(200, profile({ humanEngaged: true }));
      if (url.endsWith("/user-input/ask")) {
        posts.push(JSON.parse(init.body!));
        return response(200, { requestId: "loom-ask:t:call-1" });
      }
      assert.isTrue(url.endsWith("/user-input/loom-ask%3At%3Acall-1/wait"));
      return polls[polled++]!();
    });
    await pi.emit("session_start");
    const result = await pi.call(ASK, { questions: [{ header: "Ship" }] });
    assert.equal(result.content[0]!.text, "The user answered:\n- Ship?: Yes");
    assert.equal(polled, 3);
    assert.deepEqual(posts, [{ toolCallId: `call-${ASK}`, questions: [{ header: "Ship" }] }]);
  });

  it("assembles 3c's search guard and prompt-debug parts, and captures the prompt to the profile's path", async () => {
    const source = assembleLoomExtensionSource(LOOM_EXTENSION_PARTS);
    for (const name of ["toolProfile", "askUserQuestion", "search-guard", "prompt-debug"])
      assert.include(source, `[${JSON.stringify(name)}, (pi, ctx) => {`);

    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "loom-prompt-debug-"));
    const promptDebugPath = NodePath.join(dir, "thread-1.md");
    const pi = await load(serving(() => profile({ promptDebugPath })));
    await pi.emit("session_start");
    await pi.emit("before_agent_start", {
      prompt: "Do the work.",
      systemPrompt: "SYSTEM PROMPT BYTES",
      systemPromptOptions: { appendSystemPrompt: "LOOM ADDENDUM", cwd: "/work" },
    });
    await new Promise((resume) => setImmediate(resume)); // the capture is fire-and-forget

    const captured = NodeFS.readFileSync(promptDebugPath, "utf8");
    assert.include(captured, "LOOM ADDENDUM");
    assert.include(captured, "SYSTEM PROMPT BYTES");
    assert.equal(NodeFS.readFileSync(NodePath.join(dir, "thread-1.first.md"), "utf8"), captured);
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});
