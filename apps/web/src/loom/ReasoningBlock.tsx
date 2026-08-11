import { memo, use, useEffect, useRef, useState } from "react";
import { BrainIcon, ChevronDownIcon, Loader2Icon } from "lucide-react";
import { deriveTimelineEntries } from "~/session-logic";
import { type ReasoningDisplayMode } from "@t3tools/contracts/settings";
import ChatMarkdown from "~/components/ChatMarkdown";
import { cn } from "~/lib/utils";
import { formatElapsedMs, TimelineRowCtx, WorkingTimer } from "~/components/chat/MessagesTimeline";

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

  // Thinking time is measured where the burst boundaries are known (provider
  // ingestion) and carried on the message. The message's own
  // createdAt/updatedAt cannot stand in: they describe the message, and in the
  // durable record both are the single finalize instant ("Thought for 0s").
  // Absent ⇒ reasoning persisted before the duration was recorded: show
  // "Thought" rather than a fabricated number.
  // Sub-second bursts read as "<1s": flooring them to "0s" is the exact string
  // the missing-duration bug produced, so it must not be a legitimate output.
  const duration =
    streaming || message.reasoningMs === undefined
      ? null
      : message.reasoningMs < 1000
        ? "<1s"
        : formatElapsedMs(message.reasoningMs);

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
