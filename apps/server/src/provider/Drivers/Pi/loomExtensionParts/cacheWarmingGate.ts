// loom: Loom extension part — stop pi's idle cache warming once a thread has handed its
// work back. pi's idle warmer (`"cacheWarming": "idle"`) keeps re-sending the last request
// for up to 30 minutes after a run settles; for a child that has successfully called
// `mcp__t3-code__workstream_submit` those pings are wasted, because nobody is going to
// reply to it soon.
//
// pi asks extensions before every refresh (`cache_warming_decision`; a returned
// `{ action: "stop" }` ends warming until the next real request). The event carries no
// phase, but `continuationProbability` is 1 while the agent run is still active and below
// 1 (pi's idle constant, 0.15) once it has settled, so only idle refreshes are vetoed:
// in-run refreshes keep a long tool call's cache alive for the model's next step.
//
// A re-opened thread (any new prompt, steer or follow-up, seen as pi's `input` event)
// clears the gate: it is in a conversation again and warms by pi's own rule until it
// submits again.
//
// As a part: `source` is a function body run once per pi process as `(pi, ctx) => { … }`
// by Loom's extension assembler. It needs no `ctx` member.
import { agentToolName } from "../../../../mcp/toolkits/workstream/families.ts";
import type { LoomExtensionPart } from "../loomExtension.ts";

export const cacheWarmingGatePart: LoomExtensionPart = {
  name: "cacheWarmingGate",
  source: `
let submitted = false;
pi.on("tool_result", (event) => {
  if (event.toolName === ${JSON.stringify(agentToolName("workstream_submit"))} && !event.isError) submitted = true;
});
pi.on("input", () => {
  submitted = false;
});
pi.on("cache_warming_decision", (event) =>
  submitted && event.continuationProbability < 1 ? { action: "stop" } : undefined,
);
`,
};
