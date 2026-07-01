import { IconCircleCheck } from "@tabler/icons-react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";

/**
 * The `<QuestionForm>` block — the single bottom "Open Questions" list, rendered
 * READ-ONLY inside a plan (the interactive answer surface belongs to the review
 * layer, not the document render). Each question shows its mode, options with the
 * recommended one highlighted, and a write-in affordance for freeform. Schema +
 * MDX round-trip ported verbatim from `@agent-native/core` `question-form.config.ts`.
 */

export type QuestionMode = "single" | "multi" | "freeform";

export interface QuestionOption {
  id: string;
  label: string;
  detail?: string;
  recommended?: boolean;
}

export interface PlanQuestion {
  id: string;
  title: string;
  subtitle?: string;
  mode: QuestionMode;
  options?: QuestionOption[];
  allowOther?: boolean;
  placeholder?: string;
  required?: boolean;
}

export interface QuestionFormData {
  questions: PlanQuestion[];
  submitLabel?: string;
}

const optionSchema = z.object({
  id: z.string().trim().min(1).max(120),
  label: z.string().trim().min(1).max(220),
  detail: z.string().trim().max(800).optional(),
  recommended: z.boolean().optional(),
}) as z.ZodType<QuestionOption>;

const questionSchema = z.object({
  id: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(260),
  subtitle: z.string().trim().max(700).optional(),
  mode: z.enum(["single", "multi", "freeform"]),
  options: z.array(optionSchema).max(40).optional(),
  allowOther: z.boolean().optional(),
  placeholder: z.string().trim().max(240).optional(),
  required: z.boolean().optional(),
}) as z.ZodType<PlanQuestion>;

export const questionFormSchema = z.object({
  questions: z.array(questionSchema).min(1).max(40),
  submitLabel: z.string().trim().max(80).optional(),
}) as unknown as z.ZodType<QuestionFormData>;

export const questionFormMdx: BlockMdxConfig<QuestionFormData> = {
  tag: "QuestionForm",
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

const MODE_LABEL: Record<QuestionMode, string> = {
  single: "Pick one",
  multi: "Pick any",
  freeform: "Write-in",
};

export function QuestionFormRead({ data, blockId }: PlanBlockReadProps<QuestionFormData>) {
  const questions = data.questions ?? [];
  return (
    <section
      data-plan-block-id={blockId}
      data-plan-block-type="question-form"
      className="my-4 overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="border-b border-border/60 bg-muted/40 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Open questions
      </div>
      <ol className="flex flex-col divide-y divide-border/60">
        {questions.map((question, index) => (
          <li key={question.id} className="px-4 py-3">
            <div className="flex items-baseline gap-2">
              <span className="shrink-0 font-mono text-xs text-muted-foreground">Q{index + 1}</span>
              <span className="text-sm font-semibold text-foreground">{question.title}</span>
              <span className="ml-auto shrink-0 rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {MODE_LABEL[question.mode]}
              </span>
            </div>
            {question.subtitle && (
              <p className="mt-1 pl-7 text-xs text-muted-foreground">{question.subtitle}</p>
            )}
            {question.mode !== "freeform" && (question.options?.length ?? 0) > 0 && (
              <ul className="mt-2 flex flex-col gap-1.5 pl-7">
                {question.options!.map((option) => (
                  <li
                    key={option.id}
                    className={cn(
                      "flex items-start gap-2 rounded-md border px-2.5 py-1.5",
                      option.recommended
                        ? "border-emerald-400/60 bg-emerald-50 dark:bg-emerald-500/10"
                        : "border-border",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 size-3.5 shrink-0 rounded-full border",
                        question.mode === "single" ? "rounded-full" : "rounded-[3px]",
                        option.recommended ? "border-emerald-500" : "border-muted-foreground/50",
                      )}
                    />
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-sm text-foreground">
                        {option.label}
                        {option.recommended && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-emerald-100 px-1 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
                            <IconCircleCheck className="size-3" />
                            recommended
                          </span>
                        )}
                      </span>
                      {option.detail && (
                        <span className="mt-0.5 block text-[11px] text-muted-foreground">
                          {option.detail}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 pl-7">
              <div className="rounded-md border border-dashed border-border px-2.5 py-1.5 text-[11px] italic text-muted-foreground">
                {question.placeholder ?? "Write-in answer…"}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export const questionFormBlock: PlanBlock<QuestionFormData> = {
  schema: questionFormSchema,
  mdx: questionFormMdx,
  Read: QuestionFormRead,
};
