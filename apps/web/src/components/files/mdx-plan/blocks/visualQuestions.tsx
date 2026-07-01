import { z } from "zod";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import {
  type PlanQuestion,
  type QuestionFormData,
  QuestionListRead,
  questionFormSchema,
} from "./questionForm";

/**
 * The `<VisualQuestions>` block — a visual-intake question block with the SAME
 * question/option shape as `<QuestionForm>` (BuilderIO marks it deprecated in
 * favour of `question-form`). It reuses the shared question list renderer,
 * stamping its own `data-plan-block-type="visual-questions"` so the annotation
 * layer distinguishes the two. The BuilderIO schema additionally allows per-
 * option `wireframe`/`diagram` previews; those are deprecated authoring-editor
 * fields with no read surface, so the port mirrors `<QuestionForm>` exactly and
 * omits them.
 */

export const visualQuestionsSchema = questionFormSchema as unknown as z.ZodType<QuestionFormData>;

export const visualQuestionsMdx: BlockMdxConfig<QuestionFormData> = {
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

export function VisualQuestionsRead(props: PlanBlockReadProps<QuestionFormData>) {
  return <QuestionListRead {...props} blockType="visual-questions" />;
}

export const visualQuestionsBlock: PlanBlock<QuestionFormData> = {
  schema: visualQuestionsSchema,
  mdx: visualQuestionsMdx,
  Read: VisualQuestionsRead,
};
