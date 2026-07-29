import type { ApprovalRequestId, UserInputQuestion } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { memo, useState } from "react";

import type { UserInputAnswerDraft } from "@t3tools/shared/userInputAnswers";
import {
  isUsingCustomUserInputAnswer,
  selectedUserInputOptionLabels,
} from "@t3tools/shared/userInputAnswers";
import { cn } from "~/lib/utils";
import type { PendingUserInput } from "../../session-logic";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export interface PendingQuestionCardProps {
  /** The oldest open request — the one being answered. */
  readonly pendingUserInput: PendingUserInput;
  /** How many requests are open in total, so a second one is never invisible (S8). */
  readonly pendingCount: number;
  readonly drafts: Record<string, UserInputAnswerDraft>;
  /** Non-null once every question is answered; also the submit control's gate. */
  readonly answers: Record<string, string | ReadonlyArray<string>> | null;
  readonly isResponding: boolean;
  readonly isDismissing: boolean;
  /** True once a plain send has settled this question server-side as superseded. */
  readonly supersededByMessage: boolean;
  readonly onToggleOption: (question: UserInputQuestion, optionLabel: string) => void;
  readonly onChangeCustomAnswer: (questionId: string, customAnswer: string) => void;
  readonly onSubmit: (requestId: ApprovalRequestId) => void;
  readonly onDismiss: (requestId: ApprovalRequestId) => void;
}

/**
 * An agent question, rendered as a self-contained card that sits above the
 * composer and never touches it (design commitment 5).
 *
 * Everything the human needs is inside this card: the options, their previews,
 * a free-text field per question, submit, and — always — dismiss. The composer
 * behind it stays a composer: no value swap, no keystroke reroute, no Enter
 * hijack, and no document-level digit listener, so no keystroke aimed at
 * something else can ever select or submit an answer.
 */
export const PendingQuestionCard = memo(function PendingQuestionCard({
  pendingUserInput,
  pendingCount,
  drafts,
  answers,
  isResponding,
  isDismissing,
  supersededByMessage,
  onToggleOption,
  onChangeCustomAnswer,
  onSubmit,
  onDismiss,
}: PendingQuestionCardProps) {
  const busy = isResponding || isDismissing || supersededByMessage;
  const morePending = pendingCount - 1;

  return (
    <div
      data-pending-question-card="true"
      data-pending-question-request-id={pendingUserInput.requestId}
      className="rounded-t-[19px] border-b border-border/65 bg-muted/20 px-4 py-3 sm:px-5"
    >
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold tracking-widest text-muted-foreground/55 uppercase">
          {supersededByMessage ? "Answered by your message" : "Agent question"}
        </span>
        {morePending > 0 ? (
          <span className="flex h-5 items-center rounded-md bg-muted/60 px-1.5 text-[10px] font-medium tabular-nums text-muted-foreground/60">
            {morePending} more pending
          </span>
        ) : null}
      </div>

      {supersededByMessage ? (
        <p className="text-sm text-muted-foreground">
          Your message was delivered as the response to this question.
        </p>
      ) : (
        <div className="space-y-4">
          {pendingUserInput.questions.map((question) => (
            <PendingQuestionSection
              key={question.id}
              question={question}
              draft={drafts[question.id]}
              disabled={busy}
              onToggleOption={onToggleOption}
              onChangeCustomAnswer={onChangeCustomAnswer}
            />
          ))}
        </div>
      )}

      {supersededByMessage ? null : (
        <div className="mt-3.5 flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            data-pending-question-dismiss="true"
            className="rounded-full text-muted-foreground hover:text-foreground"
            disabled={busy}
            onClick={() => onDismiss(pendingUserInput.requestId)}
          >
            {isDismissing ? "Dismissing..." : "Dismiss"}
          </Button>
          <Button
            type="button"
            size="sm"
            data-pending-question-submit="true"
            className="rounded-full px-4"
            disabled={busy || answers === null}
            onClick={() => onSubmit(pendingUserInput.requestId)}
          >
            {isResponding
              ? "Submitting..."
              : pendingUserInput.questions.length > 1
                ? "Submit answers"
                : "Submit answer"}
          </Button>
        </div>
      )}
    </div>
  );
});

const PendingQuestionSection = memo(function PendingQuestionSection({
  question,
  draft,
  disabled,
  onToggleOption,
  onChangeCustomAnswer,
}: {
  readonly question: UserInputQuestion;
  readonly draft: UserInputAnswerDraft | undefined;
  readonly disabled: boolean;
  readonly onToggleOption: (question: UserInputQuestion, optionLabel: string) => void;
  readonly onChangeCustomAnswer: (questionId: string, customAnswer: string) => void;
}) {
  const [previewedOptionLabel, setPreviewedOptionLabel] = useState<string | null>(null);
  const usingCustomAnswer = isUsingCustomUserInputAnswer(draft);
  const selectedOptionLabels = selectedUserInputOptionLabels(draft);
  // `preview` is single-select only (enforced in the shared parse layer), so a
  // multi-select question never reaches here with previews attached.
  const previewableOptions = question.options.filter((option) => option.preview);
  const activePreviewOption =
    previewableOptions.find((option) => option.label === previewedOptionLabel) ??
    previewableOptions.find(
      (option) => !usingCustomAnswer && selectedOptionLabels.includes(option.label),
    ) ??
    previewableOptions[0] ??
    null;

  return (
    <div>
      <span className="text-[11px] font-semibold tracking-widest text-muted-foreground/55 uppercase">
        {question.header}
      </span>
      <p className="mt-1 text-sm text-foreground/90">{question.question}</p>
      {question.stakes ? (
        <p className="mt-1.5 border-l-2 border-amber-500/40 pl-2 text-xs leading-relaxed text-muted-foreground">
          {question.stakes}
        </p>
      ) : null}
      {question.multiSelect ? (
        <p className="mt-1 text-xs text-muted-foreground/65">Select one or more options.</p>
      ) : null}

      <div className="mt-2.5 space-y-1.5">
        {question.options.map((option) => {
          const isSelected = !usingCustomAnswer && selectedOptionLabels.includes(option.label);
          const focusPreview = option.preview
            ? () => setPreviewedOptionLabel(option.label)
            : undefined;
          return (
            <button
              key={`${question.id}:${option.label}`}
              type="button"
              disabled={disabled}
              onClick={() => onToggleOption(question, option.label)}
              onMouseEnter={focusPreview}
              onFocus={focusPreview}
              className={cn(
                "group flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none transition-all duration-150 focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/25",
                isSelected
                  ? "border-primary/30 bg-primary/8 text-foreground"
                  : "border-transparent bg-muted/22 text-foreground/85 hover:border-border/45 hover:bg-muted/34",
                disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
              )}
              aria-pressed={isSelected}
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium">{option.label}</span>
                  {option.recommended ? (
                    <span className="shrink-0 rounded border border-emerald-500/30 bg-emerald-500/10 px-1 py-px text-[9px] font-semibold uppercase leading-[1.25] tracking-wide text-emerald-700 dark:border-emerald-400/25 dark:bg-emerald-400/10 dark:text-emerald-300">
                      Suggested
                    </span>
                  ) : null}
                </span>
                {option.description && option.description !== option.label ? (
                  <span className="text-xs text-muted-foreground">{option.description}</span>
                ) : null}
              </div>
              {isSelected ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
            </button>
          );
        })}
      </div>

      {activePreviewOption?.preview ? (
        <div className="mt-2 min-w-0 overflow-hidden rounded-lg border border-border/50 bg-background/35">
          <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-1.5">
            <span className="shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground/70 uppercase">
              Preview
            </span>
            {previewableOptions.length > 1 ? (
              <div className="-m-1 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {previewableOptions.map((option) => (
                  <button
                    key={`preview-tab:${question.id}:${option.label}`}
                    type="button"
                    onClick={() => setPreviewedOptionLabel(option.label)}
                    className={cn(
                      "shrink-0 cursor-pointer rounded-md px-1.5 py-0.5 text-[11px] outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-primary/25",
                      option.label === activePreviewOption.label
                        ? "bg-primary/10 text-foreground/90"
                        : "text-muted-foreground/65 hover:text-muted-foreground",
                    )}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            ) : (
              <span className="truncate text-[11px] text-muted-foreground/65">
                {activePreviewOption.label}
              </span>
            )}
          </div>
          <div className="max-h-64 overflow-auto px-3 py-2">
            <ChatMarkdown
              key={`${question.id}:${activePreviewOption.label}`}
              text={activePreviewOption.preview}
              cwd={undefined}
              isStreaming={false}
            />
          </div>
        </div>
      ) : null}

      <Textarea
        size="sm"
        className="mt-2"
        value={draft?.customAnswer ?? ""}
        disabled={disabled}
        placeholder="Or type your own answer"
        aria-label={`Custom answer for ${question.header}`}
        onChange={(event) => onChangeCustomAnswer(question.id, event.target.value)}
      />
    </div>
  );
});
