import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { memo, use, useMemo } from "react";

import { type MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";
import { TimelineRowCtx } from "~/components/chat/MessagesTimeline";
import { useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";

import { ControlDigestCardView } from "./ControlDigestCard";
import { classifyControlMessage } from "./controlMessages";

/**
 * loom: the timeline row a control-plane arrival renders as — the connected
 * shell that reads the timeline context and the router, and hands the message's
 * own persisted payload to {@link ControlDigestCardView}.
 *
 * It also resolves each item's sender. The dispatcher stamps a generic verdict
 * as the item title ("Completed", "Gate resolved (clean)") and carries identity
 * only as `threadId`, so without this a three-child digest reads "coder
 * Completed" three times and never answers *which* sub-thread delivered. The
 * `ControlPayloadItem` contract anticipates exactly this — "the UI resolves the
 * live sub-thread title/status from `threadId` when present, falling back to
 * these stamped-at-send values" — and a thread's own title is a link label, not
 * message content the model must have seen.
 */
export const ControlDigestRow = memo(function ControlDigestRow({
  row,
}: {
  row: Extract<MessagesTimelineRow, { kind: "message" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const navigate = useNavigate();
  const shells = useThreadShells();
  const items = row.message.controlPayload?.items;
  const senderLabels = useMemo(() => {
    const wanted = new Set(items?.flatMap((item) => item.threadId ?? []));
    return new Map<ThreadId, string>(
      wanted.size === 0
        ? []
        : shells.flatMap((shell) =>
            wanted.has(shell.id) ? [[shell.id, shell.title] as const] : [],
          ),
    );
  }, [items, shells]);
  const presentation = classifyControlMessage(row.message);
  if (!presentation) return null;
  return (
    <ControlDigestCardView
      channel={presentation.channel}
      label={presentation.label}
      payload={row.message.controlPayload ?? null}
      senderLabels={senderLabels}
      text={row.message.text}
      cwd={ctx.markdownCwd}
      threadRef={ctx.threadRef}
      skills={ctx.skills}
      onOpenThread={(threadId) =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(ctx.activeThreadEnvironmentId, threadId)),
        })
      }
    />
  );
});
