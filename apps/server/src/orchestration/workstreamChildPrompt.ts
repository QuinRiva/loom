/**
 * workstreamChildPrompt - Kick-off message for a spawned Workstream sub-thread.
 *
 * Shared by the dispatcher (the start authority that fires the kick-off turn
 * once dependencies are satisfied) and the turn-start recovery guard in
 * ProviderCommandReactor (which delivers the never-dispatched brief when a
 * provision-parked child is recovered), so both produce an identical
 * first-turn prompt.
 *
 * @module workstreamChildPrompt
 */

export const workstreamChildPrompt = (input: {
  readonly role: string;
  readonly brief: string;
}): string =>
  [
    `You are a ${input.role} sub-thread spawned by a parent orchestrator in T3 Code.`,
    "",
    "Your brief:",
    input.brief,
    "",
    "Work autonomously toward the outcome this brief is meant to deliver — stay anchored to the value it produces (the capability, fix, or decision), not just the mechanical steps. Keep the work focused and report progress clearly.",
    "Finish with ONE call: `workstream_submit`, carrying a concise markdown handoff for your parent orchestrator (not your whole transcript — lead with the value you delivered and what it enables or unblocks, then the key results/decisions and anything the parent must act on) plus an outcome. Plain completion: omit the outcome — the control plane records your report and advances your plan to done in the same step (releasing any dependents/reviewers); never set your own lane at completion. If your work concluded with anything other than plain success (the approach is wrong, you are blocked on a decision), pass a short outcome token saying so (e.g. `rework_approach`) — the control plane yields you to your parent orchestrator with your report instead of marking you done. Pass `needs_human` when only a human can unblock you.",
    "Attention (only when a HUMAN is needed): `workstream_request_attention` — raise `awaiting_acceptance` when a human must accept your output before it can count as done, or `needs_guidance` when you cannot proceed without a human. Do not sit silently halted: either submit or raise attention. Your parent is automatically woken with your report once your submit resolves or you raise attention.",
  ].join("\n");
