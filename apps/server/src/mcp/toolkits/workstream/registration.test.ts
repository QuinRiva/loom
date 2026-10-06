import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import type { WorkstreamCaller } from "./authorisation.ts";
import { LOOM_TOOL_DEFS, LoomToolError, type LoomToolHandlers } from "./defs.ts";
import { LOOM_TEST_THREAD, mcpTestLayer, serveMcp } from "./mcpHttp.testkit.ts";
import { LOOM_TOOL_PROSE } from "./prose.ts";
import { callLoomTool } from "./registration.ts";

const scope = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: ThreadId.make("thread-caller"),
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("pi"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const defOf = (name: string) => LOOM_TOOL_DEFS.find((def) => def.name === name)!;

const handlers = {
  workstream_list: (_input: unknown, caller: WorkstreamCaller) =>
    Effect.succeed(`list for ${caller.threadId}`),
  workstream_stop: () => Effect.fail(new LoomToolError({ message: "refused: not a child" })),
  goal_task_add: () => Effect.fail(new LoomToolError({ message: "no active goal" })),
} as unknown as LoomToolHandlers;

const call = (
  name: string,
  payload: unknown,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["workstream"],
) =>
  callLoomTool(defOf(name), handlers, payload).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope(capabilities)),
  );

it.effect("a success is one text block, isError false, no structuredContent", () =>
  Effect.gen(function* () {
    const result = yield* call("workstream_list", {});
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "list for thread-caller" }]);
    expect(result.structuredContent).toBeUndefined();
  }),
);

it.effect("a throw-mode failure is isError true with the rendered text", () =>
  Effect.gen(function* () {
    const result = yield* call("workstream_stop", { threadId: "t" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "refused: not a child" }]);
  }),
);

it.effect("a soft-mode failure is plain text", () =>
  Effect.gen(function* () {
    const result = yield* call("goal_task_add", { text: "x" });
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "no active goal" }]);
  }),
);

it.effect("a credential without workstream is refused before the handler runs", () =>
  Effect.gen(function* () {
    const result = yield* call("workstream_list", {}, ["orchestration", "pull-requests"]);
    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("workstream"),
    });
  }),
);

it.effect("unknown or mistyped parameters are refused, closed like the JSON schema", () =>
  Effect.gen(function* () {
    const extra = yield* call("workstream_stop", { threadId: "t", staged: true });
    expect(extra.isError).toBe(true);
    expect(extra.content[0]).toMatchObject({ text: expect.stringContaining("Invalid") });
    const mistyped = yield* call("workstream_stop", { threadId: 7 });
    expect(mistyped.isError).toBe(true);
  }),
);

it.effect("/mcp lists exactly the 21 Loom tools with _meta prose, object schemas and hints", () =>
  Effect.gen(function* () {
    const mcp = yield* serveMcp({}, { threadId: LOOM_TEST_THREAD, capabilities: ["workstream"] });
    const tools = yield* mcp.listTools;
    const loom = tools.filter((tool) => tool._meta?.["loom/promptSnippet"] !== undefined);
    expect(loom.map((tool) => tool.name).toSorted()).toEqual(
      LOOM_TOOL_DEFS.map((def) => def.name).toSorted(),
    );
    expect(loom).toHaveLength(21);
    for (const tool of loom) {
      const prose = LOOM_TOOL_PROSE[tool.name as keyof typeof LOOM_TOOL_PROSE];
      expect(tool.description).toBe(prose.description);
      expect(tool._meta).toEqual({
        "loom/promptSnippet": prose.promptSnippet,
        "loom/promptGuidelines": prose.promptGuidelines,
      });
      expect(tool.inputSchema.type, tool.name).toBe("object");
      expect(tool.annotations).toMatchObject({ destructiveHint: false, openWorldHint: false });
    }
    expect(loom.find((tool) => tool.name === "workstream_list")?.annotations).toMatchObject({
      readOnlyHint: true,
      idempotentHint: true,
    });
    // Upstream's toolkits are still listed beside Loom's.
    expect(tools.map((tool) => tool.name)).toContain("delegate_task");
  }).pipe(Effect.scoped, Effect.provide(mcpTestLayer)),
);

it.effect("every stub answers a workstream credential with its error mode", () =>
  Effect.gen(function* () {
    const mcp = yield* serveMcp({}, { threadId: LOOM_TEST_THREAD, capabilities: ["workstream"] });
    const list = yield* mcp.callTool("workstream_list", {});
    expect(list).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "workstream_list is not ported in 3a-1." }],
    });
    const tasks = yield* mcp.callTool("goal_task_list", {});
    expect(tasks).toMatchObject({
      content: [{ type: "text", text: "goal_task_list is not ported in 3a-1." }],
    });
    expect(tasks.isError ?? false).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(mcpTestLayer)),
);
