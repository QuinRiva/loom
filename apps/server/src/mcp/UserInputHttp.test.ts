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

  it("preserves stakes and a single recommended option", () => {
    const result = validateAskUserQuestions([
      question({
        stakes: "Dropping the column loses live rows.",
        options: [
          { label: "A", description: "First", recommended: true },
          { label: "B", description: "Second" },
        ],
      }),
    ]);
    expect("questions" in result && result.questions[0]?.stakes).toBe(
      "Dropping the column loses live rows.",
    );
    expect("questions" in result && result.questions[0]?.options).toEqual([
      { label: "A", description: "First", recommended: true },
      { label: "B", description: "Second" },
    ]);
  });

  it("rejects more than one recommended option per question", () => {
    expect(
      validateAskUserQuestions([
        question({
          options: [
            { label: "A", description: "First", recommended: true },
            { label: "B", description: "Second", recommended: true },
          ],
        }),
      ]),
    ).toMatchObject({ error: expect.stringContaining("more than one option recommended") });
  });

  it("rejects blank stakes and non-boolean recommended", () => {
    expect(validateAskUserQuestions([question({ stakes: "   " })])).toMatchObject({
      error: expect.stringContaining("stakes must be a non-empty string"),
    });
    expect(
      validateAskUserQuestions([
        question({
          options: [
            { label: "A", description: "First", recommended: "yes" },
            { label: "B", description: "Second" },
          ],
        }),
      ]),
    ).toMatchObject({ error: expect.stringContaining("recommended must be a boolean") });
  });
});
