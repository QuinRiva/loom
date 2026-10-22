/**
 * loom: the Diff panel scope menu's change-review entries (plans/change-review/plan.mdx §5),
 * mounted after upstream's Turn submenu: "Since your message" (the live interval), "Earlier"
 * (closed intervals that changed something in an enabled source kind, newest first, each with a
 * jump to its message in the chat) and the Sources toggle.
 *
 * @module loom/review/LoomScopeMenuEntries
 */
import type { LoomReviewInterval, ScopedThreadRef } from "@t3tools/contracts";
import { CheckIcon, MessageSquareIcon } from "lucide-react";
import { useEffect } from "react";

import {
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "../../components/ui/menu";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { useClientSettings } from "../../hooks/useSettings";
import { formatShortTimestamp } from "../../timestampFormat";
import { useConversationJumpStore } from "../conversationJump";
import {
  REVIEW_SOURCE_KINDS,
  type ReviewSourcesChoice,
  useReviewBaselineStore,
} from "./reviewBaselineStore";
import { useLoomReviewIntervals } from "./useLoomReviewSelection";

const changedFiles = (interval: LoomReviewInterval, sources: ReviewSourcesChoice) =>
  REVIEW_SOURCE_KINDS[sources].reduce(
    (total, kind) => total + (interval.changedBySource?.[kind] ?? 0),
    0,
  );

function Selected({ selected }: { selected: boolean }) {
  return selected ? <CheckIcon className="size-3.5" /> : <span className="size-3.5 shrink-0" />;
}

export function LoomScopeMenuEntries({
  threadRef,
  active,
}: {
  threadRef: ScopedThreadRef;
  /** An interval is what the panel shows (the Sources toggle applies only then). */
  active: boolean;
}) {
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const intervalsQuery = useLoomReviewIntervals(threadRef);
  const { refresh } = intervalsQuery;
  // The menu opening is a refresh: a message sent since the panel opened has its own interval.
  useEffect(() => refresh(), [refresh]);
  const selectedId = useReviewBaselineStore(
    (state) => state.intervalIdByThreadKey[scopedThreadKey(threadRef)] ?? null,
  );
  const sources = useReviewBaselineStore((state) => state.sources);
  const intervals = intervalsQuery.data?.intervals ?? [];
  const [live] = intervals;
  if (live === undefined) return null;
  const closed = intervals.slice(1);
  const earlier = closed.filter((interval) => changedFiles(interval, sources) > 0);
  const quiet = closed.length - earlier.length;
  const time = (at: string) => formatShortTimestamp(at, timestampFormat);
  const select = (intervalId: string) =>
    useReviewBaselineStore.getState().selectInterval(threadRef, intervalId);

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => select(live.id)}>
        <Selected selected={active && selectedId === live.id} />
        <span className="min-w-0 flex-1 truncate">Since your message</span>
        <span className="text-xs tabular-nums text-muted-foreground">{time(live.from.at)}</span>
      </DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger disabled={earlier.length === 0}>
          <span className="size-3.5 shrink-0" />
          <span className="flex-1">Earlier</span>
          <span className="text-xs tabular-nums text-muted-foreground">{earlier.length}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <div className="flex w-[min(28rem,calc(100vw-4rem))] flex-col">
            {earlier.map((interval) => {
              const files = changedFiles(interval, sources);
              return (
                <div key={interval.id} className="flex items-center gap-1">
                  <DropdownMenuItem className="min-w-0 flex-1" onClick={() => select(interval.id)}>
                    <Selected selected={active && selectedId === interval.id} />
                    <span className="text-xs font-medium tabular-nums">
                      {time(interval.from.at)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {interval.from.sender ? `${interval.from.sender}: ` : ""}
                      {interval.from.firstLine || "(no text)"}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {files === 1 ? "1 file" : `${files} files`}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    aria-label="Jump to this message in the chat"
                    title="Jump to this message in the chat"
                    onClick={() =>
                      useConversationJumpStore
                        .getState()
                        .setRequest({ threadId: threadRef.threadId, at: interval.from.at })
                    }
                  >
                    <MessageSquareIcon />
                  </DropdownMenuItem>
                </div>
              );
            })}
            {quiet > 0 ? (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                {`${quiet === 1 ? "1 message" : `${quiet} messages`} after which ${
                  sources === "repo" ? "no repo code" : "nothing"
                } changed ${quiet === 1 ? "is" : "are"} not listed.`}
              </p>
            ) : null}
          </div>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuGroup>
        <DropdownMenuLabel>
          {active ? "Sources" : "Sources (for Since your message and Earlier)"}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={sources}
          onValueChange={(value: ReviewSourcesChoice) =>
            useReviewBaselineStore.getState().setSources(value)
          }
        >
          <DropdownMenuRadioItem value="repo" disabled={!active}>
            Repo code
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="everything" disabled={!active}>
            Everything
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuGroup>
    </>
  );
}
