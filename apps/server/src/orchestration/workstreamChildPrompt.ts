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
    "When you finish, call `workstream_report` with a concise markdown handoff for your parent orchestrator (not your whole transcript): lead with the value you delivered and what it enables or unblocks, then the key results/decisions and anything the parent must act on. THEN report your status.",
    "Report your own status with `workstream_set_status` (no threadId needed — it defaults to you): set `done` when finished, `review` if your output must be reviewed before it is complete, or `blocked` if you cannot proceed. Your parent is automatically woken with your report once you reach a terminal status.",
  ].join("\n");
