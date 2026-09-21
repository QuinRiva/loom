import type { UserInputQuestion } from "@t3tools/contracts";

type UserInputQuestionOption = UserInputQuestion["options"][number];

function parseOption(value: unknown): UserInputQuestionOption | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.label !== "string" || typeof record.description !== "string") {
    return null;
  }
  return {
    label: record.label,
    description: record.description,
    ...(typeof record.value === "string" ? { value: record.value } : {}),
  };
}

/**
 * Parse the `questions` array of a `user-input.requested` activity payload into
 * the contract shape. Shared by both clients so a field added to the contract
 * reaches every UI, not just the one that was edited.
 */
export function parseUserInputQuestions(
  payload: Record<string, unknown> | null,
): ReadonlyArray<UserInputQuestion> | null {
  const questions = payload?.questions;
  if (!Array.isArray(questions)) {
    return null;
  }

  const parsed = questions
    .map<UserInputQuestion | null>((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const question = entry as Record<string, unknown>;
      if (
        typeof question.id !== "string" ||
        typeof question.header !== "string" ||
        typeof question.question !== "string" ||
        !Array.isArray(question.options)
      ) {
        return null;
      }
      const options = question.options
        .map(parseOption)
        .filter((option): option is UserInputQuestionOption => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        multiSelect: question.multiSelect === true,
        ...(typeof question.allowCustomAnswer === "boolean"
          ? { allowCustomAnswer: question.allowCustomAnswer }
          : {}),
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);

  return parsed.length > 0 ? parsed : null;
}
