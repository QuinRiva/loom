/**
 * The production `/mcp` layer served over a test HTTP server, with a JSON-RPC
 * client per credential — the pattern of `toolkits/worktree/registration.test.ts`.
 * Services the toolkits need are stubbed by the caller.
 */
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../../../config.ts";
import * as DeviceService from "../../../device/DeviceService.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../../../git/GitWorkflowService.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../../project/ProjectSetupScriptRunner.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as VcsStatusBroadcaster from "../../../vcs/VcsStatusBroadcaster.ts";
import * as LoomGoalBroadcast from "../../../loom/projection/LoomGoalBroadcast.ts";
import * as LoomStore from "../../../loom/projection/LoomStore.ts";
import { LoomThreadConsult } from "../../../loom/workstream/consult.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import { ProviderHealthRegistry } from "../../../provider/ProviderHealthRegistry.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import type { McpCapability } from "../../McpInvocationContext.ts";
import * as McpSessionRegistry from "../../McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

export interface McpServiceStubs {
  readonly orchestrator?: Partial<Orchestrator.OrchestratorV2["Service"]>;
  readonly projects?: Partial<ProjectService.ProjectService["Service"]>;
  readonly loomStore?: Pick<
    Partial<LoomStore.LoomStoreV2["Service"]>,
    "getWorkstream" | "listWorkstreamTree" | "listChildren"
  >;
}

const stubServices = (stubs: McpServiceStubs) =>
  Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)(stubs.orchestrator ?? {}),
    Layer.mock(ProjectService.ProjectService)(stubs.projects ?? {}),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
    Layer.mock(DeviceService.DeviceService)({}),
    Layer.mock(ThreadManagementService.ThreadManagementService)({}),
    Layer.mock(ProviderRegistry.ProviderRegistry)({}),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
    Layer.mock(SecretRequests.SecretRequests)({}),
    ServerSettings.layerTest({}),
    Layer.mock(GitWorkflowService.GitWorkflowService)({}),
    Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({}),
    loomToolkitServiceStubs(stubs.loomStore),
  );

/** Every service Loom's toolkit captures when `/mcp` builds, stubbed (one line in upstream's tests). */
export const loomToolkitServiceStubs = (loomStore: McpServiceStubs["loomStore"] = {}) =>
  Layer.mergeAll(
    Layer.mock(LoomStore.LoomStoreV2)({
      goals: {} as never,
      tasks: {} as never,
      consults: {} as never,
      peerMessages: {} as never,
      ...loomStore,
    }),
    Layer.mock(ProviderHealthRegistry)({}),
    Layer.mock(LoomGoalBroadcast.LoomGoalBroadcast)({}),
    Layer.mock(LoomThreadConsult)({}),
    Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  );

export interface McpToolResult {
  readonly isError?: boolean;
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
  readonly structuredContent?: unknown;
}

export interface McpListedTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: { readonly type?: string };
  readonly annotations?: Record<string, unknown>;
  readonly _meta?: Record<string, unknown>;
}

/**
 * Serves `/mcp` and issues a credential for `threadId` through the real
 * registry with the given capabilities (undefined = upstream's default set).
 */
export const serveMcp = Effect.fn("serveMcp")(function* (
  stubs: McpServiceStubs,
  credential: {
    readonly threadId: ThreadId;
    readonly capabilities?: ReadonlyArray<McpCapability>;
  },
) {
  yield* HttpRouter.serve(McpHttpServer.layer.pipe(Layer.provide(McpSessionRegistry.layer)), {
    disableListenLog: true,
    disableLogger: true,
  }).pipe(
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed("environment-loom-mcp" as never),
      }),
    ),
    Layer.provide(PreviewAutomationBroker.layer),
    Layer.provide(stubServices(stubs)),
    Layer.build,
  );
  const issued = yield* McpSessionRegistry.issueActiveMcpCredential({
    threadId: credential.threadId,
    providerInstanceId: ProviderInstanceId.make("pi"),
    ...(credential.capabilities === undefined
      ? {}
      : { capabilities: new Set(credential.capabilities) }),
  });
  const authorization = issued!.config.authorizationHeader;
  const httpClient = yield* HttpClient.HttpClient;
  let nextId = 1;
  const post = (method: string, params: unknown, sessionId?: string) =>
    httpClient
      .post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          authorization,
          "mcp-protocol-version": "2025-06-18",
          ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
        },
        body: HttpBody.text(
          JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
          "application/json",
        ),
      })
      .pipe(Effect.orDie);
  const init = yield* post("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "loom-test", version: "1.0.0" },
  });
  const sessionId = init.headers["mcp-session-id"];
  const rpc = <A>(method: string, params: unknown) =>
    post(method, params, sessionId).pipe(
      Effect.flatMap((response) => response.text),
      Effect.orDie,
      Effect.map((text) => (JSON.parse(text.match(/\{.*\}/s)![0]) as { result: A }).result),
    );
  return {
    listTools: rpc<{ readonly tools: ReadonlyArray<McpListedTool> }>("tools/list", {}).pipe(
      Effect.map((result) => result.tools),
    ),
    callTool: (name: string, args: unknown) =>
      rpc<McpToolResult>("tools/call", { name, arguments: args }),
  };
});

export const mcpTestLayer = Layer.mergeAll(
  NodeHttpServer.layerTest,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-mcp-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
  NodeServices.layer,
);

export const LOOM_TEST_THREAD = ThreadId.make("thread-loom-caller");
