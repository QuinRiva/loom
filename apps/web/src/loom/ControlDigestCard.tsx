/**
 * loom: the card a control-plane arrival collapses to (3d-3) — a digest, a
 * yield hand-back, a notice (gate legs, brief-needed, deadlock, stall nudge,
 * attention, notify).
 *
 * Collapsed (the default) it says only *that* something arrived and from
 * whom — one line per item naming the sender and its verdict, no markdown
 * rendered, so the timeline pays nothing for a payload nobody is reading. An
 * item with a report opens it from its row (↗ opens the thread instead), and
 * the documents its report named sit under it as chips. Expanding reveals
 * per-item detail and "show raw payload" (the exact bytes the model received). Everything shown comes from the persisted message, never
 * live thread state, apart from the sender titles `senderLabels` resolves.
 * Free of router and timeline context (`ControlDigestRow` supplies both), so
 * `/preview` can mount it directly.
 */
import type {
  EnvironmentId,
  ScopedThreadRef,
  ServerProviderSkill,
  ThreadId,
} from "@t3tools/contracts";
import { ArrowUpRightIcon, ChevronDownIcon, ChevronRightIcon, InboxIcon } from "lucide-react";
import { useState, type ReactElement, type ReactNode } from "react";

import { isArtifactViewerPath } from "~/components/artifact/artifactView";
import ChatMarkdown from "~/components/ChatMarkdown";
import { revalidatePathExistence, usePathExistence } from "~/components/chat/usePathExistence";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import {
  isAbsolutePreviewablePath,
  resolveInlineCodeFileLinkMeta,
  type MarkdownFileLinkMeta,
} from "~/markdown-links";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { verifyChipTargetBeforeOpen } from "./verifiedFileChips";

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
                cwd={cwd}
                threadRef={threadRef}
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

/** Opens a handed-back document where a chat file chip would: the artefact viewer, the workspace file, or the read-only host file. */
const openDocument = (threadRef: ScopedThreadRef, meta: MarkdownFileLinkMeta) => {
  const panel = useRightPanelStore.getState();
  if (meta.workspaceRelativePath === null) panel.openFileAbsolute(threadRef, meta.filePath);
  else if (isArtifactViewerPath(meta.filePath) && !isPreviewSupportedInRuntime())
    panel.openArtifact(threadRef, meta.workspaceRelativePath);
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
  chipClass,
}: {
  documents: ReadonlyArray<string>;
  cwd: string | undefined;
  threadRef: ScopedThreadRef | null;
  chipClass: string;
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
  const chip =
    "rounded border px-1.5 font-mono text-3xs leading-4.5 whitespace-nowrap focus-visible:ring-ring/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none";
  return (
    <div className="flex flex-wrap items-center gap-1 pt-1 pl-5">
      {visible.map((meta) => {
        const missing = lookupExistence(meta.filePath)?.exists === false;
        return (
          <Tip
            key={meta.filePath}
            tip={
              <>
                <div className="font-mono leading-tight wrap-anywhere">{meta.filePath}</div>
                {missing ? <div className="mt-0.5">Missing — moved or deleted?</div> : null}
              </>
            }
          >
            {missing ? (
              <span
                className={cn(chip, chipClass, "line-through opacity-45")}
                onPointerEnter={() =>
                  environmentId !== null && revalidatePathExistence(environmentId, meta.filePath)
                }
              >
                {documentLabel(meta)}
              </span>
            ) : (
              <button
                type="button"
                className={cn(
                  chip,
                  chipClass,
                  "transition-colors hover:brightness-125 disabled:cursor-default",
                )}
                disabled={threadRef === null}
                onClick={() =>
                  threadRef &&
                  void verifyChipTargetBeforeOpen(environmentId, meta.filePath).then(
                    (ok) => ok && openDocument(threadRef, meta),
                  )
                }
              >
                {documentLabel(meta)}
              </button>
            )}
          </Tip>
        );
      })}
      {metas.length > visible.length ? (
        <button
          type="button"
          className={cn(
            chip,
            "border-dashed border-muted-foreground/30 text-muted-foreground/80 transition-colors hover:text-foreground/80",
          )}
          onClick={() => setShowAll(true)}
        >
          +{metas.length - visible.length} more
        </button>
      ) : null}
    </div>
  );
}

function ControlDigestItem({
  entry: { item, kindLabel },
  channel,
  sender,
  expanded,
  markdown,
  cwd,
  threadRef,
  onOpen,
}: {
  entry: ControlCardItem;
  channel: ControlChannel;
  sender: string | null;
  expanded: boolean;
  markdown: (body: string) => ReactNode;
  cwd: string | undefined;
  threadRef: ScopedThreadRef | null;
  onOpen: ((threadId: ThreadId) => void) | null;
}) {
  const classes = CHANNEL_CLASSES[channel];
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
        <span
          className={cn("shrink-0 rounded border px-1.5 py-0.5 font-mono text-3xs", classes.chip)}
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
      {openReport ? (
        <span
          className={cn(
            "shrink-0 text-2xs opacity-0 transition-opacity group-hover/row:opacity-85 group-focus-visible/row:opacity-85",
            classes.kicker,
          )}
        >
          Open report
        </span>
      ) : null}
      {kindLabel ? (
        <span className="text-muted-foreground/70 shrink-0 text-3xs tracking-wide uppercase">
          {kindLabel}
        </span>
      ) : null}
      {item.status ? (
        <span className="text-muted-foreground/70 shrink-0 text-2xs">{item.status}</span>
      ) : null}
      {!openReport && openThread ? (
        <ChevronRightIcon className="size-3.5 shrink-0 opacity-50" aria-hidden />
      ) : null}
    </>
  );
  return (
    <li>
      <div className="rounded-md px-1.5 py-1">
        <div
          className={cn(
            "flex items-center gap-1 rounded-md",
            open && cn("transition-colors", classes.hover),
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
                className="text-muted-foreground/70 hover:text-foreground focus-visible:ring-ring/70 grid size-5 shrink-0 place-items-center rounded transition-colors hover:bg-foreground/8 focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
                onClick={openThread}
                aria-label="Open thread"
              >
                <ArrowUpRightIcon className="size-3.5" aria-hidden />
              </button>
            </Tip>
          ) : null}
        </div>
        {item.documents?.length ? (
          <ReportDocumentChips
            documents={item.documents}
            cwd={cwd}
            threadRef={threadRef}
            chipClass={classes.chip}
          />
        ) : null}

        {expanded && (item.excerpt || item.timestamp) ? (
          <div className={cn("mt-1 space-y-1 border-l pl-2.5 text-xs", classes.divider)}>
            {item.timestamp ? (
              <div className="text-muted-foreground/60 text-2xs">{item.timestamp}</div>
            ) : null}
            {item.excerpt ? (
              <div className="text-foreground/75">{markdown(item.excerpt)}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}
