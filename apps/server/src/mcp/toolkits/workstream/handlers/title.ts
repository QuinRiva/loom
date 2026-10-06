/**
 * `set_thread_title`: the calling thread renames ITSELF (never another
 * thread) through upstream's `thread.metadata.update` — the command behind
 * upstream's own rename (`ThreadMetadataMcpService`, which a Loom credential
 * cannot reach: it needs the `orchestration` capability). An explicit title
 * clears any in-flight title regeneration, so it is not overwritten later.
 *
 * @module mcp/toolkits/workstream/handlers/title
 */
import { CommandId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { requestKey } from "../idempotency.ts";
import { dispatch, fail } from "./shared.ts";

export const setThreadTitle = Effect.fn("LoomToolkit.setThreadTitle")(function* (
  input: LoomToolInput<"set_thread_title">,
  caller: WorkstreamCaller,
) {
  const title = input.title.trim();
  if (!title) return yield* fail("title must be a non-empty string.");
  yield* dispatch({
    type: "thread.metadata.update",
    commandId: CommandId.make(`server:set-thread-title:${yield* requestKey(undefined)}`),
    threadId: caller.threadId,
    title,
  });
  return `Set this thread's title to "${title}".`;
});
