import { describe, expect, it } from "@effect/vitest";

import { parseUserInputQuestions } from "./userInputQuestions.ts";

function makeQuestion(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "layout",
    header: "Layout",
    question: "Which layout?",
    options: [
      { label: "stacked", description: "One column" },
      { label: "split", description: "Two columns", preview: "```\n| a | b |\n```" },
    ],
    ...overrides,
  };
}

describe("parseUserInputQuestions", () => {
  it("keeps option previews on single-select questions", () => {
    const parsed = parseUserInputQuestions({ questions: [makeQuestion({ multiSelect: false })] });

    expect(parsed?.[0]?.options).toEqual([
      { label: "stacked", description: "One column" },
      { label: "split", description: "Two columns", preview: "```\n| a | b |\n```" },
    ]);
  });

  it("drops option previews on multi-select questions", () => {
    const parsed = parseUserInputQuestions({ questions: [makeQuestion({ multiSelect: true })] });

    expect(parsed?.[0]?.options).toEqual([
      { label: "stacked", description: "One column" },
      { label: "split", description: "Two columns" },
    ]);
  });

  it("ignores blank and non-string previews", () => {
    const parsed = parseUserInputQuestions({
      questions: [
        makeQuestion({
          options: [
            { label: "a", description: "A", preview: "   " },
            { label: "b", description: "B", preview: 42 },
          ],
        }),
      ],
    });

    expect(parsed?.[0]?.options).toEqual([
      { label: "a", description: "A" },
      { label: "b", description: "B" },
    ]);
  });

  it("returns null when the payload carries no usable questions", () => {
    expect(parseUserInputQuestions(null)).toBeNull();
    expect(parseUserInputQuestions({ questions: "nope" })).toBeNull();
    expect(parseUserInputQuestions({ questions: [makeQuestion({ options: [] })] })).toBeNull();
  });
});
