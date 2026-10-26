import { z } from "zod";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import {
  type PlanQuestion,
  type QuestionFormData,
  QuestionListRead,
  questionFormSchema,
} from "./questionForm";

/**
 * `<VisualQuestions>` (deprecated upstream in favour of `question-form`): the same shape
 * and renderer as `<QuestionForm>` under its own block type. BuilderIO's per-option
 * `wireframe`/`diagram` previews are editor-only fields with no read surface, so omitted.
 */

const visualQuestionsSchema = questionFormSchema as unknown as z.ZodType<QuestionFormData>;

const visualQuestionsMdx: BlockMdxConfig<QuestionFormData> = {
  tag: "VisualQuestions",
  toAttrs: (data) => ({
    questions: data.questions,
    submitLabel: data.submitLabel,
  }),
  fromAttrs: (attrs) =>
    ({
      questions: attrs.array<PlanQuestion>("questions") ?? [],
      submitLabel: attrs.string("submitLabel"),
    }) as QuestionFormData,
};

function VisualQuestionsRead(props: PlanBlockReadProps<QuestionFormData>) {
  return <QuestionListRead {...props} blockType="visual-questions" />;
}

export const visualQuestionsBlock: PlanBlock<QuestionFormData> = {
  schema: visualQuestionsSchema,
  mdx: visualQuestionsMdx,
  Read: VisualQuestionsRead,
};
