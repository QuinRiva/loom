/**
 * `loom.contextUsage`: a thread's pi session file, read on demand and attributed, with its findings.
 * A plain function, not a service: it holds no state, and it is the seam an MCP tool would call.
 */
import type { LoomContextReport, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { piSessionPathOf } from "../prompt/childPrompt.ts";
import { contextFindings } from "./findings.ts";
import { readPiSessionContext } from "./piSessionContext.ts";

export const reportFromSession = async (path: string): Promise<LoomContextReport | null> => {
  const session = await readPiSessionContext(path);
  if (session === null) return null;
  const { toolArgs, ...rest } = session;
  const findings = contextFindings(session.items, toolArgs);
  const wholeFile = new Set(
    findings.find((finding) => finding.rule === "whole_file_read")?.itemIds,
  );
  return {
    ...rest,
    items: rest.items.map((item) => (wholeFile.has(item.id) ? { ...item, wholeFile: true } : item)),
    findings,
  };
};

export const contextUsageReport = Effect.fn("ContextUsage.report")(function* (threadId: ThreadId) {
  yield* Effect.annotateCurrentSpan("threadId", threadId);
  const path = yield* piSessionPathOf(threadId);
  if (path === null) return null;
  return yield* Effect.tryPromise(() => reportFromSession(path));
});
