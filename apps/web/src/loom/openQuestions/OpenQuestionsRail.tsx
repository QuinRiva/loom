/**
 * loom: the open-questions rail above the composer, one row per Loom ask, one expanded at a time
 * with its own answer field. While the composer draft is non-empty every row is minimised unless
 * expanded since; an explicit minimise persists per question (`openQuestionsUiStore`).
 */
import type { RuntimeRequestId, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { ChevronDownIcon, ChevronUpIcon, MessageCircleQuestionIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { create } from "zustand";

import ChatMarkdown from "../../components/ChatMarkdown";
import { ComposerBanner } from "../../components/chat/ComposerBanner";
import { OptionRadio } from "../../components/chat/ComposerPendingUserInputPanel";
import { Button } from "../../components/ui/button";
import { CheckboxMark } from "../../components/ui/checkbox";
import { Input } from "../../components/ui/input";
import { Kbd } from "../../components/ui/kbd";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { cn } from "../../lib/utils";
import {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "@t3tools/client-runtime/state/pending-user-input";
import { derivePendingUserInputProgress } from "../../pendingUserInput";
import type { PendingUserInput } from "../../session-logic";
import { PendingQuestionWaitAge } from "../pendingUserInputLoom";
import { proceedingOn } from "./openQuestions";
import { selectCollapsedQuestions, useOpenQuestionsUiStore } from "./openQuestionsUiStore";

const VISIBLE_ROWS = 3;

interface AnswerDraft {
  readonly answers: Readonly<Record<string, PendingUserInputDraftAnswer>>;
  readonly index: number;
}
const NO_DRAFT: AnswerDraft = { answers: {}, index: 0 };
/** Tier 4 in spirit, but outlives the card so a half-typed answer survives navigating away. */
const useAnswerDrafts = create<Readonly<Record<string, AnswerDraft>>>(() => ({}));
const draftKey = (threadRef: ScopedThreadRef, requestId: string) =>
  `${scopedThreadKey(threadRef)}|${requestId}`;
const updateDraft = (key: string, update: (draft: AnswerDraft) => AnswerDraft) =>
  useAnswerDrafts.setState((state) => ({ [key]: update(state[key] ?? NO_DRAFT) }));

export function OpenQuestionsRail({
  threadRef,
  composerDraftTarget,
  questions,
  cwd,
  disabled,
  respondingRequestIds,
  onAnswer,
  onDismiss,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly questions: ReadonlyArray<PendingUserInput>;
  readonly cwd: string | undefined;
  readonly disabled: boolean;
  readonly respondingRequestIds: ReadonlyArray<RuntimeRequestId>;
  readonly onAnswer: (requestId: RuntimeRequestId, answers: Record<string, unknown>) => unknown;
  readonly onDismiss: (requestId: RuntimeRequestId) => unknown;
}) {
  const typing = useComposerDraftStore(
    (store) => (store.getComposerDraft(composerDraftTarget)?.prompt.trim().length ?? 0) > 0,
  );
  const collapsed = useOpenQuestionsUiStore((state) => selectCollapsedQuestions(state, threadRef));
  const setCollapsed = useOpenQuestionsUiStore((state) => state.setCollapsed);
  // An explicit expand (id) or minimise (null), held only in the typing state it was made in.
  const [pick, setPick] = useState<{ readonly id: string | null; readonly typing: boolean } | null>(
    null,
  );
  const [showAll, setShowAll] = useState(false);
  if (pick !== null && pick.typing !== typing) setPick(null);
  if (questions.length === 0) return null;

  const ids = questions.map((question) => question.requestId);
  const head = questions[0]!;
  const expandedId =
    pick !== null && (pick.id === null || ids.includes(pick.id as RuntimeRequestId))
      ? pick.id
      : typing || collapsed[head.requestId]
        ? null
        : head.requestId;
  const visible = showAll ? questions : questions.slice(0, VISIBLE_ROWS);
  const expand = (id: RuntimeRequestId) => {
    setPick({ id, typing });
    if (collapsed[id]) setCollapsed(threadRef, id, false, ids);
  };
  const minimise = (id: RuntimeRequestId) => {
    setPick({ id: null, typing });
    setCollapsed(threadRef, id, true, ids);
  };

  return (
    <ComposerBanner.Root detached density="comfortable" className="mb-2" data-loom-open-questions>
      {questions.length >= 2 ? (
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <MessageCircleQuestionIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content className="text-muted-foreground">
            {questions.length} open questions
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={disabled}
              onClick={() => ids.forEach((id) => void onDismiss(id))}
            >
              Dismiss all
            </Button>
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
      ) : null}
      {visible.map((question) =>
        question.requestId === expandedId ? (
          <ExpandedQuestion
            key={question.requestId}
            threadRef={threadRef}
            question={question}
            cwd={cwd}
            disabled={disabled || respondingRequestIds.includes(question.requestId)}
            onMinimise={() => minimise(question.requestId)}
            onAnswer={(answers) => onAnswer(question.requestId, answers)}
            onDismiss={() => onDismiss(question.requestId)}
          />
        ) : (
          <QuestionRow
            key={question.requestId}
            question={question}
            disabled={disabled || respondingRequestIds.includes(question.requestId)}
            onExpand={() => expand(question.requestId)}
            onDismiss={() => onDismiss(question.requestId)}
          />
        ),
      )}
      {questions.length > visible.length ? (
        <button
          type="button"
          className="w-full ps-8 pt-1 text-start text-muted-foreground hover:text-foreground sm:ps-7"
          onClick={() => setShowAll(true)}
        >
          {questions.length - visible.length} more
        </button>
      ) : null}
    </ComposerBanner.Root>
  );
}

function RowLabel({ question }: { readonly question: PendingUserInput }) {
  const first = question.questions[0];
  const recommended = first ? proceedingOn(first) : null;
  return (
    <ComposerBanner.Content className="gap-1.5">
      <span className="truncate font-medium text-foreground">{first?.header}</span>
      <span className="shrink-0 text-muted-foreground">
        <PendingQuestionWaitAge since={question.createdAt} />
      </span>
      <span className="truncate text-muted-foreground">
        ·{" "}
        {question.blocking
          ? "the agent is waiting"
          : recommended === null
            ? "the agent carried on"
            : `proceeding on: ${recommended}`}
      </span>
    </ComposerBanner.Content>
  );
}

function QuestionRow({
  question,
  disabled,
  onExpand,
  onDismiss,
}: {
  readonly question: PendingUserInput;
  readonly disabled: boolean;
  readonly onExpand: () => void;
  readonly onDismiss: () => void;
}) {
  return (
    <ComposerBanner.Row data-loom-open-question="minimised">
      <ComposerBanner.Icon>
        <MessageCircleQuestionIcon />
      </ComposerBanner.Icon>
      <RowLabel question={question} />
      <ComposerBanner.Actions className="gap-0">
        <Button size="icon-xs" variant="ghost" aria-label="Expand question" onClick={onExpand}>
          <ChevronUpIcon className="size-3.5" />
        </Button>
        <ComposerBanner.Dismiss
          aria-label="Dismiss question without answering"
          disabled={disabled}
          onClick={onDismiss}
        />
      </ComposerBanner.Actions>
    </ComposerBanner.Row>
  );
}

function ExpandedQuestion({
  threadRef,
  question: request,
  cwd,
  disabled,
  onMinimise,
  onAnswer,
  onDismiss,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly question: PendingUserInput;
  readonly cwd: string | undefined;
  readonly disabled: boolean;
  readonly onMinimise: () => void;
  readonly onAnswer: (answers: Record<string, unknown>) => unknown;
  readonly onDismiss: () => unknown;
}) {
  const key = draftKey(threadRef, request.requestId);
  const draft = useAnswerDrafts((state) => state[key] ?? NO_DRAFT);
  const progress = derivePendingUserInputProgress(request.questions, draft.answers, draft.index);
  const question = progress.activeQuestion;
  const recommended = question ? proceedingOn(question) : null;
  const toggle = (optionValue: string) => {
    if (disabled || question === null) return;
    updateDraft(key, (current) => ({
      ...current,
      answers: {
        ...current.answers,
        [question.id]: togglePendingUserInputOptionSelection(
          question,
          current.answers[question.id],
          optionValue,
        ),
      },
    }));
  };
  const submit = () => {
    if (disabled || !progress.canAdvance) return;
    if (!progress.isLastQuestion) {
      updateDraft(key, (current) => ({ ...current, index: progress.questionIndex + 1 }));
      return;
    }
    const answers = buildPendingUserInputAnswers(request.questions, draft.answers);
    if (answers !== null) void onAnswer(answers);
  };
  const selectFromDigit = useEffectEvent(toggle);
  // Digits select and never submit; typing in a field or the composer is left alone.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a document keydown listener, held while this question is expanded
  useEffect(() => {
    if (question === null) return;
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement &&
          target.closest('[contenteditable]:not([contenteditable="false"])'))
      )
        return;
      const option = question.options[Number.parseInt(event.key, 10) - 1];
      if (option === undefined) return;
      event.preventDefault();
      selectFromDigit(option.value ?? option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [question]);
  if (question === null) return null;

  return (
    <div data-loom-open-question="expanded" className="py-0.5">
      <ComposerBanner.Row>
        <ComposerBanner.Icon className="text-foreground">
          <MessageCircleQuestionIcon />
        </ComposerBanner.Icon>
        <RowLabel question={request} />
        <ComposerBanner.Actions className="gap-0">
          {request.questions.length > 1 ? (
            <ComposerBanner.Count>
              {progress.questionIndex + 1}/{request.questions.length}
            </ComposerBanner.Count>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Minimise question"
            onClick={onMinimise}
          >
            <ChevronDownIcon className="size-3.5" />
          </Button>
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
      <ComposerBanner.Scroll>
        <ComposerBanner.Body className="pe-3 pb-1 wrap-anywhere">
          {request.questions.length > 1 ? (
            <p className="pt-1 font-medium text-foreground">{question.header}</p>
          ) : null}
          <ChatMarkdown
            text={question.question}
            cwd={cwd}
            threadRef={threadRef}
            className="pt-1.5 text-foreground/85"
            lineBreaks
          />
          <div className="-ms-2 mt-1.5 sm:-ms-1.5">
            {question.options.map((option, index) => {
              const value = option.value ?? option.label;
              const selected =
                !progress.usingCustomAnswer && progress.selectedOptionValues.includes(value);
              const isRecommended = recommended !== null && option.value === recommended;
              return (
                <button
                  key={value}
                  type="button"
                  aria-pressed={selected}
                  disabled={disabled}
                  onClick={() => toggle(value)}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-md py-1.5 ps-2 text-start outline-none transition-colors focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/25 sm:ps-1.5",
                    selected ? "text-foreground" : "text-foreground/70 hover:bg-muted/30",
                    disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer",
                  )}
                >
                  <span className="flex h-5 shrink-0 items-center">
                    {question.multiSelect ? (
                      <CheckboxMark checked={selected} />
                    ) : (
                      <OptionRadio checked={selected} />
                    )}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="text-sm font-medium">
                      {isRecommended ? recommended : option.label}
                      {isRecommended && !request.blocking ? (
                        <span className="ms-2 text-2xs font-normal text-muted-foreground">
                          proceeding on this
                        </span>
                      ) : isRecommended ? (
                        <span className="ms-2 text-2xs font-normal text-muted-foreground">
                          recommended
                        </span>
                      ) : null}
                    </span>
                    {option.description && option.description !== option.label ? (
                      <span className="text-2xs text-secondary-label">{option.description}</span>
                    ) : null}
                  </span>
                  {index < 9 ? (
                    <span className="flex h-5 w-7 shrink-0 items-center justify-center sm:w-6">
                      <Kbd>{index + 1}</Kbd>
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="mt-2 flex items-center gap-2">
            {question.allowCustomAnswer === false ? null : (
              <Input
                size="sm"
                className="flex-1"
                placeholder="Or in your own words…"
                aria-label={`Answer "${question.header}" in your own words`}
                value={progress.customAnswer}
                disabled={disabled}
                onChange={(event) => {
                  const text = event.currentTarget.value;
                  updateDraft(key, (current) => ({
                    ...current,
                    answers: {
                      ...current.answers,
                      [question.id]: setPendingUserInputCustomAnswer(
                        question,
                        current.answers[question.id],
                        text,
                      ),
                    },
                  }));
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" || event.shiftKey) return;
                  event.preventDefault();
                  submit();
                }}
              />
            )}
            {progress.questionIndex > 0 ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  updateDraft(key, (current) => ({ ...current, index: progress.questionIndex - 1 }))
                }
              >
                Back
              </Button>
            ) : null}
            <Button size="sm" disabled={disabled || !progress.canAdvance} onClick={submit}>
              {progress.isLastQuestion ? "Answer" : "Next"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => void onDismiss()}
            >
              <XIcon />
              Dismiss
            </Button>
          </div>
        </ComposerBanner.Body>
      </ComposerBanner.Scroll>
    </div>
  );
}
