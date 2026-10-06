/**
 * Hand-registers Loom's tools on `/mcp` the way upstream registers its image
 * tools (`registerImageTool` in `McpHttpServer.ts`), because `McpServer.toolkit`
 * would JSON-stringify every result (P3-1). A success is the rendered markdown
 * as one text block; a failure is its message as text, flagged `isError` only
 * for throw-mode tools. No `structuredContent`: the text is the contract.
 * `_meta` carries the prompt snippet and guidelines for the bridge (P3-2).
 *
 * @module mcp/toolkits/workstream/registration
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { requireWorkstreamCaller, type WorkstreamCaller } from "./authorisation.ts";
import { LOOM_TOOL_DEFS, LoomToolError, type LoomToolDef, type LoomToolHandlers } from "./defs.ts";
import { makeLoomToolHandlers } from "./handlers.ts";

const textResult = (text: string, isError: boolean) =>
  new McpSchema.CallToolResult({ isError, content: [{ type: "text", text }] });

/**
 * One call, start to finish: authorise, decode, run, and shape the result. A
 * success is one text block; a failure is its message, `isError` per the
 * tool's error mode.
 */
export const callLoomTool = (def: LoomToolDef, handlers: LoomToolHandlers, payload: unknown) =>
  Effect.gen(function* () {
    const caller = yield* requireWorkstreamCaller();
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
  }).pipe(
    Effect.match({
      onSuccess: (rendered) => textResult(rendered, false),
      onFailure: (error) => textResult(error.message, def.errorMode === "throw"),
    }),
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
