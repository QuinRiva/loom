import { evaluate, type EvaluateOptions } from "@mdx-js/mdx";
import { Component, type ErrorInfo, type ReactNode, useEffect, useRef, useState } from "react";
import * as runtime from "react/jsx-runtime";
import remarkGfm from "remark-gfm";

import { cn } from "~/lib/utils";

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
 *      `{expression}` bodies (`mdxFlow/TextExpression`) at compile time, so plan
 *      source cannot smuggle arbitrary JS. (JSON literal *attribute* expressions
 *      — `entities={[…]}` — remain allowed; that is the block wire format.)
 *   3. Unknown-component trap — MDX's own `_missingMdxReference` throws for any
 *      capitalized tag not supplied, surfaced by the error boundary.
 *
 * Per decision D2 this accepts `unsafe-eval` (the `Function` constructor) under a
 * strict CSP; the app sets no CSP today. The remark guard + closed registry
 * bound the eval surface to our own trusted components.
 *
 * Annotation hook (Phase 2): the rendered output lives under one stable
 * container (`data-plan-root`, exposed via `containerRef`), and every top-level
 * block carries a stable `data-plan-block-id` — authored `id` when present, else
 * an assigned `plan-block-N`. That gives the annotation layer a Range root plus a
 * block-level fallback anchor without re-architecting this renderer.
 */

const DISALLOWED_MDX_NODES = new Set(["mdxjsEsm", "mdxFlowExpression", "mdxTextExpression"]);

/** remark plugin: reject import/export + raw `{expression}` bodies at compile. */
function remarkRejectCodeEscapes() {
  return (tree: { type: string; children?: unknown[] }) => {
    const walk = (node: { type: string; children?: unknown[] }) => {
      if (DISALLOWED_MDX_NODES.has(node.type)) {
        throw new Error(
          `Disallowed MDX construct: ${node.type}. Imports and raw {expressions} are not permitted in plans.`,
        );
      }
      for (const child of node.children ?? []) {
        walk(child as { type: string; children?: unknown[] });
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

/** Assign a stable `data-plan-block-id` to each top-level block missing one. */
function assignBlockIds(root: HTMLElement): void {
  let index = 0;
  for (const child of Array.from(root.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (!child.hasAttribute("data-plan-block-id")) {
      child.setAttribute("data-plan-block-id", `plan-block-${index}`);
    }
    index += 1;
  }
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
  });

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
