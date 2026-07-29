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
    "Finish with ONE call: `workstream_submit`, carrying a concise markdown handoff for your parent orchestrator (not your whole transcript — lead with the value you delivered and what it enables or unblocks, then the key results/decisions and anything the parent must act on) plus an outcome. Plain completion: omit the outcome — the control plane records your report and advances your plan to done in the same step (releasing any dependents/reviewers); never set your own lane at completion. If your work concluded with anything other than plain success (the approach is wrong, you are blocked on a decision), pass a short outcome token saying so (e.g. `rework_approach`) — the control plane yields you to your parent orchestrator with your report instead of marking you done. Pass `needs_human` when only a human can unblock you.",
    "Attention (only when a HUMAN is needed): `workstream_request_attention` — raise `awaiting_acceptance` when a human must accept your output before it can count as done, or `needs_guidance` when you cannot proceed without a human. Do not sit silently halted: either submit or raise attention. Your parent is automatically woken with your report once your submit resolves or you raise attention.",
  ].join("\n");

/**
 * loom: forkFrom (D8) — pure kickoff-vs-plain decision for `workstream_prompt`.
 * When the child's kickoff has NOT been delivered to pi (a backstop-refused
 * fork, an exhausted first turn, or a genuinely unstarted child), the composed
 * kickoff (role framing + completion contract) is prepended to the parent's
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
