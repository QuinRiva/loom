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
  /** When set, this child is the verdict-carrying source of a review gate on
   * that sibling thread. Stated in the kickoff because gate membership is
   * otherwise invisible until the first rework resume — too late for the first
   * verdict (the role overlay's gate protocol keys off this line). */
  readonly gateTargetId?: string | null;
}): string =>
  [
    `You are a ${input.role} sub-thread spawned by a parent orchestrator in T3 Code.`,
    ...(input.gateTargetId != null
      ? [
          `You are inside a review gate: a \`gate\` names thread ${input.gateTargetId} as the work you verify, and your workstream_submit outcomes route it — your role's gate protocol applies from your FIRST submit.`,
        ]
      : []),
    "",
    "Your brief:",
    input.brief,
    "",
    "Work autonomously toward the outcome this brief is meant to deliver — stay anchored to the value it produces (the capability, fix, or decision), not just the mechanical steps. Keep the work focused and report progress clearly.",
    "If you run a command you expect to take much longer than ~5 minutes (a full pipeline, a corpus classification, a long build or test suite), declare its expected duration so your parent is not spammed with slow-tool notices: prefix the bash command with an inline `# eta: <n>m` comment (e.g. `# eta: 25m — full corpus classification`, or `# eta: 1h`). The notices are then deferred until your estimate elapses; a declared `timeout` on the call is used as a fallback signal.",
    "Finish with ONE call: `workstream_submit` — its description is the contract for outcomes and routing, and its result names where your report went. Write the report as a concise handoff for your parent orchestrator, not a transcript dump: lead with the value you delivered and what it enables or unblocks, then the key results/decisions and anything the parent must act on.",
    "If a HUMAN is needed, raise it with `workstream_request_attention` (its description covers the two reasons). Do not sit silently halted: either submit or raise attention — your parent is woken automatically either way.",
  ].join("\n");

/**
 * loom: forkFrom (D8) — pure kickoff-vs-plain decision for `workstream_prompt`.
 * When the child's kickoff has NOT been delivered to pi (a backstop-refused
 * fork, an exhausted first turn, or a genuinely unstarted child), the composed
 * kickoff (role framing + the completion-contract reference) is prepended to the parent's
 * message so the brief is never lost; a role-less legacy child falls back to the
 * raw brief. A DELIVERED kickoff takes the plain steer/resume path — this is
 * what stops a delivered-then-errored turn from being re-prepended. Exposed for
 * unit tests so the decision is a hard regression surface.
 */
export const kickoffTextForPrompt = (input: {
  readonly delivered: boolean;
  readonly role: string | null;
  readonly brief: string;
  readonly message: string;
  readonly gateTargetId?: string | null;
}): string =>
  input.delivered
    ? input.message
    : input.role !== null
      ? `${workstreamChildPrompt({ role: input.role, brief: input.brief, gateTargetId: input.gateTargetId ?? null })}\n\n${input.message}`
      : `${input.brief}\n\n${input.message}`;
