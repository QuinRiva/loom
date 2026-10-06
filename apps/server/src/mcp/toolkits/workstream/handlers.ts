/**
 * The handler record registration serves: one handler per tool
 * (`handlers/*.ts`), checked against the defs' decoded inputs. Services are
 * captured when the record is built, so every handler runs with the server's
 * context.
 *
 * @module mcp/toolkits/workstream/handlers
 */
import * as Effect from "effect/Effect";
import type * as Context from "effect/Context";

import type { WorkstreamCaller } from "./authorisation.ts";
import type { LoomMcpToolName, LoomToolError, LoomToolHandlers, LoomToolInput } from "./defs.ts";
import { workstreamBrief } from "./handlers/brief.ts";
import { consultThread } from "./handlers/consult.ts";
import { threadFork } from "./handlers/fork.ts";
import { goalContinue } from "./handlers/goalContinue.ts";
import { goalHandoff } from "./handlers/goalHandoff.ts";
import {
  goalTaskAdd,
  goalTaskList,
  goalTasksRewrite,
  goalTaskUpdate,
} from "./handlers/goalTasks.ts";
import { goalUpdate } from "./handlers/goalUpdate.ts";
import { notifyThread } from "./handlers/notify.ts";
import { setThreadTitle } from "./handlers/title.ts";
import { workstreamList } from "./handlers/list.ts";
import { workstreamSetOutcome } from "./handlers/outcome.ts";
import { workstreamPrompt } from "./handlers/prompt.ts";
import { workstreamRequestAttention } from "./handlers/attention.ts";
import { workstreamScaffold } from "./handlers/scaffold.ts";
import { workstreamSetDependencies } from "./handlers/dependencies.ts";
import { workstreamSpawn } from "./handlers/spawn.ts";
import { workstreamStop } from "./handlers/stop.ts";
import { workstreamSubmit } from "./handlers/submit.ts";

const loomHandlers = {
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
  consult_thread: consultThread,
  notify_thread: notifyThread,
  set_thread_title: setThreadTitle,
  thread_fork: threadFork,
  goal_task_list: goalTaskList,
  goal_task_add: goalTaskAdd,
  goal_task_update: goalTaskUpdate,
  goal_tasks_rewrite: goalTasksRewrite,
  goal_handoff: goalHandoff,
  goal_continue: goalContinue,
  goal_update: goalUpdate,
} satisfies {
  readonly [N in LoomMcpToolName]: (
    input: LoomToolInput<N>,
    caller: WorkstreamCaller,
  ) => Effect.Effect<string, LoomToolError, unknown>;
};

type HandlerServices = Effect.Services<
  ReturnType<(typeof loomHandlers)[keyof typeof loomHandlers]>
>;

/** Builds the record, providing each handler the services it needs from the building context. */
export const makeLoomToolHandlers = Effect.map(
  Effect.context<HandlerServices>(),
  (context: Context.Context<HandlerServices>): LoomToolHandlers =>
    Object.fromEntries(
      Object.entries(loomHandlers).map(([name, handler]) => [
        name,
        (input: never, caller: never) =>
          (
            handler as (
              input: never,
              caller: never,
            ) => Effect.Effect<string, LoomToolError, HandlerServices>
          )(input, caller).pipe(Effect.provideContext(context)),
      ]),
    ) as LoomToolHandlers,
);
