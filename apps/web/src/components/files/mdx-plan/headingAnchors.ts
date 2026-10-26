/**
 * Heading slug ids and the source bounds of each heading's section, which a question's
 * `refs` anchor peeks at. The worker, `evaluate` path and linter all run this on the
 * same mdast, so a lint-clean anchor is both a rendered id and a compilable slice; a
 * second, text-level scanner drifted (phantom headings in fences), so there is one.
 */

type HeadingNode = {
  type: string;
  value?: string;
  depth?: number;
  children?: HeadingNode[];
  data?: { hProperties?: Record<string, unknown> };
  position?: { start: { offset?: number }; end?: { offset?: number } };
};

const textOf = (node: HeadingNode): string =>
  node.value ?? (node.children ?? []).map(textOf).join("");

/** `"Delivery order & slices"` → `"delivery-order-slices"`. */
const slugifyHeading = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";

/** Source offsets of one section's BODY: just past its heading, up to the next
 * sibling heading of the same or higher level — or the end of whatever contains
 * it. Bounded by the siblings, so a heading inside `<Columns>`/`<Tab>` slices to
 * the end of that container's children and the slice stays balanced. */
export type PlanSections = Record<string, [start: number, end: number]>;

/**
 * Walk an mdast tree, give every heading a document-unique slug id (via
 * `data.hProperties`, which `mdast-util-to-hast` renders as the element's `id`),
 * and return each slug's section bounds. Repeats of the same text get `-2`,
 * `-3`, … so an anchor always names exactly one heading.
 */
export function assignHeadingAnchors(tree: HeadingNode): PlanSections {
  const seen = new Map<string, number>();
  const sections: PlanSections = {};
  const walk = (node: HeadingNode) => {
    const children = node.children ?? [];
    for (const [index, child] of children.entries()) {
      if (child.type === "heading") {
        const base = slugifyHeading(textOf(child));
        const count = (seen.get(base) ?? 0) + 1;
        seen.set(base, count);
        const slug = count === 1 ? base : `${base}-${count}`;
        ((child.data ??= {}).hProperties ??= {}).id = slug;
        const depth = child.depth ?? 6;
        const next = children
          .slice(index + 1)
          .find((sibling) => sibling.type === "heading" && (sibling.depth ?? 6) <= depth);
        const start = child.position?.end?.offset;
        const end = next ? next.position?.start.offset : children.at(-1)?.position?.end?.offset;
        if (start !== undefined && end !== undefined) sections[slug] = [start, end];
      }
      walk(child);
    }
  };
  walk(tree);
  return sections;
}

/** The remark plugin form: stamps the ids and publishes the section bounds on
 * the compiled file, so the renderer gets them without a second parse. */
export const remarkHeadingAnchors =
  () => (tree: HeadingNode, file: { data: Record<string, unknown> }) => {
    file.data.planSections = assignHeadingAnchors(tree);
  };
