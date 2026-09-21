import { describe, expect, it } from "@effect/vitest";

import { parseUserInputQuestions } from "./userInputQuestions.ts";

function makeQuestion(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "layout",
    header: "Layout",
    question: "Which layout?",
    options: [
      { label: "stacked", description: "One column" },
      { label: "split", description: "Two columns", value: "split-value" },
    ],
    ...overrides,
  };
}

describe("parseUserInputQuestions", () => {
  it("carries option values and allowCustomAnswer through to the client", () => {
    const parsed = parseUserInputQuestions({
      questions: [makeQuestion({ allowCustomAnswer: false })],
    });

    expect(parsed?.[0]).toEqual({
      id: "layout",
      header: "Layout",
      question: "Which layout?",
      options: [
        { label: "stacked", description: "One column" },
        { label: "split", description: "Two columns", value: "split-value" },
      ],
      multiSelect: false,
      allowCustomAnswer: false,
    });
  });

  it("drops fields the contract no longer carries", () => {
    const parsed = parseUserInputQuestions({
      questions: [
        makeQuestion({
          stakes: "Hard to undo once shipped.",
          options: [{ label: "a", description: "A", preview: "```\nx\n```", recommended: true }],
        }),
      ],
    });

    expect(parsed?.[0]).not.toHaveProperty("stakes");
    expect(parsed?.[0]?.options).toEqual([{ label: "a", description: "A" }]);
  });

  it("returns null when the payload carries no usable questions", () => {
    expect(parseUserInputQuestions(null)).toBeNull();
    expect(parseUserInputQuestions({ questions: "nope" })).toBeNull();
    expect(parseUserInputQuestions({ questions: [makeQuestion({ options: [] })] })).toBeNull();
  });
});
