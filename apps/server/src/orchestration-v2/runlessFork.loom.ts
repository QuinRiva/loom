/**
 * loom: forking a thread imported from V1. Such a thread has no V2 run, only the
 * provider thread the importer bound to its pi session (`LoomV1WorkstreamImporter`),
 * so `thread.fork.prepare` writes a fork transfer with no `runId` whose source is
 * that binding, and upstream's fork resolution finds the source provider thread
 * here instead of through a run. Pi then forks the whole session file, which is
 * the whole conversation: the source is idle by construction (it has no run).
 *
 * @module orchestration-v2/runlessFork.loom
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
