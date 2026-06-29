/**
 * workstreamChildPrompt - Kick-off message for a spawned Workstream sub-thread.
 *
 * Shared by the spawn path (which creates the node) and the dispatcher (the
 * sole start authority that fires the deferred first turn once dependencies
 * are satisfied), so both produce an identical first-turn prompt.
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
    "When you finish, call `workstream_report` with a concise markdown handoff for your parent orchestrator (not your whole transcript): lead with the value you delivered and what it enables or unblocks, then the key results/decisions and anything the parent must act on. THEN advance your plan.",
    "Drive two separate axes on yourself (no threadId needed — both default to you). Plan: `workstream_set_lane` — set `done` when the work is genuinely complete (this releases any dependents/reviewers), or `cancelled` to abandon it. Attention (only when a HUMAN is needed): `workstream_request_attention` — raise `awaiting_acceptance` when a human must accept your output before it can count as done, or `needs_guidance` when you cannot proceed without a human. Do not sit silently halted: either advance the plan or raise attention. Your parent is automatically woken with your report once you reach a terminal lane or raise attention.",
  ].join("\n");
