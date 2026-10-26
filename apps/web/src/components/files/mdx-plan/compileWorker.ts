/// <reference lib="webworker" />
import type { ReferenceLinkRule } from "@t3tools/client-runtime/reference-links";

import type { PlanSections } from "./headingAnchors";
import { compilePlanDocument, compilePlanSection } from "./mdxCompileOptions";

/**
 * Compiles `.mdx` plan source off the main thread (seconds at multi-MB). The shared
 * guards run during this compile, so the worker emits an inert function-body string
 * and nothing executes until the main thread's `run(...)`.
 */

export interface CompileRequest {
  id: number;
  source: string;
  /** One section slice for a question "peek" rather than a whole document:
   * heading ids are not stamped and no section bounds come back. */
  section?: boolean;
  /** The project's reference-link rules (`.t3code/links.json`). */
  referenceLinks?: ReadonlyArray<ReferenceLinkRule> | undefined;
}

export type CompileResponse =
  | { id: number; ok: true; code: string; sections: PlanSections }
  | { id: number; ok: false; error: string };

self.addEventListener("message", (event: MessageEvent<CompileRequest>) => {
  const { id, source, section, referenceLinks } = event.data;
  const compiled = section
    ? compilePlanSection(source).then((code) => ({ code, sections: {} }))
    : compilePlanDocument(source, referenceLinks);
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
