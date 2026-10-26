import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import { HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "../../../auth/EnvironmentAuth.ts";
import * as McpOAuth from "../../../auth/McpOAuth.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { documentQueryClient } from "../../../loom/query/queryPosture.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
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

// An outside agent signed in via upstream's MCP OAuth has no thread and no `workstream` capability.
// Loom's tools bypass McpToolAccess, so requireWorkstreamCaller must refuse before decoding or
// running a handler. The scope comes from upstream's real authenticator, so a widening shows here.

/** The scope upstream gives an outside agent signed in through MCP OAuth. */
const oauthScope = Effect.gen(function* () {
  const auth = yield* McpHttpServer.McpClientAuthenticator;
  const scope = yield* auth.authenticate(
    HttpServerRequest.fromWeb(new Request("http://t3.invalid/mcp")),
  );
  expect(scope).toBeDefined();
  expect(scope!.thread).toBeUndefined();
  return scope!;
}).pipe(
  Effect.provide(
    McpOAuth.layerMcpClientAuthenticator.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mock(EnvironmentAuth.EnvironmentAuth)({
            authenticateMcpClient: () =>
              Effect.succeed({
                sessionId: "oauth-session-1",
                label: "Outside agent",
                access: "full-access",
              } as unknown as EnvironmentAuth.McpClientSession),
          }),
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-1")),
          }),
        ),
      ),
    ),
  ),
);

/** Every Loom tool, each with a handler that records that it ran. */
const spyHandlers = () => {
  const ran: Array<string> = [];
  const spies = Object.fromEntries(
    LOOM_TOOL_DEFS.map((def) => [
      def.name,
      () =>
        Effect.sync(() => {
          ran.push(def.name);
          return "ran";
        }),
    ]),
  ) as unknown as LoomToolHandlers;
  return { ran, spies };
};

const callEveryTool = (scope: McpInvocationContext.McpInvocationScope) =>
  Effect.gen(function* () {
    const { ran, spies } = spyHandlers();
    const results = yield* Effect.forEach(LOOM_TOOL_DEFS, (def) =>
      callLoomTool(def, spies, {}).pipe(
        Effect.map((result) => ({ def, result })),
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      ),
    );
    return { ran, results };
  });

it.effect("an OAuth-signed outside agent is refused by every Loom tool before it runs", () =>
  Effect.gen(function* () {
    const scope = yield* oauthScope;
    expect(scope.capabilities.has("workstream")).toBe(false);
    const { ran, results } = yield* callEveryTool(scope);
    expect(results).toHaveLength(24);
    for (const { def, result } of results) {
      // A soft-mode tool refuses as plain text; only throw-mode tools set isError.
      expect(result.isError, def.name).toBe(def.errorMode === "throw");
      expect(result.content, def.name).toEqual([
        { type: "text", text: "MCP credential does not grant the workstream capability." },
      ]);
    }
    expect(ran).toEqual([]);
  }),
);

it.effect("a thread-less caller is refused even if it ever holds the workstream capability", () =>
  Effect.gen(function* () {
    const scope = yield* oauthScope;
    const { ran, results } = yield* callEveryTool({
      ...scope,
      capabilities: new Set([...scope.capabilities, "workstream" as const]),
    });
    for (const { def, result } of results)
      expect(result.content[0], def.name).toMatchObject({
        text: expect.stringContaining("need an agent running inside T3 Code"),
      });
    expect(ran).toEqual([]);
  }),
);

// A consult fork answers as its target under a read-only client: the server must refuse every
// Loom tool that changes state (consult_thread included, so forks cannot recurse) before its
// handler runs, and serve only the two reads.
it.effect("a read-only consult fork reaches only workstream_list and goal_task_list", () =>
  Effect.gen(function* () {
    const { ran, results } = yield* callEveryTool({
      ...scope(["workstream", "pull-requests"]),
      client: { sessionId: "consult-1", label: "consult fork", access: "read-only" },
    });
    expect(results).toHaveLength(24);
    for (const { def, result } of results) {
      if (def.name === "workstream_list" || def.name === "goal_task_list") {
        expect(result.content, def.name).toEqual([{ type: "text", text: "ran" }]);
        continue;
      }
      expect(result.isError, def.name).toBe(def.errorMode === "throw");
      expect(result.content, def.name).toEqual([
        {
          type: "text",
          text: `This is a read-only consult fork of thread thread-caller: ${def.name} changes workstream state and was refused. Answer from this session's context; workstream_list and goal_task_list still work.`,
        },
      ]);
    }
    expect(ran.toSorted()).toEqual(["goal_task_list", "workstream_list"]);
  }),
);

// A query thread is its own thread under a read-only client: it may also consult the live author,
// retitle itself and promote an exchange, and every other write is refused with the query thread's own refusal.
it.effect(
  "a query thread reaches the reads, consult_thread, set_thread_title and promote only",
  () =>
    Effect.gen(function* () {
      const { ran, results } = yield* callEveryTool({
        ...scope(["workstream", "pull-requests"]),
        client: documentQueryClient(ThreadId.make("thread-caller")),
      });
      const allowed = [
        "consult_thread",
        "document_query_promote",
        "goal_task_list",
        "set_thread_title",
        "workstream_list",
      ];
      for (const { def, result } of results) {
        // The ones with required parameters get past the gate and fail decoding the empty payload.
        if (allowed.includes(def.name)) {
          expect(result.content[0], def.name).not.toMatchObject({
            text: expect.stringContaining("read-only"),
          });
          continue;
        }
        expect(result.content, def.name).toEqual([
          {
            type: "text",
            text: `This is a read-only query thread: ${def.name} changes workstream state and was refused. The author is the document's only writer; the human promotes an exchange to it as a comment. workstream_list, goal_task_list, consult_thread and set_thread_title still work.`,
          },
        ]);
      }
      expect(ran.toSorted()).toEqual(["goal_task_list", "workstream_list"]);
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

it.effect("/mcp lists exactly the 24 Loom tools with _meta prose, object schemas and hints", () =>
  Effect.gen(function* () {
    const mcp = yield* serveMcp({}, { threadId: LOOM_TEST_THREAD, capabilities: ["workstream"] });
    const tools = yield* mcp.listTools;
    const loom = tools.filter((tool) => tool._meta?.["loom/promptSnippet"] !== undefined);
    expect(loom.map((tool) => tool.name).toSorted()).toEqual(
      LOOM_TOOL_DEFS.map((def) => def.name).toSorted(),
    );
    expect(loom).toHaveLength(24);
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
    for (const name of ["workstream_list", "thread_search"])
      expect(loom.find((tool) => tool.name === name)?.annotations, name).toMatchObject({
        readOnlyHint: true,
        idempotentHint: true,
      });
    // Upstream's toolkits are still listed beside Loom's.
    expect(tools.map((tool) => tool.name)).toContain("delegate_task");
  }).pipe(Effect.scoped, Effect.provide(mcpTestLayer)),
);

it.effect("/mcp serves the real handlers with their error modes", () =>
  Effect.gen(function* () {
    const mcp = yield* serveMcp(
      {
        loomStore: {
          getWorkstream: () => Effect.succeed(null),
          listChildren: () => Effect.succeed([]),
        },
      },
      { threadId: LOOM_TEST_THREAD, capabilities: ["workstream"] },
    );
    // A real handler reaches the server's services (here: the stubbed sidecar store).
    const brief = yield* mcp.callTool("workstream_brief", { node: "coder", markdown: "go" });
    expect(brief).toMatchObject({
      isError: true,
      content: [{ type: "text", text: expect.stringContaining('No direct child matches "coder"') }],
    });
    // A soft-mode refusal is plain text, not a failed call.
    const tasks = yield* mcp.callTool("goal_task_list", {});
    expect(tasks).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("has no active goal") }],
    });
    expect(tasks.isError ?? false).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(mcpTestLayer)),
);

// A Loom thread's credential carries `workstream` in place of upstream's `orchestration`. The
// scheduled-task tools accept it (the role profile decides which threads see them); the rest of
// upstream's OrchestratorToolkit still refuses it.
it.effect("a Loom credential reaches the scheduled-task tools and no other orchestrator tool", () =>
  Effect.gen(function* () {
    const shell = {
      ...liveThreadShell(LOOM_TEST_THREAD),
      providerInstanceId: ProviderInstanceId.make("pi"),
    };
    const mcp = yield* serveMcp(
      {
        threadManagement: {
          getThreadShell: () => Effect.succeed(shell),
          getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
        },
        projects: { getById: () => Effect.succeed(Option.none()) },
        scheduledTasks: { list: () => Effect.succeed({ tasks: [] }) },
      },
      { threadId: LOOM_TEST_THREAD, capabilities: ["workstream", "pull-requests"] },
    );
    const text = (result: { readonly content: ReadonlyArray<{ readonly text?: string }> }) =>
      result.content[0]?.text ?? "";
    expect(yield* mcp.callTool("list_scheduled_tasks", {})).toMatchObject({
      isError: false,
      structuredContent: { tasks: [] },
    });
    // Past the capability gate, each fails on what the stubs lack, not on the credential.
    const scheduled = yield* mcp.callTool("schedule_task", {
      prompt: "Measure the prompt",
      schedule: { type: "interval", everyMs: 3_600_000 },
    });
    expect(text(scheduled)).toContain("was not found");
    for (const [name, args] of [
      ["update_scheduled_task", { scheduledTaskId: "scheduled-task:gone", enabled: false }],
      ["delete_scheduled_task", { scheduledTaskId: "scheduled-task:gone" }],
    ] as const)
      expect(text(yield* mcp.callTool(name, args)), name).toContain('"code":"task_not_found"');
    for (const [name, args] of [
      ["t3_thread_list", {}],
      ["request_secret", { label: "Webhook secret", reason: "Signs the webhook." }],
    ] as const)
      expect(text(yield* mcp.callTool(name, args)), name).toContain('"code":"capability_denied"');
  }).pipe(Effect.scoped, Effect.provide(mcpTestLayer)),
);
