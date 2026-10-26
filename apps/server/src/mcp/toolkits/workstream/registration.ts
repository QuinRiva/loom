/**
 * Hand-registers Loom's tools on `/mcp` like upstream's `registerImageTool`, because
 * `McpServer.toolkit` would JSON-stringify results. Text is the contract: rendered markdown, or the
 * error message (`isError` for throw-mode tools); `_meta` carries snippet and guidelines.
 *
 * @module mcp/toolkits/workstream/registration
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import { DOCUMENT_QUERY_CLIENT_LABEL } from "../../../loom/query/queryPosture.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  CONSULT_READ_TOOLS,
  DOCUMENT_QUERY_TOOLS,
  isReadOnlyCaller,
  requireWorkstreamCaller,
  type WorkstreamCaller,
} from "./authorisation.ts";
import { LOOM_TOOL_DEFS, LoomToolError, type LoomToolDef, type LoomToolHandlers } from "./defs.ts";
import { makeLoomToolHandlers } from "./handlers.ts";

const textResult = (text: string, isError: boolean) =>
  new McpSchema.CallToolResult({ isError, content: [{ type: "text", text }] });

/**
 * One call, start to finish: authorise, decode, run, and shape the result. A
 * success is one text block; a failure is its message, `isError` per the
 * tool's error mode.
 */
export const callLoomTool = Effect.fn("registration.callLoomTool")(
  function* (def: LoomToolDef, handlers: LoomToolHandlers, payload: unknown) {
    const caller = yield* requireWorkstreamCaller();
    // A consult fork answers as its target but may only read; a query thread may also consult,
    // retitle itself and promote (both refused before decoding).
    const query = caller.scope.client?.label === DOCUMENT_QUERY_CLIENT_LABEL;
    if (
      isReadOnlyCaller(caller.scope) &&
      !(query ? DOCUMENT_QUERY_TOOLS : CONSULT_READ_TOOLS).has(def.name)
    )
      return yield* new LoomToolError({
        message: query
          ? `This is a read-only query thread: ${def.name} changes workstream state and was refused. The author is the document's only writer; the human promotes an exchange to it as a comment. workstream_list, goal_task_list, consult_thread and set_thread_title still work.`
          : `This is a read-only consult fork of thread ${caller.threadId}: ${def.name} changes workstream state and was refused. Answer from this session's context; workstream_list and goal_task_list still work.`,
      });
    const input = yield* Schema.decodeUnknownEffect(def.input)(payload ?? {}, {
      onExcessProperty: "error",
    }).pipe(
      Effect.mapError(
        (error) =>
          new LoomToolError({ message: `Invalid ${def.name} parameters: ${error.message}` }),
      ),
    );
    // One correlation the compiler cannot see: `def.input` decodes `handlers[def.name]`'s input.
    const handle = handlers[def.name] as (
      input: unknown,
      caller: WorkstreamCaller,
    ) => Effect.Effect<string, LoomToolError>;
    return yield* handle(input, caller);
  },
  (effect, def, handlers, payload) =>
    effect.pipe(
      Effect.match({
        onSuccess: (rendered) => textResult(rendered, false),
        onFailure: (error) => textResult(error.message, def.errorMode === "throw"),
      }),
    ),
);

export const registerLoomToolkit = Effect.fn("LoomToolkit.register")(function* (
  defs: ReadonlyArray<LoomToolDef>,
  handlers: LoomToolHandlers,
) {
  const server = yield* McpServer.McpServer;
  for (const def of defs) {
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: def.name,
        title: def.label,
        description: def.description,
        inputSchema: def.parameters as McpSchema.Tool["inputSchema"],
        annotations: {
          title: def.label,
          readOnlyHint: def.readOnly,
          destructiveHint: false,
          idempotentHint: def.idempotent,
          openWorldHint: false,
        },
        _meta: {
          "loom/promptSnippet": def.promptSnippet,
          "loom/promptGuidelines": def.promptGuidelines,
        },
      }),
      annotations: Context.empty(),
      handle: (payload) =>
        Effect.withFiber((fiber) =>
          callLoomTool(def, handlers, payload).pipe(
            Effect.provideService(
              McpInvocationContext.McpInvocationContext,
              Context.getUnsafe(fiber.context, McpInvocationContext.McpInvocationContext),
            ),
          ),
        ),
    });
  }
});

/** Loom's toolkit on the MCP server; one marked line in `McpHttpServer.layer`. */
export const LoomToolkitRegistrationLive = Layer.effectDiscard(
  makeLoomToolHandlers.pipe(
    Effect.flatMap((handlers) => registerLoomToolkit(LOOM_TOOL_DEFS, handlers)),
  ),
);
