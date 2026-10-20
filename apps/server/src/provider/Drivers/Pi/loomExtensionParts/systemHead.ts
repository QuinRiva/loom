// loom: Loom extension part — keep pi's system message at the head of every request.
// Global packages (pi-session-search, and pi-memory unless perTurnInjection is false) send
// custom messages at `session_start`, before pi persists its first system message, so loom
// transcripts start [custom, custom, user, system, …]. pi's providers read the prompt and the
// initial tool list from messages[0] only: with none there, Anthropic gets no `system` field and
// resends the whole tool list on every `tool_search` load (a full cache rewrite), and Codex runs
// under a placeholder `instructions`. Request-local: the saved transcript is unchanged. A no-op
// when another extension (pi-craft's global copy) has already hoisted it.
import type { LoomExtensionPart } from "../loomExtension.ts";

export const systemHeadPart: LoomExtensionPart = {
  name: "systemHead",
  source: `
pi.on("context_with_system", (event) => {
  const m = event.messages;
  const i = m.findIndex((x) => x.role === "system");
  // Only user-side context may precede it: a model reply before it is a genuine legacy transcript.
  if (i <= 0 || m.slice(0, i).some((x) => x.role === "assistant" || x.role === "toolResult")) return;
  // Only the first moves; later system messages (tool additions, section patches) stay inline.
  return { messages: [m[i], ...m.slice(0, i), ...m.slice(i + 1)] };
});
`,
};
