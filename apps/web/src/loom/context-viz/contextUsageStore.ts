/**
 * loom: the context-viz client data path (plans/context-viz-experiment §3.3): one `loom.contextUsage`
 * read per thread open and per finished turn, the last eight threads' reports kept. Each consumer
 * mounts `useContextUsageLoader` (two mounts cost one request) and reads with `useContextUsage`.
 */
import type { EnvironmentThreadStructure } from "@t3tools/client-runtime/state/models";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { LoomContextReport, ScopedThreadRef } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect } from "react";
import { create } from "zustand";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { useQuietThreadProjection } from "../../state/entities";
import { loomCommands } from "../loomGoalState";

/**
 * `none`: the server found no session file (not pi, or never run); `failed`: the request failed.
 * A refresh keeps the previous report while `loading`.
 */
export interface ContextUsageEntry {
  readonly status: "loading" | "ready" | "none" | "failed";
  readonly report: LoomContextReport | null;
  readonly refreshKey: string;
}

/** What the Context tab hands each sub-view; P4 and P5 read nothing else from the panel. */
export interface ContextViewProps {
  readonly report: LoomContextReport;
  readonly threadRef: ScopedThreadRef;
  /** The model's window (`contextUsage.maxTokens` of the active provider thread), when known. */
  readonly contextWindow: number | null;
}

const KEPT_THREADS = 8;
const TERMINAL_TURN = new Set(["completed", "failed", "cancelled", "interrupted"]);

const useContextUsageStore = create<{ byThreadKey: Record<string, ContextUsageEntry> }>()(() => ({
  byThreadKey: {},
}));

const inFlight = new Map<string, string>();

function write(key: string, entry: ContextUsageEntry) {
  useContextUsageStore.setState(({ byThreadKey: { [key]: _previous, ...rest } }) => ({
    byThreadKey: Object.fromEntries(
      [...Object.entries(rest), [key, entry] as const].slice(-KEPT_THREADS),
    ),
  }));
}

/** The active provider thread is pi's, so a session jsonl exists to read. */
export function isPiThread(thread: EnvironmentThreadStructure | null): boolean {
  const projection = thread?.projection;
  return (
    projection?.providerThreads.find(
      (providerThread) => providerThread.id === projection.thread.activeProviderThreadId,
    )?.driver === "pi"
  );
}

/** Changes when a provider turn reaches a terminal status, never while one streams. */
function contextRefreshKey(thread: EnvironmentThreadStructure): string {
  const ended = thread.projection.providerTurns.flatMap((turn) =>
    TERMINAL_TURN.has(turn.status) && turn.completedAt !== null
      ? [DateTime.toEpochMillis(turn.completedAt)]
      : [],
  );
  return `${ended.length}:${Math.max(0, ...ended)}`;
}

/** Fetch the report for `refreshKey` unless it is answered or already on its way. */
async function loadContextUsage(
  threadRef: ScopedThreadRef,
  refreshKey: string,
  force = false,
): Promise<void> {
  const key = scopedThreadKey(threadRef);
  const current = useContextUsageStore.getState().byThreadKey[key];
  if (inFlight.get(key) === refreshKey) return;
  if (!force && current?.refreshKey === refreshKey && current.status !== "failed") return;
  inFlight.set(key, refreshKey);
  write(key, { status: "loading", report: current?.report ?? null, refreshKey });
  const result = await executeAtomQuery(
    appAtomRegistry,
    loomCommands.contextUsage({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    }),
    { refresh: true, reportDefect: false, reportFailure: false },
  );
  if (inFlight.get(key) !== refreshKey) return;
  inFlight.delete(key);
  write(
    key,
    result._tag !== "Success"
      ? { status: "failed", report: current?.report ?? null, refreshKey }
      : { status: result.value.report ? "ready" : "none", report: result.value.report, refreshKey },
  );
}

/** The Refresh button: re-read the file for the same turn. */
export function refreshContextUsage(threadRef: ScopedThreadRef): void {
  const entry = useContextUsageStore.getState().byThreadKey[scopedThreadKey(threadRef)];
  if (entry) void loadContextUsage(threadRef, entry.refreshKey, true);
}

/** Mount in each consumer that is switched on; returns nothing, loads on open and at turn end. */
export function useContextUsageLoader(threadRef: ScopedThreadRef | null): void {
  const thread = useQuietThreadProjection(threadRef);
  const refreshKey = thread && isPiThread(thread) ? contextRefreshKey(thread) : null;
  useEffect(() => {
    if (threadRef && refreshKey !== null) void loadContextUsage(threadRef, refreshKey);
  }, [threadRef, refreshKey]);
}

/** The thread's entry: null before the first answer is asked for (not pi, or not loaded yet). */
export function useContextUsage(threadRef: ScopedThreadRef | null): ContextUsageEntry | null {
  return useContextUsageStore((state) =>
    threadRef ? (state.byThreadKey[scopedThreadKey(threadRef)] ?? null) : null,
  );
}

/** The latest report, kept through a refresh. */
export function useContextUsageReport(threadRef: ScopedThreadRef | null): LoomContextReport | null {
  return useContextUsage(threadRef)?.report ?? null;
}
