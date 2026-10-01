import {
  compileReferenceLinks,
  type ReferenceLinkRule,
  splitReferenceLinks,
} from "@t3tools/client-runtime/reference-links";

interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  url?: string;
  data?: unknown;
}

// Text inside these keeps its own meaning: an authored link stays as written.
// Code (`inlineCode`/`code`) and raw HTML carry `value`, not text children, so
// the walk never reaches them.
const SKIP_TYPES = new Set(["link", "linkReference", "definition"]);

/**
 * Remark plugin: split prose text nodes on the project's reference patterns and
 * replace each hit with an external link. Takes raw rules (not a compiled
 * linker) so the options stay structured-cloneable for the MDX compile worker.
 */
export function remarkReferenceLinks(options: { rules: ReadonlyArray<ReferenceLinkRule> }) {
  const linker = compileReferenceLinks(options.rules);
  return (tree: MdastNode) => {
    if (!linker) return;
    const visit = (node: MdastNode) => {
      const children = node.children;
      if (!children) return;
      for (let index = 0; index < children.length; index += 1) {
        const child = children[index]!;
        if (SKIP_TYPES.has(child.type)) continue;
        if (child.type !== "text") {
          visit(child);
          continue;
        }
        const segments = splitReferenceLinks(child.value ?? "", linker);
        if (!segments) continue;
        const replacement = segments.map((segment): MdastNode =>
          segment.url === undefined
            ? { type: "text", value: segment.text }
            : {
                type: "link",
                url: segment.url,
                data: { hProperties: { target: "_blank", rel: "noopener noreferrer" } },
                children: [{ type: "text", value: segment.text }],
              },
        );
        children.splice(index, 1, ...replacement);
        index += replacement.length - 1;
      }
    };
    visit(tree);
  };
}
