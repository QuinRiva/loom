/**
 * loom: the user-row switch for control-plane arrivals: a control arrival (`controlCardModel`)
 * renders as a {@link ControlDigestCardView}, any other user message as upstream's row, told its
 * {@link ControlBubble}. It resolves each item's sender too: the dispatcher titles items with a
 * generic verdict, so without live titles a three-child digest reads "Completed" three times.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { MessageId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { memo, type ReactNode, use } from "react";

import { TimelineRowCtx } from "~/components/chat/timelineRowContext";
import { useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";

import { ControlDigestCardView } from "./ControlDigestCard";
import {
  controlBubble,
  type ControlBubble,
} from "@t3tools/client-runtime/state/loom/controlBubble";

import { controlCardModel } from "./controlMessages";
import { useLoomMessageFields } from "./loomMessageFields";

export const ControlDigestRow = memo(function ControlDigestRow({
  messageId,
  text,
  fallback,
}: {
  messageId: MessageId;
  text: string;
  fallback: (bubble: ControlBubble | null) => ReactNode;
}) {
  const ctx = use(TimelineRowCtx);
  const loom = useLoomMessageFields(ctx.displayThreadKey ?? ctx.routeThreadKey, messageId);
  const model = controlCardModel(loom, text);
  return model === null ? (
    fallback(controlBubble(loom))
  ) : (
    <ConnectedCard model={model} text={text} />
  );
});

function ConnectedCard({
  model,
  text,
}: {
  model: NonNullable<ReturnType<typeof controlCardModel>>;
  text: string;
}) {
  const ctx = use(TimelineRowCtx);
  const navigate = useNavigate();
  // Only carded rows subscribe to the shells, and only for item titles.
  const shells = useThreadShells(
    model.kind === "card" && model.items.some((entry) => entry.item.threadId),
  );
  const wanted = new Set(
    model.kind === "card" ? model.items.flatMap((entry) => entry.item.threadId ?? []) : [],
  );
  const senderLabels = new Map<ThreadId, string>(
    shells.flatMap((shell) =>
      wanted.has(shell.id) && shell.environmentId === ctx.activeThreadEnvironmentId
        ? [[shell.id, shell.title] as const]
        : [],
    ),
  );
  return (
    <ControlDigestCardView
      model={model}
      text={text}
      senderLabels={senderLabels}
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
}
