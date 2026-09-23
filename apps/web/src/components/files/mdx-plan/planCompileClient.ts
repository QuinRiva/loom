import CompileWorker from "./compileWorker?worker";
import type { PlanSections } from "./headingAnchors";
import {
  compilePlanDocument,
  compilePlanSection,
  type PlanMdxComponent,
  runPlanModule,
} from "./mdxCompileOptions";
import type { CompileRequest, CompileResponse } from "./compileWorker";

/**
 * Client side of the plan compile worker, shared by the document renderer
 * ({@link ./MdxPlanRenderer}) and the question "peek", which compiles one
 * section's source slice the same way (see {@link ./blocks/questionRefs}).
 *
 * ONE worker for all plans: compile is stateless and request-multiplexed by id,
 * plans open one at a time, and a peek's slice is small. Lazily created on first
 * use and kept for the page's lifetime. Where `Worker` is unavailable (SSR,
 * jsdom tests) it degrades to the same compile on this thread — same module,
 * same plugin set, same guards.
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
async function compile(
  source: string,
  section: boolean,
): Promise<{ code: string; sections: PlanSections }> {
  const worker = getCompileWorker();
  if (!worker) {
    return section
      ? { code: await compilePlanSection(source), sections: {} }
      : compilePlanDocument(source);
  }
  const id = ++requestCounter;
  return new Promise((resolve, reject) => {
    pending.set(id, (response) => {
      if (response.ok) resolve({ code: response.code, sections: response.sections });
      else reject(new Error(response.error));
    });
    const request: CompileRequest = { id, source, section };
    worker.postMessage(request);
  });
}

/** A whole plan document: its component plus the source bounds of each heading's
 * section, which a question "peek" slices with. */
export async function loadPlanDocument(
  source: string,
): Promise<{ Component: PlanMdxComponent; sections: PlanSections }> {
  const { code, sections } = await compile(source, false);
  return { Component: await runPlanModule(code), sections };
}

/** One section slice, for a peek. */
export async function loadPlanSection(slice: string): Promise<PlanMdxComponent> {
  return runPlanModule((await compile(slice, true)).code);
}
