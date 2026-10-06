/**
 * Calls a Loom tool as a given thread, through `callLoomTool` (the function
 * `/mcp` registration serves) with the real handler record, on V2's real
 * orchestrator (`LoomOrchestratorTestLayer`). Settings, provider catalogue and
 * health are test layers; reports and briefs land in a temp state dir.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, ProviderInstanceId, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../../../config.ts";
import * as GitWorkflowService from "../../../../git/GitWorkflowService.ts";
import * as LoomGoalBroadcast from "../../../../loom/projection/LoomGoalBroadcast.ts";
import { LoomOrchestratorTestLayer } from "../../../../loom/testkit/loomOrchestratorLayer.ts";
import { LoomThreadConsult } from "../../../../loom/workstream/consult.ts";
import * as ThreadLaunchService from "../../../../orchestration-v2/ThreadLaunchService.ts";
import { ProviderHealthRegistry } from "../../../../provider/Services/ProviderHealthRegistry.ts";
import { ProviderRegistry } from "../../../../provider/Services/ProviderRegistry.ts";
import * as ServerSettings from "../../../../serverSettings.ts";
import * as McpInvocationContext from "../../../McpInvocationContext.ts";
import { LOOM_TOOL_DEFS, type LoomMcpToolName } from "../defs.ts";
import { makeLoomToolHandlers } from "../handlers.ts";
import { callLoomTool } from "../registration.ts";

/** The services a test replaces: launch (mcp__t3-code__goal_handoff), the consult fork, git. Unstubbed calls die. */
export type StubbedServices =
  | ThreadLaunchService.ThreadLaunchService
  | LoomThreadConsult
  | GitWorkflowService.GitWorkflowService;

export const DefaultServiceStubs = Layer.mergeAll(
  Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
  Layer.mock(LoomThreadConsult)({}),
  Layer.mock(GitWorkflowService.GitWorkflowService)({}),
);

/** The handler test layer with `stubs` for the services a test drives (they may use the orchestrator). */
export const makeHandlerTestLayer = <E, R>(stubs: Layer.Layer<StubbedServices, E, R>) =>
  Layer.mergeAll(
    ServerSettings.layerTest(),
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-handlers-" }),
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([]) }),
    Layer.mock(ProviderHealthRegistry)({
      snapshot: Effect.succeed([]),
      usage: Effect.succeed([]),
    }),
    LoomGoalBroadcast.layer,
    stubs,
  ).pipe(Layer.provideMerge(LoomOrchestratorTestLayer), Layer.provideMerge(NodeServices.layer));

export const HandlerTestLayer = makeHandlerTestLayer(DefaultServiceStubs);

/** One tool call as `threadId`: the rendered text and whether it failed. */
export const callAs = Effect.fn("loom.testkit.callAs")(function* (
  threadId: ThreadId,
  name: LoomMcpToolName,
  payload: unknown,
) {
  const handlers = yield* makeLoomToolHandlers;
  const result = yield* callLoomTool(
    LOOM_TOOL_DEFS.find((def) => def.name === name)!,
    handlers,
    payload,
  ).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment-loom-handlers"),
      requestNamespace: `session-${threadId}`,
      thread: {
        threadId,
        providerSessionId: `session-${threadId}`,
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(["workstream"] as const),
      issuedAt: 1,
    }),
  );
  return {
    isError: result.isError === true,
    text: result.content.map((block) => ("text" in block ? block.text : "")).join(""),
  };
});

/** The child id in a spawn's confirmation line. */
export const spawnedId = (text: string) =>
  text.match(/^Spawned Workstream sub-thread (\S+):/)![1]! as ThreadId;
