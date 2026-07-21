/**
 * loom: thread-tab group-key derivation.
 *
 * Centre-panel tabs are grouped per orchestration tree (see `threadTabsStore`).
 * A tab's group key is the `scopedThreadKey` of its **lineage root** — the
 * highest ancestor reached by walking `parentThreadId` within the thread's own
 * environment. This is the one place lineage is turned into a group key; the
 * store never computes it (it takes a group key as an argument), so this stays
 * the single source of that mapping, shared by the sync hook and the sidebar.
 *
 * Provisional vs resolved: on a cold load / deep link into a subthread, ancestor
 * shells may not have replayed yet, so the walk stops early and the derived key
 * is the topmost *reachable* thread (often the thread itself) — a provisional
 * group. Once the ancestors arrive, this resolver returns the real root key and
 * the sync hook coalesces the provisional group into it. The mapping is pure, so
 * re-deriving on every shell change is exactly what drives coalescing.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useThreadShells } from "~/state/entities";
import { buildThreadLineage } from "../threadRouteLineage";

export type ThreadGroupResolver = (ref: ScopedThreadRef) => string;

/**
 * Derive the group key for `ref` from a per-environment shell map. Walks to the
 * lineage root via `buildThreadLineage`; the group key is the root's (or, when
 * the root has not replayed yet, the topmost reachable ancestor's)
 * `scopedThreadKey`. A thread with no parent — or one whose own shell is absent —
 * is its own group.
 */
export function resolveThreadGroupKey(
  shellMap: Record<ThreadId, EnvironmentThreadShell>,
  ref: ScopedThreadRef,
): string {
  const lineage = buildThreadLineage(shellMap, ref.threadId);
  const rootThreadId = lineage.length > 0 ? lineage[0]!.threadId : ref.threadId;
  return scopedThreadKey({ environmentId: ref.environmentId, threadId: rootThreadId });
}

/**
 * A stable resolver that maps any `ScopedThreadRef` to its current group key,
 * backed by the live thread-shell list (bucketed per environment). Its identity
 * changes when the shells change, so an effect depending on it re-runs to
 * coalesce groups as lineage resolves.
 */
export function useThreadGroupResolver(): ThreadGroupResolver {
  const shells = useThreadShells();
  const shellMapByEnv = useMemo(() => {
    const byEnv = new Map<EnvironmentId, Record<ThreadId, EnvironmentThreadShell>>();
    for (const shell of shells) {
      let map = byEnv.get(shell.environmentId);
      if (!map) {
        map = {};
        byEnv.set(shell.environmentId, map);
      }
      map[shell.id] = shell;
    }
    return byEnv;
  }, [shells]);

  return useCallback(
    (ref: ScopedThreadRef) =>
      resolveThreadGroupKey(shellMapByEnv.get(ref.environmentId) ?? {}, ref),
    [shellMapByEnv],
  );
}
