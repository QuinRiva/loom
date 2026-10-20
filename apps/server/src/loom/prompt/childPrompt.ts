/**
 * The first-turn text a child receives: its brief inside the kickoff wrapper
 * (`workstreamChildPrompt` in `prose.ts`), or the raw brief for a role-less
 * child — led, for a `forkFrom` child either way, by the copied-history clause.
 * The dispatcher's kickoff is its only sender.
 *
 * @module loom/prompt/childPrompt
 */
import { copiedHistoryClause, workstreamChildPrompt } from "./prose.ts";

export const kickoffText = (input: {
  readonly role: string | null;
  readonly brief: string;
  readonly gateTargetId?: string | null;
  readonly forkedFrom?: string | null;
}): string =>
  input.role === null
    ? input.forkedFrom != null
      ? `${copiedHistoryClause(input.forkedFrom)}\n\n${input.brief}`
      : input.brief
    : workstreamChildPrompt({
        role: input.role,
        brief: input.brief,
        gateTargetId: input.gateTargetId ?? null,
        forkedFrom: input.forkedFrom ?? null,
      });
