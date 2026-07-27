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

  it("keeps stakes and the first recommended option, dropping later badges", () => {
    const parsed = parseUserInputQuestions({
      questions: [
        makeQuestion({
          stakes: "Hard to undo once shipped.",
          options: [
            { label: "a", description: "A", recommended: true },
            { label: "b", description: "B", recommended: true },
          ],
        }),
      ],
    });

    expect(parsed?.[0]?.stakes).toBe("Hard to undo once shipped.");
    expect(parsed?.[0]?.options).toEqual([
      { label: "a", description: "A", recommended: true },
      { label: "b", description: "B" },
    ]);
  });

  it("omits blank stakes and non-true recommended flags", () => {
    const parsed = parseUserInputQuestions({
      questions: [
        makeQuestion({
          stakes: "  ",
          options: [
            { label: "a", description: "A", recommended: "yes" },
            { label: "b", description: "B", recommended: false },
          ],
        }),
      ],
    });

    expect(parsed?.[0]).not.toHaveProperty("stakes");
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
