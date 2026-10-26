/**
 * Compile-time half of `<Glossary>`: links each body-prose glossary term to
 * `<GlossaryTerm term="key">` inside one document-wide `<GlossaryScope>` (the shared card),
 * matched once in the worker. Injected after the unknown-tag guard, so neither is authorable;
 * neither adds DOM text, so annotation text-quote anchors still resolve.
 */

type MdastNode = {
  type: string;
  name?: string | null;
  value?: string;
  children?: MdastNode[];
  attributes?: Array<{ type: string; name?: string; value?: unknown }>;
};

export const glossaryKey = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();

/** Prose a term card must not sit inside: code, headings, tables, links, and
 * inline JSX such as a `<Badge>` label. */
const UNLINKED = new Set([
  "code",
  "heading",
  "html",
  "inlineCode",
  "link",
  "linkReference",
  "mdxJsxTextElement",
  "table",
  "yaml",
]);

const isElement = (node: MdastNode, name: string) =>
  (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") && node.name === name;

const termNames = (node: MdastNode): string[] =>
  isElement(node, "Term")
    ? (node.attributes
        ?.filter((attr) => attr.name === "name" && typeof attr.value === "string")
        .map((attr) => attr.value as string) ?? [])
    : (node.children ?? []).flatMap(termNames);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const remarkGlossary = () => (tree: MdastNode) => {
  const glossaries = (tree.children ?? []).filter((node) => isElement(node, "Glossary"));
  const keys = new Set(glossaries.flatMap(termNames).map(glossaryKey).filter(Boolean));
  if (keys.size === 0) return;

  // Longest first, so "reading unit" wins over "unit" at the same position. A
  // plural `s`/`es` suffix matches the singular name.
  const alternation = [...keys]
    .toSorted((a, b) => b.length - a.length)
    .map((key) => key.split(" ").map(escapeRegExp).join("\\s+"))
    .join("|");
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${alternation})(?:e?s)?(?![\\p{L}\\p{N}_])`,
    "giu",
  );

  const linkText = (node: MdastNode): MdastNode[] => {
    const value = node.value ?? "";
    const out: MdastNode[] = [];
    let last = 0;
    for (const match of value.matchAll(pattern)) {
      const lower = glossaryKey(match[0]);
      const key = [lower, lower.slice(0, -1), lower.slice(0, -2)].find((k) => keys.has(k));
      if (!key) continue;
      if (match.index > last) out.push({ type: "text", value: value.slice(last, match.index) });
      out.push({
        type: "mdxJsxTextElement",
        name: "GlossaryTerm",
        attributes: [{ type: "mdxJsxAttribute", name: "term", value: key }],
        children: [{ type: "text", value: match[0] }],
      });
      last = match.index + match[0].length;
    }
    if (out.length === 0) return [node];
    if (last < value.length) out.push({ type: "text", value: value.slice(last) });
    return out;
  };

  const walk = (node: MdastNode) => {
    if (UNLINKED.has(node.type) || glossaries.includes(node) || !node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === "text") return linkText(child);
      walk(child);
      return [child];
    });
  };
  walk(tree);

  tree.children = [
    {
      type: "mdxJsxFlowElement",
      name: "GlossaryScope",
      attributes: [],
      children: tree.children ?? [],
    },
  ];
};
