/**
 * loom: the card a control-plane arrival collapses to (3d-3) — a digest, a
 * yield hand-back, a notice (gate legs, brief-needed, deadlock, stall nudge,
 * attention, notify).
 *
 * Collapsed (the default) it says only *that* something arrived and from
 * whom — one line per item naming the sender and its verdict, no markdown
 * rendered, so the timeline pays nothing for a payload nobody is reading.
 * Expanding reveals per-item detail and "show raw payload" (the exact bytes the
 * model received). Everything shown comes from the persisted message, never
 * live thread state, apart from the sender titles `senderLabels` resolves.
 * Free of router and timeline context (`ControlDigestRow` supplies both), so
 * `/preview` can mount it directly.
 */
import type { ScopedThreadRef, ServerProviderSkill, ThreadId } from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, InboxIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { cn } from "~/lib/utils";

import {
  CHANNEL_CLASSES,
  type ControlCardItem,
  type ControlCardModel,
  type ControlChannel,
  controlSummaryLine,
} from "./controlMessages";

export function ControlDigestCardView({
  model,
  text,
  senderLabels,
  cwd,
  threadRef,
  skills,
  onOpenThread,
  defaultExpanded = false,
}: {
  model: ControlCardModel;
  text: string;
  /** Live thread title per item `threadId`; absent ⇒ the id itself is the label. */
  senderLabels: ReadonlyMap<ThreadId, string>;
  cwd: string | undefined;
  threadRef: ScopedThreadRef | null;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  onOpenThread: ((threadId: ThreadId) => void) | null;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showRaw, setShowRaw] = useState(false);
  const classes = CHANNEL_CLASSES[model.channel];
  const items = model.kind === "card" ? model.items : [];
  const summary = model.kind === "card" ? model.summary : controlSummaryLine(text);
  const markdown = (body: string) => (
    <ChatMarkdown text={body} cwd={cwd} threadRef={threadRef ?? undefined} skills={skills} />
  );

  return (
    <section className="-mx-1 min-w-0 px-1 py-0.5" aria-label={`${model.label} — ${summary}`}>
      <div className={cn("rounded-lg border", classes.card)} data-control-card={model.label}>
        <button
          type="button"
          className={cn(
            "focus-visible:ring-ring/70 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs leading-5 transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset",
            classes.hover,
          )}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <InboxIcon className={cn("size-3.5 shrink-0", classes.kicker)} />
          <span className="text-foreground/82 min-w-0 flex-1 truncate font-medium">{summary}</span>
          {model.kind === "card" && model.marker ? (
            <span className="shrink-0 rounded border border-warning/30 bg-warning/10 px-1.5 text-3xs text-warning-foreground">
              {model.marker}
            </span>
          ) : null}
          <span className={cn("shrink-0 text-3xs tracking-wide uppercase", classes.kicker)}>
            {model.label}
          </span>
          <ChevronDownIcon
            className={cn("size-3.5 shrink-0 opacity-60", expanded && "rotate-180")}
            aria-hidden
          />
        </button>

        {items.length > 0 ? (
          <ul className={cn("space-y-px border-t p-1", classes.divider)}>
            {items.map((entry, index) => (
              <ControlDigestItem
                key={entry.item.threadId ?? `item-${index}`}
                entry={entry}
                channel={model.channel}
                sender={
                  entry.item.threadId
                    ? (senderLabels.get(entry.item.threadId) ?? entry.item.threadId)
                    : null
                }
                expanded={expanded}
                markdown={markdown}
                onOpen={onOpenThread}
              />
            ))}
          </ul>
        ) : expanded ? (
          // The raw-text fallback, and a card with no items: the message itself.
          <div className={cn("border-t p-2", classes.divider)}>{markdown(text)}</div>
        ) : null}

        {expanded && items.length > 0 ? (
          <div className={cn("flex items-center gap-2 border-t px-2 py-1", classes.divider)}>
            <button
              type="button"
              className="text-muted-foreground/60 hover:text-foreground/70 focus-visible:ring-ring/70 text-2xs tracking-wide uppercase transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
              onClick={() => setShowRaw((value) => !value)}
              aria-expanded={showRaw}
            >
              {showRaw ? "Hide raw payload" : "Show raw payload"}
            </button>
          </div>
        ) : null}
        {expanded && showRaw ? (
          <div className={cn("border-t p-2", classes.divider)}>
            {/* The verbatim bytes the model received — never through markdown. */}
            <pre className="bg-muted/40 text-foreground/80 max-h-[420px] overflow-auto rounded-md p-2 font-mono text-2xs leading-5 break-words whitespace-pre-wrap">
              {text}
            </pre>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ControlDigestItem({
  entry: { item, kindLabel },
  channel,
  sender,
  expanded,
  markdown,
  onOpen,
}: {
  entry: ControlCardItem;
  channel: ControlChannel;
  sender: string | null;
  expanded: boolean;
  markdown: (body: string) => ReactNode;
  onOpen: ((threadId: ThreadId) => void) | null;
}) {
  const classes = CHANNEL_CLASSES[channel];
  const threadId = item.threadId;
  const open = threadId && onOpen ? () => onOpen(threadId) : null;
  return (
    <li>
      <div className="rounded-md px-1.5 py-1">
        <div
          className={cn(
            "flex items-center gap-2",
            open && cn("cursor-pointer rounded-md transition-colors", classes.hover),
          )}
          onClick={open ?? undefined}
          role={open ? "button" : undefined}
          tabIndex={open ? 0 : undefined}
          onKeyDown={
            open
              ? (event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  open();
                }
              : undefined
          }
        >
          {item.icon ? (
            <span className="shrink-0 text-xs" aria-hidden>
              {item.icon}
            </span>
          ) : null}
          {item.role ? (
            <span
              className={cn(
                "shrink-0 rounded border px-1.5 py-0.5 font-mono text-3xs",
                classes.chip,
              )}
            >
              {item.role}
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate text-xs leading-5">
            {sender ? <span className="text-foreground/82 font-medium">{sender}</span> : null}
            <span className={cn("text-foreground/82", sender && "text-muted-foreground/80")}>
              {sender ? ` — ${item.title}` : item.title}
            </span>
          </span>
          {kindLabel ? (
            <span className="text-muted-foreground/70 shrink-0 text-3xs tracking-wide uppercase">
              {kindLabel}
            </span>
          ) : null}
          {item.status ? (
            <span className="text-muted-foreground/70 shrink-0 text-2xs">{item.status}</span>
          ) : null}
          {open ? <ChevronRightIcon className="size-3.5 shrink-0 opacity-50" aria-hidden /> : null}
        </div>

        {expanded && (item.reportPath || item.excerpt || item.timestamp) ? (
          <div className={cn("mt-1 space-y-1 border-l pl-2.5 text-xs", classes.divider)}>
            {item.timestamp ? (
              <div className="text-muted-foreground/60 text-2xs">{item.timestamp}</div>
            ) : null}
            {item.reportPath ? markdown(`Report: \`${item.reportPath}\``) : null}
            {item.excerpt ? (
              <div className="text-foreground/75">{markdown(item.excerpt)}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
