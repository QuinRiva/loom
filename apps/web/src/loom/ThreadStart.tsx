/**
 * loom: the agent-started cue on sidebar rows: a 2 px left rail on a root whose brief the human did
 * not write, accent for an agent's origin and muted for the human's `/handoff` (`threadStartOf`).
 * Colour-only, so the hover card, the row's accessible name and the breadcrumb all name the origin;
 * only the hover line, mounted while the card is open, reads the origin's title.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type ThreadStart,
  threadStartOf,
  threadStartOriginOf,
} from "@t3tools/client-runtime/state/loom/threadOrigin";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import { BotIcon } from "lucide-react";

import { cn } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useThreadShell } from "../state/entities";
import { loomEnvironmentSnapshotAtom } from "../state/threads";
import { buildThreadRouteParams } from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";
import { useConversationJumpStore } from "./conversationJump";
import { handoffReceiptRows } from "./loomTimelineRows";

export const THREAD_START_LABEL: Record<ThreadStart, string> = {
  agent: "started by an agent",
  requested: "requested via /handoff",
  continued: "continued by an agent",
};

/** How a started root names its origin thread (hover line, breadcrumb tooltip). */
export const THREAD_START_LEAD: Record<ThreadStart, string> = {
  agent: "Started by an agent in",
  requested: "From your /handoff in",
  continued: "Continued from",
};

/**
 * The rail, absolutely placed so it never competes with the row's own
 * surface states (hover / selected / active backgrounds, the drag-over inset
 * ring). `dimmed` (settled rows) rests faint and returns on hover, like the
 * settled favicon; receded working rows dim through the row's own opacity.
 */
export function ThreadStartRail({
  start,
  dimmed = false,
}: {
  start: ThreadStart | null;
  dimmed?: boolean;
}) {
  if (start === null) return null;
  return (
    <span
      aria-hidden
      data-thread-start={start}
      className={cn(
        "pointer-events-none absolute inset-y-1.5 left-0 z-20 w-0.5 rounded-full",
        start === "requested" ? "bg-muted-foreground/70" : "bg-agent-start",
        dimmed &&
          "opacity-40 group-focus-within/sidebar-row:opacity-100 group-hover/sidebar-row:opacity-100",
      )}
    />
  );
}

/** The hover card's provenance line; renders nothing for the human's own threads. */
export function ThreadStartHoverLine({ thread }: { thread: SidebarThreadSummary }) {
  const start = threadStartOf(thread.source);
  const originId = threadStartOriginOf(thread.source.workstream)?.threadId ?? null;
  if (start === null) return null;
  return (
    // Wraps rather than truncates: the origin's title is the link, so it must show.
    <div className="flex min-w-0 items-start gap-2">
      <BotIcon className="mt-0.5 size-3 shrink-0 stroke-muted-foreground" />
      <div className="min-w-0 text-foreground/75">
        {originId === null ? (
          // No handoff behind it: an agent-made scheduled task launched it.
          thread.source.workstream === undefined ? (
            "Started by a scheduled task"
          ) : (
            "Started by an agent"
          )
        ) : (
          <OriginText
            environmentId={thread.environmentId}
            start={start}
            originId={originId}
            destinationId={thread.id}
          />
        )}
      </div>
    </div>
  );
}

function OriginText({
  environmentId,
  start,
  originId,
  destinationId,
}: {
  environmentId: EnvironmentId;
  start: ThreadStart;
  originId: ThreadId;
  destinationId: ThreadId;
}) {
  const title = useThreadShell(scopeThreadRef(environmentId, originId))?.title;
  const openOrigin = useOpenHandoffOrigin(environmentId);
  const lead = THREAD_START_LEAD[start];
  if (title === undefined) return `${lead} an archived thread`;
  return (
    <>
      {lead}{" "}
      <button
        type="button"
        className="cursor-pointer text-left text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground"
        onClick={() => openOrigin(originId, destinationId)}
      >
        {title || "Untitled thread"}
      </button>
    </>
  );
}

/**
 * Open a handed-off root's origin at the handoff: the receipt row its timeline draws for this
 * destination (`handoffReceiptRows`), else the destination's creation inside the handoff call, else
 * just the origin. Read once per click, never subscribed.
 */
export function useOpenHandoffOrigin(environmentId: EnvironmentId) {
  const navigate = useNavigate();
  return (originId: ThreadId, destinationId: ThreadId) => {
    const threads = appAtomRegistry.get(loomEnvironmentSnapshotAtom(environmentId))?.threads ?? [];
    const destination = threads.find((thread) => thread.id === destinationId);
    const at =
      handoffReceiptRows(threads, originId).find((row) =>
        row.destinations.some((candidate) => candidate.threadId === destinationId),
      )?.createdAt ??
      (destination && DateTime.formatIso(destination.createdAt));
    useConversationJumpStore
      .getState()
      .setRequest(at === undefined ? null : { threadId: originId, at });
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, originId)),
    });
  };
}
