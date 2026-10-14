// loom: Loom extension part — a consult fork (`T3_LOOM_CONSULT_FORK=1`, set by
// `loom/workstream/consult.ts`) refuses pi's `edit` and `write`, the two tools whose only
// purpose is changing files. A blocking `tool_call` hook, not a narrower tool set: hooks are
// not declarations, so the fork's request prefix stays the target's (a warm cache). Bash stays
// open for inspection; the server refuses every state-changing MCP call on its own.
import type { LoomExtensionPart } from "../loomExtension.ts";

export const consultGuardPart: LoomExtensionPart = {
  name: "consult-guard",
  source: `
if (process.env.T3_LOOM_CONSULT_FORK === "1") {
  pi.on("tool_call", (event) =>
    event.toolName === "edit" || event.toolName === "write"
      ? { block: true, reason: "This is a read-only consult fork: " + event.toolName + " is refused. Answer from this session's context; reading and inspecting still work." }
      : undefined,
  );
}
`,
};
