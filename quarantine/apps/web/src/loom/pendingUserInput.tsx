// Loom's additions to upstream's pending-question panel
// (`components/chat/ComposerPendingUserInputPanel.tsx`), so a question read
// cold — hours later, from another thread — is legible: a markdown body whose
// workspace paths are chat's file chips, how long it has waited, the agent's
// pick, the whole set at a glance, and a way to answer the set in prose.
import type { ScopedThreadRef, UserInputQuestion } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { formatElapsedDurationLabel } from "~/timestampFormat";

/** Where the body's relative paths resolve and which panel their chips open in. */
export interface PendingQuestionMarkdownContext {
  readonly cwd: string | undefined;
  readonly threadRef: ScopedThreadRef | undefined;
}

export function PendingQuestionBody(props: {
  text: string;
  markdown: PendingQuestionMarkdownContext | undefined;
}) {
  return (
    <ChatMarkdown
      text={props.text}
      cwd={props.markdown?.cwd}
      threadRef={props.markdown?.threadRef}
      className="text-sm text-foreground/85"
      lineBreaks
    />
  );
}

/**
 * Age of `iso` on the shared minute clock: undefined when unparseable, null
 * under a minute, else "4m" / "3h" / "2d". The clock's VALUE must feed the
 * computation: the React Compiler memoises on reactive inputs, so a bare
 * `useNowMinute()` subscription re-rendered without recomputing a label
 * derived from `iso` alone (a `Date.now()` inside is invisible to it), so
 * the label froze.
 * Minute resolution, so an age reads up to a minute low.
 */
function useMinuteAge(iso: string): string | null | undefined {
  const label = formatElapsedDurationLabel(iso, Date.parse(`${useNowMinute()}:00Z`));
  if (label === "") return undefined;
  return label === "just now" || label.endsWith("s") ? null : label;
}

/** "asked 3h ago" in the panel header. */
export function PendingQuestionAge({ createdAt }: { createdAt: string }) {
  const age = useMinuteAge(createdAt);
  return age === undefined ? null : (
    <span className="shrink-0 text-3xs text-muted-foreground tabular-nums">
      asked {age === null ? "just now" : `${age} ago`}
    </span>
  );
}

/** Sidebar row's Input label suffix: how long the oldest open question has waited ("· 3h"). */
export function PendingQuestionWaitAge({ since }: { since: string }) {
  const age = useMinuteAge(since);
  return age === undefined ? null : <span className="font-normal">· {age ?? "now"}</span>;
}

export function RecommendedBadge() {
  return (
    <span className="shrink-0 rounded border border-success/30 bg-success/10 px-1 py-px text-3xs font-semibold uppercase leading-tight tracking-wide text-success-foreground">
      Recommended
    </span>
  );
}

/**
 * Every header of a multi-question set with its answered state, so the reader
 * sees the whole set before answering the first. Clicking jumps to a question.
 */
export function PendingQuestionSetStrip(props: {
  questions: ReadonlyArray<UserInputQuestion>;
  activeIndex: number;
  isAnswered: (question: UserInputQuestion) => boolean;
  onSelect: (index: number) => void;
}) {
  if (props.questions.length < 2) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-1" data-pending-user-input-set-strip>
      {props.questions.map((question, index) => {
        const answered = props.isAnswered(question);
        return (
          <button
            key={question.id}
            type="button"
            onClick={() => props.onSelect(index)}
            aria-current={index === props.activeIndex ? "step" : undefined}
            className={cn(
              "flex max-w-full items-center gap-1 rounded-md border px-1.5 py-0.5 text-2xs transition-colors",
              index === props.activeIndex
                ? "border-primary/40 bg-muted/55 text-foreground"
                : "border-border/60 text-muted-foreground hover:bg-muted/30",
            )}
          >
            <span className="tabular-nums">{index + 1}.</span>
            <span className="truncate">{question.header}</span>
            {answered ? <CheckIcon className="size-3 shrink-0 text-primary" /> : null}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Sends the composer's text as a plain chat message, which settles the whole
 * set `superseded` server-side instead of answering the current question.
 */
export function ReplyInChatInsteadButton(props: {
  hasText: boolean;
  questionCount: number;
  disabled: boolean;
  onReply: () => void;
}) {
  const scope = props.questionCount > 1 ? `all ${props.questionCount} questions` : "the question";
  return (
    <div className="mt-2 flex items-center justify-end gap-2 text-2xs text-muted-foreground">
      <span>
        {props.hasText
          ? `Sends the composer text as a message that settles ${scope}`
          : "Type in the composer to reply in your own words"}
      </span>
      <button
        type="button"
        disabled={props.disabled || !props.hasText}
        onClick={props.onReply}
        data-pending-user-input-reply-in-chat
        className="shrink-0 rounded-md border border-border/60 px-2 py-1 transition-colors hover:bg-muted/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
      >
        Reply in chat instead ↩
      </button>
    </div>
  );
}
