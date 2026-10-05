/**
 * loom: thread-tab group-key derivation.
 *
 * Centre-panel tabs are grouped per orchestration tree (see `threadTabsStore`).
 * loom: detached in pull 9, ledger DT-71 — the lineage-root walk read V1
 * `parentThreadId` through the quarantined `threadRouteLineage.ts`, so every tab
 * shares one group (a flat strip) until phase 3d re-hangs per-tree grouping on
 * V2 lineage. Persisted multi-group state coalesces into this group on first
 * load (`useThreadTabsSync`'s coalescing effect).
 */
import type { ScopedThreadRef } from "@t3tools/contracts";

export type ThreadGroupResolver = (ref: ScopedThreadRef) => string;

const FLAT_GROUP_KEY = "all";
const resolveFlatGroupKey: ThreadGroupResolver = () => FLAT_GROUP_KEY;

/** A stable resolver mapping every `ScopedThreadRef` to the one flat group. */
export function useThreadGroupResolver(): ThreadGroupResolver {
  return resolveFlatGroupKey;
}
