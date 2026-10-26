/**
 * loom: the Files tree's folder expansion outlives the tree, which unmounts when a file opens. Tier 1
 * per thread but held in memory, not persisted: an expanded set grows with the repo and names
 * folders that may be gone next launch. Only transitions are recorded (a folder collapsed because it
 * just loaded is not a choice); Changed only seeds every folder open, and a stored collapse wins.
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
