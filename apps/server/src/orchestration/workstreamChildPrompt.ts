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
  readonly purpose: string;
}): string =>
  [
    `You are a ${input.role} sub-thread spawned by a parent orchestrator in T3 Code.`,
    "",
    "Purpose:",
    input.purpose,
    "",
    "Work autonomously on this goal. Keep the work focused and report progress clearly.",
    "Report your own status with `workstream_set_status` (no threadId needed — it defaults to you): set `done` when finished, `review` if your output must be reviewed by another sub-thread before it is complete, or `blocked` if you cannot proceed.",
  ].join("\n");
