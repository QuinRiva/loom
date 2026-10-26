// loom: Loom extension part — a query thread (`T3_LOOM_QUERY_FORK=1`, set by the session
// composer for role `document-query`) refuses pi's `edit` and `write`, as `consultGuard.ts` does
// for a consult fork and for the same reason: a hook, not a narrower tool set, so the query
// thread declares its author's tools and reads the author's warm cache. Its credential is
// read-only too, so the server refuses every state-changing MCP call on its own.
import { LOOM_QUERY_FORK_ENV } from "../../../../loom/query/queryPosture.ts";
import type { LoomExtensionPart } from "../loomExtension.ts";

export const queryGuardPart: LoomExtensionPart = {
  name: "query-guard",
  source: `
if (process.env.${LOOM_QUERY_FORK_ENV} === "1") {
  pi.on("tool_call", (event) =>
    event.toolName === "edit" || event.toolName === "write"
      ? { block: true, reason: "This is a read-only query thread: " + event.toolName + " is refused. The author (the thread named in this thread's kickoff brief) is the document's only writer. Say what you would change instead; the human can Promote the exchange to the author as a comment." }
      : undefined,
  );
}
`,
};
