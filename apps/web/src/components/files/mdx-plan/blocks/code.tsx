import { isValidElement, type ReactNode, useState } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { useShikiHtml } from "../shiki";
import { WrapToggle } from "./wrapToggle";

/**
 * `<Code>`: one snippet highlighted with the app's shared Shiki highlighter (the one
 * `ChatMarkdown` fences use), not a second Shiki instance.
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

const codeSchema = z.object({
  code: z.string().max(100_000),
  language: z.string().trim().max(40).optional(),
  filename: z.string().trim().max(400).optional(),
  caption: z.string().trim().max(400).optional(),
  maxLines: z.number().int().min(0).max(2000).optional(),
  wrap: z.boolean().optional(),
}) as unknown as z.ZodType<CodeData>;

const codeMdx: BlockMdxConfig<CodeData> = {
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
      className={cn("overflow-x-auto p-3 text-xs", wrap && "plan-code-wrap")}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Languages whose content is prose, not code: a quoted message, a markdown
 * excerpt. Their max-content width is one long line, which would take the
 * whole bleed budget for no gain, so they keep the reading measure and wrap
 * by default (the stamping in `MdxPlanRenderer` reads `data-plan-code-prose`). */
const PROSE_LANGUAGES = new Set(["text", "txt", "plain", "plaintext", "markdown", "md", "mdx"]);

function CodeRead({ data, blockId }: PlanBlockReadProps<CodeData>) {
  const language = data.language?.trim() || "text";
  const prose = PROSE_LANGUAGES.has(language.toLowerCase());
  const lines = data.code.split("\n");
  const maxLines = data.maxLines ?? DEFAULT_CODE_MAX_LINES;
  const collapsible = maxLines > 0 && lines.length > maxLines;
  const [expanded, setExpanded] = useState(false);
  const [wrap, setWrap] = useState(data.wrap ?? prose);
  const shownCode = collapsible && !expanded ? lines.slice(0, maxLines).join("\n") : data.code;
  // A plain-text snippet with no filename has nothing to label: it renders as a
  // bare panel, its wrap toggle surfacing on hover (`.plan-code--bare`).
  const header = Boolean(data.filename) || language !== "text";

  return (
    <figure
      data-plan-block-id={blockId}
      data-plan-block-type="code"
      data-plan-code-prose={prose ? "" : undefined}
      className={cn(
        "my-4 overflow-hidden rounded-lg border border-border bg-card",
        !header && "plan-code--bare",
      )}
    >
      {header ? (
        <figcaption className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-2xs text-muted-foreground">
          <span className="min-w-0 flex-1 truncate font-mono">{data.filename ?? ""}</span>
          <div className="flex shrink-0 items-center gap-2">
            {language !== "text" && <span className="uppercase tracking-wide">{language}</span>}
            <WrapToggle wrapped={wrap} onToggle={() => setWrap((value) => !value)} />
          </div>
        </figcaption>
      ) : (
        <div className="plan-code-tools">
          <WrapToggle wrapped={wrap} onToggle={() => setWrap((value) => !value)} />
        </div>
      )}
      <CodeBody code={shownCode} language={language} wrap={wrap} />
      {collapsible && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className={cn(
            "w-full border-t border-border/60 bg-muted/30 px-3 py-1.5 text-left text-2xs",
            "text-muted-foreground hover:bg-muted/60",
          )}
        >
          {expanded ? "Show less" : `Show ${lines.length - maxLines} more lines`}
        </button>
      )}
      {data.caption && (
        <figcaption className="border-t border-border/60 px-3 py-1.5 text-2xs italic text-muted-foreground">
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

/** Markdown code fences (```json …```) compile to `<pre><code class="language-x">`;
 * render them as `<Code>` so they get the same highlighting, header and wrap toggle.
 * Never collapsed — a fence is shown in full, as authored. */
export function PlanMarkdownPre({ children }: { children?: ReactNode }) {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) {
    return <pre>{children}</pre>;
  }
  const { className, children: code } = children.props;
  return (
    <CodeRead
      blockId={undefined}
      data={{
        code: String(code ?? "").replace(/\n$/, ""),
        language: /language-(\S+)/.exec(className ?? "")?.[1] ?? "text",
        maxLines: 0,
      }}
    />
  );
}
