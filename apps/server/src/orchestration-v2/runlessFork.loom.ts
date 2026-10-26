/**
 * loom: a V1-imported thread has no V2 run, only the provider thread bound to its pi session, so
 * `thread.fork.prepare` writes a run-less transfer and upstream's fork resolution finds the source
 * here. Pi forks the whole session file; the source is idle by construction.
 */
import type {
  OrchestrationV2ContextSourcePoint,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts";

/** The bound provider thread a run-less source forks from, if it has one. */
export const runlessForkSource = (source: {
  readonly runs: ReadonlyArray<unknown>;
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
}) =>
  source.runs.length === 0
    ? source.providerThreads.find((thread) => thread.nativeThreadRef?.strength === "strong")
    : undefined;

/** The source provider thread of a run-less fork transfer (undefined for a run-anchored one). */
export const runlessForkSourceProviderThread = (
  providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>,
  sourcePoint: OrchestrationV2ContextSourcePoint,
) =>
  sourcePoint.runId === undefined && sourcePoint.providerThreadRef !== undefined
    ? providerThreads.find(
        (thread) => thread.nativeThreadRef?.nativeId === sourcePoint.providerThreadRef!.nativeId,
      )
    : undefined;
