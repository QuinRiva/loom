/**
 * The first-turn text a child receives: its brief inside the kickoff wrapper
 * (`workstreamChildPrompt` in `prose.ts`), or the raw brief for a role-less
 * child. Shared by `mcp__t3-code__workstream_prompt` and the dispatcher's
 * kickoff so both deliver an identical first turn.
 *
 * @module loom/prompt/childPrompt
 */
import { workstreamChildPrompt } from "./prose.ts";

export const kickoffText = (input: {
  readonly role: string | null;
  readonly brief: string;
  readonly gateTargetId?: string | null;
}): string =>
  input.role === null
    ? input.brief
    : workstreamChildPrompt({
        role: input.role,
        brief: input.brief,
        gateTargetId: input.gateTargetId ?? null,
      });

/**
 * What `mcp__t3-code__workstream_prompt` sends: an undelivered kickoff is
 * prepended to the parent's message so the brief is never lost; once the
 * kickoff was delivered the message goes alone (never re-prepended).
 */
export const kickoffTextForPrompt = (input: {
  readonly delivered: boolean;
  readonly role: string | null;
  readonly brief: string;
  readonly message: string;
  readonly gateTargetId?: string | null;
}): string => (input.delivered ? input.message : `${kickoffText(input)}\n\n${input.message}`);
