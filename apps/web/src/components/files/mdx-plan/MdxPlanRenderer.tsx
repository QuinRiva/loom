import { evaluate, type EvaluateOptions } from "@mdx-js/mdx";
import { Component, type ErrorInfo, type ReactNode, useEffect, useRef, useState } from "react";
import * as runtime from "react/jsx-runtime";
import remarkGfm from "remark-gfm";

import { cn } from "~/lib/utils";

import { assertLiteralAttributeExpression, type MdxAttrExpression } from "./mdxAttrs";
import { PLAN_BLOCK_COMPONENTS } from "./registry";

/**
 * Secure runtime MDX renderer for `.mdx` plan files. Compiles + evaluates MDX in
 * the browser (`@mdx-js/mdx` `evaluate`) and renders only through the closed
 * plan-block registry. This is a NEW render path for `.mdx`; the `.md`
 * react-markdown path (`ChatMarkdown`) is untouched.
 *
 * Security model (replaces `rehype-sanitize` for this path), 3 layers:
 *   1. Closed component registry — MDX resolves custom JSX names only from
 *      {@link PLAN_BLOCK_COMPONENTS}; nothing else is reachable.
 *   2. remark guard — rejects `import`/`export` (`mdxjsEsm`) and raw
 *      `{expression}` bodies (`mdxFlow/TextExpression`) at compile time, AND
 *      rejects any *attribute*-value expression that is not a static literal
 *      (`code={fetch(...)}`, sequence/IIFE tricks), so plan source cannot smuggle
 *      executable JS. JSON-literal attribute expressions — `entities={[…]}`,
 *      `data={{…}}`, `code={"…"}` — remain allowed; that is the block wire format.
 *   3. Unknown-component trap — MDX's own `_missingMdxReference` throws for any
 *      capitalized tag not supplied, surfaced by the error boundary.
 *
 * Per decision D2 this accepts `unsafe-eval` (the `Function` constructor) under a
 * strict CSP; the app sets no CSP today. The remark guard + closed registry
 * bound the eval surface to our own trusted components.
 *
 * Annotation hook (Phase 2): the rendered output lives under one stable
 * container (`data-plan-root`, exposed via `containerRef`), and every block —
 * top-level or nested inside a container block (`Columns`/`Tabs`) — carries a
 * stable `data-plan-block-id` (authored `id` when present, else an assigned
 * unique `plan-block-N`; see {@link assignBlockIds}). That gives the annotation
 * layer a Range root plus a block-level fallback anchor at any nesting depth
 * without re-architecting this renderer.
 */

const DISALLOWED_MDX_NODES = new Set(["mdxjsEsm", "mdxFlowExpression", "mdxTextExpression"]);

type GuardNode = {
  type: string;
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

type PlanMdxComponent = React.ComponentType<{ components?: Record<string, unknown> }>;

const evaluateOptions = {
  ...runtime,
  remarkPlugins: [remarkGfm, remarkRejectCodeEscapes],
  development: false,
} as unknown as EvaluateOptions;

/**
 * Compile + evaluate MDX plan source to a renderable component, applying the
 * remark guard. Rejects (throws) on disallowed constructs or compile errors.
 * Exported for verification; the component below uses it internally.
 */
export async function compilePlanMdx(source: string): Promise<PlanMdxComponent> {
  const module = await evaluate(source, evaluateOptions);
  return module.default as unknown as PlanMdxComponent;
}

/**
 * Catches render-time failures (e.g. MDX's `_missingMdxReference` for an unknown
 * tag, or a block throwing). The parent remounts this boundary via `key={source}`
 * so a corrected plan renders fresh — no `componentDidUpdate` reset needed.
 */
class PlanRenderErrorBoundary extends Component<
  { children: ReactNode; onError: (error: Error) => void },
  { errored: boolean }
> {
  override state = { errored: false };
  static getDerivedStateFromError() {
    return { errored: true };
  }
  override componentDidCatch(error: Error, _info: ErrorInfo) {
    this.props.onError(error);
  }
  override render() {
    return this.state.errored ? null : this.props.children;
  }
}

/** Assign a stable, unique `data-plan-block-id` to every block lacking one — both
 * top-level children (headings, prose, blocks) AND blocks nested inside container
 * blocks (`Columns`/`Tabs`, Wave B6). Authored ids are left untouched; the rest
 * draw from a single document-wide counter so ids never collide across nesting
 * depth. The walk is deterministic (same DOM → same ids), so anchors persist
 * across re-renders. Nested non-block wrappers are skipped — only elements with a
 * `data-plan-block-type` are stamped below the top level. Exported for verification. */
export function assignBlockIds(root: HTMLElement): void {
  let counter = 0;
  const stamp = (el: HTMLElement) => {
    if (!el.hasAttribute("data-plan-block-id")) {
      el.setAttribute("data-plan-block-id", `plan-block-${counter}`);
    }
    counter += 1;
  };
  const descend = (parent: HTMLElement, topLevel: boolean) => {
    for (const child of Array.from(parent.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (topLevel || child.hasAttribute("data-plan-block-type")) stamp(child);
      descend(child, false);
    }
  };
  descend(root, true);
}

interface MdxPlanRendererProps {
  source: string;
  className?: string;
}

function PlanErrorNotice({ message }: { message: string }) {
  return (
    <div className="mx-auto max-w-4xl px-6 py-5">
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        <div className="font-medium">This plan could not be rendered.</div>
        <div className="mt-1 whitespace-pre-wrap font-mono text-xs opacity-80">{message}</div>
      </div>
    </div>
  );
}

export function MdxPlanRenderer({ source, className }: MdxPlanRendererProps) {
  const [content, setContent] = useState<{ Component: PlanMdxComponent } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    void compilePlanMdx(source)
      .then((Component) => {
        if (active) setContent({ Component });
      })
      .catch((cause: unknown) => {
        if (active) {
          setContent(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => {
      active = false;
    };
  }, [source]);

  useEffect(() => {
    if (containerRef.current) assignBlockIds(containerRef.current);
  }, [content]);

  if (error !== null) {
    return <PlanErrorNotice message={error} />;
  }
  if (content === null) {
    return null;
  }

  const { Component: MdxContent } = content;
  return (
    <div
      ref={containerRef}
      data-plan-root
      className={cn("plan-mdx mx-auto max-w-4xl px-6 py-5", className)}
    >
      <PlanRenderErrorBoundary key={source} onError={(cause) => setError(cause.message)}>
        <MdxContent components={PLAN_BLOCK_COMPONENTS} />
      </PlanRenderErrorBoundary>
    </div>
  );
}
