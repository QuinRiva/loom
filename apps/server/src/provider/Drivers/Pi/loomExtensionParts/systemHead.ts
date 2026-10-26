// loom: Loom extension part: hoist pi's system message to the head of every request. Global
// packages send custom messages at `session_start`, before pi's first system message, and pi's
// providers read prompt and tools from messages[0] only (Anthropic then rewrites the cache on
// every `tool_search` load). Request-local; a no-op when another extension already hoisted it.
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
