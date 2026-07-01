import type { FC } from "react";

import type { MdxAttrValue, PlanBlock } from "./blockTypes";
import { createAttrReader, parseFirstJsxBlock, serializeBlockElement } from "./mdxAttrs";
import { codeBlock } from "./blocks/code";
import { dataModelBlock } from "./blocks/dataModel";

/**
 * The closed plan-block registry: tag → block. This is the one place that lists
 * the blocks the MDX renderer will resolve — nothing outside it is reachable
 * from plan source (the security model's "closed component registry" layer).
 * Adding a block = one entry here.
 */

// Heterogeneous data types across blocks; the registry erases the type param and
// each block's own zod schema re-narrows at render time.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPlanBlock = PlanBlock<any>;

interface RegisteredBlock {
  tag: string;
  type: string;
  block: AnyPlanBlock;
}

export const PLAN_BLOCKS: RegisteredBlock[] = [
  { tag: codeBlock.mdx.tag, type: "code", block: codeBlock },
  { tag: dataModelBlock.mdx.tag, type: "data-model", block: dataModelBlock },
];

export const planBlockByTag = new Map(PLAN_BLOCKS.map((entry) => [entry.tag, entry]));

function PlanBlockError({ tag, message }: { tag: string; message: string }) {
  return (
    <div className="my-4 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
      <div className="font-medium">Invalid &lt;{tag}&gt; block</div>
      <div className="mt-1 whitespace-pre-wrap font-mono opacity-80">{message}</div>
    </div>
  );
}

/**
 * Wrap a block into the React component MDX resolves for its tag: MDX evaluates
 * the element's attributes to props, we validate them with the block's zod
 * schema, then hand clean `data` to its `Read` renderer. Unknown props (`id`,
 * `title`, …) are stripped by the schema. `id` becomes the block's stable
 * `data-plan-block-id` (the renderer fills a fallback id when absent).
 */
function makeBlockComponent(entry: RegisteredBlock): FC<Record<string, unknown>> {
  const { block } = entry;
  const Read = block.Read;
  return function PlanBlockComponent(props) {
    const blockId = typeof props.id === "string" && props.id.length > 0 ? props.id : "";
    const result = block.schema.safeParse(props);
    if (!result.success) {
      return <PlanBlockError tag={entry.tag} message={result.error.message} />;
    }
    return <Read data={result.data} blockId={blockId} />;
  };
}

/** MDX component map — the exact set of custom tags the renderer will resolve. */
export const PLAN_BLOCK_COMPONENTS: Record<
  string,
  FC<Record<string, unknown>>
> = Object.fromEntries(PLAN_BLOCKS.map((entry) => [entry.tag, makeBlockComponent(entry)]));

/* -------------------------------------------------------------------------- */
/* Byte-stable MDX round-trip (authoring / import contract)                   */
/* -------------------------------------------------------------------------- */

/** Serialize block `data` → a self-closing MDX element string. */
export function serializePlanBlock(entry: RegisteredBlock, data: unknown): string {
  const attrs = entry.block.mdx.toAttrs(data);
  const childrenField = entry.block.mdx.childrenField;
  const filtered = Object.fromEntries(
    Object.entries(attrs).filter(([key]) => key !== childrenField),
  ) as Record<string, MdxAttrValue | undefined>;
  return serializeBlockElement(entry.tag, filtered);
}

/** Parse an MDX block element string → block `data` (via the block's fromAttrs). */
export function parsePlanBlock(entry: RegisteredBlock, source: string): unknown {
  const node = parseFirstJsxBlock(source);
  if (!node) throw new Error(`No <${entry.tag}> element found in source`);
  return entry.block.mdx.fromAttrs(createAttrReader(node), "");
}
