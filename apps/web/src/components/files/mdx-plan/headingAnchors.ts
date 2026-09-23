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
 * Marks a container holding a question "peek" — a second, live render of a
 * section that is also in the document. It is a reading aid, not document
 * content: `assignBlockIds` skips it so it never consumes block ids, and the
 * annotation layer's `flattenDocument` rejects the subtree so a peek can never
 * shift or duplicate a comment anchor.
 */
export const PLAN_PEEK_ATTR = "data-plan-peek";

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*$/;

/**
 * The SOURCE of one section — everything after the heading whose slug is
 * `anchor`, up to the next heading of the same or higher level — so the peek can
 * compile and render that slice for real instead of cloning rendered DOM.
 * Returns `null` when no heading carries the slug.
 *
 * A line scan (fence-aware) rather than a second mdast parse: the slugs come
 * from {@link slugifyHeading} in the same document order the compile pipeline
 * walks headings in, so the two agree on every anchor an author can lint, and
 * peeking costs no extra parse of the whole document. The slice is plain plan
 * source, so a section holding JSX blocks must be top-level for its JSX to be
 * balanced — a heading nested inside `<Columns>`/`<Tabs>` is not peekable.
 */
export function sectionSource(source: string, anchor: string): string | null {
  const lines = source.split("\n");
  const seen = new Map<string, number>();
  let fence: string | null = null;
  let start = -1;
  let level = 0;
  for (const [index, line] of lines.entries()) {
    const marker = FENCE.exec(line)?.[1]?.[0];
    if (marker) {
      fence = fence === null ? marker : fence === marker ? null : fence;
      continue;
    }
    if (fence !== null) continue;
    const heading = ATX_HEADING.exec(line);
    if (!heading) continue;
    const [, hashes = "", text = ""] = heading;
    const depth = hashes.length;
    if (start >= 0) {
      if (depth <= level) return lines.slice(start, index).join("\n").trim();
      continue;
    }
    const base = slugifyHeading(text);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    if ((count === 1 ? base : `${base}-${count}`) === anchor) {
      start = index + 1;
      level = depth;
    }
  }
  return start >= 0 ? lines.slice(start).join("\n").trim() : null;
}

/** The remark plugin form, for the plan compile pipeline. */
export const remarkHeadingAnchors = () => (tree: HeadingNode) => {
  assignHeadingAnchors(tree);
};
