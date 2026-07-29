import type { ApprovalRequestId, UserInputQuestion } from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, PencilLineIcon } from "lucide-react";
import { memo, useLayoutEffect, useRef, useState } from "react";

import type { UserInputAnswerDraft } from "@t3tools/shared/userInputAnswers";
import {
  isUsingCustomUserInputAnswer,
  resolveUserInputAnswer,
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

/** The answer as one line of prose, or `null` while the question is unanswered. */
const answerSummary = (
  question: UserInputQuestion,
  draft: UserInputAnswerDraft | undefined,
): string | null => {
  const answer = resolveUserInputAnswer(question, draft);
  if (answer === null) return null;
  return typeof answer === "string" ? answer : answer.join(", ");
};

/**
 * An agent question, rendered as a self-contained card that sits above the
 * composer and never touches it (design commitment 5).
 *
 * Everything the human needs is inside this card: the options, their previews,
 * a free-text field per question, submit, and — always — dismiss. The composer
 * behind it stays a composer: no value swap, no keystroke reroute, no Enter
 * hijack, and no document-level digit listener, so no keystroke aimed at
 * something else can ever select or submit an answer.
 *
 * A multi-question request is an **accordion**: one question is expanded at a
 * time and every other one keeps a visible header row, so the card reads as a
 * prompt rather than a form (a three-question request rendered in parallel cost
 * ~1600px of the viewport). The expanded question is presentational, per-mount
 * state — it is never written to the answer-draft store, and expanding,
 * collapsing or auto-advancing dispatches nothing: submit remains the only path
 * that sends answers, and dismiss stays outside the collapsing region.
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
  const questions = pendingUserInput.questions;

  const firstUnansweredId = (from: ReadonlyArray<UserInputQuestion>): string | null =>
    from.find((question) => answerSummary(question, drafts[question.id]) === null)?.id ?? null;

  // Per-mount and presentational — never written to the answer-draft store, so a
  // partial answer that survived a thread switch re-derives "first unanswered" on
  // its next mount rather than restoring a stale position. Held rather than
  // derived every render because a question must not close under the user the
  // instant their typing makes it answered; re-derived whenever the held id is not
  // one of these questions, so the card can never render with nothing expanded.
  const [openedQuestionId, setOpenedQuestionId] = useState<string | null>(() =>
    firstUnansweredId(questions),
  );
  const expandedQuestionId = questions.some((question) => question.id === openedQuestionId)
    ? openedQuestionId
    : firstUnansweredId(questions);

  const cardRef = useRef<HTMLDivElement | null>(null);
  // Set only by an aimed activation inside the card that is about to unmount the
  // control the user is standing on, so focus is never taken from elsewhere (the
  // composer included) and never moves on a plain mount.
  const focusAfterAdvanceRef = useRef<string | null>(null);

  // An advance unmounts the option or confirm button that triggered it, which
  // drops focus to <body> — outside the card — and forces a keyboard user to
  // restart tab traversal after every question. Focus moves to the newly expanded
  // question's header, or to submit when that was the last one, so the keyboard
  // path lands exactly where the flow continues. A layout effect keyed on the
  // resolved expansion, rather than a timer, so it runs once the row it targets is
  // actually in the DOM.
  useLayoutEffect(() => {
    const target = focusAfterAdvanceRef.current;
    if (target === null) return;
    focusAfterAdvanceRef.current = null;
    cardRef.current?.querySelector<HTMLElement>(target)?.focus();
  }, [expandedQuestionId]);

  /**
   * Collapse `questionId` and open the next question still unanswered, wrapping
   * past the end so answering out of order cannot skip anything. `null` — every
   * question answered — collapses them all to their summaries, which is the state
   * in which submit is the only thing left to do.
   */
  const advancePast = (questionId: string) => {
    const index = questions.findIndex((question) => question.id === questionId);
    const next = firstUnansweredId([...questions.slice(index + 1), ...questions.slice(0, index)]);
    // A lone question never collapses, so the control the user activated is still
    // there and focus must be left exactly where they put it.
    if (questions.length > 1) {
      focusAfterAdvanceRef.current =
        next === null
          ? "[data-pending-question-submit]"
          : `[data-pending-question-header="${next}"]`;
    }
    setOpenedQuestionId(next);
  };

  return (
    <div
      ref={cardRef}
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
        <div className="space-y-1">
          {questions.map((question) => (
            <PendingQuestionSection
              key={question.id}
              question={question}
              draft={drafts[question.id]}
              disabled={busy}
              // A lone question has nothing to collapse for, so it keeps the plain
              // header it always had rather than a disclosure control that does
              // nothing.
              collapsible={questions.length > 1}
              expanded={questions.length === 1 || expandedQuestionId === question.id}
              // Whether advancing from here lands on another question, so the
              // advance control can say where it goes instead of implying that it
              // validates the answer.
              advancesToAnother={
                questions.some(
                  (other) =>
                    other.id !== question.id && answerSummary(other, drafts[other.id]) === null,
                ) && questions.length > 1
              }
              onExpand={() => setOpenedQuestionId(question.id)}
              onAnswered={() => advancePast(question.id)}
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
              : questions.length > 1
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
  collapsible,
  expanded,
  advancesToAnother,
  onExpand,
  onAnswered,
  onToggleOption,
  onChangeCustomAnswer,
}: {
  readonly question: UserInputQuestion;
  readonly draft: UserInputAnswerDraft | undefined;
  readonly disabled: boolean;
  readonly collapsible: boolean;
  readonly expanded: boolean;
  readonly advancesToAnother: boolean;
  readonly onExpand: () => void;
  /** The question just became answered by an explicit act: collapse and advance. */
  readonly onAnswered: () => void;
  readonly onToggleOption: (question: UserInputQuestion, optionLabel: string) => void;
  readonly onChangeCustomAnswer: (questionId: string, customAnswer: string) => void;
}) {
  const [previewedOptionLabel, setPreviewedOptionLabel] = useState<string | null>(null);
  const [customAnswerOpened, setCustomAnswerOpened] = useState(false);
  const usingCustomAnswer = isUsingCustomUserInputAnswer(draft);
  const selectedOptionLabels = selectedUserInputOptionLabels(draft);
  const summary = answerSummary(question, draft);
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
  // Free text that already exists stays visible on its own account: collapsing it
  // back behind the affordance would hide the answer in play.
  const customAnswerExpanded = customAnswerOpened || (draft?.customAnswer ?? "") !== "";
  const bodyId = `pending-question-body:${question.id}`;

  return (
    <div
      data-pending-question={question.id}
      data-pending-question-expanded={expanded ? "true" : "false"}
      data-pending-question-answered={summary === null ? "false" : "true"}
      className={cn(
        "rounded-lg transition-colors duration-150",
        collapsible && expanded ? "bg-muted/15" : null,
      )}
    >
      {collapsible ? (
        <button
          type="button"
          data-pending-question-header={question.id}
          aria-expanded={expanded}
          aria-controls={expanded ? bodyId : undefined}
          onClick={onExpand}
          className={cn(
            "flex w-full min-w-0 items-baseline gap-2 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-1 focus-visible:ring-primary/25",
            expanded ? "cursor-default" : "cursor-pointer hover:bg-muted/25",
          )}
        >
          {expanded ? (
            <ChevronDownIcon className="size-3 shrink-0 translate-y-0.5 text-muted-foreground/50" />
          ) : (
            <ChevronRightIcon className="size-3 shrink-0 translate-y-0.5 text-muted-foreground/50" />
          )}
          <span className="shrink-0 text-[11px] font-semibold tracking-widest text-muted-foreground/55 uppercase">
            {question.header}
          </span>
          {expanded ? null : (
            <span
              data-pending-question-summary={question.id}
              className={cn(
                "min-w-0 flex-1 truncate text-xs",
                summary === null ? "text-muted-foreground/70" : "text-foreground/85",
              )}
            >
              {summary ?? question.question}
            </span>
          )}
          {/* A multi-select answer is complete at one selection, so a collapsed row
              can hold a set the user was still building. The count states the
              extent of what would be submitted — a bare tick would read as a
              deliberate final choice either way. */}
          {summary !== null && !expanded && question.multiSelect && !usingCustomAnswer ? (
            <span
              data-pending-question-selected-count={question.id}
              className="shrink-0 text-[10px] font-medium tabular-nums text-muted-foreground/60"
            >
              {selectedOptionLabels.length} of {question.options.length}
            </span>
          ) : null}
          {summary !== null && !expanded ? (
            <CheckIcon className="size-3.5 shrink-0 translate-y-0.5 text-primary" />
          ) : null}
        </button>
      ) : (
        <span className="text-[11px] font-semibold tracking-widest text-muted-foreground/55 uppercase">
          {question.header}
        </span>
      )}

      {expanded ? (
        <div id={bodyId} className={collapsible ? "px-2 pb-2" : "mt-1"}>
          <p className="text-sm text-foreground/90">{question.question}</p>
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
                  onClick={() => {
                    onToggleOption(question, option.label);
                    // Selecting an option discards free text (shared draft rule),
                    // so the field folds back to its affordance with it.
                    setCustomAnswerOpened(false);
                    // A multi-select question is not answered by its first
                    // toggle — advancing there would take the surface away
                    // mid-selection, so it waits for the explicit control below.
                    if (!question.multiSelect) onAnswered();
                  }}
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

          {customAnswerExpanded ? (
            <div className="mt-2">
              <Textarea
                size="sm"
                // Opened by an aimed click, so taking focus is what the user asked
                // for; the field never mounts focused on its own.
                autoFocus={customAnswerOpened}
                value={draft?.customAnswer ?? ""}
                disabled={disabled}
                placeholder="Type your own answer"
                aria-label={`Custom answer for ${question.header}`}
                onChange={(event) => onChangeCustomAnswer(question.id, event.target.value)}
              />
            </div>
          ) : (
            <button
              type="button"
              data-pending-question-custom-answer-open={question.id}
              disabled={disabled}
              onClick={() => setCustomAnswerOpened(true)}
              className={cn(
                "mt-2 flex w-full items-center gap-2 rounded-lg border border-dashed border-border/50 px-3 py-1.5 text-left text-xs text-muted-foreground outline-none transition-colors duration-150 focus-visible:border-primary/40 focus-visible:ring-1 focus-visible:ring-primary/25",
                disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-muted/25",
              )}
            >
              <PencilLineIcon className="size-3.5 shrink-0" />
              Type your own answer…
            </button>
          )}

          {/* Only an accordion has somewhere to advance to: a lone question needs
              no advance control, and adding one would read as a second submit.

              This control ADVANCES; it does not validate. A multi-select answer is
              complete once one option is selected (the shared contract's rule,
              which mobile submits on identically), so the label says where it goes
              rather than "Confirm" — which would imply a commitment gate the answer
              contract does not have, and which the row state could not honour. */}
          {collapsible && (question.multiSelect || customAnswerExpanded) ? (
            <div className="mt-2 flex justify-end">
              <Button
                type="button"
                size="xs"
                variant="outline"
                data-pending-question-confirm={question.id}
                className="rounded-full"
                disabled={disabled || summary === null}
                onClick={onAnswered}
              >
                {advancesToAnother ? "Next question" : "Done"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
