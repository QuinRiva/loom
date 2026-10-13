// loom: Loom extension part — Loom's policy on pi's idle cache warming (`"cacheWarming":
// "idle"`, where pi re-sends a thread's last request with a one-token cap shortly before its
// prompt cache expires). pi asks extensions before every refresh (`cache_warming_decision`);
// the answer replaces pi's own `warm`/`stop`. The event carries no phase, but
// `continuationProbability` is 1 while the agent run is still active and below 1 (pi's idle
// constant, 0.15) once it has settled, so only idle refreshes are touched: in-run refreshes
// keep a long tool call's cache alive for the model's next step, by pi's own rule.
//
// Two rules, in precedence order:
// 1. A thread that has successfully called `mcp__t3-code__workstream_submit` stops: nobody is
//    going to reply to it soon. A re-opened thread (any new prompt, steer or follow-up, seen
//    as pi's `input` event) clears this until it submits again.
// 2. A 1-hour root (`PI_CACHE_RETENTION=long`, set per pi process by Loom's session composer)
//    warms. Its single idle ping at ~54 minutes is Loom's keep-alive policy; pi's economics
//    would skip it for most contexts because it prices a miss at the 5-minute write rate.
//    pi's idle horizon (`PI_CACHE_WARMING_IDLE_MAX_MS`) still bounds it to one ping.
// Everything else (5-minute threads) is left to pi's economics.
//
// It also reports the resulting plan to Loom (`POST /loom/agent/cache-warming`), which the
// sidebar's cache gauge needs to count down to when the cache really goes cold: at
// `agent_settled` (`stopped` after a submit, `scheduled` for a 1-hour root, otherwise null —
// undecided until pi's first idle decision), and at each idle decision (the final action).
// The settle report is awaited, so it lands before any next turn (pi awaits `agent_settled`
// handlers); the decision report never delays a ping. Both swallow every failure.
//
// An extension answer cannot override pi's safety stops: pi checks "conversation context
// changed", "cache refresh deadline missed" and the warming mode before asking and again
// after, so `warm` here only ever overrules the economics.
//
// As a part: `source` is a function body run once per pi process as `(pi, ctx) => { … }`
// by Loom's extension assembler; `loomFetch(ctx, …)` is the assembled module's.
import { agentToolName } from "../../../../mcp/toolkits/workstream/families.ts";
import type { LoomExtensionPart } from "../loomExtension.ts";

export const cacheWarmingGatePart: LoomExtensionPart = {
  name: "cacheWarmingGate",
  source: `
const longRoot = process.env.PI_CACHE_RETENTION === "long";
let submitted = false;
const report = (warming) =>
  loomFetch(ctx, "POST", "/cache-warming", { warming }, AbortSignal.timeout(5000)).catch(() => {});
pi.on("tool_result", (event) => {
  if (event.toolName === ${JSON.stringify(agentToolName("workstream_submit"))} && !event.isError) submitted = true;
});
pi.on("input", () => {
  submitted = false;
});
pi.on("agent_settled", async () => {
  await report(submitted ? "stopped" : longRoot ? "scheduled" : null);
});
pi.on("cache_warming_decision", (event) => {
  if (event.continuationProbability >= 1) return undefined;
  const action = submitted ? "stop" : longRoot ? "warm" : event.action;
  void report(action === "warm" ? "scheduled" : "stopped");
  return action === event.action ? undefined : { action };
});
`,
};
