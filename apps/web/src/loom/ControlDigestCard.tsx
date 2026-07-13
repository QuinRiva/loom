import { type ControlPayloadItem, type ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { memo, use, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, InboxIcon } from "lucide-react";
import { buildThreadRouteParams } from "~/threadRoutes";
import { cn } from "~/lib/utils";
import ChatMarkdown from "~/components/ChatMarkdown";
import { type MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";
import { TimelineRowCtx } from "~/components/chat/MessagesTimeline";

/**
 * The verbatim "raw payload" surface: the exact bytes the model received
 * (`message.text`), shown un-transformed in a monospace `pre` (NOT through
 * markdown — that would reformat headings/lists/code fences). Exported so it can
 * be asserted directly: the string in equals the string displayed.
 */
export const ControlRawPayload = memo(function ControlRawPayload({ text }: { text: string }) {
  return (
    <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 font-mono text-[11px] leading-5 text-foreground/80">
      {text}
    </pre>
  );
});

/**
 * Collapsed-by-default renderer for a control-plane digest / notice / yield
 * message that carries a structured `controlPayload`. The card is the quiet,
 * skimmable view (one line per item); expanding reveals per-item detail (status,
 * report link, excerpt); the "raw payload" toggle reveals the exact verbatim
 * text the model received (`message.text`) for developers. Historical
 * control_notice messages with no payload never reach here — they keep the
 * tinted-bubble rendering in `UserTimelineRow`.
 *
 * Everything the card shows as message content comes from the persisted payload
 * (never live thread state), so it can never surface text the model did not
 * receive. `threadId` is used only for click-through navigation, not for copy.
 */
export const ControlDigestCard = memo(function ControlDigestCard({
  row,
}: {
  row: Extract<MessagesTimelineRow, { kind: "message" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const navigate = useNavigate();
  const environmentId = ctx.activeThreadEnvironmentId;
  const [expanded, setExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);

  const payload = row.message.controlPayload!;
  const items = payload.items;

  const openThread = (threadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });

  const count = items.length;
  const summaryLabel = payload.heading ?? `Control plane — ${count} item${count === 1 ? "" : "s"}`;

  return (
    <section className="-mx-1 min-w-0 px-1 py-0.5" aria-label={summaryLabel}>
      <div className="rounded-lg border border-info/25 bg-info/[0.06]">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12px] leading-5 transition-colors hover:bg-info/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
        >
          <span className="flex size-5 shrink-0 items-center justify-center text-info/80">
            <InboxIcon className="size-3.5 shrink-0" />
          </span>
          <span className="min-w-0 flex-1 truncate font-medium text-foreground/82">
            {summaryLabel}
          </span>
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-info/70">
            control plane
          </span>
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 opacity-60 transition-transform duration-200",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </button>

        <ul className="space-y-px border-t border-info/15 p-1">
          {items.map((item, index) => (
            <ControlDigestItem
              key={item.threadId ?? `item-${index}`}
              item={item}
              expanded={expanded}
              onOpen={openThread}
            />
          ))}
        </ul>

        <div className="flex items-center gap-2 border-t border-info/15 px-2 py-1">
          <button
            type="button"
            className="text-[10.5px] uppercase tracking-wide text-muted-foreground/60 transition-colors hover:text-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
            onClick={() => setShowRaw((v) => !v)}
            aria-expanded={showRaw}
          >
            {showRaw ? "Hide raw payload" : "Show raw payload"}
          </button>
        </div>
        {showRaw ? (
          <div className="border-t border-info/15 p-2">
            <ControlRawPayload text={row.message.text} />
          </div>
        ) : null}
      </div>
    </section>
  );
});

function ControlDigestItem({
  item,
  expanded,
  onOpen,
}: {
  item: ControlPayloadItem;
  expanded: boolean;
  onOpen: (threadId: ThreadId) => void;
}) {
  const ctx = use(TimelineRowCtx);
  const clickable = item.threadId != null;
  return (
    <li>
      <div className="rounded-md px-1.5 py-1">
        <div
          className={cn(
            "flex items-center gap-2",
            clickable && "cursor-pointer rounded-md transition-colors hover:bg-info/10",
          )}
          onClick={clickable ? () => onOpen(item.threadId!) : undefined}
          role={clickable ? "button" : undefined}
          tabIndex={clickable ? 0 : undefined}
          onKeyDown={
            clickable
              ? (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpen(item.threadId!);
                  }
                }
              : undefined
          }
        >
          {item.icon ? (
            <span className="shrink-0 text-[12px]" aria-hidden>
              {item.icon}
            </span>
          ) : null}
          {item.role ? (
            <span className="shrink-0 rounded border border-info/30 bg-info/10 px-1.5 py-0.5 font-mono text-[10px] text-info/90">
              {item.role}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-[12px] leading-5 text-foreground/82">
            {item.title}
          </span>
          {item.status ? (
            <span className="shrink-0 text-[10.5px] text-muted-foreground/70">{item.status}</span>
          ) : null}
          {clickable ? (
            <ChevronRightIcon className="size-3.5 shrink-0 opacity-50" aria-hidden />
          ) : null}
        </div>

        {expanded && (item.reportPath || item.excerpt || item.timestamp) ? (
          <div className="mt-1 space-y-1 border-l border-info/20 pl-2.5 text-[12px]">
            {item.timestamp ? (
              <div className="text-[10.5px] text-muted-foreground/60">{item.timestamp}</div>
            ) : null}
            {item.reportPath ? (
              <ChatMarkdown
                text={`Report: \`${item.reportPath}\``}
                cwd={ctx.markdownCwd}
                threadRef={ctx.threadRef ?? undefined}
                skills={ctx.skills}
              />
            ) : null}
            {item.excerpt ? (
              <div className="text-foreground/75">
                <ChatMarkdown
                  text={item.excerpt}
                  cwd={ctx.markdownCwd}
                  threadRef={ctx.threadRef ?? undefined}
                  skills={ctx.skills}
                />
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
