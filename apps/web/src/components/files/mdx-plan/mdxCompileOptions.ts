import { compile, evaluate, run, type CompileOptions, type EvaluateOptions } from "@mdx-js/mdx";
import * as runtime from "react/jsx-runtime";
import remarkGfm from "remark-gfm";

import { type PlanSections, remarkHeadingAnchors } from "./headingAnchors";
import { assertLiteralAttributeExpression, type MdxAttrExpression } from "./mdxAttrs";
import { PLAN_BLOCK_TAGS } from "./planBlockTags";

/**
 * The single source of truth for the MDX plan compile pipeline: the remark
 * security guards + the option bags for both the main-thread/Node `evaluate`
 * path (linter, tests, SSR) and the Web Worker `compile` path (interactive
 * renderer). Both paths share ONE plugin set here so the security model cannot
 * drift between them — the worker applies the exact same guards during compile,
 * before any executable module exists.
 *
 * Security model (replaces `rehype-sanitize` for `.mdx`), 3 layers:
 *   1. Closed component registry — MDX resolves custom JSX names only from
 *      {@link PLAN_BLOCK_COMPONENTS}; nothing else is reachable.
 *   2. remark guard — rejects `import`/`export` (`mdxjsEsm`) and raw
 *      `{expression}` bodies (`mdxFlow/TextExpression`) at compile time, AND
 *      rejects any *attribute*-value expression that is not a static literal
 *      (`code={fetch(...)}`, sequence/IIFE tricks), so plan source cannot smuggle
 *      executable JS. JSON-literal attribute expressions — `entities={[…]}`,
 *      `data={{…}}`, `code={"…"}` — remain allowed; that is the block wire format.
 *   3. Unknown-component fallback — a remark pass rewrites any capitalized JSX
 *      tag not in the registry to the inline `UnknownPlanBlock` error card
 *      (attrs/children dropped), so one bad tag cannot reach MDX's
 *      `_missingMdxReference` throw and kill the whole document.
 */

const DISALLOWED_MDX_NODES = new Set(["mdxjsEsm", "mdxFlowExpression", "mdxTextExpression"]);

type GuardNode = {
  type: string;
  name?: string | null;
  children?: unknown[];
  attributes?: Array<{ type?: string; name?: string; value?: unknown }>;
};

/**
 * remark plugin: at compile time reject import/export + raw `{expression}`
 * bodies, and reject any attribute-value expression that is not a static literal.
 * The last part is load-bearing for the security model: `code={…}` attribute
 * expressions compile to executable JS and are NOT reached by the body-node walk,
 * so without this an author could run arbitrary browser JS via any `.mdx`.
 */
function remarkRejectCodeEscapes() {
  return (tree: GuardNode) => {
    const walk = (node: GuardNode) => {
      if (DISALLOWED_MDX_NODES.has(node.type)) {
        throw new Error(
          `Disallowed MDX construct: ${node.type}. Imports and raw {expressions} are not permitted in plans.`,
        );
      }
      for (const attr of node.attributes ?? []) {
        // A spread attribute ({...expr}) is an arbitrary expression too — without
        // this it compiles straight into the JSX call and executes at render.
        if (attr?.type === "mdxJsxExpressionAttribute") {
          throw new Error(
            "Disallowed MDX spread attribute: {...expression} is not permitted in plans.",
          );
        }
        if (attr?.type === "mdxJsxAttribute" && attr.value && typeof attr.value === "object") {
          assertLiteralAttributeExpression(attr.name ?? "?", attr.value as MdxAttrExpression);
        }
      }
      for (const child of node.children ?? []) {
        walk(child as GuardNode);
      }
    };
    walk(tree);
  };
}

const MDX_JSX_NODE_TYPES = new Set(["mdxJsxFlowElement", "mdxJsxTextElement"]);

/**
 * remark plugin: rewrite any capitalized JSX tag that is not in the closed
 * registry to the `UnknownPlanBlock` error card (original tag preserved as its
 * `tag` attr; other attrs and children dropped). Runs AFTER the code-escape
 * guard, so smuggled attribute expressions are still rejected doc-wide rather
 * than silently discarded here. Lowercase (HTML) tags are left to MDX.
 */
function remarkUnknownBlockFallback() {
  return (tree: GuardNode) => {
    const walk = (node: GuardNode) => {
      for (const child of node.children ?? []) {
        walk(child as GuardNode);
      }
      if (
        MDX_JSX_NODE_TYPES.has(node.type) &&
        node.name &&
        /^[A-Z]/.test(node.name) &&
        !PLAN_BLOCK_TAGS.has(node.name)
      ) {
        node.attributes = [{ type: "mdxJsxAttribute", name: "tag", value: node.name }];
        node.name = "UnknownPlanBlock";
        node.children = [];
      }
    };
    walk(tree);
  };
}

/** The one guard plugin set every compile path applies. */
const PLAN_GUARD_PLUGINS = [remarkGfm, remarkRejectCodeEscapes, remarkUnknownBlockFallback];

/** Guards + `remarkHeadingAnchors`, which is not a guard: it stamps heading slug
 * ids and publishes each section's source bounds. It lives here so the worker,
 * the linter and the main-thread render agree both on the anchors a question's
 * `refs` may name and on what "that section" is. */
const PLAN_REMARK_PLUGINS = [...PLAN_GUARD_PLUGINS, remarkHeadingAnchors];

export type PlanMdxComponent = React.ComponentType<{ components?: Record<string, unknown> }>;

/**
 * Options for the main-thread/Node `evaluate` path (compile + run in one call).
 * Used by {@link compilePlanMdx} for the linter, tests, and SSR.
 */
const evaluateOptions = {
  ...runtime,
  remarkPlugins: PLAN_REMARK_PLUGINS,
  development: false,
} as unknown as EvaluateOptions;

/**
 * Options for the Web Worker `compile` path: emit a portable function-body
 * module the main thread instantiates with `run(...)`. The remark guards run
 * here, in the worker, before any executable module exists.
 */
const planCompileOptions = {
  remarkPlugins: PLAN_REMARK_PLUGINS,
  outputFormat: "function-body",
  development: false,
} as unknown as CompileOptions;

/** As above for ONE section slice (the peek): guards only, no heading ids — the
 * slice's headings are already in the document and must not be stamped twice. */
const sectionCompileOptions = {
  remarkPlugins: PLAN_GUARD_PLUGINS,
  outputFormat: "function-body",
  development: false,
} as unknown as CompileOptions;

/**
 * Compile + evaluate MDX plan source to a renderable component on the current
 * thread, applying the remark guard. Rejects (throws) on disallowed constructs
 * or compile errors. Used by the linter/tests/SSR; the interactive renderer
 * uses the worker `compile` + main-thread `run` split instead (same guards).
 */
export async function compilePlanMdx(source: string): Promise<PlanMdxComponent> {
  const module = await evaluate(source, evaluateOptions);
  return module.default as unknown as PlanMdxComponent;
}

/**
 * Compile a whole plan document to a function-body module string, plus the
 * source bounds of every heading's section — a by-product of the same parse,
 * which is what lets a question "peek" slice a section without re-parsing the
 * document or inventing a second notion of where a section ends.
 */
export async function compilePlanDocument(
  source: string,
): Promise<{ code: string; sections: PlanSections }> {
  const file = await compile(source, planCompileOptions);
  return { code: String(file), sections: (file.data.planSections as PlanSections) ?? {} };
}

/** Compile ONE section slice to a function-body module string (the peek). */
export async function compilePlanSection(source: string): Promise<string> {
  return String(await compile(source, sectionCompileOptions));
}

/**
 * Instantiate a function-body module string (produced by
 * {@link compilePlanDocument}) into a renderable component on the main
 * thread. Cheap relative to compile — the guards already ran during compile, so
 * nothing outside the closed registry is reachable here. Plans carry no imports
 * (the guard rejects them), so no `baseUrl` is needed.
 */
export async function runPlanModule(code: string): Promise<PlanMdxComponent> {
  const module = await run(code, runtime as Parameters<typeof run>[1]);
  return module.default as unknown as PlanMdxComponent;
}
