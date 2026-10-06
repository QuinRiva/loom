/**
 * The handler record registration serves. Every entry is a stub until 3a-2
 * (workstream_* handlers) and 3a-3 (goal, fork, title, consult, notify) fill
 * it; a stub fails with the tool's own error mode, so the agent sees the call
 * reach the server.
 *
 * @module mcp/toolkits/workstream/handlers
 */
import * as Effect from "effect/Effect";

import { LOOM_TOOL_DEFS, LoomToolError, type LoomToolHandlers } from "./defs.ts";

const notPorted = Object.fromEntries(
  LOOM_TOOL_DEFS.map((def) => [
    def.name,
    () => Effect.fail(new LoomToolError({ message: `${def.name} is not ported in 3a-1.` })),
  ]),
) as unknown as LoomToolHandlers;

/** Builds the record; later sessions yield their services here and replace entries. */
export const makeLoomToolHandlers = Effect.succeed<LoomToolHandlers>(notPorted);
