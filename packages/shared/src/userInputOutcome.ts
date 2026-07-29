import type { UserInputQuestion, UserInputResolvedOutcome } from "@t3tools/contracts";

/**
 * How a settled agent question is described to the model — one definition,
 * shared by the in-turn tool result (pi's ask_user_question route) and the
 * next-turn conversion the server performs when no live tool call is left to
 * receive it. The two must read the same or the model's behaviour depends on
 * which delivery path happened to win, which is not a distinction it can act on.
 *
 * @module userInputOutcome
 */

export type UserInputDeliveryOutcome = UserInputResolvedOutcome | "could_not_present";

export const answerText = (answer: unknown): string =>
  Array.isArray(answer)
    ? answer.map(String).join(", ")
    : typeof answer === "string"
      ? answer
      : JSON.stringify(answer);

/** Whether an answer is a custom (typed) value rather than one of the offered labels. */
export const isCustomAnswer = (question: UserInputQuestion, answer: unknown): boolean => {
  const labels = new Set(question.options.map((option) => option.label));
  return Array.isArray(answer)
    ? answer.some((value) => typeof value !== "string" || !labels.has(value))
    : typeof answer !== "string" || !labels.has(answer);
};

const renderAnswers = (
  questions: ReadonlyArray<UserInputQuestion>,
  answers: Record<string, unknown>,
): string =>
  questions
    .map((question) => {
      const answer = answers[question.id];
      const custom = isCustomAnswer(question, answer);
      return `- ${question.question}: ${answerText(answer)}${custom ? " (custom answer)" : ""}`;
    })
    .join("\n");

/**
 * The text the model sees for a settled question. `questions` may be absent when
 * the settling layer no longer has the payload (a next-turn conversion after a
 * restart); the answers are then rendered by question id.
 */
export const renderUserInputOutcome = (input: {
  readonly outcome: UserInputDeliveryOutcome;
  readonly questions?: ReadonlyArray<UserInputQuestion>;
  readonly answers?: Record<string, unknown>;
  readonly message?: string;
}): string => {
  switch (input.outcome) {
    case "could_not_present":
      return "The questions could not be presented because no live Loom pi session was available to receive them. This is a delivery failure, not a user decline: do not interpret it as the user refusing, cancelling, or choosing any option.";
    case "cancelled":
      return "The questions were cancelled or interrupted without answers. Do not proceed on an assumed answer.";
    case "dismissed":
      return "The user dismissed these questions without answering. Do not treat this as selecting any option. Proceed on your best judgement and state the assumption you are making.";
    case "superseded":
      return [
        "The user replied with a message instead of the form — treat it as their response:",
        input.message ?? "",
      ]
        .join("\n")
        .trim();
    case "answered": {
      const answers = input.answers ?? {};
      const lines = input.questions
        ? renderAnswers(input.questions, answers)
        : Object.entries(answers)
            .map(([questionId, answer]) => `- ${questionId}: ${answerText(answer)}`)
            .join("\n");
      return ["The user answered:", lines].join("\n");
    }
  }
};

/**
 * The tool result for a callback that is being RELEASED so its content can be
 * re-delivered as the next turn.
 *
 * Used by the SDK/ACP adapters whose question callbacks cannot carry a supersede
 * message (their protocols model only accepted/cancelled, or an answers map with
 * no free-text slot). A bare `cancelled` there would be a lie by omission: the
 * model would read "nobody answered" and could proceed on an assumption, when in
 * fact the human's answer is arriving in the very next turn. So the release says
 * so explicitly, and tells the model to wait rather than assume.
 */
export const renderUserInputOutcomeHandoff = (input: {
  readonly outcome: UserInputResolvedOutcome;
  readonly message?: string;
}): string =>
  input.outcome === "superseded"
    ? [
        "The user replied with a message instead of using the form, so these questions are settled.",
        "Their message could not be delivered through this tool call, so it arrives as the NEXT message in this conversation.",
        "Do not proceed on an assumed answer and do not re-ask: read their message and respond to it.",
      ].join(" ")
    : renderUserInputOutcome(input);

/**
 * The same text, framed for a NEW turn rather than a tool result — used when the
 * consumer died, so the settlement opens the next turn instead of being lost.
 */
export const renderUserInputOutcomeAsTurnOpener = (input: {
  readonly requestId: string;
  readonly outcome: UserInputResolvedOutcome;
  readonly questions?: ReadonlyArray<UserInputQuestion>;
  readonly answers?: Record<string, unknown>;
  readonly message?: string;
}): string =>
  [
    `The questions you asked earlier (request \`${input.requestId}\`) have now been settled, after the tool call that asked them had already ended. This is that outcome, delivered as a new turn.`,
    "",
    renderUserInputOutcome(input),
  ].join("\n");
