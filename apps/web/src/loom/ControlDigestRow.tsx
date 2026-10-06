/**
 * loom: the user-row switch for control-plane arrivals (3d-3). A user message
 * whose Loom fields make it a control arrival (`controlCardModel`) renders as
 * a {@link ControlDigestCardView}; every other user message renders upstream's
 * row (`fallback`) untouched.
 *
 * It also resolves each item's sender: the dispatcher stamps a generic verdict
 * as the item title and carries identity only as `threadId`, so without the
 * live title a three-child digest reads "Completed" three times.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { MessageId, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { memo, type ReactNode, use, useMemo } from "react";

import { TimelineRowCtx } from "~/components/chat/MessagesTimeline";
import { useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";

import { ControlDigestCardView } from "./ControlDigestCard";
import { controlCardModel } from "./controlMessages";
import { useLoomMessageFields } from "./loomMessageFields";

export const ControlDigestRow = memo(function ControlDigestRow({
  messageId,
  text,
  fallback,
}: {
  messageId: MessageId;
  text: string;
  fallback: ReactNode;
}) {
  const ctx = use(TimelineRowCtx);
  const loom = useLoomMessageFields(ctx.displayThreadKey ?? ctx.routeThreadKey, messageId);
  const model = useMemo(() => controlCardModel(loom, text), [loom, text]);
  return model === null ? fallback : <ConnectedCard model={model} text={text} />;
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
  const shells = useThreadShells(model.kind === "card" && model.items.some((entry) => entry.item.threadId));
  const senderLabels = useMemo(() => {
    const wanted = new Set(model.kind === "card" ? model.items.flatMap((entry) => entry.item.threadId ?? []) : []);
    return new Map<ThreadId, string>(
      shells.flatMap((shell) =>
        wanted.has(shell.id) && shell.environmentId === ctx.activeThreadEnvironmentId
          ? [[shell.id, shell.title] as const]
          : [],
      ),
    );
  }, [model, shells, ctx.activeThreadEnvironmentId]);
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
