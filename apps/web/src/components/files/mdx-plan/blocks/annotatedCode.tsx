import { useMemo } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { useShikiHtml } from "../shiki";

/**
 * The `<AnnotatedCode>` block — a code walkthrough with margin notes keyed to
 * line ranges. Reuses the app's shared Shiki highlighter (via `useShikiHtml`),
 * renders one highlighted block, and lists each annotation with its `lines`
 * badge + label + note. Schema + MDX round-trip ported verbatim from
 * `@agent-native/core` `annotated-code.config.ts` (`code` is a multiline string
 * attribute; `annotations` is a JSON array prop).
 */

export interface CodeAnnotation {
  /** A single line ("12") or an inclusive range ("12-18"). */
  lines: string;
  label?: string;
  note: string;
}

export interface AnnotatedCodeData {
  code: string;
  language?: string;
  filename?: string;
  annotations: CodeAnnotation[];
}

const annotationSchema = z.object({
  lines: z
    .string()
    .trim()
    .max(40)
    .regex(/^\d+(\s*-\s*\d+)?$/, "lines must be a number or a `start-end` range"),
  label: z.string().trim().max(160).optional(),
  note: z.string().trim().min(1).max(4000),
}) as z.ZodType<CodeAnnotation>;

export const annotatedCodeSchema = z.object({
  code: z.string().max(100_000),
  language: z.string().trim().max(40).optional(),
  filename: z.string().trim().max(400).optional(),
  annotations: z.array(annotationSchema).max(80),
}) as unknown as z.ZodType<AnnotatedCodeData>;

export const annotatedCodeMdx: BlockMdxConfig<AnnotatedCodeData> = {
  tag: "AnnotatedCode",
  toAttrs: (data) => ({
    filename: data.filename,
    language: data.language,
    code: data.code,
    annotations: data.annotations,
  }),
  fromAttrs: (attrs) =>
    ({
      code: attrs.string("code") ?? "",
      language: attrs.string("language"),
      filename: attrs.string("filename"),
      annotations: attrs.array<CodeAnnotation>("annotations") ?? [],
    }) as AnnotatedCodeData,
};

/** "12" → [12,12]; "12-18" → [12,18]. */
function parseLineStart(lines: string): number {
  return Number.parseInt(lines.split("-")[0]?.trim() ?? "0", 10) || 0;
}

function AnnotatedCodeBody({ code, language }: { code: string; language: string }) {
  const html = useShikiHtml(code, language);
  if (html === null) {
    return <pre className="overflow-x-auto p-3 font-mono text-xs">{code}</pre>;
  }
  return (
    <div
      className="plan-code-shiki overflow-x-auto p-3 text-xs"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function AnnotatedCodeRead({ data, blockId }: PlanBlockReadProps<AnnotatedCodeData>) {
  const language = data.language?.trim() || "text";
  const annotations = useMemo(
    () =>
      [...(data.annotations ?? [])].sort(
        (a, b) => parseLineStart(a.lines) - parseLineStart(b.lines),
      ),
    [data.annotations],
  );

  return (
    <figure
      data-plan-block-id={blockId}
      data-plan-block-type="annotated-code"
      className="my-4 overflow-hidden rounded-lg border border-border bg-card"
    >
      {(data.filename || language !== "text") && (
        <figcaption className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span className="truncate font-mono">{data.filename ?? ""}</span>
          <span className="shrink-0 uppercase tracking-wide">{language}</span>
        </figcaption>
      )}
      <AnnotatedCodeBody code={data.code} language={language} />
      {annotations.length > 0 && (
        <div className="border-t border-border/60 bg-muted/20 px-3 py-2">
          <ol className="flex flex-col gap-2">
            {annotations.map((annotation) => (
              <li
                key={`${annotation.lines}-${annotation.label ?? annotation.note ?? ""}`}
                className="flex gap-2 text-xs"
              >
                <span className="mt-0.5 shrink-0 rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] font-semibold text-muted-foreground">
                  L{annotation.lines.replace(/\s*-\s*/, "–")}
                </span>
                <span className="min-w-0 text-foreground">
                  {annotation.label && <span className="font-semibold">{annotation.label}: </span>}
                  <span className={cn(!annotation.label && "text-muted-foreground")}>
                    {annotation.note}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </figure>
  );
}

export const annotatedCodeBlock: PlanBlock<AnnotatedCodeData> = {
  schema: annotatedCodeSchema,
  mdx: annotatedCodeMdx,
  Read: AnnotatedCodeRead,
};
