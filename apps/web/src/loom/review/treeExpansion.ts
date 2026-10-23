/**
 * loom: the Files tree's folder expansion outlives the tree. Opening a file swaps the explorer for
 * the file, so the tree unmounts and its model (and every expanded folder) went with it; reopening
 * showed every folder collapsed.
 *
 * State tier (docs/architecture/loom-ui-state-tiers.md): a tier-1 per-thread choice in what it
 * scopes and outlives, held in memory for the session rather than persisted, because an expanded
 * set grows with the repo (expand-all on a large tree is thousands of paths) and names folders that
 * may be gone by the next launch.
 *
 * Only transitions are recorded: a folder that appears collapsed because it just loaded is not a
 * choice. Changed only seeds every folder open, and a stored choice (a folder the user collapsed)
 * wins over the seed.
 *
 * @module loom/review/treeExpansion
 */
import type { FileTree, FileTreeDirectoryHandle } from "@pierre/trees";
import { useEffect } from "react";

const choicesByTree = new Map<string, Map<string, boolean>>();

function directory(model: FileTree, path: string): FileTreeDirectoryHandle | null {
  const item = model.getItem(path);
  return item !== null && "isExpanded" in item ? item : null;
}

/** Call after the effect that loads paths into `model`, so restoring sees them. */
export function useLoomTreeExpansion(
  model: FileTree,
  key: string | null,
  directoryPaths: readonly string[],
  seedExpanded: boolean,
): void {
  useEffect(() => {
    if (key === null) return;
    const choices = choicesByTree.get(key) ?? new Map<string, boolean>();
    choicesByTree.set(key, choices);
    for (const path of directoryPaths) {
      const item = directory(model, path);
      const want = choices.get(path) ?? (seedExpanded || undefined);
      if (item === null || want === undefined || item.isExpanded() === want) continue;
      choices.set(path, want);
      if (want) item.expand();
      else item.collapse();
    }
    const isExpanded = (path: string) => directory(model, path)?.isExpanded();
    const observed = new Map(directoryPaths.map((path) => [path, isExpanded(path)]));
    return model.subscribe(() => {
      for (const path of directoryPaths) {
        const now = isExpanded(path);
        const before = observed.get(path);
        if (now !== undefined && before !== undefined && now !== before) choices.set(path, now);
        observed.set(path, now);
      }
    });
  }, [directoryPaths, key, model, seedExpanded]);
}
