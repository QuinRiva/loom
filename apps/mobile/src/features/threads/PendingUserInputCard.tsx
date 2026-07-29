import type {
  ApprovalRequestId,
  ProviderUserInputAnswers,
  UserInputQuestion,
} from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";

import {
  isUsingCustomUserInputAnswer,
  selectedUserInputOptionLabels,
  type UserInputAnswerDraft,
} from "@t3tools/shared/userInputAnswers";
import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { MarkdownBlock } from "../../components/MarkdownBlock";
import { cn } from "../../lib/cn";
import type { PendingUserInput } from "../../lib/threadActivity";

export interface PendingUserInputCardProps {
  readonly pendingUserInput: PendingUserInput;
  /** Total open requests, so a second question is never invisible. */
  readonly pendingCount: number;
  readonly drafts: Record<string, UserInputAnswerDraft>;
  readonly answers: ProviderUserInputAnswers | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly dismissingUserInputId: ApprovalRequestId | null;
  readonly onSelectOption: (
    requestId: ApprovalRequestId,
    question: UserInputQuestion,
    label: string,
  ) => void;
  readonly onChangeCustomAnswer: (
    requestId: ApprovalRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmit: () => Promise<unknown>;
  readonly onDismiss: () => Promise<unknown>;
}

export function PendingUserInputCard(props: PendingUserInputCardProps) {
  const isResponding = props.respondingUserInputId === props.pendingUserInput.requestId;
  const isDismissing = props.dismissingUserInputId === props.pendingUserInput.requestId;
  const busy = isResponding || isDismissing;
  const morePending = props.pendingCount - 1;

  return (
    <View className="gap-2.5 rounded-[20px] border border-neutral-200 bg-neutral-100/80 p-4 dark:border-white/6 dark:bg-neutral-900/80">
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-sky-700 dark:text-sky-300">
        User input needed
      </Text>
      <Text className="font-t3-bold text-lg text-neutral-950 dark:text-neutral-50">
        Fill in the pending answers
      </Text>
      {morePending > 0 ? (
        <Text className="font-sans text-sm text-neutral-500 dark:text-neutral-400">
          {morePending} more pending after this one.
        </Text>
      ) : null}
      {props.pendingUserInput.questions.map((question) => {
        const draft = props.drafts[question.id];
        const usingCustomAnswer = isUsingCustomUserInputAnswer(draft);
        const selectedOptionLabels = selectedUserInputOptionLabels(draft);
        // `preview` is single-select only (enforced in the shared parse layer).
        // The card is narrow, so previews stack under the option list and only
        // the focused option's preview is shown.
        const previewableOptions = question.options.filter((option) => option.preview);
        const previewedOption =
          previewableOptions.find(
            (option) => !usingCustomAnswer && selectedOptionLabels.includes(option.label),
          ) ??
          previewableOptions[0] ??
          null;
        return (
          <View key={question.id} className="gap-2 pt-1">
            <Text className="font-t3-bold text-xs uppercase tracking-[1px] text-neutral-500 dark:text-neutral-500">
              {question.header}
            </Text>
            <Text className="font-sans text-base leading-snug text-neutral-950 dark:text-neutral-50">
              {question.question}
            </Text>
            {question.stakes ? (
              <View className="border-l-2 border-amber-400/60 pl-2.5">
                <Text className="font-sans text-sm leading-snug text-neutral-600 dark:text-neutral-400">
                  {question.stakes}
                </Text>
              </View>
            ) : null}
            {question.multiSelect ? (
              <Text className="font-sans text-sm text-neutral-500 dark:text-neutral-400">
                Select one or more options.
              </Text>
            ) : null}
            <View className="flex-row flex-wrap gap-2.5">
              {question.options.map((option) => {
                const selected = !usingCustomAnswer && selectedOptionLabels.includes(option.label);
                return (
                  <Pressable
                    key={option.label}
                    className={cn(
                      "rounded-full border px-3 py-2.5 ",
                      selected
                        ? "border-blue-300/50 bg-blue-50 dark:border-blue-400/28 dark:bg-blue-400/14"
                        : "border-neutral-200 bg-white dark:border-white/6 dark:bg-neutral-950/70",
                    )}
                    disabled={busy}
                    onPress={() =>
                      props.onSelectOption(props.pendingUserInput.requestId, question, option.label)
                    }
                  >
                    <View className="flex-row items-center gap-1.5">
                      <Text
                        className={cn(
                          "font-t3-bold text-sm",
                          selected
                            ? "text-sky-700 dark:text-sky-300"
                            : "text-neutral-600 dark:text-neutral-300",
                        )}
                      >
                        {option.label}
                      </Text>
                      {option.recommended ? (
                        <Text className="rounded-full bg-emerald-500/12 px-1.5 py-0.5 font-t3-bold text-2xs uppercase tracking-[0.8px] text-emerald-700 dark:bg-emerald-400/14 dark:text-emerald-300">
                          Suggested
                        </Text>
                      ) : null}
                    </View>
                  </Pressable>
                );
              })}
            </View>
            {previewedOption?.preview ? (
              <View className="overflow-hidden rounded-2xl border border-neutral-200 bg-white dark:border-white/8 dark:bg-neutral-950/70">
                <Text className="border-b border-neutral-200 px-3 py-2 font-t3-bold text-2xs uppercase tracking-[1px] text-neutral-500 dark:border-white/8 dark:text-neutral-500">
                  Preview · {previewedOption.label}
                </Text>
                <ScrollView
                  className="max-h-56"
                  contentContainerStyle={{ padding: 12 }}
                  nestedScrollEnabled
                >
                  <MarkdownBlock markdown={previewedOption.preview} />
                </ScrollView>
              </View>
            ) : null}
            <TextInput
              value={draft?.customAnswer ?? ""}
              editable={!busy}
              onChangeText={(value) =>
                props.onChangeCustomAnswer(props.pendingUserInput.requestId, question.id, value)
              }
              placeholder="Or type a custom answer"
              className="min-h-[54px] rounded-2xl border border-neutral-200 bg-white px-3.5 py-3 font-sans text-base text-neutral-950 dark:border-white/8 dark:bg-neutral-950/70 dark:text-neutral-50"
            />
          </View>
        );
      })}
      <View className="flex-row gap-2.5">
        {/* Always an exit: dismissal settles the question server-side, so it works
            even when the session that asked is gone. */}
        <Pressable
          className="items-center justify-center rounded-2xl border border-neutral-200 px-4 py-3.5 dark:border-white/8"
          disabled={busy}
          onPress={() => void props.onDismiss()}
        >
          <Text className="font-t3-extrabold text-sm text-neutral-600 dark:text-neutral-300">
            {isDismissing ? "Dismissing…" : "Dismiss"}
          </Text>
        </Pressable>
        <Pressable
          className={cn(
            "flex-1 items-center justify-center rounded-2xl px-4 py-3.5",
            props.answers && !busy ? "bg-blue-500" : "bg-neutral-200 dark:bg-neutral-700/60",
          )}
          disabled={props.answers === null || busy}
          onPress={() => void props.onSubmit()}
        >
          <Text className="font-t3-extrabold text-sm text-white">
            {isResponding ? "Submitting…" : "Submit answers"}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
