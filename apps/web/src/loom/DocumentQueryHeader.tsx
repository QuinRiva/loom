/** A header button's label, hidden (still read aloud) while the thread header is narrow. */
const NARROW_HEADER_LABEL = "@max-[36rem]/thread-header:sr-only";

/**
 * loom: what a query thread (role `document-query`) shows of itself (plan-query-threads §4, §5
 * step 12): a header chip naming the author it is a read-only fork of, the document and author
 * one click away; and, while the fork waits behind a mid-turn author, one muted row.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DOCUMENT_QUERY_ROLE, type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import { ClockIcon, FileTextIcon, GitForkIcon, UserRoundIcon } from "lucide-react";
import type { CSSProperties } from "react";

import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { truncateLabel } from "../lib/workstreamPresentation";
import { useRightPanelStore } from "../rightPanelStore";
import { useQuietThreadShell } from "../state/entities";

export function DocumentQueryHeaderChip({
  threadRef,
  onOpenThread,
}: {
  readonly threadRef: ScopedThreadRef;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const workstream = useQuietThreadShell(threadRef)?.source.workstream;
  const authorId =
    workstream?.role === DOCUMENT_QUERY_ROLE ? (workstream.forkFromThreadId ?? null) : null;
  const authorTitle = useQuietThreadShell(
    authorId === null ? null : scopeThreadRef(threadRef.environmentId, authorId),
  )?.title;
  if (authorId === null) return null;
  const filePath = workstream?.documentQuery?.filePath ?? null;
  return (
    <div className="flex min-w-0 shrink items-center gap-1.5" data-document-query-header="">
      {/* Narrow, the badge keeps only its icon so the thread's own title stays readable. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <Badge
              variant="label"
              size="sm"
              className="min-w-0 shrink"
              style={{ "--label": "var(--color-primary)" } as CSSProperties}
            />
          }
        >
          <GitForkIcon />
          <span className={`min-w-0 truncate ${NARROW_HEADER_LABEL}`}>
            read-only fork of “{truncateLabel(authorTitle ?? "an earlier thread", 36)}”
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">
          A read-only fork of “{authorTitle ?? "an earlier thread"}”
        </TooltipPopup>
      </Tooltip>
      {filePath ? (
        <Button
          variant="outline"
          size="xs"
          className="shrink-0"
          onClick={() => useRightPanelStore.getState().openFile(threadRef, filePath)}
        >
          <FileTextIcon />
          <span className={NARROW_HEADER_LABEL}>Open document</span>
        </Button>
      ) : null}
      <Button
        variant="outline"
        size="xs"
        className="shrink-0"
        onClick={() => onOpenThread(authorId)}
      >
        <UserRoundIcon />
        <span className={NARROW_HEADER_LABEL}>Author thread</span>
      </Button>
    </div>
  );
}

/**
 * The fork is prepared from the author's latest finished run, so a Query sent
 * while the author is mid-turn waits for that turn to end (the `/handoff`
 * drafter's rule); `kickoffAt` stays null until the overlay is delivered.
 */
export function isDocumentQueryWaiting(
  workstream: { readonly role: string | null; readonly kickoffAt: string | null } | undefined,
) {
  return workstream?.role === DOCUMENT_QUERY_ROLE && workstream.kickoffAt === null;
}

export function DocumentQueryWaitingRow() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center px-4 py-6 sm:py-10">
      <div
        className="flex items-center gap-2 rounded-lg border border-border/70 bg-card px-3 py-2 text-muted-foreground text-sm"
        data-document-query-waiting=""
      >
        <ClockIcon className="size-4" />
        Forking the author once its turn ends
      </div>
    </div>
  );
}
