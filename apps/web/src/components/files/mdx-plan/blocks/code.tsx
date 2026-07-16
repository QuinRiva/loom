import { useMemo, useState } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { useShikiHtml } from "../shiki";
import { WrapToggle } from "./wrapToggle";

/**
 * The primitive `<Code>` block — one syntax-highlighted snippet. Reuses the
 * app's existing Shiki highlighter (`@pierre/diffs` `getSharedHighlighter`) — the
 * same one `ChatMarkdown` code fences use — rather than adding a second Shiki.
 * Schema + MDX round-trip ported verbatim from `@agent-native/core`
 * `code.config.ts` (the `code` string is a multiline string attribute).
 */

export interface CodeData {
  code: string;
  language?: string;
  filename?: string;
  caption?: string;
  maxLines?: number;
  /** Initial soft-wrap state (§5). Toggleable in the header regardless. */
  wrap?: boolean;
}

export const codeSchema = z.object({
  code: z.string().max(100_000),
  language: z.string().trim().max(40).optional(),
  filename: z.string().trim().max(400).optional(),
  caption: z.string().trim().max(400).optional(),
  maxLines: z.number().int().min(0).max(2000).optional(),
  wrap: z.boolean().optional(),
}) as unknown as z.ZodType<CodeData>;

export const codeMdx: BlockMdxConfig<CodeData> = {
  tag: "Code",
  toAttrs: (data) => ({
    filename: data.filename,
    language: data.language,
    caption: data.caption,
    maxLines: data.maxLines,
    wrap: data.wrap,
    code: data.code,
  }),
  fromAttrs: (attrs) =>
    ({
      code: attrs.string("code") ?? "",
      language: attrs.string("language"),
      filename: attrs.string("filename"),
      caption: attrs.string("caption"),
      maxLines: attrs.number("maxLines"),
      wrap: attrs.bool("wrap"),
    }) as CodeData,
};

const DEFAULT_CODE_MAX_LINES = 30;

function CodeBody({ code, language, wrap }: { code: string; language: string; wrap: boolean }) {
  const html = useShikiHtml(code, language);

  if (html === null) {
    return (
      <pre
        className={cn(
          "overflow-x-auto p-3 font-mono text-xs",
          wrap && "whitespace-pre-wrap break-words",
        )}
      >
        {code}
      </pre>
    );
  }
  return (
    <div
      className={cn("plan-code-shiki overflow-x-auto p-3 text-xs", wrap && "plan-code-wrap")}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function CodeRead({ data, blockId }: PlanBlockReadProps<CodeData>) {
  const language = data.language?.trim() || "text";
  const lines = useMemo(() => data.code.split("\n"), [data.code]);
  const maxLines = data.maxLines ?? DEFAULT_CODE_MAX_LINES;
  const collapsible = maxLines > 0 && lines.length > maxLines;
  const [expanded, setExpanded] = useState(false);
  const [wrap, setWrap] = useState(data.wrap ?? false);
  const shownCode = collapsible && !expanded ? lines.slice(0, maxLines).join("\n") : data.code;

  return (
    <figure
      data-plan-block-id={blockId}
      data-plan-block-type="code"
      className="my-4 overflow-hidden rounded-lg border border-border bg-card"
    >
      <figcaption className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-mono">{data.filename ?? ""}</span>
        <div className="flex shrink-0 items-center gap-2">
          {language !== "text" && <span className="uppercase tracking-wide">{language}</span>}
          <WrapToggle wrapped={wrap} onToggle={() => setWrap((value) => !value)} />
        </div>
      </figcaption>
      <CodeBody code={shownCode} language={language} wrap={wrap} />
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={cn(
            "w-full border-t border-border/60 bg-muted/30 px-3 py-1.5 text-left text-[11px]",
            "text-muted-foreground hover:bg-muted/60",
          )}
        >
          {expanded ? "Show less" : `Show ${lines.length - maxLines} more lines`}
        </button>
      )}
      {data.caption && (
        <figcaption className="border-t border-border/60 px-3 py-1.5 text-[11px] italic text-muted-foreground">
          {data.caption}
        </figcaption>
      )}
    </figure>
  );
}

export const codeBlock: PlanBlock<CodeData> = {
  schema: codeSchema,
  mdx: codeMdx,
  Read: CodeRead,
};
