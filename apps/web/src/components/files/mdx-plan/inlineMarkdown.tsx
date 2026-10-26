import type { PhrasingContent, Root } from "mdast";
import { memo, type ReactNode } from "react";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

/**
 * Inline markdown for string props (string attributes are never parsed as MDX): bold,
 * em, code, strikethrough, links and hard breaks render; anything else renders as text.
 * A string that is not ONE paragraph (`1. step`, `# x`) renders verbatim, so block
 * syntax never eats characters out of a cell.
 */
const processor = unified().use(remarkParse).use(remarkGfm);

const UNSAFE_URL = /^\s*(javascript|vbscript|data):/i;

const textOf = (node: object): string =>
  "value" in node
    ? String(node.value)
    : "children" in node
      ? (node.children as object[]).map(textOf).join("")
      : "";

function renderNode(node: PhrasingContent, key: number): ReactNode {
  const children = () => ("children" in node ? node.children.map(renderNode) : null);
  switch (node.type) {
    case "text":
      return node.value;
    case "strong":
      return <strong key={key}>{children()}</strong>;
    case "emphasis":
      return <em key={key}>{children()}</em>;
    case "delete":
      return <del key={key}>{children()}</del>;
    case "inlineCode":
      return <code key={key}>{node.value}</code>;
    case "break":
      return <br key={key} />;
    case "link":
      return UNSAFE_URL.test(node.url) ? (
        textOf(node)
      ) : (
        <a key={key} href={node.url} target="_blank" rel="noreferrer">
          {children()}
        </a>
      );
    default:
      return textOf(node);
  }
}

export const InlineMarkdown = memo(function InlineMarkdown({ text }: { text: string }) {
  const { children } = processor.parse(text) as Root;
  const [first] = children;
  return (
    <span className="plan-inline-md">
      {children.length === 1 && first?.type === "paragraph" ? first.children.map(renderNode) : text}
    </span>
  );
});
