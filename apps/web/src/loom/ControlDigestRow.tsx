import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { memo, use } from "react";

import { type MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";
import { TimelineRowCtx } from "~/components/chat/MessagesTimeline";
import { buildThreadRouteParams } from "~/threadRoutes";

import { ControlDigestCardView } from "./ControlDigestCard";
import { classifyControlMessage } from "./controlMessages";

/**
 * loom: the timeline row a control-plane arrival renders as — the connected
 * shell that reads the timeline context and the router, and hands the message's
 * own persisted payload to {@link ControlDigestCardView}.
 */
export const ControlDigestRow = memo(function ControlDigestRow({
  row,
}: {
  row: Extract<MessagesTimelineRow, { kind: "message" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const navigate = useNavigate();
  const presentation = classifyControlMessage(row.message);
  if (!presentation) return null;
  return (
    <ControlDigestCardView
      channel={presentation.channel}
      label={presentation.label}
      payload={row.message.controlPayload ?? null}
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
