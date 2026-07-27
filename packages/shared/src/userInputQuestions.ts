import type { UserInputQuestion } from "@t3tools/contracts";

type UserInputQuestionOption = UserInputQuestion["options"][number];

function parseOption(value: unknown, allowPreview: boolean): UserInputQuestionOption | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.label !== "string" || typeof record.description !== "string") {
    return null;
  }
  const preview =
    allowPreview && typeof record.preview === "string" && record.preview.trim().length > 0
      ? record.preview
      : null;
  return {
    label: record.label,
    description: record.description,
    ...(preview ? { preview } : {}),
  };
}

/**
 * Parse the `questions` array of a `user-input.requested` activity payload into
 * the contract shape. Shared by both clients so a field added to the contract
 * (like an option `preview`) reaches every UI, not just the one that was edited.
 *
 * `preview` is single-select only — the server-side tool schema rejects it on
 * multi-select questions, and it is dropped here so a stale or hand-rolled
 * payload cannot make multi-select options sprout preview panes.
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
      const multiSelect = question.multiSelect === true;
      const options = question.options
        .map((option) => parseOption(option, !multiSelect))
        .filter((option): option is UserInputQuestionOption => option !== null);
      if (options.length === 0) {
        return null;
      }
      return {
        id: question.id,
        header: question.header,
        question: question.question,
        options,
        multiSelect,
      };
    })
    .filter((question): question is UserInputQuestion => question !== null);

  return parsed.length > 0 ? parsed : null;
}
