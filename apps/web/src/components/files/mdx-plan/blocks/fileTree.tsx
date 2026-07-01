import { IconChevronRight, IconFile, IconFolder } from "@tabler/icons-react";
import { useMemo, useState } from "react";
import { z } from "zod";

import { cn } from "~/lib/utils";

import type { BlockMdxConfig, PlanBlock, PlanBlockReadProps } from "../blockTypes";
import { useShikiHtml } from "../shiki";

/**
 * The `<FileTree>` block — a nested file/change map. Slash-delimited `entries`
 * paths are folded into a real directory tree; each file carries an optional
 * change badge, note, and an expandable syntax-highlighted snippet. Schema + MDX
 * round-trip ported verbatim from `@agent-native/core` `file-tree.config.ts`
 * (the whole `entries` array is one JSON prop).
 */

export type FileChange = "added" | "modified" | "removed" | "renamed";

export interface FileTreeEntry {
  path: string;
  change?: FileChange;
  note?: string;
  snippet?: string;
  language?: string;
}

export interface FileTreeData {
  title?: string;
  entries: FileTreeEntry[];
}

const changeSchema = z.enum(["added", "modified", "removed", "renamed"]);

const entrySchema = z.object({
  path: z.string().trim().min(1).max(500),
  change: changeSchema.optional(),
  note: z.string().trim().max(2000).optional(),
  snippet: z.string().max(50_000).optional(),
  language: z.string().trim().max(40).optional(),
}) as z.ZodType<FileTreeEntry>;

export const fileTreeSchema = z.object({
  title: z.string().trim().max(180).optional(),
  entries: z.array(entrySchema).min(1).max(200),
}) as unknown as z.ZodType<FileTreeData>;

export const fileTreeMdx: BlockMdxConfig<FileTreeData> = {
  tag: "FileTree",
  toAttrs: (data) => ({
    title: data.title,
    entries: data.entries,
  }),
  fromAttrs: (attrs) =>
    ({
      title: attrs.string("title"),
      entries: attrs.array<FileTreeEntry>("entries") ?? [],
    }) as FileTreeData,
};

const CHANGE_BADGE: Record<FileChange, string> = {
  added: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  modified: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  removed: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  renamed: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
};

const CHANGE_GLYPH: Record<FileChange, string> = {
  added: "A",
  modified: "M",
  removed: "D",
  renamed: "R",
};

/* ── Tree model: fold slash paths into nested nodes ───────────────────────── */

interface TreeNode {
  name: string;
  children: Map<string, TreeNode>;
  entry?: FileTreeEntry;
}

function buildTree(entries: FileTreeEntry[]): TreeNode {
  const root: TreeNode = { name: "", children: new Map() };
  for (const entry of entries) {
    const segments = entry.path.split("/").filter(Boolean);
    let node = root;
    segments.forEach((segment, index) => {
      let child = node.children.get(segment);
      if (!child) {
        child = { name: segment, children: new Map() };
        node.children.set(segment, child);
      }
      if (index === segments.length - 1) child.entry = entry;
      node = child;
    });
  }
  return root;
}

function Snippet({ code, language }: { code: string; language: string }) {
  const html = useShikiHtml(code, language);
  if (html === null) {
    return <pre className="overflow-x-auto p-2 font-mono text-[11px]">{code}</pre>;
  }
  return (
    <div
      className="plan-code-shiki overflow-x-auto p-2 text-[11px]"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function FileRow({ node, depth }: { node: TreeNode; depth: number }) {
  const entry = node.entry!;
  const [open, setOpen] = useState(false);
  const hasSnippet = Boolean(entry.snippet);
  return (
    <div>
      <div
        role={hasSnippet ? "button" : undefined}
        onClick={hasSnippet ? () => setOpen((value) => !value) : undefined}
        className={cn(
          "flex items-center gap-1.5 rounded px-1.5 py-1 text-sm",
          hasSnippet && "cursor-pointer hover:bg-accent/50",
        )}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        <IconFile className="size-3.5 shrink-0 text-muted-foreground" />
        <span
          className={cn(
            "min-w-0 truncate font-mono text-xs",
            entry.change === "removed"
              ? "text-red-600 line-through dark:text-red-300"
              : "text-foreground",
          )}
        >
          {node.name}
        </span>
        {entry.change && (
          <span
            title={entry.change}
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded text-[10px] font-bold leading-none",
              CHANGE_BADGE[entry.change],
            )}
          >
            {CHANGE_GLYPH[entry.change]}
          </span>
        )}
        {entry.note && (
          <span className="truncate text-[11px] italic text-muted-foreground">— {entry.note}</span>
        )}
        {hasSnippet && (
          <IconChevronRight
            className={cn(
              "ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        )}
      </div>
      {hasSnippet && open && (
        <div
          className="my-1 overflow-hidden rounded-md border border-border bg-card"
          style={{ marginLeft: `${depth * 14 + 20}px` }}
        >
          <Snippet code={entry.snippet!} language={entry.language?.trim() || "text"} />
        </div>
      )}
    </div>
  );
}

function TreeLevel({ node, depth }: { node: TreeNode; depth: number }) {
  // Folders first, then files; each alphabetical.
  const children = [...node.children.values()].sort((a, b) => {
    const aDir = a.children.size > 0 ? 0 : 1;
    const bDir = b.children.size > 0 ? 0 : 1;
    return aDir - bDir || a.name.localeCompare(b.name);
  });
  return (
    <>
      {children.map((child) =>
        child.children.size > 0 ? (
          <div key={child.name}>
            <div
              className="flex items-center gap-1.5 px-1.5 py-1 text-sm"
              style={{ paddingLeft: `${depth * 14 + 6}px` }}
            >
              <IconFolder className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="font-mono text-xs font-semibold text-foreground">{child.name}</span>
            </div>
            <TreeLevel node={child} depth={depth + 1} />
          </div>
        ) : (
          <FileRow key={child.name} node={child} depth={depth} />
        ),
      )}
    </>
  );
}

export function FileTreeRead({ data, blockId }: PlanBlockReadProps<FileTreeData>) {
  const tree = useMemo(() => buildTree(data.entries ?? []), [data.entries]);
  return (
    <section
      data-plan-block-id={blockId}
      data-plan-block-type="file-tree"
      className="my-4 overflow-hidden rounded-lg border border-border bg-card"
    >
      {data.title && (
        <div className="border-b border-border/60 bg-muted/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {data.title}
        </div>
      )}
      <div className="p-1.5">
        <TreeLevel node={tree} depth={0} />
      </div>
    </section>
  );
}

export const fileTreeBlock: PlanBlock<FileTreeData> = {
  schema: fileTreeSchema,
  mdx: fileTreeMdx,
  Read: FileTreeRead,
};
