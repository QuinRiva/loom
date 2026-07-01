import type { FC, ReactNode } from "react";

import type { MdxAttrValue, PlanBlock } from "./blockTypes";
import { createAttrReader, parseFirstJsxBlock, serializeBlockElement } from "./mdxAttrs";
import { annotatedCodeBlock } from "./blocks/annotatedCode";
import { calloutBlock } from "./blocks/callout";
import {
  annotationBlock,
  artboardBlock,
  connectorBlock,
  designBoardBlock,
  sectionBlock,
} from "./blocks/canvas";
import { checklistBlock } from "./blocks/checklist";
import { codeBlock } from "./blocks/code";
import { columnBlock, columnsBlock } from "./blocks/columns";
import { dataModelBlock } from "./blocks/dataModel";
import { diagramBlock } from "./blocks/diagram";
import { diffBlock } from "./blocks/diff";
import { endpointBlock } from "./blocks/endpoint";
import { fileTreeBlock } from "./blocks/fileTree";
import { jsonBlock } from "./blocks/json";
import { mermaidBlock } from "./blocks/mermaid";
import { openApiBlock } from "./blocks/openApi";
import { questionFormBlock } from "./blocks/questionForm";
import { htmlBlock, prototypeBlock } from "./blocks/sandboxedFrame";
import { designBlock, screenBlock } from "./blocks/screen";
import { tableBlock } from "./blocks/table";
import { tabBlock, tabsBlock } from "./blocks/tabs";
import { visualQuestionsBlock } from "./blocks/visualQuestions";

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
  { tag: endpointBlock.mdx.tag, type: "api-endpoint", block: endpointBlock },
  { tag: fileTreeBlock.mdx.tag, type: "file-tree", block: fileTreeBlock },
  { tag: annotatedCodeBlock.mdx.tag, type: "annotated-code", block: annotatedCodeBlock },
  { tag: diagramBlock.mdx.tag, type: "diagram", block: diagramBlock },
  { tag: questionFormBlock.mdx.tag, type: "question-form", block: questionFormBlock },
  { tag: jsonBlock.mdx.tag, type: "json-explorer", block: jsonBlock },
  { tag: calloutBlock.mdx.tag, type: "callout", block: calloutBlock },
  { tag: checklistBlock.mdx.tag, type: "checklist", block: checklistBlock },
  { tag: tableBlock.mdx.tag, type: "table", block: tableBlock },
  { tag: visualQuestionsBlock.mdx.tag, type: "visual-questions", block: visualQuestionsBlock },
  { tag: diffBlock.mdx.tag, type: "diff", block: diffBlock },
  { tag: openApiBlock.mdx.tag, type: "openapi-spec", block: openApiBlock },
  { tag: mermaidBlock.mdx.tag, type: "mermaid", block: mermaidBlock },
  { tag: screenBlock.mdx.tag, type: "wireframe", block: screenBlock },
  { tag: designBlock.mdx.tag, type: "design", block: designBlock },
  { tag: designBoardBlock.mdx.tag, type: "canvas", block: designBoardBlock },
  { tag: sectionBlock.mdx.tag, type: "canvas-section", block: sectionBlock },
  { tag: artboardBlock.mdx.tag, type: "wireframe", block: artboardBlock },
  { tag: annotationBlock.mdx.tag, type: "annotation", block: annotationBlock },
  { tag: connectorBlock.mdx.tag, type: "canvas-connector", block: connectorBlock },
  { tag: columnsBlock.mdx.tag, type: "columns", block: columnsBlock },
  { tag: columnBlock.mdx.tag, type: "column", block: columnBlock },
  { tag: tabsBlock.mdx.tag, type: "tabs", block: tabsBlock },
  { tag: tabBlock.mdx.tag, type: "tab", block: tabBlock },
  { tag: prototypeBlock.mdx.tag, type: "prototype", block: prototypeBlock },
  { tag: htmlBlock.mdx.tag, type: "html", block: htmlBlock },
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
 * `title`, `children`, …) are stripped by the schema. `id` becomes the block's
 * stable `data-plan-block-id`; when absent we pass `undefined` so the block emits
 * NO attribute and the renderer's `assignBlockIds` fallback fills a unique
 * `plan-block-N` (emitting `data-plan-block-id=""` would collide every un-id'd
 * block onto the first `[…=""]` match).
 * A block with a `childrenField` (e.g. `<Endpoint>`'s description) also receives
 * the MDX prose between its tags as `children`, already resolved to React nodes.
 */
function makeBlockComponent(entry: RegisteredBlock): FC<Record<string, unknown>> {
  const { block } = entry;
  const Read = block.Read;
  const passesChildren = Boolean(block.mdx.childrenField) || Boolean(block.mdx.passChildren);
  return function PlanBlockComponent(props) {
    const blockId = typeof props.id === "string" && props.id.length > 0 ? props.id : undefined;
    const result = block.schema.safeParse(props);
    if (!result.success) {
      return <PlanBlockError tag={entry.tag} message={result.error.message} />;
    }
    return (
      <Read data={result.data} blockId={blockId}>
        {passesChildren ? (props.children as ReactNode) : undefined}
      </Read>
    );
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
