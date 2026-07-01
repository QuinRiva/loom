import type { FC, ReactNode } from "react";
import type { ZodType } from "zod";

/**
 * Slim block-registration contract for first-party MDX plan rendering.
 *
 * This is a deliberately trimmed subset of BuilderIO's `BlockSpec`
 * (`@agent-native/core` `client/blocks/types.ts`): we keep only what a
 * read-only renderer + a byte-stable MDX round-trip need — `schema`, `mdx`,
 * `Read` — and drop the editor/container/placement/icon machinery, which is
 * built for their in-app block editor and does not transfer to a read surface.
 * The `tag` names + `mdx` round-trip are the stable wire contract (never rename
 * a tag); everything else here is ours to shape. See `docs/mdx-spike-findings.md`
 * §3.2.
 */

/**
 * A serialized MDX attribute value before the shared `prop()` encoder runs.
 * `prop()` decides string-vs-JSON encoding; this is just the value domain.
 */
export type MdxAttrValue = string | number | boolean | unknown[] | Record<string, unknown>;

/**
 * Type-narrowed reader over the resolved MDX attributes of a parsed block node.
 * Values are already estree/JSON-resolved by {@link createAttrReader}, so a
 * spec's `fromAttrs` never touches the AST.
 */
export interface BlockAttrReader {
  string(name: string): string | undefined;
  number(name: string): number | undefined;
  bool(name: string): boolean | undefined;
  array<T = unknown>(name: string): T[] | undefined;
  object<T = unknown>(name: string): T | undefined;
  raw(name: string): unknown;
}

/**
 * Maps a block's validated data to/from its MDX component representation. `tag`
 * is the JSX component name in source (e.g. "DataModel"). It MUST match the
 * BuilderIO tag + attribute shape so authored `.mdx` plans round-trip.
 */
export interface BlockMdxConfig<TData> {
  /** JSX component name in MDX source. Stable wire contract — never rename. */
  tag: string;
  /**
   * Encode `data` → a flat attribute bag, in stable insertion order. Return
   * `undefined` for a key (or omit it) to drop the attribute.
   */
  toAttrs: (data: TData) => Record<string, MdxAttrValue | undefined>;
  /**
   * Decode resolved attributes (+ optional children markdown) → data. Must
   * tolerate missing/partial attributes (mirror `?? []` / `?? ""` defaults).
   */
  fromAttrs: (attrs: BlockAttrReader, children: string) => TData;
  /** When set, this field is serialized as MDX prose *children*, not a prop. */
  childrenField?: keyof TData & string;
}

/** Props passed to a block's read-only renderer. */
export interface PlanBlockReadProps<TData> {
  data: TData;
  /** Stable per-top-level-block id, mirrored to `data-plan-block-id`. `undefined`
   * when the author omitted `id`, so the block emits no attribute and the
   * renderer's `assignBlockIds` fallback can fill a unique `plan-block-N`. */
  blockId: string | undefined;
  /**
   * MDX prose rendered between the block's tags, already resolved to React
   * nodes. Populated for blocks whose `mdx.childrenField` names a prose body
   * (e.g. `<Endpoint>`'s description); `undefined` for self-closing blocks.
   */
  children?: ReactNode;
}

/** One registered plan block: data schema + MDX round-trip + read renderer. */
export interface PlanBlock<TData> {
  /** Zod schema validating decoded block `data` before render. */
  schema: ZodType<TData>;
  /** MDX round-trip config (tag + toAttrs/fromAttrs). */
  mdx: BlockMdxConfig<TData>;
  /** Read-only renderer. */
  Read: FC<PlanBlockReadProps<TData>>;
}

/** Identity helper for authoring a block with full type inference. */
export function definePlanBlock<TData>(block: PlanBlock<TData>): PlanBlock<TData> {
  return block;
}
