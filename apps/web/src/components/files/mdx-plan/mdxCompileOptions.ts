import { compile, evaluate, run, type CompileOptions, type EvaluateOptions } from "@mdx-js/mdx";
import * as runtime from "react/jsx-runtime";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";

import type { ReferenceLinkRule } from "@t3tools/client-runtime/reference-links";

import { remarkReferenceLinks } from "~/loom/remarkReferenceLinks";

import { type PlanSections, remarkHeadingAnchors } from "./headingAnchors";
import { remarkKicker } from "./kicker";
import { assertLiteralAttributeExpression, type MdxAttrExpression } from "./mdxAttrs";
import { ALLOWED_HTML_TAGS, PLAN_BLOCK_TAGS } from "./planBlockTags";

/**
 * The one MDX plan compile pipeline, shared by `evaluate` (linter, tests, SSR) and the
 * worker's `compile` so the security guards cannot drift. Replaces `rehype-sanitize`:
 * a closed component registry, a code-escape guard, and an unknown-tag fallback so
 * one bad tag renders an error card instead of killing the document.
 */

const DISALLOWED_MDX_NODES = new Set(["mdxjsEsm", "mdxFlowExpression", "mdxTextExpression"]);

type GuardNode = {
  type: string;
  name?: string | null;
  children?: unknown[];
  attributes?: Array<{ type?: string; name?: string; value?: unknown }>;
};

/**
 * Reject import/export, raw `{expression}` bodies and any non-literal attribute
 * expression. Attribute expressions compile to executable JS the body walk never
 * reaches, so without this any `.mdx` could run arbitrary browser JS.
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
 * Rewrite unregistered JSX tags and HTML tags outside `ALLOWED_HTML_TAGS` to the
 * `UnknownPlanBlock` card (tag kept, attrs and children dropped), and strip every
 * attribute from allowed HTML tags. Runs after the code-escape guard, so smuggled
 * attribute expressions are still rejected doc-wide.
 */
function remarkUnknownBlockFallback() {
  return (tree: GuardNode) => {
    const walk = (node: GuardNode) => {
      for (const child of node.children ?? []) {
        walk(child as GuardNode);
      }
      if (!MDX_JSX_NODE_TYPES.has(node.type) || !node.name) return;
      if (ALLOWED_HTML_TAGS.has(node.name)) {
        node.attributes = [];
      } else if (!PLAN_BLOCK_TAGS.has(node.name)) {
        node.attributes = [{ type: "mdxJsxAttribute", name: "tag", value: node.name }];
        node.name = "UnknownPlanBlock";
        node.children = [];
      }
    };
    walk(tree);
  };
}

/** The one guard plugin set every compile path applies. `remarkFrontmatter`
 * parses a leading YAML block (the `sign_document` authorship manifest) into an
 * inert `yaml` node that MDX never renders or exports, instead of letting it
 * render as a thematic break + body text above the H1. */
const PLAN_GUARD_PLUGINS = [
  remarkFrontmatter,
  remarkGfm,
  remarkRejectCodeEscapes,
  remarkUnknownBlockFallback,
];

/** Guards plus `remarkHeadingAnchors` (heading slugs and section bounds, shared so
 * worker, linter and render agree on what a question's `refs` name) and
 * `remarkKicker` (frontmatter `kicker:` above the title, whole documents only). */
const PLAN_REMARK_PLUGINS = [...PLAN_GUARD_PLUGINS, remarkHeadingAnchors, remarkKicker];

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
  referenceLinks?: ReadonlyArray<ReferenceLinkRule>,
): Promise<{ code: string; sections: PlanSections }> {
  // The project's `.t3code/links.json` rules linkify prose after the guards.
  const file = await compile(
    source,
    referenceLinks?.length
      ? {
          ...planCompileOptions,
          remarkPlugins: [
            ...PLAN_REMARK_PLUGINS,
            [remarkReferenceLinks, { rules: referenceLinks }],
          ],
        }
      : planCompileOptions,
  );
  return { code: String(file), sections: (file.data.planSections as PlanSections) ?? {} };
}

/** Compile ONE section slice to a function-body module string (the peek). */
export async function compilePlanSection(source: string): Promise<string> {
  return String(await compile(source, sectionCompileOptions));
}

/**
 * Instantiate a compiled function-body module into a component on the main thread.
 * The guards already ran during compile, and plans carry no imports, so no `baseUrl`.
 */
export async function runPlanModule(code: string): Promise<PlanMdxComponent> {
  const module = await run(code, runtime as Parameters<typeof run>[1]);
  return module.default as unknown as PlanMdxComponent;
}
