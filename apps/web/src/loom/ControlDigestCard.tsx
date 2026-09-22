import {
  type ControlPayload,
  type ControlPayloadItem,
  type ScopedThreadRef,
  type ServerProviderSkill,
  type ThreadId,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, InboxIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { cn } from "~/lib/utils";

import { CHANNEL_CLASSES, controlSummaryLine, type ControlChannel } from "./controlMessages";

/**
 * loom: the card a control-plane arrival collapses to — a completion digest, a
 * yield hand-back, a gate resolution, a `notify_thread` push.
 *
 * These messages are how the workstream talks to a thread, and their payloads
 * are large: rendered as ordinary bubbles they bury the actual conversation. The
 * card inverts that. Collapsed (the default) it says only *that* something
 * arrived and from whom — one line per item, no markdown rendered at all, which
 * is the point: the timeline pays nothing for a payload nobody is reading.
 * Expanding reveals the per-item detail, and "show raw payload" reveals the
 * exact bytes the model received.
 *
 * Everything shown comes from the persisted message (payload or `text`), never
 * live thread state, so the card can never surface something the model did not
 * see. Deliberately free of router and timeline context — `ControlDigestRow`
 * supplies both — so `/preview` and a unit test can mount it directly.
 */
export function ControlDigestCardView({
  channel,
  label,
  payload,
  text,
  cwd,
  threadRef,
  skills,
  onOpenThread,
}: {
  channel: ControlChannel;
  label: string;
  payload: ControlPayload | null;
  text: string;
  cwd: string | undefined;
  threadRef: ScopedThreadRef | null;
  skills: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  onOpenThread: ((threadId: ThreadId) => void) | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const classes = CHANNEL_CLASSES[channel];
  const items = payload?.items ?? [];
  const summary = payload?.heading ?? controlSummaryLine(text);
  const markdown = (body: string) => (
    <ChatMarkdown text={body} cwd={cwd} threadRef={threadRef ?? undefined} skills={skills} />
  );

  return (
    <section className="-mx-1 min-w-0 px-1 py-0.5" aria-label={`${label} — ${summary}`}>
      <div className={cn("rounded-lg border", classes.card)} data-control-card={channel}>
        <button
          type="button"
          className={cn(
            "focus-visible:ring-ring/70 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12px] leading-5 transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset",
            classes.hover,
          )}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <InboxIcon className={cn("size-3.5 shrink-0", classes.kicker)} />
          <span className="text-foreground/82 min-w-0 flex-1 truncate font-medium">{summary}</span>
          <span className={cn("shrink-0 text-[10px] tracking-wide uppercase", classes.kicker)}>
            {label}
          </span>
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 opacity-60 transition-transform duration-200",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </button>

        {items.length > 0 ? (
          <ul className={cn("space-y-px border-t p-1", classes.divider)}>
            {items.map((item, index) => (
              <ControlDigestItem
                key={item.threadId ?? `item-${index}`}
                item={item}
                channel={channel}
                expanded={expanded}
                markdown={markdown}
                onOpen={onOpenThread}
              />
            ))}
          </ul>
        ) : expanded ? (
          <div className={cn("border-t p-2", classes.divider)}>{markdown(text)}</div>
        ) : null}

        <div className={cn("flex items-center gap-2 border-t px-2 py-1", classes.divider)}>
          <button
            type="button"
            className="text-muted-foreground/60 hover:text-foreground/70 focus-visible:ring-ring/70 text-[10.5px] tracking-wide uppercase transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
            onClick={() => setShowRaw((value) => !value)}
            aria-expanded={showRaw}
          >
            {showRaw ? "Hide raw payload" : "Show raw payload"}
          </button>
        </div>
        {showRaw ? (
          <div className={cn("border-t p-2", classes.divider)}>
            {/* The verbatim bytes the model received — never through markdown, which
                would reformat the headings, lists and fences it is proof of. */}
            <pre className="bg-muted/40 text-foreground/80 max-h-[420px] overflow-auto rounded-md p-2 font-mono text-[11px] leading-5 break-words whitespace-pre-wrap">
              {text}
            </pre>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ControlDigestItem({
  item,
  channel,
  expanded,
  markdown,
  onOpen,
}: {
  item: ControlPayloadItem;
  channel: ControlChannel;
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
            <span className="shrink-0 text-[12px]" aria-hidden>
              {item.icon}
            </span>
          ) : null}
          {item.role ? (
            <span
              className={cn(
                "shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px]",
                classes.chip,
              )}
            >
              {item.role}
            </span>
          ) : null}
          <span className="text-foreground/82 min-w-0 flex-1 truncate text-[12px] leading-5">
            {item.title}
          </span>
          {item.status ? (
            <span className="text-muted-foreground/70 shrink-0 text-[10.5px]">{item.status}</span>
          ) : null}
          {open ? <ChevronRightIcon className="size-3.5 shrink-0 opacity-50" aria-hidden /> : null}
        </div>

        {expanded && (item.reportPath || item.excerpt || item.timestamp) ? (
          <div className={cn("mt-1 space-y-1 border-l pl-2.5 text-[12px]", classes.divider)}>
            {item.timestamp ? (
              <div className="text-muted-foreground/60 text-[10.5px]">{item.timestamp}</div>
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
