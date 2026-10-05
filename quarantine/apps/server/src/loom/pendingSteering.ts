// loom: pi holds queued steers inside its own process, so a server restart
// mid-turn drops every steer pi had not yet folded in — while the transcript
// still shows it as sent and a parent orchestrator's `workstream_prompt` even
// returned a success receipt. The pending texts are therefore stashed on the
// provider session binding's `runtimePayload` (ProviderRuntimeIngestion, on
// `thread.queue.updated`) and re-delivered by the restart continuation
// (serverRuntimeStartup's `reconcileProviderSessions`), which sends straight to
// the provider and so adds no duplicate transcript message.
//
// Text only: pi's `queue_update` reports the queued message text and nothing
// else, so an attachment on a queued steer is unrecoverable.

export const PENDING_STEERING_KEY = "pendingSteering";

export const readPendingSteering = (runtimePayload: unknown): ReadonlyArray<string> => {
  const stash =
    runtimePayload !== null && typeof runtimePayload === "object" && !Array.isArray(runtimePayload)
      ? (runtimePayload as Record<string, unknown>)[PENDING_STEERING_KEY]
      : null;
  return Array.isArray(stash)
    ? stash.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
};

/**
 * Append the undelivered steers to the restart continuation prompt, verbatim
 * and in the order they were sent. Delimited so the agent cannot read them as
 * part of the restart notice, and labelled so it knows they never reached the
 * killed turn. A steer pi had consumed in the instant before the process died
 * reads as a repeated instruction, which is benign.
 */
export const appendPendingSteering = (prompt: string, pending: ReadonlyArray<string>) =>
  pending.length === 0
    ? prompt
    : [
        prompt,
        `${pending.length === 1 ? "A message was" : `${pending.length} messages were`} sent to you while that turn was running and never reached it. Treat ${pending.length === 1 ? "it" : "them"} as the user's latest instructions, in the order shown, and apply ${pending.length === 1 ? "it" : "them"} to the work you resume.`,
        ...pending.map(
          (text, index) =>
            `--- queued message ${index + 1} of ${pending.length} ---\n${text}\n--- end of queued message ${index + 1} ---`,
        ),
      ].join("\n\n");
