/**
 * The handler record registration serves. The workstream family is 3a-2's
 * (`handlers/*.ts`); the goal, fork, title, consult and notify entries stay
 * stubs until 3a-3, failing with the tool's own error mode so the agent sees
 * the call reach the server. Services are captured when the record is built,
 * so every handler runs with the server's context.
 *
 * @module mcp/toolkits/workstream/handlers
 */
import * as Effect from "effect/Effect";
import type * as Context from "effect/Context";

import type { WorkstreamCaller } from "./authorisation.ts";
import {
  LOOM_TOOL_DEFS,
  LoomToolError,
  type LoomMcpToolName,
  type LoomToolHandlers,
  type LoomToolInput,
} from "./defs.ts";
import { workstreamBrief } from "./handlers/brief.ts";
import { workstreamList } from "./handlers/list.ts";
import { workstreamSetOutcome } from "./handlers/outcome.ts";
import { workstreamPrompt } from "./handlers/prompt.ts";
import { workstreamRequestAttention } from "./handlers/attention.ts";
import { workstreamScaffold } from "./handlers/scaffold.ts";
import { workstreamSetDependencies } from "./handlers/dependencies.ts";
import { workstreamSpawn } from "./handlers/spawn.ts";
import { workstreamStop } from "./handlers/stop.ts";
import { workstreamSubmit } from "./handlers/submit.ts";

const notPorted = Object.fromEntries(
  LOOM_TOOL_DEFS.map((def) => [
    def.name,
    () => Effect.fail(new LoomToolError({ message: `${def.name} is not ported in 3a-1.` })),
  ]),
) as unknown as LoomToolHandlers;

const workstreamHandlers = {
  workstream_spawn: workstreamSpawn,
  workstream_scaffold: workstreamScaffold,
  workstream_brief: workstreamBrief,
  workstream_set_outcome: workstreamSetOutcome,
  workstream_request_attention: workstreamRequestAttention,
  workstream_stop: workstreamStop,
  workstream_prompt: workstreamPrompt,
  workstream_set_dependencies: workstreamSetDependencies,
  workstream_submit: workstreamSubmit,
  workstream_list: workstreamList,
} satisfies {
  readonly [N in LoomMcpToolName]?: (
    input: LoomToolInput<N>,
    caller: WorkstreamCaller,
  ) => Effect.Effect<string, LoomToolError, unknown>;
};

type HandlerServices = Effect.Services<
  ReturnType<(typeof workstreamHandlers)[keyof typeof workstreamHandlers]>
>;

/** Builds the record, providing each handler the services it needs from the building context. */
export const makeLoomToolHandlers = Effect.map(
  Effect.context<HandlerServices>(),
  (context: Context.Context<HandlerServices>): LoomToolHandlers => ({
    ...notPorted,
    ...(Object.fromEntries(
      Object.entries(workstreamHandlers).map(([name, handler]) => [
        name,
        (input: never, caller: never) =>
          (
            handler as (
              input: never,
              caller: never,
            ) => Effect.Effect<string, LoomToolError, HandlerServices>
          )(input, caller).pipe(Effect.provideContext(context)),
      ]),
    ) as Partial<LoomToolHandlers>),
  }),
);
