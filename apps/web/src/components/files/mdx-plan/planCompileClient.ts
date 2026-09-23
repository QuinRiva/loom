import CompileWorker from "./compileWorker?worker";
import { compilePlanMdx, type PlanMdxComponent, runPlanModule } from "./mdxCompileOptions";
import type { CompileRequest, CompileResponse } from "./compileWorker";

/**
 * Client side of the plan compile worker, shared by the document renderer
 * ({@link ./MdxPlanRenderer}) and the question "peek", which compiles one
 * section's source slice the same way (see {@link ./blocks/questionRefs}).
 *
 * ONE worker for all plans: compile is stateless and request-multiplexed by id,
 * plans open one at a time, and a peek's slice is small. Lazily created on first
 * use and kept for the page's lifetime. Where `Worker` is unavailable (SSR,
 * jsdom tests) it degrades to the main-thread `compilePlanMdx` — same plugin
 * set, same guards.
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
export async function compileInWorker(source: string): Promise<PlanMdxComponent> {
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
