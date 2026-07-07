import { memo, use, useEffect, useRef, useState } from "react";
import { BrainIcon, ChevronDownIcon, Loader2Icon } from "lucide-react";
import { deriveTimelineEntries } from "~/session-logic";
import { type ReasoningDisplayMode } from "@t3tools/contracts/settings";
import ChatMarkdown from "~/components/ChatMarkdown";
import { cn } from "~/lib/utils";
import {
  formatWorkingTimer,
  TimelineRowCtx,
  WorkingTimer,
} from "~/components/chat/MessagesTimeline";

type TimelineMessage = Extract<
  ReturnType<typeof deriveTimelineEntries>[number],
  { kind: "message" }
>["message"];

// Collapsible "thinking" trace rendered above an assistant answer. Shows a live
// "Thinking…" header with elapsed time while streaming, then "Thought for Xs".
export const ReasoningBlock = memo(function ReasoningBlock({
  message,
  mode,
}: {
  message: TimelineMessage;
  mode: ReasoningDisplayMode;
}) {
  const ctx = use(TimelineRowCtx);
  const streaming = Boolean(message.reasoningStreaming);
  const [open, setOpen] = useState(mode === "expanded" || streaming);
  const wasStreamingRef = useRef(streaming);
  useEffect(() => {
    const wasStreaming = wasStreamingRef.current;
    wasStreamingRef.current = streaming;
    if (streaming) {
      setOpen(true);
    } else if (wasStreaming && mode === "collapsed") {
      setOpen(false);
    }
  }, [streaming, mode]);

  const duration = streaming ? null : formatWorkingTimer(message.createdAt, message.updatedAt);

  return (
    <div className="mb-1.5 rounded-lg border border-border/60 bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        {streaming ? (
          <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <BrainIcon className="size-3.5" aria-hidden />
        )}
        <span className="font-medium">
          {streaming ? (
            <>
              Thinking <WorkingTimer createdAt={message.createdAt} />
            </>
          ) : duration ? (
            `Thought for ${duration}`
          ) : (
            "Thought"
          )}
        </span>
        <ChevronDownIcon
          className={cn("ml-auto size-3.5 transition-transform", open ? "rotate-180" : null)}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="min-w-0 border-t border-border/60 px-2 py-1.5 text-sm text-muted-foreground">
          <ChatMarkdown
            text={message.reasoningText ?? ""}
            cwd={ctx.markdownCwd}
            threadRef={ctx.threadRef ?? undefined}
            isStreaming={streaming}
            skills={ctx.skills}
            className="text-muted-foreground"
          />
        </div>
      ) : null}
    </div>
  );
});
