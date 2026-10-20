// loom: Loom extension part — Loom's policy on pi's idle cache warming (`"cacheWarming":
// "idle"`, where pi re-sends a thread's last request with a one-token cap shortly before its
// prompt cache expires). pi asks extensions before every refresh (`cache_warming_decision`);
// the answer replaces pi's own `warm`/`stop`. The event carries no phase, but
// `continuationProbability` is 1 while the agent run is still active and below 1 (pi's idle
// constant, 0.15) once it has settled, so only idle refreshes are touched: in-run refreshes
// keep a long tool call's cache alive for the model's next step, by pi's own rule.
//
// Two rules, in precedence order:
// 1. A thread that has successfully called `mcp__t3-code__workstream_submit` stops, unless Loom
//    confirms it is parked in a review gate whose counterpart is live (`GET
//    /loom/agent/gate-keep-alive`, asked before every idle refresh): then it warms. A gate
//    hand-back (the reviewer's findings to a coder, the coder's rework to its reviewer) arrives
//    inside 30 minutes about nine times in ten, against pi's 15%, so every refresh is sent until
//    the first check after the gate resolves, the counterpart is cancelled or flagged, the thread
//    itself is flagged, or pi's idle horizon ends. Any other submitted thread, and any failed
//    or timed-out check, stops: nobody is going to reply to it soon. A re-opened thread (any new
//    prompt, steer or follow-up, seen as pi's `input` event) clears the submit until it submits
//    again.
// 2. A 1-hour root (`PI_CACHE_RETENTION=long`, set per pi process by Loom's session composer)
//    warms. Its single idle ping at ~54 minutes is Loom's keep-alive policy; pi's economics
//    would skip it for most contexts because it prices a miss at the 5-minute write rate.
//    pi's idle horizon (`PI_CACHE_WARMING_IDLE_MAX_MS`) still bounds it to one ping.
// Everything else (5-minute threads) is left to pi's economics.
//
// Once this answers `stop`, pi drops warming until the next real request, so a counterpart that
// recovers later (a parent resuming a yielded reviewer) does not re-warm a parked thread.
//
// It also reports the resulting plan to Loom (`POST /loom/agent/cache-warming`), which the
// sidebar's cache gauge needs to count down to when the cache really goes cold: at
// `agent_settled` (after a submit `scheduled` for a parked gate member and `stopped` otherwise,
// `scheduled` for a 1-hour root, otherwise null — undecided until pi's first idle decision),
// and at each idle decision (the final action). The settle report is awaited, so it lands
// before any next turn (pi awaits `agent_settled` handlers); the decision report never delays
// a ping. Both swallow every failure. pi awaits the decision handler too, and the gate check
// is capped at 5 seconds, inside pi's 15-second window before it abandons a due refresh.
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
const gateKeepAlive = () =>
  loomFetch(ctx, "GET", "/gate-keep-alive", undefined, AbortSignal.timeout(5000)).then(
    (answer) => answer?.keepAlive === true,
    () => false,
  );
pi.on("tool_result", (event) => {
  if (event.toolName === ${JSON.stringify(agentToolName("workstream_submit"))} && !event.isError) submitted = true;
});
pi.on("input", () => {
  submitted = false;
});
pi.on("agent_settled", async () => {
  await report(submitted ? ((await gateKeepAlive()) ? "scheduled" : "stopped") : longRoot ? "scheduled" : null);
});
pi.on("cache_warming_decision", async (event) => {
  if (event.continuationProbability >= 1) return undefined;
  const action = submitted ? ((await gateKeepAlive()) ? "warm" : "stop") : longRoot ? "warm" : event.action;
  void report(action === "warm" ? "scheduled" : "stopped");
  return action === event.action ? undefined : { action };
});
`,
};
