/**
 * loom: Loom asks (`loom-ask:` ids) are rendered by the open-questions rail, never by upstream's
 * composer panel, which keeps serving native provider questions.
 */
import { LOOM_ASK_REQUEST_PREFIX } from "@t3tools/contracts";

import type { PendingUserInput } from "../../session-logic";

const NO_QUESTIONS: ReadonlyArray<PendingUserInput> = [];

/** Splits the pending questions (oldest first) into the rail's, blocking first, and upstream's. */
export function splitLoomQuestions<Inputs extends ReadonlyArray<PendingUserInput>>(
  inputs: Inputs,
): { readonly loomQuestions: ReadonlyArray<PendingUserInput>; readonly pendingUserInputs: Inputs } {
  if (!inputs.some((input) => input.requestId.startsWith(LOOM_ASK_REQUEST_PREFIX)))
    return { loomQuestions: NO_QUESTIONS, pendingUserInputs: inputs };
  const isLoom = (input: PendingUserInput) => input.requestId.startsWith(LOOM_ASK_REQUEST_PREFIX);
  return {
    loomQuestions: inputs
      .filter(isLoom)
      .toSorted((left, right) => +right.blocking - +left.blocking),
    pendingUserInputs: inputs.filter((input) => !isLoom(input)) as unknown as Inputs,
  };
}

const RECOMMENDED_SUFFIX = " (Recommended)";

/** The option the agent proceeds on: the server marks it in its label and keeps the plain value. */
export const proceedingOn = (question: {
  readonly options: ReadonlyArray<{ readonly label: string }>;
}) =>
  question.options
    .find((option) => option.label.endsWith(RECOMMENDED_SUFFIX))
    ?.label.slice(0, -RECOMMENDED_SUFFIX.length) ?? null;
