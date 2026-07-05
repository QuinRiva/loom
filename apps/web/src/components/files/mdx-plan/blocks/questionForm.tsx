import { IconCheck, IconCircleCheck } from "@tabler/icons-react";
import { useContext, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import {
  EMPTY_QUESTION_ANSWER,
  isEmptyQuestionAnswer,
  type PlanQuestionAnswer,
  PlanQuestionAnswersContext,
} from "../questionAnswers";

/**
 * The `<QuestionForm>` block — the single bottom "Open Questions" list. When the
 * annotation layer provides {@link PlanQuestionAnswersContext} the questions are
 * ANSWERABLE in place: option clicks select (single/multi semantics), a write-in
 * renders where the question allows it (`mode:"freeform"` or `allowOther`), and
 * each answer flows into the composer as a review-comment chip included in the
 * next review turn. Without the context (bare renderer/tests) it stays read-only.
 * Schema + MDX round-trip ported verbatim from `@agent-native/core`
 * `question-form.config.ts`; `submitLabel` is accepted for the wire round-trip
 * but not rendered — answers attach per-question, so there is nothing to submit.
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

/**
 * Shared read-only question list, keyed on a `blockType` so both `<QuestionForm>`
 * and its `<VisualQuestions>` variant render the same UI while stamping their own
 * `data-plan-block-type` (the annotation layer distinguishes them).
 */
export function QuestionListRead({
  data,
  blockId,
  blockType,
}: PlanBlockReadProps<QuestionFormData> & { blockType: string }) {
  const api = useContext(PlanQuestionAnswersContext);
  const sectionRef = useRef<HTMLElement>(null);
  const questions = data.questions ?? [];
  const answered = api
    ? questions.filter((question) => !isEmptyQuestionAnswer(api.getAnswer(question.id))).length
    : 0;
  return (
    <section
      ref={sectionRef}
      data-plan-block-id={blockId}
      data-plan-block-type={blockType}
      className="my-4 overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="border-b border-border/60 bg-muted/40 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Open questions
      </div>
      <ol className="flex flex-col divide-y divide-border/60">
        {questions.map((question, index) => (
          <QuestionItem
            key={question.id}
            question={question}
            index={index}
            answer={api?.getAnswer(question.id) ?? EMPTY_QUESTION_ANSWER}
            onChange={
              api ? (answer) => api.setAnswer(question, sectionRef.current, answer) : undefined
            }
          />
        ))}
      </ol>
      {api && questions.length > 0 && (
        <div className="border-t border-border/60 bg-muted/40 px-4 py-2 text-[11px] text-muted-foreground">
          {answered} of {questions.length} answered · answers are attached to your next message
        </div>
      )}
    </section>
  );
}

interface QuestionItemProps {
  question: PlanQuestion;
  index: number;
  answer: PlanQuestionAnswer;
  /** Present only when an interactive answer surface hosts the render. */
  onChange?: ((answer: PlanQuestionAnswer) => void) | undefined;
}

function QuestionItem({ question, index, answer, onChange }: QuestionItemProps) {
  const showWriteIn = question.mode === "freeform" || question.allowOther === true;
  const toggleOption = (optionId: string) =>
    onChange?.({
      ...answer,
      selected:
        question.mode === "single"
          ? answer.selected.includes(optionId)
            ? []
            : [optionId]
          : answer.selected.includes(optionId)
            ? answer.selected.filter((id) => id !== optionId)
            : [...answer.selected, optionId],
    });
  return (
    <li className="px-4 py-3">
      <div className="flex items-baseline gap-2">
        <span className="shrink-0 font-mono text-xs text-muted-foreground">Q{index + 1}</span>
        <span className="text-sm font-semibold text-foreground">{question.title}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {onChange && !isEmptyQuestionAnswer(answer) && (
            <button
              type="button"
              className="text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => onChange(EMPTY_QUESTION_ANSWER)}
            >
              clear
            </button>
          )}
          <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {MODE_LABEL[question.mode]}
          </span>
        </span>
      </div>
      {question.subtitle && (
        <p className="mt-1 pl-7 text-xs text-muted-foreground">{question.subtitle}</p>
      )}
      {question.mode !== "freeform" && (question.options?.length ?? 0) > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5 pl-7">
          {question.options!.map((option) => {
            const selected = answer.selected.includes(option.id);
            const rowClassName = cn(
              "flex w-full items-start gap-2 rounded-md border px-2.5 py-1.5 text-left",
              selected
                ? "border-primary bg-primary/10"
                : option.recommended
                  ? "border-emerald-400/60 bg-emerald-50 dark:bg-emerald-500/10"
                  : "border-border",
              onChange && "cursor-pointer transition-colors hover:border-primary/60",
            );
            const rowContent = (
              <>
                <span
                  className={cn(
                    "mt-0.5 grid size-3.5 shrink-0 place-items-center border",
                    question.mode === "single" ? "rounded-full" : "rounded-[3px]",
                    selected
                      ? "border-primary bg-primary"
                      : option.recommended
                        ? "border-emerald-500"
                        : "border-muted-foreground/50",
                  )}
                >
                  {selected &&
                    (question.mode === "single" ? (
                      <span className="size-1.5 rounded-full bg-primary-foreground" />
                    ) : (
                      <IconCheck className="size-3 text-primary-foreground" stroke={3} />
                    ))}
                </span>
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
              </>
            );
            return (
              <li key={option.id}>
                {onChange ? (
                  <button
                    type="button"
                    role={question.mode === "single" ? "radio" : "checkbox"}
                    aria-checked={selected}
                    className={rowClassName}
                    onClick={() => toggleOption(option.id)}
                  >
                    {rowContent}
                  </button>
                ) : (
                  <div className={rowClassName}>{rowContent}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {showWriteIn && (
        <div className="mt-2 pl-7">
          {onChange ? (
            <WriteInAnswer
              value={answer.other}
              placeholder={question.placeholder ?? "Write-in answer…"}
              onCommit={(text) => onChange({ ...answer, other: text })}
            />
          ) : (
            <div className="rounded-md border border-dashed border-border px-2.5 py-1.5 text-[11px] italic text-muted-foreground">
              {question.placeholder ?? "Write-in answer…"}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Uncommitted-edit input: local text state, committed on blur or Enter so the
 * composer chip is not rewritten per keystroke. External resets (clear, chip
 * removal) sync back in via the effect. */
function WriteInAnswer({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder: string;
  onCommit: (text: string) => void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = () => {
    if (text.trim() !== value) onCommit(text.trim());
  };
  return (
    <textarea
      rows={1}
      value={text}
      placeholder={placeholder}
      aria-label="Write-in answer"
      className="field-sizing-content w-full resize-none rounded-md border border-dashed border-border bg-transparent px-2.5 py-1.5 text-sm text-foreground placeholder:italic placeholder:text-muted-foreground focus:border-solid focus:border-ring focus:outline-none"
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

export function QuestionFormRead(props: PlanBlockReadProps<QuestionFormData>) {
  return <QuestionListRead {...props} blockType="question-form" />;
}

export const questionFormBlock: PlanBlock<QuestionFormData> = {
  schema: questionFormSchema,
  mdx: questionFormMdx,
  Read: QuestionFormRead,
};
