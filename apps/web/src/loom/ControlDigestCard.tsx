/**
 * loom: the card a control-plane arrival (digest, yield hand-back, notice) collapses to. Collapsed,
 * one line per item names sender and verdict with no markdown rendered, so an unread payload costs
 * nothing; expanding shows per-item detail and the raw payload. Everything comes from the persisted
 * message except sender titles; no router or timeline context, so `/preview` can mount it directly.
 */
import type {
  EnvironmentId,
  ScopedThreadRef,
  ServerProviderSkill,
  ThreadId,
} from "@t3tools/contracts";
import { ArrowUpRightIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { revalidatePathExistence, usePathExistence } from "~/components/chat/usePathExistence";
import { Badge } from "~/components/ui/badge";
import { InlineButton } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import {
  isAbsolutePreviewablePath,
  resolveInlineCodeFileLinkMeta,
  type MarkdownFileLinkMeta,
} from "~/markdown-links";
import { useRightPanelStore } from "~/rightPanelStore";

import { verifyChipTargetBeforeOpen } from "./verifiedFileChips";

import type { ControlBubble } from "@t3tools/client-runtime/state/loom/controlBubble";

import {
  CHANNEL_ICONS,
  type ControlCardItem,
  type ControlCardModel,
  controlSummaryLine,
  SEVERITY_CLASSES,
} from "./controlMessages";

/**
 * Who a kickoff, steer or short notice bubble speaks for: the channel's icon plus the bubble's
 * label, in the line upstream uses for "Sent by T3 Code". The bubble itself stays neutral.
 */
export function ControlBubbleAttribution({ bubble }: { bubble: ControlBubble }) {
  const { icon: Icon, word } = CHANNEL_ICONS[bubble.channel];
  return (
    <p
      className="me-1 flex items-center gap-1 text-2xs text-muted-foreground"
      data-loom-bubble={bubble.channel}
    >
      <Icon className="size-3 shrink-0" role="img" aria-label={word} />
      {bubble.label}
    </p>
  );
}

/** Neutral hover, shared by the header and the openable item rows. */
const ROW_HOVER = "hover:bg-foreground/[0.06]";

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
  skills: ReadonlyArray<ServerProviderSkill>;
  onOpenThread: ((threadId: ThreadId) => void) | null;
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showRaw, setShowRaw] = useState(false);
  const severity = SEVERITY_CLASSES[model.severity];
  const { icon: ChannelIcon, word: channelWord } = CHANNEL_ICONS[model.channel];
  const items = model.kind === "card" ? model.items : [];
  const summary = model.kind === "card" ? model.summary : controlSummaryLine(text);
  const markdown = (body: string) => (
    <ChatMarkdown text={body} cwd={cwd} threadRef={threadRef ?? undefined} skills={skills} />
  );

  return (
    <section className="-mx-1 min-w-0 px-1 py-0.5" aria-label={`${model.label}: ${summary}`}>
      <div
        className={cn("overflow-hidden rounded-2xl border bg-card/70", severity.border)}
        data-control-card={model.label}
      >
        <button
          type="button"
          className={cn(
            "focus-visible:ring-ring/70 flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs leading-5 transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset",
            ROW_HOVER,
          )}
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          <ChannelIcon
            className={cn("size-3.5 shrink-0", severity.text)}
            role="img"
            aria-label={channelWord}
          />
          <span className={cn("shrink-0", severity.text)}>{model.label}</span>
          <span className="min-w-0 flex-1 truncate text-foreground">{summary}</span>
          {model.kind === "card" && model.marker ? (
            <Badge variant="warning">{model.marker}</Badge>
          ) : null}
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </button>

        {items.length > 0 ? (
          <ul className="space-y-px border-t border-border/60 px-1.5 py-1">
            {items.map((entry, index) => (
              <ControlDigestItem
                key={entry.item.threadId ?? `item-${index}`}
                entry={entry}
                sender={
                  entry.item.threadId
                    ? (senderLabels.get(entry.item.threadId) ?? entry.item.threadId)
                    : null
                }
                expanded={expanded}
                markdown={markdown}
                cwd={cwd}
                threadRef={threadRef}
                onOpen={onOpenThread}
              />
            ))}
          </ul>
        ) : expanded ? (
          // The raw-text fallback, and a card with no items: the message itself.
          <div className="border-t border-border/60 px-3 py-2">{markdown(text)}</div>
        ) : null}

        {expanded && items.length > 0 ? (
          <div className="flex items-center gap-2 border-t border-border/60 px-3 py-1 text-xs">
            <InlineButton
              tone="muted"
              onClick={() => setShowRaw((value) => !value)}
              aria-expanded={showRaw}
            >
              {showRaw ? "Hide raw payload" : "Show raw payload"}
            </InlineButton>
          </div>
        ) : null}
        {expanded && showRaw ? (
          <div className="border-t border-border/60 p-2">
            {/* The verbatim bytes the model received — never through markdown. */}
            <pre className="max-h-[420px] overflow-auto rounded-md bg-muted/40 p-2 font-mono text-2xs leading-5 break-words whitespace-pre-wrap text-foreground">
              {text}
            </pre>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Opens a handed-back document where a chat file chip would: the workspace file or the read-only host file. */
const openDocument = (threadRef: ScopedThreadRef, meta: MarkdownFileLinkMeta) => {
  const panel = useRightPanelStore.getState();
  if (meta.workspaceRelativePath === null) panel.openFileAbsolute(threadRef, meta.filePath);
  else panel.openFile(threadRef, meta.workspaceRelativePath);
};

/** A one-word name (`plan.mdx`, `README.md`) says what kind of file, not which: lead with its folder. */
const documentLabel = ({ filePath, basename }: MarkdownFileLinkMeta) =>
  /^[A-Za-z]+\.\w+$/.test(basename)
    ? `${filePath.split("/").at(-2) ?? ""}/${basename}`.replace(/^\//, "")
    : basename;

const VISIBLE_DOCUMENTS = 3;

/** A hover tooltip on one trigger element. */
const Tip = ({ tip, children }: { tip: ReactNode; children: ReactElement }) => (
  <Tooltip>
    <TooltipTrigger render={children} />
    <TooltipPopup side="top" className="max-w-[min(40rem,calc(100vw-2rem))]">
      {tip}
    </TooltipPopup>
  </Tooltip>
);

/**
 * The documents a report named, as chips under its row: up to three, then
 * "+n more" expanding in place. Only the visible chips are stat'd (one batched
 * lookup), and one the server reports gone renders struck through and inert
 * until hovering re-checks it.
 */
function ReportDocumentChips({
  documents,
  cwd,
  threadRef,
}: {
  documents: ReadonlyArray<string>;
  cwd: string | undefined;
  threadRef: ScopedThreadRef | null;
}) {
  const [showAll, setShowAll] = useState(false);
  const environmentId: EnvironmentId | null = threadRef?.environmentId ?? null;
  // Unresolvable without a workspace (no `cwd`), a relative name is dropped rather than misopened.
  const resolved = documents.flatMap((path) => {
    const meta = resolveInlineCodeFileLinkMeta(path, cwd);
    return meta && isAbsolutePreviewablePath(meta.filePath) ? [meta] : [];
  });
  const metas = resolved.filter(
    (meta, index) => resolved.findIndex((other) => other.filePath === meta.filePath) === index,
  );
  const visible = showAll ? metas : metas.slice(0, VISIBLE_DOCUMENTS);
  const paths = visible.map((meta) => meta.filePath);
  const lookupExistence = usePathExistence(environmentId, paths);
  if (metas.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1 pt-1 pl-5 text-xs">
      {visible.map((meta) => {
        const missing = lookupExistence(meta.filePath)?.exists === false;
        return (
          <Tip
            key={meta.filePath}
            tip={
              <>
                <div className="font-mono leading-tight wrap-anywhere">{meta.filePath}</div>
                {missing ? <div className="mt-0.5">Missing (moved or deleted?)</div> : null}
              </>
            }
          >
            {missing ? (
              <Badge
                variant="outline"
                onPointerEnter={() =>
                  environmentId !== null && revalidatePathExistence(environmentId, meta.filePath)
                }
              >
                <s className="text-muted-foreground">{documentLabel(meta)}</s>
              </Badge>
            ) : (
              <Badge
                variant="outline"
                render={<button type="button" disabled={threadRef === null} />}
                onClick={() =>
                  threadRef &&
                  void verifyChipTargetBeforeOpen(environmentId, meta.filePath).then(
                    (ok) => ok && openDocument(threadRef, meta),
                  )
                }
              >
                {documentLabel(meta)}
              </Badge>
            )}
          </Tip>
        );
      })}
      {metas.length > visible.length ? (
        <InlineButton tone="muted" onClick={() => setShowAll(true)}>
          +{metas.length - visible.length} more
        </InlineButton>
      ) : null}
    </div>
  );
}

function ControlDigestItem({
  entry: { item, kindLabel },
  sender,
  expanded,
  markdown,
  cwd,
  threadRef,
  onOpen,
}: {
  entry: ControlCardItem;
  sender: string | null;
  expanded: boolean;
  markdown: (body: string) => ReactNode;
  cwd: string | undefined;
  threadRef: ScopedThreadRef | null;
  onOpen: ((threadId: ThreadId) => void) | null;
}) {
  const { threadId, reportPath } = item;
  const openThread = threadId && onOpen ? () => onOpen(threadId) : null;
  // Reports live outside every worktree: they open read-only in this thread's panel.
  const openReport =
    reportPath && threadRef && isAbsolutePreviewablePath(reportPath)
      ? () => useRightPanelStore.getState().openFileAbsolute(threadRef, reportPath)
      : null;
  const open = openReport ?? openThread;
  const label = (
    <>
      {item.icon ? (
        <span className="shrink-0 text-xs" aria-hidden>
          {item.icon}
        </span>
      ) : null}
      {item.role ? (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">{item.role}</span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-xs leading-5">
        {sender ? <span className="font-medium text-foreground">{sender}</span> : null}
        <span className={sender ? "text-muted-foreground" : "text-foreground"}>
          {sender ? `: ${item.title}` : item.title}
        </span>
      </span>
      {openReport ? (
        <span className="shrink-0 text-xs text-muted-foreground opacity-0 transition-opacity group-hover/row:opacity-100 group-focus-visible/row:opacity-100">
          Open report
        </span>
      ) : null}
      {kindLabel ? (
        <span className="shrink-0 text-xs text-muted-foreground">{kindLabel}</span>
      ) : null}
      {item.status ? (
        <span className="shrink-0 text-xs text-muted-foreground">{item.status}</span>
      ) : null}
      {!openReport && openThread ? (
        <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      ) : null}
    </>
  );
  return (
    <li>
      <div className="rounded-md px-1.5 py-1">
        <div
          className={cn(
            "flex items-center gap-1 rounded-md",
            open && cn("transition-colors", ROW_HOVER),
          )}
        >
          {open ? (
            <button
              type="button"
              className="group/row focus-visible:ring-ring/70 flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
              onClick={open}
            >
              {label}
            </button>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-2">{label}</div>
          )}
          {openReport && openThread ? (
            <Tip tip="Open thread">
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/70 grid size-5 shrink-0 place-items-center rounded transition-colors hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
                onClick={openThread}
                aria-label="Open thread"
              >
                <ArrowUpRightIcon className="size-3.5" aria-hidden />
              </button>
            </Tip>
          ) : null}
        </div>
        {item.documents?.length ? (
          <ReportDocumentChips documents={item.documents} cwd={cwd} threadRef={threadRef} />
        ) : null}

        {expanded && (item.excerpt || item.timestamp) ? (
          <div className="mt-1 space-y-1 border-l border-border/60 pl-2.5 text-xs">
            {item.timestamp ? (
              <div className="text-muted-foreground tabular-nums">{item.timestamp}</div>
            ) : null}
            {item.excerpt ? <div>{markdown(item.excerpt)}</div> : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
