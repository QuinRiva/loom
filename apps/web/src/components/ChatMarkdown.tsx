import { useAtomValue } from "@effect/atom-react";
import { DiffsHighlighter, getSharedHighlighter, SupportedLanguages } from "@pierre/diffs";
import {
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  GlobeIcon,
  Maximize2Icon,
  Minimize2Icon,
  WrapTextIcon,
} from "lucide-react";
import type { ScopedThreadRef, ServerProviderSkill } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import React, {
  Children,
  Suspense,
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent as ReactMouseEvent,
  isValidElement,
  use,
  useCallback,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Components, Options as ReactMarkdownOptions } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { defaultUrlTransform } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { renderSkillInlineMarkdownChildren } from "./chat/SkillInlineText";
import {
  CHAT_FILE_TAG_CHIP_CLASS_NAME,
  FileTagChipContent,
  ThreadTagChipContent,
} from "./chat/FileTagChip";
import { usePathExistence } from "./chat/usePathExistence";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { hasSpecificPierreIconForFileName, syntheticFileNameForLanguageId } from "../pierre-icons";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { Button } from "./ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { ScrollArea } from "./ui/scroll-area";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { fnv1a32 } from "../lib/diffRendering";
import { LRUCache } from "../lib/lruCache";
import { useTheme } from "../hooks/useTheme";
import { getClientSettings } from "../hooks/useSettings";
import {
  chatMarkdownClipboardPayload,
  serializeTableElementToCsv,
  serializeTableElementToMarkdown,
} from "../markdown-clipboard";
import { remarkNormalizeListItemIndentation } from "../markdown-list-indentation";
import {
  type MarkdownFileLinkMeta,
  type TextPathSpan,
  collectMessageDirectoryBases,
  extractInlineCodeSpanTexts,
  extractMarkdownLinkHrefs,
  extractMessagePathCandidates,
  isAbsolutePreviewablePath,
  matchTextPathSpans,
  normalizeMarkdownLinkHrefKey,
  resolveInlineCodeFileLinkCandidates,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  selectChipBinding,
} from "../markdown-links";
import { decorateCodeBlockPaths, type CodePathTarget } from "../codePathDecorations";
import { readLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
import { useActiveEnvironmentId } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { assetEnvironment } from "../state/assets";
import { usePreparedConnection } from "../state/session";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { isArtifactViewerPath } from "./artifact/artifactView";
import {
  isBrowserPreviewFile,
  openFileInPreview,
  openUrlInPreview,
  BrowserPreviewUnavailableError,
} from "../browser/openFileInPreview";

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  threadRef?: ScopedThreadRef | undefined;
  onTaskListChange?: ((input: { markerOffset: number; checked: boolean }) => void) | undefined;
  isStreaming?: boolean;
  skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">>;
  className?: string;
  /** Treat single newlines as hard breaks — chat-style user input. */
  lineBreaks?: boolean;
}

const EMPTY_MARKDOWN_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
const MAX_HIGHLIGHT_CACHE_ENTRIES = 500;
const MAX_HIGHLIGHT_CACHE_MEMORY_BYTES = 50 * 1024 * 1024;

interface MarkdownActionFailureContext {
  readonly operation: string;
  readonly target?: string;
  readonly format?: "markdown" | "csv";
  readonly language?: string;
  readonly fenceTitle?: string;
  readonly copyTarget?: string;
}

function reportMarkdownActionFailure(context: MarkdownActionFailureContext, cause: unknown): void {
  console.error("[chat-markdown] action failed", context, cause);
}

const highlightedCodeCache = new LRUCache<string>(
  MAX_HIGHLIGHT_CACHE_ENTRIES,
  MAX_HIGHLIGHT_CACHE_MEMORY_BYTES,
);
const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

function findTaskListMarkerOffset(markdown: string, listItemStart: number): number | null {
  const firstLineEnd = markdown.indexOf("\n", listItemStart);
  const firstLine = markdown.slice(
    listItemStart,
    firstLineEnd === -1 ? markdown.length : firstLineEnd,
  );
  const match = firstLine.match(/^(?:\s*(?:[-+*]|\d+[.)])\s+)(\[[ xX]\])/);
  if (!match?.[1]) return null;
  return listItemStart + firstLine.indexOf(match[1]);
}
const CHAT_MARKDOWN_SANITIZE_SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attribute) => attribute !== "title"),
    code: [...(defaultSchema.attributes?.code ?? []), "dataCodeMeta"],
  },
  protocols: {
    ...defaultSchema.protocols,
    href: [...(defaultSchema.protocols?.href ?? []), "file", "thread"],
  },
} satisfies Parameters<typeof rehypeSanitize>[0];

const CHAT_MARKDOWN_REMARK_PLUGINS = [
  remarkGfm,
  remarkNormalizeListItemIndentation,
  remarkPreserveCodeMeta,
] satisfies NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

const CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS = [
  remarkGfm,
  remarkNormalizeListItemIndentation,
  remarkBreaks,
  remarkPreserveCodeMeta,
] satisfies NonNullable<ReactMarkdownOptions["remarkPlugins"]>;

const CHAT_MARKDOWN_REHYPE_PLUGINS = [
  rehypeRaw,
  [rehypeSanitize, CHAT_MARKDOWN_SANITIZE_SCHEMA],
] satisfies NonNullable<ReactMarkdownOptions["rehypePlugins"]>;

function extractFenceLanguage(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  const raw = match?.[1] ?? "text";
  // Shiki doesn't bundle a gitignore grammar; ini is a close match (#685)
  return raw === "gitignore" ? "ini" : raw;
}

const FENCE_TITLE_ATTR_REGEX = /(?:^|\s)(?:title|file(?:name)?)=(?:"([^"]+)"|'([^']+)'|(\S+))/i;
const FENCE_FILENAME_TOKEN_REGEX = /^[\w@][\w@./-]*\.[A-Za-z0-9]+$/;

/** Pulls a filename out of fence meta: ```ts title="x.ts" / ```ts src/main.ts */
function extractFenceTitle(meta: string | undefined): string | null {
  if (!meta) return null;
  const attrMatch = FENCE_TITLE_ATTR_REGEX.exec(meta);
  const attrTitle = attrMatch?.[1] ?? attrMatch?.[2] ?? attrMatch?.[3];
  if (attrTitle) return attrTitle;
  return meta.split(/\s+/).find((candidate) => FENCE_FILENAME_TOKEN_REGEX.test(candidate)) ?? null;
}

function extractPreCodeMeta(node: unknown): string | undefined {
  const children = (
    node as
      | {
          children?: Array<{
            type?: string;
            tagName?: string;
            data?: { meta?: unknown };
            properties?: { dataCodeMeta?: unknown };
          }>;
        }
      | undefined
  )?.children;
  const codeNode = children?.find((child) => child?.type === "element" && child.tagName === "code");
  const meta = codeNode?.properties?.dataCodeMeta ?? codeNode?.data?.meta;
  return typeof meta === "string" && meta.trim().length > 0 ? meta.trim() : undefined;
}

type MarkdownAstNode = {
  type?: string;
  meta?: unknown;
  data?: {
    hProperties?: Record<string, unknown>;
  };
  children?: MarkdownAstNode[];
};

function remarkPreserveCodeMeta() {
  return (tree: MarkdownAstNode) => {
    const visit = (node: MarkdownAstNode) => {
      if (node.type === "code" && typeof node.meta === "string" && node.meta.trim().length > 0) {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            dataCodeMeta: node.meta.trim(),
          },
        };
      }
      node.children?.forEach(visit);
    };

    visit(tree);
  };
}

// Custom hast tag the prose-path rehype plugin injects; mapped to a component
// in `markdownComponents` that resolves + existence-checks + renders the chip.
const PROSE_FILE_PATH_TAG = "t3-file-path";
// Never scan inside these (code/pre handled by the block decorator; existing
// links keep their own behaviour).
const PROSE_FILE_PATH_SKIP_TAGS = new Set(["code", "pre", "a", PROSE_FILE_PATH_TAG]);

interface HastTextNode {
  type: "text";
  value: string;
}
interface HastElementNode {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastChildNode[];
}
type HastChildNode = HastTextNode | HastElementNode | { type: string; children?: HastChildNode[] };
interface HastRootNode {
  type: "root";
  children: HastChildNode[];
}

function buildProsePathNodes(value: string, spans: readonly TextPathSpan[]): HastChildNode[] {
  const nodes: HastChildNode[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) {
      nodes.push({ type: "text", value: value.slice(cursor, span.start) });
    }
    nodes.push({
      type: "element",
      tagName: PROSE_FILE_PATH_TAG,
      properties: {},
      children: [{ type: "text", value: value.slice(span.start, span.end) }],
    });
    cursor = span.end;
  }
  if (cursor < value.length) {
    nodes.push({ type: "text", value: value.slice(cursor) });
  }
  return nodes;
}

/**
 * Rehype plugin: split plain-prose text nodes on path-like substrings and inject
 * `<t3-file-path>` elements for them. Runs *after* rehype-sanitize so the
 * injected (trusted) nodes are not stripped; skips code/pre/anchor subtrees so
 * inline code, fenced blocks, and existing links keep their own handling. The
 * mapped component decides whether each hit resolves to an existing file.
 */
function rehypeChatFilePaths() {
  return (tree: HastRootNode) => {
    const visit = (node: { children?: HastChildNode[] }) => {
      const children = node.children;
      if (!children) return;
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index];
        if (!child) continue;
        if (child.type === "text") {
          const spans = matchTextPathSpans((child as HastTextNode).value);
          if (spans.length === 0) continue;
          const replacement = buildProsePathNodes((child as HastTextNode).value, spans);
          children.splice(index, 1, ...replacement);
          index += replacement.length - 1;
        } else if (child.type === "element") {
          if (PROSE_FILE_PATH_SKIP_TAGS.has((child as HastElementNode).tagName)) continue;
          visit(child as HastElementNode);
        }
      }
    };
    visit(tree);
  };
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  const onlyChild = childNodes[0];
  // The child is either the intrinsic `code` element or our `code` component
  // override (a function component) — both expose className/children props and
  // both are the sole child a fenced block ever produces.
  if (
    !isValidElement<{ className?: string; children?: ReactNode }>(onlyChild) ||
    (onlyChild.type !== "code" && typeof onlyChild.type !== "function")
  ) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

function createHighlightCacheKey(code: string, language: string, themeName: DiffThemeName): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${language}:${themeName}`;
}

function estimateHighlightedSize(html: string, code: string): number {
  return Math.max(html.length * 2, code.length * 3);
}

function getHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  const promise = getSharedHighlighter({
    themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
    langs: [language as SupportedLanguages],
    preferredHighlighter: "shiki-js",
  }).catch((err) => {
    highlighterPromiseCache.delete(language);
    if (language === "text") {
      // "text" itself failed — Shiki cannot initialize at all, surface the error
      throw err;
    }
    // Language not supported by Shiki — fall back to "text"
    return getHighlighterPromise("text");
  });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

function readInitialWordWrapSetting(): boolean {
  return getClientSettings().wordWrap;
}

function MarkdownTable({ children, ...props }: React.ComponentProps<"table">) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const [expanded, setExpanded] = useState(readInitialWordWrapSetting);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expandLabel = expanded ? "Collapse table cells" : "Expand table cells";
  const copyLabel = copied ? "Copied" : "Copy table";

  function toggleExpanded() {
    const table = tableRef.current;
    if (!table) return;

    if (!expanded) {
      const rows = [...table.rows];
      const columnWidths = rows.reduce<number[]>((widths, row) => {
        [...row.cells].forEach((cell, columnIndex) => {
          widths[columnIndex] = Math.max(
            widths[columnIndex] ?? 0,
            cell.getBoundingClientRect().width,
          );
        });
        return widths;
      }, []);

      [...(table.tHead?.rows[0]?.cells ?? [])].forEach((cell, columnIndex) => {
        cell.style.minWidth = `${columnWidths[columnIndex] ?? cell.getBoundingClientRect().width}px`;
      });
    }

    setExpanded((value) => !value);
  }

  const handleCopy = useCallback((format: "markdown" | "csv") => {
    const table = containerRef.current?.querySelector("table");
    if (!table || typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    const text =
      format === "markdown"
        ? serializeTableElementToMarkdown(table)
        : serializeTableElementToCsv(table);
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        reportMarkdownActionFailure({ operation: "copy-table", format }, cause);
      });
  }, []);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      className="chat-markdown-table-container"
      data-expanded={expanded ? "true" : "false"}
    >
      <ScrollArea
        chainVerticalScroll
        scrollFade
        hideScrollbars
        className="w-full max-w-full rounded-none"
      >
        <table ref={tableRef} {...props}>
          {children}
        </table>
      </ScrollArea>
      <div className="chat-markdown-table-footer select-none">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="chat-markdown-chrome-action"
                aria-pressed={expanded}
                onClick={toggleExpanded}
                aria-label={expandLabel}
              />
            }
          >
            {expanded ? <Minimize2Icon className="size-3" /> : <Maximize2Icon className="size-3" />}
          </TooltipTrigger>
          <TooltipPopup side="top">{expandLabel}</TooltipPopup>
        </Tooltip>
        <Menu>
          <Tooltip>
            <TooltipTrigger
              render={
                <MenuTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="chat-markdown-chrome-action"
                      aria-label={copyLabel}
                    />
                  }
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
          <MenuPopup align="end">
            <MenuItem onClick={() => handleCopy("markdown")}>Copy as Markdown</MenuItem>
            <MenuItem onClick={() => handleCopy("csv")}>Copy as CSV</MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
}

function MarkdownDetails({
  children,
  open = false,
}: Pick<React.ComponentProps<"details">, "children" | "open">) {
  const [isOpen, setIsOpen] = useState(open);
  const childNodes = Children.toArray(children);
  const summaryIndex = childNodes.findIndex(
    (child) => isValidElement(child) && child.type === "summary",
  );
  const summaryNode = summaryIndex >= 0 ? childNodes[summaryIndex] : null;
  const summary =
    isValidElement<{ children?: ReactNode }>(summaryNode) && summaryNode.props.children
      ? summaryNode.props.children
      : "Details";
  const content = childNodes.filter((_, index) => index !== summaryIndex);

  return (
    <Collapsible
      defaultOpen={open}
      onOpenChange={setIsOpen}
      className="chat-markdown-details my-2 border-y border-border/60"
      data-markdown-details=""
      data-markdown-details-open={isOpen ? "true" : "false"}
    >
      <CollapsibleTrigger
        className="flex w-full items-center gap-2 py-2 text-left text-sm font-medium text-foreground data-panel-open:[&_svg]:rotate-90"
        data-markdown-details-summary=""
      >
        <ChevronRightIcon
          className="size-4 shrink-0 text-muted-foreground transition-transform"
          aria-hidden
        />
        <span>{summary}</span>
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="pb-3 ps-6 text-foreground/80" data-markdown-details-content="">
          {content}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

/**
 * Filename titles render icon + text; language-only titles render just the
 * icon (redundant next to its own name) and fall back to the language text
 * when no specific icon exists or it fails to load.
 */
function MarkdownCodeBlockTitleContent({
  fenceTitle,
  language,
  theme,
}: {
  fenceTitle: string | null;
  language: string;
  theme: "light" | "dark";
}) {
  if (fenceTitle) {
    return (
      <>
        <PierreEntryIcon pathValue={fenceTitle} kind="file" theme={theme} className="size-3.5" />
        <span className="truncate">{fenceTitle}</span>
      </>
    );
  }

  const fileName = syntheticFileNameForLanguageId(language);
  if (!hasSpecificPierreIconForFileName(fileName)) {
    return <span className="truncate">{language}</span>;
  }
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span className="inline-flex shrink-0 rounded-sm" aria-label={`Language: ${language}`} />
        }
      >
        <PierreEntryIcon pathValue={fileName} kind="file" theme={theme} className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{language}</TooltipPopup>
    </Tooltip>
  );
}

function MarkdownCodeBlock({
  code,
  language,
  fenceTitle,
  theme,
  children,
}: {
  code: string;
  language: string;
  fenceTitle: string | null;
  theme: "light" | "dark";
  children: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const [wrapped, setWrapped] = useState(readInitialWordWrapSetting);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapLabel = wrapped ? "Disable line wrap" : "Wrap lines";
  const copyLabel = copied ? "Copied" : "Copy code";

  const handleCopy = useCallback(() => {
    if (typeof navigator === "undefined" || navigator.clipboard == null) {
      return;
    }
    void navigator.clipboard
      .writeText(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch((cause) => {
        reportMarkdownActionFailure(
          {
            operation: "copy-code-block",
            language,
            ...(fenceTitle ? { fenceTitle } : {}),
          },
          cause,
        );
      });
  }, [code, fenceTitle, language]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  return (
    <div
      className="chat-markdown-codeblock leading-snug"
      data-language={language}
      data-wrap={wrapped ? "true" : "false"}
    >
      <div className="chat-markdown-codeblock-header select-none">
        <span className="chat-markdown-codeblock-title">
          <MarkdownCodeBlockTitleContent
            fenceTitle={fenceTitle}
            language={language}
            theme={theme}
          />
        </span>
        <span className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  aria-pressed={wrapped}
                  onClick={() => setWrapped((value) => !value)}
                  aria-label={wrapLabel}
                />
              }
            >
              <WrapTextIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="top">{wrapLabel}</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="chat-markdown-chrome-action"
                  onClick={handleCopy}
                  aria-label={copyLabel}
                />
              }
            >
              {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </TooltipTrigger>
            <TooltipPopup side="top">{copyLabel}</TooltipPopup>
          </Tooltip>
        </span>
      </div>
      {children}
    </div>
  );
}

/**
 * Renders Shiki HTML and, after paint, hands the container to `decorate` so
 * path substrings can be turned into clickable regions. The effect re-runs when
 * `html` changes (re-highlight / streaming) or when `decorate`'s identity
 * changes (existence verification resolves), and the decorator is idempotent.
 */
function ShikiHtml({
  html,
  decorate,
}: {
  html: string;
  decorate?: ((container: HTMLElement) => void) | undefined;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (container && decorate) decorate(container);
  }, [decorate, html]);
  return (
    <div
      ref={containerRef}
      className="chat-markdown-shiki"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

interface SuspenseShikiCodeBlockProps {
  className: string | undefined;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
  decorate?: ((container: HTMLElement) => void) | undefined;
}

function SuspenseShikiCodeBlock({
  className,
  code,
  themeName,
  isStreaming,
  decorate,
}: SuspenseShikiCodeBlockProps) {
  const language = extractFenceLanguage(className);
  const cacheKey = createHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = !isStreaming ? highlightedCodeCache.get(cacheKey) : null;

  if (cachedHighlightedHtml != null) {
    return <ShikiHtml html={cachedHighlightedHtml} decorate={decorate} />;
  }

  return (
    <UncachedShikiCodeBlock
      code={code}
      language={language}
      themeName={themeName}
      cacheKey={cacheKey}
      isStreaming={isStreaming}
      decorate={decorate}
    />
  );
}

interface UncachedShikiCodeBlockProps {
  code: string;
  language: string;
  themeName: DiffThemeName;
  cacheKey: string;
  isStreaming: boolean;
  decorate?: ((container: HTMLElement) => void) | undefined;
}

function UncachedShikiCodeBlock({
  code,
  language,
  themeName,
  cacheKey,
  isStreaming,
  decorate,
}: UncachedShikiCodeBlockProps) {
  const highlighter = use(getHighlighterPromise(language));
  const highlightedHtml = useMemo(() => {
    try {
      return highlighter.codeToHtml(code, { lang: language, theme: themeName });
    } catch (error) {
      // Log highlighting failures for debugging while falling back to plain text
      console.warn(
        `Code highlighting failed for language "${language}", falling back to plain text.`,
        error instanceof Error ? error.message : error,
      );
      // If highlighting fails for this language, render as plain text
      return highlighter.codeToHtml(code, { lang: "text", theme: themeName });
    }
  }, [code, highlighter, language, themeName]);

  useEffect(() => {
    if (!isStreaming) {
      highlightedCodeCache.set(
        cacheKey,
        highlightedHtml,
        estimateHighlightedSize(highlightedHtml, code),
      );
    }
  }, [cacheKey, code, highlightedHtml, isStreaming]);

  return <ShikiHtml html={highlightedHtml} decorate={decorate} />;
}

interface MarkdownFileLinkProps {
  href: string;
  targetPath: string;
  iconPath: string;
  displayPath: string;
  workspaceRelativePath: string | null;
  line?: number | undefined;
  label: string;
  copyMarkdown: string;
  theme: "light" | "dark";
  threadRef?: ScopedThreadRef | undefined;
  onOpen: (targetPath: string) => Promise<AtomCommandResult<unknown, unknown>>;
  onOpenInBrowser?: (() => Promise<AtomCommandResult<unknown, unknown>>) | undefined;
  /**
   * Web-runtime counterpart to `onOpenInBrowser`: renders the artefact in the
   * sandboxed viewer surface. The two are mutually exclusive (browser on
   * desktop, viewer on web), so at most one is ever set.
   */
  onOpenInViewer?: (() => void) | undefined;
  /** Directory targets swap the file actions for an explorer/copy behaviour. */
  isDirectory?: boolean | undefined;
  onOpenDirectory?: (() => void) | undefined;
  className?: string | undefined;
}

const MARKDOWN_FILE_LINK_CLASS_NAME =
  "chat-markdown-file-link cursor-pointer transition-colors hover:bg-accent/70";

function pathParentSegments(path: string): string[] {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments.slice(0, -1);
}

function buildFileLinkParentSuffixByPath(filePaths: ReadonlyArray<string>): Map<string, string> {
  const groups = new Map<string, Set<string>>();
  for (const filePath of filePaths) {
    const pathSegments = filePath
      .replaceAll("\\", "/")
      .split("/")
      .filter((segment) => segment.length > 0);
    const basename = pathSegments[pathSegments.length - 1];
    if (!basename) continue;
    const group = groups.get(basename) ?? new Set<string>();
    group.add(filePath);
    groups.set(basename, group);
  }

  const suffixByPath = new Map<string, string>();
  for (const group of groups.values()) {
    const uniquePaths = [...group];
    if (uniquePaths.length < 2) continue;

    const parentSegmentsByPath = new Map(
      uniquePaths.map((filePath) => [filePath, pathParentSegments(filePath)]),
    );
    const minUniqueDepthByPath = new Map<string, number>();

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      let resolvedDepth = segments.length;
      for (let depth = 1; depth <= segments.length; depth += 1) {
        const candidate = segments.slice(-depth).join("/");
        const collision = uniquePaths.some((otherPath) => {
          if (otherPath === filePath) return false;
          const otherSegments = parentSegmentsByPath.get(otherPath) ?? [];
          return otherSegments.slice(-depth).join("/") === candidate;
        });
        if (!collision) {
          resolvedDepth = depth;
          break;
        }
      }
      minUniqueDepthByPath.set(filePath, resolvedDepth);
    }

    for (const filePath of uniquePaths) {
      const segments = parentSegmentsByPath.get(filePath) ?? [];
      if (segments.length === 0) continue;
      const minUniqueDepth = minUniqueDepthByPath.get(filePath) ?? 1;
      const suffixDepth = Math.min(segments.length, Math.max(minUniqueDepth, 2));
      suffixByPath.set(filePath, segments.slice(-suffixDepth).join("/"));
    }
  }

  return suffixByPath;
}

const MARKDOWN_LINK_FAVICON_CLASS_NAME = "block size-full shrink-0 select-none";

/** Hosts whose favicon request already failed this session — skip straight to the globe. */
const failedFaviconHosts = new Set<string>();

function resolveExternalLinkHost(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.hostname || null;
  } catch {
    return null;
  }
}

const MarkdownLinkFavicon = memo(function MarkdownLinkFavicon({ host }: { host: string }) {
  const [failedHost, setFailedHost] = useState<string | null>(null);
  return (
    <span className="chat-markdown-link-favicon" aria-hidden>
      {failedHost === host || failedFaviconHosts.has(host) ? (
        <GlobeIcon className={MARKDOWN_LINK_FAVICON_CLASS_NAME} />
      ) : (
        <img
          src={`https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`}
          alt=""
          loading="lazy"
          draggable={false}
          className={cn(MARKDOWN_LINK_FAVICON_CLASS_NAME, "rounded-sm")}
          onError={() => {
            failedFaviconHosts.add(host);
            setFailedHost(host);
          }}
        />
      )}
    </span>
  );
});

function leadingExternalLinkTextLength(text: string): number {
  const protocol = /^(?:https?:\/\/)/i.exec(text)?.[0];
  if (protocol) return protocol.length;
  return Math.min(text.length, 1);
}

function breakableExternalLinkText(text: string): ReactNode[] {
  return Array.from(text, (character, index) => (
    <React.Fragment key={`${index}:${character}`}>
      {character}
      <wbr />
    </React.Fragment>
  ));
}

function plainHastText(node: unknown): string | null {
  if (!node || typeof node !== "object" || !("children" in node) || !Array.isArray(node.children)) {
    return null;
  }
  const parts = node.children.map((child) => {
    if (
      child &&
      typeof child === "object" &&
      "type" in child &&
      child.type === "text" &&
      "value" in child &&
      typeof child.value === "string"
    ) {
      return child.value;
    }
    return null;
  });
  return parts.every((part) => part !== null) ? parts.join("") : null;
}

const SANITIZED_FRAGMENT_PREFIX = "user-content-";

function decodeMarkdownFragmentId(href: string): string {
  const encodedId = href.slice(1);
  try {
    return decodeURIComponent(encodedId);
  } catch {
    return encodedId;
  }
}

function normalizeSanitizedFragmentId(id: string): string {
  let normalizedId = id;
  while (normalizedId.startsWith(SANITIZED_FRAGMENT_PREFIX)) {
    normalizedId = normalizedId.slice(SANITIZED_FRAGMENT_PREFIX.length);
  }
  return normalizedId;
}

function findMarkdownFragmentTarget(anchor: HTMLAnchorElement, href: string): HTMLElement | null {
  const decodedId = decodeMarkdownFragmentId(href);
  const normalizedId = normalizeSanitizedFragmentId(decodedId);
  const matchesFragment = (element: HTMLElement) =>
    element.id === decodedId || normalizeSanitizedFragmentId(element.id) === normalizedId;
  const markdownRoot = anchor.closest<HTMLElement>(".chat-markdown");
  if (markdownRoot) {
    const localTargets = Array.from(markdownRoot.querySelectorAll<HTMLElement>("[id]"));
    const localTarget = localTargets.find(matchesFragment);
    if (localTarget) return localTarget;
  }

  return (
    document.getElementById(decodedId) ??
    Array.from(document.querySelectorAll<HTMLElement>("[id]")).find(matchesFragment) ??
    null
  );
}

function handleMarkdownFragmentClick(event: ReactMouseEvent<HTMLAnchorElement>, href: string) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return;
  }

  const target = findMarkdownFragmentTarget(event.currentTarget, href);
  if (!target) return;

  event.preventDefault();
  const nextUrl = new URL(window.location.href);
  nextUrl.hash = href.slice(1);
  window.history.pushState(window.history.state, "", nextUrl);
  target.scrollIntoView({ block: "nearest" });
}

function MarkdownExternalLinkContent({
  host,
  plainText,
  children,
}: {
  host: string;
  plainText: string | null;
  children: ReactNode;
}) {
  if (plainText) {
    const leadingLength = leadingExternalLinkTextLength(plainText);
    return (
      <>
        <span className="chat-markdown-link-leading">
          <MarkdownLinkFavicon host={host} />
          {plainText.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(plainText.slice(leadingLength))}
      </>
    );
  }

  const childNodes = Children.toArray(children);
  const firstChild = childNodes[0];

  if (typeof firstChild === "string" && firstChild.length > 0) {
    const leadingLength = leadingExternalLinkTextLength(firstChild);
    return (
      <>
        <span className="chat-markdown-link-leading">
          <MarkdownLinkFavicon host={host} />
          {firstChild.slice(0, leadingLength)}
        </span>
        {breakableExternalLinkText(firstChild.slice(leadingLength))}
        {childNodes.slice(1)}
      </>
    );
  }

  return (
    <>
      <span className="chat-markdown-link-leading">
        <MarkdownLinkFavicon host={host} />
        {firstChild}
      </span>
      {childNodes.slice(1)}
    </>
  );
}

const MarkdownFileLink = memo(function MarkdownFileLink({
  href,
  targetPath,
  iconPath,
  displayPath,
  workspaceRelativePath,
  line,
  label,
  copyMarkdown,
  theme,
  threadRef,
  onOpen,
  onOpenInBrowser,
  onOpenInViewer,
  isDirectory,
  onOpenDirectory,
  className,
}: MarkdownFileLinkProps) {
  const handleOpenDirectory = useCallback(() => {
    onOpenDirectory?.();
  }, [onOpenDirectory]);
  const handleOpenInEditor = useCallback(() => {
    void (async () => {
      try {
        const result = await onOpen(targetPath);
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "open-file-in-editor", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "open-file-in-editor", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      }
    })();
  }, [onOpen, targetPath]);

  const handleOpenInFilePreview = useCallback(() => {
    if (!threadRef) {
      handleOpenInEditor();
      return;
    }
    if (workspaceRelativePath) {
      useRightPanelStore.getState().openFile(threadRef, workspaceRelativePath, line);
      return;
    }
    // Outside the workspace: open the absolute path in the read-only preview
    // surface (e.g. workstream report paths). Anything the preview can't serve
    // (e.g. a Windows drive path on a POSIX host) falls back to the editor.
    if (isAbsolutePreviewablePath(iconPath)) {
      useRightPanelStore.getState().openFileAbsolute(threadRef, iconPath, line);
      return;
    }
    handleOpenInEditor();
  }, [handleOpenInEditor, iconPath, line, threadRef, workspaceRelativePath]);

  const handleOpenInBrowser = useCallback(() => {
    if (!onOpenInBrowser) {
      return;
    }
    void (async () => {
      try {
        const result = await onOpenInBrowser();
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
          return;
        }
        reportMarkdownActionFailure(
          { operation: "open-file-in-browser", target: targetPath },
          result.cause,
        );
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file in browser",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "open-file-in-browser", target: targetPath },
          cause,
        );
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file in browser",
            description: cause instanceof Error ? cause.message : "An error occurred.",
          }),
        );
      }
    })();
  }, [onOpenInBrowser, targetPath]);

  const handleCopy = useCallback(
    (value: string, title: string) => {
      if (typeof window === "undefined" || !navigator.clipboard?.writeText) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to copy ${title.toLowerCase()}`,
            description: "Clipboard API unavailable.",
          }),
        );
        return;
      }

      void navigator.clipboard.writeText(value).then(
        () => {
          toastManager.add({
            type: "success",
            title: `${title} copied`,
            description: value,
          });
        },
        (error) => {
          reportMarkdownActionFailure(
            { operation: "copy-file-path", target: targetPath, copyTarget: title },
            error,
          );
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Failed to copy ${title.toLowerCase()}`,
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        },
      );
    },
    [targetPath],
  );

  const handleContextMenu = useCallback(
    async (event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const api = readLocalApi();
      if (!api) return;

      try {
        const clicked = await api.contextMenu.show(
          [
            { id: "open", label: isDirectory ? "Open in files" : "Open in editor" },
            ...(!isDirectory && onOpenInBrowser
              ? ([{ id: "open-in-browser", label: "Open in integrated browser" }] as const)
              : []),
            { id: "copy-relative", label: "Copy relative path" },
            { id: "copy-full", label: "Copy full path" },
          ] as const,
          { x: event.clientX, y: event.clientY },
        );

        if (clicked === "open") {
          if (isDirectory) {
            handleOpenDirectory();
            return;
          }
          handleOpenInEditor();
          return;
        }
        if (clicked === "open-in-browser") {
          handleOpenInBrowser();
          return;
        }
        if (clicked === "copy-relative") {
          handleCopy(displayPath, "Relative path");
          return;
        }
        if (clicked === "copy-full") {
          handleCopy(targetPath, "Full path");
        }
      } catch (cause) {
        reportMarkdownActionFailure(
          { operation: "show-file-context-menu", target: targetPath },
          cause,
        );
      }
    },
    [
      displayPath,
      handleCopy,
      handleOpenDirectory,
      handleOpenInBrowser,
      handleOpenInEditor,
      isDirectory,
      onOpenInBrowser,
      targetPath,
    ],
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={href}
            className={cn(CHAT_FILE_TAG_CHIP_CLASS_NAME, MARKDOWN_FILE_LINK_CLASS_NAME, className)}
            data-markdown-copy={copyMarkdown}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (isDirectory) {
                handleOpenDirectory();
                return;
              }
              if (onOpenInViewer) {
                onOpenInViewer();
                return;
              }
              if (onOpenInBrowser) {
                handleOpenInBrowser();
                return;
              }
              handleOpenInFilePreview();
            }}
            onContextMenu={handleContextMenu}
          >
            <FileTagChipContent path={iconPath} label={label} theme={theme} selectable />
          </a>
        }
      />
      <TooltipPopup
        side="top"
        className="max-w-[min(40rem,calc(100vw-2rem))] font-mono text-[11px] leading-tight"
      >
        <div className="markdown-file-link-tooltip-scroll overflow-x-auto whitespace-nowrap">
          {displayPath}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}, areMarkdownFileLinkPropsEqual);

function areMarkdownFileLinkPropsEqual(
  previous: Readonly<MarkdownFileLinkProps>,
  next: Readonly<MarkdownFileLinkProps>,
): boolean {
  return (
    previous.href === next.href &&
    previous.targetPath === next.targetPath &&
    previous.iconPath === next.iconPath &&
    previous.displayPath === next.displayPath &&
    previous.workspaceRelativePath === next.workspaceRelativePath &&
    previous.line === next.line &&
    previous.label === next.label &&
    previous.copyMarkdown === next.copyMarkdown &&
    previous.theme === next.theme &&
    previous.threadRef === next.threadRef &&
    previous.onOpen === next.onOpen &&
    previous.onOpenInBrowser === next.onOpenInBrowser &&
    previous.onOpenInViewer === next.onOpenInViewer &&
    previous.isDirectory === next.isDirectory &&
    previous.onOpenDirectory === next.onOpenDirectory &&
    previous.className === next.className
  );
}

function ChatMarkdown({
  text,
  cwd,
  threadRef,
  onTaskListChange,
  isStreaming = false,
  skills = EMPTY_MARKDOWN_SKILLS,
  className,
  lineBreaks = false,
}: ChatMarkdownProps) {
  const { resolvedTheme } = useTheme();
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const preparedConnection = usePreparedConnection(threadRef?.environmentId ?? null);
  const environmentId = useActiveEnvironmentId();
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const openInPreferredEditor = useOpenInPreferredEditor(
    environmentId,
    serverConfig?.availableEditors ?? [],
  );
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const markdownFileLinkMetaByHref = useMemo(() => {
    const metaByHref = new Map<
      string,
      NonNullable<ReturnType<typeof resolveMarkdownFileLinkMeta>>
    >();
    for (const href of extractMarkdownLinkHrefs(text)) {
      const normalizedHref = normalizeMarkdownLinkHrefKey(href);
      if (metaByHref.has(normalizedHref)) continue;
      const meta = resolveMarkdownFileLinkMeta(normalizedHref, cwd);
      if (meta) {
        metaByHref.set(normalizedHref, meta);
      }
    }
    return metaByHref;
  }, [cwd, text]);
  // Inline code spans are frequent, so resolution is memoised per message text:
  // a cache keyed by the raw span text turns each `code` render into a cheap
  // lookup, and clearing it when `text`/`cwd` change keeps streaming correct.
  const resolveInlineCodeMeta = useMemo(() => {
    const cache = new Map<string, MarkdownFileLinkMeta | null>();
    return (rawSpan: string): MarkdownFileLinkMeta | null => {
      const cached = cache.get(rawSpan);
      if (cached !== undefined) return cached;
      const meta = resolveInlineCodeFileLinkMeta(rawSpan, cwd);
      cache.set(rawSpan, meta);
      return meta;
    };
  }, [cwd]);
  // Parent-suffix disambiguation for inline-code chips is computed over the
  // spans present in this message so `foo.ts` chips can gain a `dir/` suffix
  // when they collide, consistent with explicit-link chips.
  const inlineCodeFilePaths = useMemo(() => {
    const filePaths = new Set<string>();
    for (const rawSpan of extractInlineCodeSpanTexts(text)) {
      const meta = resolveInlineCodeMeta(rawSpan);
      if (meta) filePaths.add(meta.filePath);
    }
    return filePaths;
  }, [resolveInlineCodeMeta, text]);
  // Directory references named anywhere in this message (appearance-ordered), so
  // a bare filename can resolve against a folder mentioned in the same sentence
  // (e.g. a `_findings/` folder plus bare `verdict.md`). Purely syntactic — no
  // existence lookup — so it cannot feed back into the existence request set.
  const messageDirectoryBases = useMemo(() => collectMessageDirectoryBases(text, cwd), [cwd, text]);
  // Per-span candidate resolution, memoised like the single-meta resolver: each
  // span yields an ordered candidate list (cwd first, then message directories).
  const resolveInlineCodeCandidates = useMemo(() => {
    const cache = new Map<string, MarkdownFileLinkMeta[]>();
    return (rawSpan: string): MarkdownFileLinkMeta[] => {
      const cached = cache.get(rawSpan);
      if (cached) return cached;
      const candidates = resolveInlineCodeFileLinkCandidates(rawSpan, cwd, messageDirectoryBases);
      cache.set(rawSpan, candidates);
      return candidates;
    };
  }, [cwd, messageDirectoryBases]);
  const fileLinkParentSuffixByPath = useMemo(() => {
    const filePaths = [
      ...[...markdownFileLinkMetaByHref.values()].map((meta) => meta.filePath),
      ...inlineCodeFilePaths,
    ];
    return buildFileLinkParentSuffixByPath(filePaths);
  }, [inlineCodeFilePaths, markdownFileLinkMetaByHref]);
  // Existence verification: a chip only becomes a clickable link once its
  // resolved target is confirmed to exist. Candidates are the resolved absolute
  // paths of every explicit-link and inline-code file reference in this message.
  const statEnvironmentId = threadRef?.environmentId ?? environmentId;
  const existenceCandidatePaths = useMemo(() => {
    const paths = new Set<string>();
    for (const meta of markdownFileLinkMetaByHref.values()) paths.add(meta.filePath);
    for (const rawSpan of extractInlineCodeSpanTexts(text)) {
      for (const meta of resolveInlineCodeCandidates(rawSpan)) paths.add(meta.filePath);
    }
    // Plain-prose and fenced-code-block path references. Deferred entirely while
    // streaming: prose linking and code-block decoration are also quiescent
    // until the message completes (see below), so scanning the growing text on
    // every token would be pure waste. Block-aware + bounded
    // (`extractMessagePathCandidates`): over-limit fenced blocks contribute
    // nothing and the total is capped. When streaming ends this memo recomputes
    // once and the single bounded existence pass fires.
    if (!isStreaming) {
      for (const candidate of extractMessagePathCandidates(text)) {
        for (const meta of resolveInlineCodeCandidates(candidate)) paths.add(meta.filePath);
      }
    }
    return [...paths];
  }, [isStreaming, markdownFileLinkMetaByHref, resolveInlineCodeCandidates, text]);
  const lookupPathExistence = usePathExistence(statEnvironmentId, existenceCandidatePaths);
  // Verification is only possible with a connected environment; without one
  // (e.g. the /preview harness) chips keep the prior syntactic-only behaviour.
  const verifyExistence = statEnvironmentId !== null;
  // Flicker strategy: render an unverified reference as inert plain code and
  // *upgrade* it to a chip once existence resolves. This never shows a dead
  // chip (code → chip is additive), at the cost of a brief plain-code state on
  // first paint / during streaming — the safe direction for the failure modes
  // this guards (chips that resolve to non-existent or directory targets).
  // Bind a chip to the first candidate confirmed to exist, walking in priority
  // order (cwd, then message directories). A higher-priority candidate that is
  // still unverified blocks binding (render inert and wait) so the choice is
  // deterministic and never flickers from a lower- to a higher-priority target.
  const resolveChipBinding = useCallback(
    (
      candidates: readonly MarkdownFileLinkMeta[],
    ): { meta: MarkdownFileLinkMeta; isDirectory: boolean } | null => {
      const first = candidates[0];
      if (!first) return null;
      // No connected environment (e.g. the /preview harness): keep the prior
      // syntactic-only behaviour — the first candidate is a plain file chip.
      if (!verifyExistence) return { meta: first, isDirectory: false };
      return selectChipBinding(candidates, lookupPathExistence);
    },
    [lookupPathExistence, verifyExistence],
  );
  const openDirectoryTarget = useCallback(
    (meta: MarkdownFileLinkMeta) => {
      // In-workspace directory: reveal it in the workspace explorer surface.
      if (threadRef && meta.workspaceRelativePath !== null) {
        useRightPanelStore.getState().openFilesAt(threadRef, meta.workspaceRelativePath);
        return;
      }
      // Out-of-workspace directory: open a read-only absolute-root listing so the
      // user can browse and click into files (POSIX absolute paths only — the
      // listing RPC rejects non-absolute/Windows paths on a POSIX host).
      if (threadRef && isAbsolutePreviewablePath(meta.filePath)) {
        useRightPanelStore.getState().openDirectoryAbsolute(threadRef, meta.filePath);
        return;
      }
      // No thread context or an unservable path: copy the path instead of
      // attempting a listing that would surface a broken error panel.
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return;
      void navigator.clipboard.writeText(meta.targetPath).then(
        () => {
          toastManager.add({
            type: "success",
            title: "Directory path copied",
            description: meta.targetPath,
          });
        },
        (cause) => {
          reportMarkdownActionFailure(
            { operation: "copy-directory-path", target: meta.targetPath },
            cause,
          );
        },
      );
    },
    [threadRef],
  );
  // Open a resolved path target. Mirrors the chip's file-preview routing
  // (workspace file → in-workspace preview, POSIX-absolute → out-of-workspace
  // preview, else editor) and reuses the directory handler for folders. Used by
  // the terminal-style code-block path decorations, which are not chips.
  const openPathTarget = useCallback(
    (meta: MarkdownFileLinkMeta, isDirectory: boolean) => {
      if (isDirectory) {
        openDirectoryTarget(meta);
        return;
      }
      if (threadRef) {
        if (meta.workspaceRelativePath) {
          useRightPanelStore.getState().openFile(threadRef, meta.workspaceRelativePath, meta.line);
          return;
        }
        if (isAbsolutePreviewablePath(meta.filePath)) {
          useRightPanelStore.getState().openFileAbsolute(threadRef, meta.filePath, meta.line);
          return;
        }
      }
      void openInPreferredEditor(meta.targetPath);
    },
    [openDirectoryTarget, openInPreferredEditor, threadRef],
  );
  // Decorate a rendered code block's DOM: turn existence-verified path
  // substrings into clickable regions without altering the block's text.
  // Re-created when existence resolves (via `resolveChipBinding`) so the effect
  // that runs it re-decorates once targets are confirmed.
  const decorateCodeBlock = useCallback(
    (container: HTMLElement) => {
      decorateCodeBlockPaths(container, {
        resolveTarget: (rawPath): CodePathTarget | null => {
          const binding = resolveChipBinding(resolveInlineCodeCandidates(rawPath));
          return binding ? { meta: binding.meta, isDirectory: binding.isDirectory } : null;
        },
        onActivate: (target) => openPathTarget(target.meta, target.isDirectory),
      });
    },
    [openPathTarget, resolveChipBinding, resolveInlineCodeCandidates],
  );
  const markdownUrlTransform = useCallback((href: string) => {
    if (href.startsWith("thread://")) return href;
    return rewriteMarkdownFileUriHref(href) ?? defaultUrlTransform(href);
  }, []);
  // Re-emit highlighted content as markdown so copying out of the rendered
  // view keeps links, emphasis, lists, and code fences intact.
  const handleCopy = useCallback((event: ReactClipboardEvent<HTMLDivElement>) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !event.clipboardData) return;
    const payload = chatMarkdownClipboardPayload(selection);
    if (!payload) return;
    event.preventDefault();
    event.clipboardData.setData("text/plain", payload.text);
    event.clipboardData.setData("text/html", payload.html);
  }, []);
  const openExternalLinkInPreview = useCallback(
    (url: string) => {
      if (!threadRef) {
        return Promise.resolve(
          AsyncResult.failure<void, BrowserPreviewUnavailableError>(
            Cause.fail(
              new BrowserPreviewUnavailableError({
                message: "Thread context is unavailable.",
              }),
            ),
          ),
        );
      }
      return openUrlInPreview({ threadRef, url, openPreview });
    },
    [openPreview, threadRef],
  );
  const openMarkdownFileInPreview = useCallback(
    (path: string) => {
      if (!threadRef || preparedConnection._tag === "None") {
        return Promise.resolve(
          AsyncResult.failure<void, BrowserPreviewUnavailableError>(
            Cause.fail(
              new BrowserPreviewUnavailableError({
                message: "Environment is not connected.",
              }),
            ),
          ),
        );
      }
      return openFileInPreview({
        threadRef,
        filePath: path,
        httpBaseUrl: preparedConnection.value.httpBaseUrl,
        createAssetUrl,
        openPreview,
      });
    },
    [createAssetUrl, openPreview, preparedConnection, threadRef],
  );
  const markdownComponents = useMemo<Components>(() => {
    // Plain-prose path reference injected by `rehypeChatFilePaths`. Resolves
    // (with same-message directory candidates) and existence-binds exactly
    // like an inline-code span, rendering the shared file chip when a target
    // exists and otherwise falling back to the original plain text.
    const ProseFilePath = ({ node, children }: { node?: unknown; children?: ReactNode }) => {
      // The injected element carries the raw path as its single text child; read
      // it from the hast node (authoritative) and fall back to rendered children.
      const rawText = plainHastText(node) ?? nodeToPlainText(children);
      const binding = resolveChipBinding(resolveInlineCodeCandidates(rawText.trim()));
      if (!binding) {
        return <>{rawText}</>;
      }
      const meta = binding.meta;
      const isDirectory = binding.isDirectory;
      const parentSuffix = fileLinkParentSuffixByPath.get(meta.filePath);
      const labelParts = [meta.basename];
      if (typeof parentSuffix === "string" && parentSuffix.length > 0) {
        labelParts.push(parentSuffix);
      }
      if (meta.line) {
        labelParts.push(`L${meta.line}${meta.column ? `:C${meta.column}` : ""}`);
      }
      return (
        <MarkdownFileLink
          href={meta.targetPath}
          targetPath={meta.targetPath}
          iconPath={meta.filePath}
          displayPath={meta.displayPath}
          workspaceRelativePath={meta.workspaceRelativePath}
          line={meta.line}
          label={labelParts.join(" · ")}
          copyMarkdown={rawText}
          theme={resolvedTheme}
          threadRef={threadRef}
          onOpen={openInPreferredEditor}
          onOpenInBrowser={
            !isDirectory &&
            threadRef &&
            isPreviewSupportedInRuntime() &&
            isBrowserPreviewFile(meta.filePath)
              ? () => openMarkdownFileInPreview(meta.filePath)
              : undefined
          }
          onOpenInViewer={
            !isDirectory &&
            threadRef &&
            !isPreviewSupportedInRuntime() &&
            isArtifactViewerPath(meta.filePath) &&
            meta.workspaceRelativePath !== null
              ? () => {
                  const relative = meta.workspaceRelativePath;
                  if (threadRef && relative) {
                    useRightPanelStore.getState().openArtifact(threadRef, relative);
                  }
                }
              : undefined
          }
          isDirectory={isDirectory}
          onOpenDirectory={isDirectory ? () => openDirectoryTarget(meta) : undefined}
        />
      );
    };
    const components: Components = {
      p({ node: _node, children, ...props }) {
        return <p {...props}>{renderSkillInlineMarkdownChildren(children, skills)}</p>;
      },
      li({ node, children, ...props }) {
        const listItemStart = node?.position?.start.offset;
        const markerOffset =
          typeof listItemStart === "number" ? findTaskListMarkerOffset(text, listItemStart) : null;
        return (
          <li {...props} data-task-marker-offset={markerOffset ?? undefined}>
            {renderSkillInlineMarkdownChildren(children, skills)}
          </li>
        );
      },
      input({ node: _node, type, checked, disabled: _disabled, ...props }) {
        if (type !== "checkbox" || !onTaskListChange) {
          return (
            <input
              {...props}
              type={type}
              checked={checked}
              disabled={_disabled}
              readOnly={type === "checkbox"}
            />
          );
        }
        return (
          <input
            {...props}
            type="checkbox"
            name="markdown-task"
            aria-label="Toggle task"
            checked={checked}
            onChange={(event) => {
              const markerOffset = Number(
                event.currentTarget.closest("li")?.dataset.taskMarkerOffset,
              );
              if (!Number.isSafeInteger(markerOffset)) return;
              onTaskListChange({ markerOffset, checked: event.currentTarget.checked });
            }}
          />
        );
      },
      a({ node, href, children, ...props }) {
        if (href?.startsWith("thread://")) {
          return (
            <span className={CHAT_FILE_TAG_CHIP_CLASS_NAME}>
              <ThreadTagChipContent label={plainHastText(node) || "thread"} />
            </span>
          );
        }
        const normalizedHref = href ? normalizeMarkdownLinkHrefKey(href) : "";
        const fileLinkMeta = normalizedHref ? markdownFileLinkMetaByHref.get(normalizedHref) : null;
        if (!fileLinkMeta) {
          const faviconHost = resolveExternalLinkHost(href);
          const isSameDocumentLink = href?.startsWith("#") ?? false;
          const onClick = props.onClick;
          const canOpenInPreview = Boolean(threadRef) && isPreviewSupportedInRuntime();
          const link = (
            <a
              {...props}
              href={href}
              target={isSameDocumentLink ? undefined : "_blank"}
              rel={isSameDocumentLink ? undefined : "noopener noreferrer"}
              onClick={(event) => {
                onClick?.(event);
                if (isSameDocumentLink && href) {
                  handleMarkdownFragmentClick(event, href);
                }
              }}
              onContextMenu={(event) => {
                if (!canOpenInPreview || !href) return;
                event.preventDefault();
                event.stopPropagation();
                const api = readLocalApi();
                if (!api) return;
                void (async () => {
                  let operation = "show-link-context-menu";
                  try {
                    const clicked = await api.contextMenu.show(
                      [
                        { id: "open-in-browser", label: "Open in integrated browser" },
                        { id: "open-external", label: "Open in system browser" },
                      ] as const,
                      { x: event.clientX, y: event.clientY },
                    );
                    if (clicked === "open-in-browser") {
                      operation = "open-link-in-preview";
                      const result = await openExternalLinkInPreview(href);
                      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                        reportMarkdownActionFailure({ operation, target: href }, result.cause);
                      }
                      return;
                    }
                    if (clicked === "open-external") {
                      operation = "open-link-external";
                      await api.shell.openExternal(href);
                    }
                  } catch (cause) {
                    reportMarkdownActionFailure({ operation, target: href }, cause);
                  }
                })();
              }}
            >
              {faviconHost ? (
                <MarkdownExternalLinkContent host={faviconHost} plainText={plainHastText(node)}>
                  {children}
                </MarkdownExternalLinkContent>
              ) : (
                children
              )}
            </a>
          );
          if (!faviconHost || !href) {
            return link;
          }
          return (
            <Tooltip>
              <TooltipTrigger render={link} />
              <TooltipPopup
                side="top"
                className="max-w-[min(36rem,calc(100vw-2rem))] whitespace-normal leading-tight wrap-anywhere"
              >
                {href}
              </TooltipPopup>
            </Tooltip>
          );
        }

        const binding = resolveChipBinding([fileLinkMeta]);
        if (!binding) {
          // Unverified or non-existent target: render the link text plainly so
          // there is no dead click.
          return <>{children}</>;
        }
        const isDirectory = binding.isDirectory;
        const parentSuffix = fileLinkParentSuffixByPath.get(fileLinkMeta.filePath);
        const labelParts = [fileLinkMeta.basename];
        if (typeof parentSuffix === "string" && parentSuffix.length > 0) {
          labelParts.push(parentSuffix);
        }
        if (fileLinkMeta.line) {
          labelParts.push(
            `L${fileLinkMeta.line}${fileLinkMeta.column ? `:C${fileLinkMeta.column}` : ""}`,
          );
        }

        return (
          <MarkdownFileLink
            href={fileLinkMeta.targetPath}
            targetPath={fileLinkMeta.targetPath}
            iconPath={fileLinkMeta.filePath}
            displayPath={fileLinkMeta.displayPath}
            workspaceRelativePath={fileLinkMeta.workspaceRelativePath}
            line={fileLinkMeta.line}
            label={labelParts.join(" · ")}
            copyMarkdown={`[${fileLinkMeta.basename}](${normalizedHref})`}
            theme={resolvedTheme}
            threadRef={threadRef}
            onOpen={openInPreferredEditor}
            onOpenInBrowser={
              !isDirectory &&
              threadRef &&
              isPreviewSupportedInRuntime() &&
              isBrowserPreviewFile(fileLinkMeta.filePath)
                ? () => openMarkdownFileInPreview(fileLinkMeta.filePath)
                : undefined
            }
            onOpenInViewer={
              !isDirectory &&
              threadRef &&
              !isPreviewSupportedInRuntime() &&
              isArtifactViewerPath(fileLinkMeta.filePath) &&
              fileLinkMeta.workspaceRelativePath !== null
                ? () => {
                    const relative = fileLinkMeta.workspaceRelativePath;
                    if (threadRef && relative) {
                      useRightPanelStore.getState().openArtifact(threadRef, relative);
                    }
                  }
                : undefined
            }
            isDirectory={isDirectory}
            onOpenDirectory={isDirectory ? () => openDirectoryTarget(fileLinkMeta) : undefined}
            className={props.className}
          />
        );
      },
      code({ node, className, children, ...props }) {
        // The `code` component fires for BOTH inline spans and the `code`
        // element inside a fenced `pre`. Fenced blocks carry a `language-*`
        // class or a trailing newline and are owned by the `pre` override
        // (which reads these props to drive Shiki); render them plainly here so
        // the fallback/suspense paths stay unchanged. Only bare inline spans
        // are candidates for file-link treatment. The raw span text is read
        // from the hast node (the rendered `children` are already wrapped into
        // skill-inline React elements, so text extraction from them is lossy).
        const rawText = plainHastText(node) ?? nodeToPlainText(children);
        const isBlockCode = (className?.includes("language-") ?? false) || rawText.includes("\n");
        const inlineCandidates = isBlockCode ? [] : resolveInlineCodeCandidates(rawText.trim());
        const binding = resolveChipBinding(inlineCandidates);
        if (!binding) {
          // No candidate confirmed to exist (or unverified): keep it as plain
          // inline code so a plausible-but-wrong path never becomes a dead click.
          return (
            <code {...props} className={className}>
              {children}
            </code>
          );
        }
        const inlineMeta = binding.meta;
        const isDirectory = binding.isDirectory;
        const parentSuffix = fileLinkParentSuffixByPath.get(inlineMeta.filePath);
        const labelParts = [inlineMeta.basename];
        if (typeof parentSuffix === "string" && parentSuffix.length > 0) {
          labelParts.push(parentSuffix);
        }
        if (inlineMeta.line) {
          labelParts.push(
            `L${inlineMeta.line}${inlineMeta.column ? `:C${inlineMeta.column}` : ""}`,
          );
        }

        return (
          <MarkdownFileLink
            href={inlineMeta.targetPath}
            targetPath={inlineMeta.targetPath}
            iconPath={inlineMeta.filePath}
            displayPath={inlineMeta.displayPath}
            workspaceRelativePath={inlineMeta.workspaceRelativePath}
            line={inlineMeta.line}
            label={labelParts.join(" · ")}
            copyMarkdown={`\`${rawText}\``}
            theme={resolvedTheme}
            threadRef={threadRef}
            onOpen={openInPreferredEditor}
            onOpenInBrowser={
              !isDirectory &&
              threadRef &&
              isPreviewSupportedInRuntime() &&
              isBrowserPreviewFile(inlineMeta.filePath)
                ? () => openMarkdownFileInPreview(inlineMeta.filePath)
                : undefined
            }
            onOpenInViewer={
              !isDirectory &&
              threadRef &&
              !isPreviewSupportedInRuntime() &&
              isArtifactViewerPath(inlineMeta.filePath) &&
              inlineMeta.workspaceRelativePath !== null
                ? () => {
                    const relative = inlineMeta.workspaceRelativePath;
                    if (threadRef && relative) {
                      useRightPanelStore.getState().openArtifact(threadRef, relative);
                    }
                  }
                : undefined
            }
            isDirectory={isDirectory}
            onOpenDirectory={isDirectory ? () => openDirectoryTarget(inlineMeta) : undefined}
          />
        );
      },
      table({ node: _node, ...props }) {
        return <MarkdownTable {...props} />;
      },
      details({ node: _node, children, open: detailsOpen }) {
        return <MarkdownDetails open={detailsOpen}>{children}</MarkdownDetails>;
      },
      pre({ node, children, ...props }) {
        const codeBlock = extractCodeBlock(children);
        if (!codeBlock) {
          return <pre {...props}>{children}</pre>;
        }

        const language = extractFenceLanguage(codeBlock.className);
        const fenceTitle = extractFenceTitle(extractPreCodeMeta(node));
        return (
          <MarkdownCodeBlock
            code={codeBlock.code}
            language={language}
            fenceTitle={fenceTitle}
            theme={resolvedTheme}
          >
            <CodeHighlightErrorBoundary fallback={<pre {...props}>{children}</pre>}>
              <Suspense fallback={<pre {...props}>{children}</pre>}>
                <SuspenseShikiCodeBlock
                  className={codeBlock.className}
                  code={codeBlock.code}
                  themeName={diffThemeName}
                  isStreaming={isStreaming}
                  // Defer path decoration until streaming completes so the DOM
                  // scan does not run on every streamed re-highlight; the final
                  // render decorates once.
                  decorate={isStreaming ? undefined : decorateCodeBlock}
                />
              </Suspense>
            </CodeHighlightErrorBoundary>
          </MarkdownCodeBlock>
        );
      },
    };
    return { ...components, [PROSE_FILE_PATH_TAG]: ProseFilePath } as Components;
  }, [
    decorateCodeBlock,
    diffThemeName,
    fileLinkParentSuffixByPath,
    isStreaming,
    markdownFileLinkMetaByHref,
    onTaskListChange,
    openDirectoryTarget,
    openInPreferredEditor,
    openExternalLinkInPreview,
    openMarkdownFileInPreview,
    resolveChipBinding,
    resolveInlineCodeCandidates,
    resolvedTheme,
    skills,
    text,
    threadRef,
  ]);

  return (
    <div
      className={cn(
        "chat-markdown w-full min-w-0 text-sm leading-relaxed text-foreground/80",
        className,
      )}
      onCopy={handleCopy}
    >
      <ReactMarkdown
        remarkPlugins={
          lineBreaks ? CHAT_MARKDOWN_REMARK_PLUGINS_WITH_BREAKS : CHAT_MARKDOWN_REMARK_PLUGINS
        }
        rehypePlugins={
          // loom (#79): reuse upstream's extracted rehype constant, appending the
          // prose path-linking plugin only once streaming completes so the text
          // is not re-split on every streamed parse (no per-token rescans); the
          // completed message runs it once.
          isStreaming
            ? CHAT_MARKDOWN_REHYPE_PLUGINS
            : [...CHAT_MARKDOWN_REHYPE_PLUGINS, rehypeChatFilePaths]
        }
        components={markdownComponents}
        urlTransform={markdownUrlTransform}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(ChatMarkdown);
