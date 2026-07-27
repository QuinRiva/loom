import { describe, expect, it } from "vite-plus/test";

import { validateAskUserQuestions } from "./UserInputHttp.ts";

const question = (overrides: Record<string, unknown> = {}) => ({
  header: "Choice",
  question: "Which option?",
  options: [
    { label: "A", description: "First", preview: "**A preview**" },
    { label: "B", description: "Second" },
  ],
  ...overrides,
});

describe("ask_user_question validation", () => {
  it("accepts and preserves single-select markdown previews", () => {
    const result = validateAskUserQuestions([question()]);
    expect("questions" in result && result.questions[0]?.multiSelect).toBe(false);
    expect("questions" in result && result.questions[0]?.options[0]).toEqual({
      label: "A",
      description: "First",
      preview: "**A preview**",
    });
  });

  it("rejects more than four questions and fewer than two options", () => {
    expect(validateAskUserQuestions(Array.from({ length: 5 }, () => question()))).toEqual({
      error: "questions must contain between 1 and 4 questions.",
    });
    expect(
      validateAskUserQuestions([question({ options: [{ label: "A", description: "Only" }] })]),
    ).toMatchObject({
      error: expect.stringContaining("between 2 and 4 options"),
    });
  });

  it("rejects labels reserved for the host custom-answer control", () => {
    expect(
      validateAskUserQuestions([
        question({
          options: [
            { label: "Other", description: "Reserved" },
            { label: "B", description: "Second" },
          ],
        }),
      ]),
    ).toMatchObject({ error: expect.stringContaining("reserved") });
  });

  it("rejects previews on multi-select questions", () => {
    expect(validateAskUserQuestions([question({ multiSelect: true })])).toMatchObject({
      error: expect.stringContaining("only supported for single-select"),
    });
  });
});
