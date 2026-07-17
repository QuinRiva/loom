import { Component, type ErrorInfo, type ReactNode, useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";

import { cn } from "~/lib/utils";

import CompileWorker from "./compileWorker?worker";
import { compilePlanMdx, type PlanMdxComponent, runPlanModule } from "./mdxCompileOptions";
import type { CompileRequest, CompileResponse } from "./compileWorker";
import { PLAN_BLOCK_COMPONENTS } from "./registry";

/**
 * Secure runtime MDX renderer for `.mdx` plan files. Compiles MDX OFF the main
 * thread (a dedicated Web Worker) and instantiates + renders the result on the
 * main thread through the closed plan-block registry. This is a NEW render path
 * for `.mdx`; the `.md` react-markdown path (`ChatMarkdown`) is untouched.
 *
 * The security model + remark guards live in {@link ./mdxCompileOptions}; the
 * worker applies the exact same guard set during compile (before any executable
 * module exists), and the linter/tests reuse the same module — so the two paths
 * cannot drift. Per decision D2 the render accepts `unsafe-eval` (`run(...)` uses
 * the `Function` constructor) under a strict CSP; the app sets no CSP today. The
 * guard + closed registry bound the eval surface to our own trusted components.
 *
 * Off-thread compile keeps the tab interactive while an evidence-heavy decision
 * document (multi-MB) compiles — the parse/transform dominates the cost, and it
 * no longer blocks the main thread. A lightweight "compiling…" placeholder shows
 * until the module is ready.
 *
 * Annotation hook (Phase 2): the rendered output lives under one stable
 * container (`data-plan-root`, exposed via `containerRef`), and every block —
 * top-level or nested inside a container block (`Columns`/`Tabs`) — carries a
 * stable `data-plan-block-id` (authored `id` when present, else an assigned
 * unique `plan-block-N`; see {@link assignBlockIds}). That gives the annotation
 * layer a Range root plus a block-level fallback anchor at any nesting depth
 * without re-architecting this renderer.
 */

export { compilePlanMdx } from "./mdxCompileOptions";

/**
 * One shared compile worker for all rendered plans (compile is stateless and
 * request-multiplexed by id). Lazily created on first use and kept for the
 * page's lifetime — plans open one at a time, so a pool is unwarranted. Falls
 * back to `null` in environments without Worker support (SSR/tests), where
 * {@link compileInWorker} degrades to the main-thread `compilePlanMdx`.
 */
let sharedWorker: Worker | null = null;
let workerUnavailable = false;
const pending = new Map<number, (response: CompileResponse) => void>();
let requestCounter = 0;

function getCompileWorker(): Worker | null {
  if (workerUnavailable) return null;
  if (sharedWorker) return sharedWorker;
  try {
    const worker = new CompileWorker();
    worker.addEventListener("message", (event: MessageEvent<CompileResponse>) => {
      const resolve = pending.get(event.data.id);
      if (resolve) {
        pending.delete(event.data.id);
        resolve(event.data);
      }
    });
    sharedWorker = worker;
    return worker;
  } catch {
    // No Worker support (SSR / some test envs) — caller falls back on-thread.
    workerUnavailable = true;
    return null;
  }
}

/** Compile off the main thread when a worker is available, else on-thread. */
async function compileInWorker(source: string): Promise<PlanMdxComponent> {
  const worker = getCompileWorker();
  if (!worker) return compilePlanMdx(source);
  const id = ++requestCounter;
  const code = await new Promise<string>((resolve, reject) => {
    pending.set(id, (response) => {
      if (response.ok) resolve(response.code);
      else reject(new Error(response.error));
    });
    const request: CompileRequest = { id, source };
    worker.postMessage(request);
  });
  return runPlanModule(code);
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

function PlanCompilingNotice() {
  return (
    <div
      className="mx-auto flex max-w-4xl items-center gap-2 px-6 py-5 text-sm text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <LoaderCircle className="size-4 animate-spin" />
      Compiling plan…
    </div>
  );
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
  const [compiling, setCompiling] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    setError(null);
    setCompiling(true);
    void compileInWorker(source)
      .then((Component) => {
        if (active) {
          setContent({ Component });
          setCompiling(false);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setContent(null);
          setCompiling(false);
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
    return compiling ? <PlanCompilingNotice /> : null;
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
