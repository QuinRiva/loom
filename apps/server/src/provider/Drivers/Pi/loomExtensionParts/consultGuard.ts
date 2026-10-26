// loom: Loom extension part: a consult fork (`T3_LOOM_CONSULT_FORK=1`) refuses pi's `edit`,
// `write` and `bg_start` (a job would outlive the answer). A blocking `tool_call` hook, not a
// narrower tool set, keeps the fork's request prefix (and warm cache) the target's. Bash stays open
// for inspection; the server refuses every state-changing MCP call itself.
import type { LoomExtensionPart } from "../loomExtension.ts";

export const consultGuardPart: LoomExtensionPart = {
  name: "consult-guard",
  source: `
if (process.env.T3_LOOM_CONSULT_FORK === "1") {
  pi.on("tool_call", (event) =>
    ["edit", "write", "bg_start"].includes(event.toolName)
      ? { block: true, reason: "This is a read-only consult fork: " + event.toolName + " is refused. Answer from this session's context; reading and inspecting still work." }
      : undefined,
  );
}
`,
};
