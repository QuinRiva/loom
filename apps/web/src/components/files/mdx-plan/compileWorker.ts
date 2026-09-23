/// <reference lib="webworker" />
import type { PlanSections } from "./headingAnchors";
import { compilePlanDocument, compilePlanSection } from "./mdxCompileOptions";

/**
 * Web Worker that compiles `.mdx` plan source off the main thread. Only the
 * parse/transform/compile step (the CPU-heavy work — seconds at multi-MB) runs
 * here; the main thread instantiates the returned function-body module with
 * `run(...)` (cheap). This keeps the tab interactive while a large decision
 * document compiles.
 *
 * The security guards live in the shared `mdxCompileOptions` module and run
 * DURING this compile — an `import`/`export`, a raw `{expression}`, a non-literal
 * attribute expression, or an unknown tag is rejected/rewritten here, before any
 * executable module is produced. The worker emits an inert string; nothing runs
 * until the main thread's guarded `run(...)`.
 */

export interface CompileRequest {
  id: number;
  source: string;
  /** One section slice for a question "peek" rather than a whole document:
   * heading ids are not stamped and no section bounds come back. */
  section?: boolean;
}

export type CompileResponse =
  | { id: number; ok: true; code: string; sections: PlanSections }
  | { id: number; ok: false; error: string };

self.addEventListener("message", (event: MessageEvent<CompileRequest>) => {
  const { id, source, section } = event.data;
  const compiled = section
    ? compilePlanSection(source).then((code) => ({ code, sections: {} }))
    : compilePlanDocument(source);
  void compiled.then(
    ({ code, sections }) => {
      const response: CompileResponse = { id, ok: true, code, sections };
      self.postMessage(response);
    },
    (cause: unknown) => {
      const response: CompileResponse = {
        id,
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      };
      self.postMessage(response);
    },
  );
});
