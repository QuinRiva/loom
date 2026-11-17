/**
 * loom: the two ways out of a followed review (plans/diff-author-query/plan.mdx §6): Back to review
 * in the thread header returns to the reviewing thread, and the ✕ on the Diff panel's "from" label
 * stops following and stays. Either deletes the follow, so this thread's own panel is as it was.
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, XIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { truncateLabel } from "../../lib/workstreamPresentation";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useReviewFollowStore } from "./reviewFollowStore";
import { useReviewFollow } from "./useReviewFollow";

export function ReviewFollowBack({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const { reviewing } = useReviewFollow(threadRef);
  if (reviewing === null) return null;
  return (
    <Button
      variant="outline"
      size="xs"
      className="shrink-0"
      onClick={() => {
        useReviewFollowStore.getState().unfollow(threadRef);
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(reviewing.ref),
        });
      }}
    >
      <ArrowLeftIcon />
      Back to review
    </Button>
  );
}

/** Above the followed diff: whose review it is, and ✕ to show this thread's own diff instead. */
export function ReviewFollowLabel({
  routed,
  follow,
}: {
  readonly routed: ScopedThreadRef | null;
  readonly follow: ReturnType<typeof useReviewFollow>;
}) {
  const { reviewing } = follow;
  if (routed === null || reviewing === null) return null;
  const title = reviewing.title ?? "another thread";
  return (
    <div
      className="flex h-7 shrink-0 items-center gap-1.5 border-b border-border/70 bg-muted/40 px-3 text-2xs text-muted-foreground"
      data-loom-review-follow=""
    >
      <span className="min-w-0 truncate">
        The diff from “{truncateLabel(title, 48)}”, as you left it there
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-micro"
              className="ms-auto"
              aria-label="Show this thread's own diff"
              onClick={() => useReviewFollowStore.getState().unfollow(routed)}
            />
          }
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">Show this thread's own diff</TooltipPopup>
      </Tooltip>
    </div>
  );
}
