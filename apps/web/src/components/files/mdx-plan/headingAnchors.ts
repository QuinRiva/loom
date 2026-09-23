/**
 * Stable ids for markdown headings in an MDX plan. A question in the bottom
 * `<QuestionForm>` can then name the section it depends on
 * (`refs: [{ label, anchor }]`) and the reader can peek at that section in place
 * instead of losing their spot in the form.
 *
 * The slugging lives in the shared compile pipeline (see
 * {@link ./mdxCompileOptions}) rather than in a heading component, so the
 * worker, the main-thread `evaluate` path and the linter all derive the SAME
 * slugs from the same source — a `refs[].anchor` that lints clean is the id the
 * renderer emits.
 */

type HeadingNode = {
  type: string;
  value?: string;
  children?: HeadingNode[];
  data?: { hProperties?: Record<string, unknown> };
  position?: { start: { line: number; column: number } };
};

const textOf = (node: HeadingNode): string =>
  node.value ?? (node.children ?? []).map(textOf).join("");

/** `"Delivery order & slices"` → `"delivery-order-slices"`. */
export const slugifyHeading = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";

/**
 * Walk an mdast tree, give every heading a document-unique slug id (via
 * `data.hProperties`, which `mdast-util-to-hast` renders as the element's `id`),
 * and return the slugs in document order. Repeats of the same text get `-2`,
 * `-3`, … so an anchor always names exactly one heading.
 */
export function assignHeadingAnchors(tree: HeadingNode): string[] {
  const seen = new Map<string, number>();
  const slugs: string[] = [];
  const walk = (node: HeadingNode) => {
    if (node.type === "heading") {
      const base = slugifyHeading(textOf(node));
      const count = (seen.get(base) ?? 0) + 1;
      seen.set(base, count);
      const slug = count === 1 ? base : `${base}-${count}`;
      ((node.data ??= {}).hProperties ??= {}).id = slug;
      slugs.push(slug);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return slugs;
}

/**
 * Marks a container holding a CLONE of a plan section (the question "peek").
 * The clone is a visual copy, not document content: `assignBlockIds` skips it so
 * it never consumes block ids, and the annotation layer's `flattenDocument`
 * rejects the subtree so a peek can never shift or duplicate a comment anchor.
 */
export const PLAN_PEEK_ATTR = "data-plan-peek";

/** The remark plugin form, for the plan compile pipeline. */
export const remarkHeadingAnchors = () => (tree: HeadingNode) => {
  assignHeadingAnchors(tree);
};
