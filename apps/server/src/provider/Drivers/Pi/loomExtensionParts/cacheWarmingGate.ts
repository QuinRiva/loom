// loom: Loom extension part: answers pi's idle `cache_warming_decision` (`continuationProbability`
// < 1; in-run refreshes keep pi's rule). A submitted thread stops unless `/gate-keep-alive` (5 s cap,
// inside pi's 15 s window) says a live gate counterpart will hand back; `input` clears the submit.
// A 1-hour root warms (pi prices its miss at the 5-minute rate). Plans go to `/cache-warming`.
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
