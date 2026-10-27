/**
 * loom: the slim side-thread rows under a sidebar host row (plans/side-thread-class/plan.mdx §4).
 * Rendered inside the host's `<li>`, so a drag of the host carries them; they take no part in the
 * sidebar's sort, selection, drag or shelves, and render nothing for a thread that hosts none.
 */
import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DOCUMENT_QUERY_ROLE,
  HANDOFF_DRAFTER_ROLE,
  type ScopedThreadRef,
  type SideThreadRole,
} from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { GitForkIcon, type LucideIcon, MessageCircleQuestionIcon } from "lucide-react";
import { memo, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "../lib/utils";
import { sideThreadRowsAtom } from "./sideThreadRowAtoms";

const ROLE_ICON: Record<SideThreadRole, LucideIcon> = {
  [DOCUMENT_QUERY_ROLE]: MessageCircleQuestionIcon,
  [HANDOFF_DRAFTER_ROLE]: GitForkIcon,
};

// The host row's drag and selection sweep start on pointerdown; a press here is only a click.
const stopPointer = (event: PointerEvent) => event.stopPropagation();

export const LoomSideThreadRows = memo(function LoomSideThreadRows({
  hostThreadKey,
  onActivate,
  dragging,
}: {
  hostThreadKey: string;
  onActivate: (threadRef: ScopedThreadRef) => void;
  dragging: boolean;
}) {
  const rows = useAtomValue(sideThreadRowsAtom(hostThreadKey));
  const routeThreadId = useParams({ strict: false }).threadId;
  const host = parseScopedThreadKey(hostThreadKey);
  if (rows.length === 0 || host === null) return null;
  return (
    <ul
      data-thread-selection-safe
      onPointerDown={stopPointer}
      // Opaque while the host is dragged, so the rows do not overprint the rows it passes.
      className={cn("mt-px pl-5", dragging && "rounded-md bg-sidebar")}
    >
      {rows.map(({ threadId, title, role, running }) => {
        const Icon = ROLE_ICON[role];
        const activate = () => onActivate(scopeThreadRef(host.environmentId, threadId));
        const current = threadId === routeThreadId;
        return (
          <li
            key={threadId}
            role="button"
            tabIndex={0}
            aria-current={current ? "page" : undefined}
            data-testid="sidebar-side-thread-row"
            className={cn(
              "flex h-7 cursor-pointer select-none items-center gap-2 rounded-md px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              current
                ? "bg-sidebar-row-active text-sidebar-foreground"
                : "text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
            )}
            onClick={activate}
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              activate();
            }}
          >
            <Icon aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{title}</span>
            {running ? (
              <span aria-label="Running" className="size-1.5 shrink-0 rounded-full bg-info" />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
});
