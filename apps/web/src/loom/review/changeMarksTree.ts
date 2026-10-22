/**
 * loom: the Files tree's side of change review: the status feed, folder counts and the "Changed
 * only" entries. Free of runtime imports, so the upstream tree panel can take it without pulling
 * in the review queries.
 *
 * @module loom/review/changeMarksTree
 */
import type { GitStatusEntry } from "@pierre/trees";

import type { LoomChangeMarks } from "./useLoomChangeMarks";

const FOLDER_STATUS_COLOR = {
  added: "var(--trees-git-added-color)",
  modified: "var(--trees-git-modified-color)",
} as const;

/**
 * The tree's status feed: each changed file lettered by its status, and each folder above one
 * coloured green when everything changed under it is new, blue otherwise. Folder statuses are ours
 * (the tree only puts a dot on a folder), so a marked file inside an ignored folder wins over it.
 */
export function loomChangeTreeStatus(
  ignored: ReadonlyArray<GitStatusEntry>,
  marks: LoomChangeMarks | null,
): {
  readonly entries: GitStatusEntry[];
  readonly folders: ReadonlyMap<string, { count: number; status: "added" | "modified" }>;
} {
  const folders = new Map<string, { count: number; status: "added" | "modified" }>();
  for (const file of marks?.files.values() ?? []) {
    const segments = file.path.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const folder = `${segments.slice(0, depth).join("/")}/`;
      const current = folders.get(folder);
      folders.set(folder, {
        count: (current?.count ?? 0) + 1,
        status: current?.status === "modified" || file.status !== "added" ? "modified" : "added",
      });
    }
  }
  const marked: GitStatusEntry[] = [
    ...[...(marks?.files.values() ?? [])].map((file) => ({
      path: file.path,
      status: file.status,
    })),
    ...[...folders].map(([path, folder]) => ({ path, status: folder.status })),
  ];
  const markedPaths = new Set(marked.map((entry) => entry.path));
  return {
    entries: [...ignored.filter((entry) => !markedPaths.has(entry.path)), ...marked],
    folders,
  };
}

/** A folder's count of changed files beneath it, in its colour. */
export function loomFolderChangeDecoration(
  folders: ReadonlyMap<string, { count: number; status: "added" | "modified" }>,
  path: string,
) {
  const folder = folders.get(path);
  if (!folder) return null;
  const text = String(folder.count);
  return {
    text,
    title: folder.count === 1 ? "1 changed file" : `${folder.count} changed files`,
    parts: [{ text, color: FOLDER_STATUS_COLOR[folder.status] }],
  };
}

/** Marked files and their ancestor folders, as the tree's entries under "Changed only". */
export function loomChangedOnlyEntries(marks: LoomChangeMarks) {
  const folders = new Set<string>();
  for (const path of marks.files.keys()) {
    const segments = path.split("/");
    for (let depth = 1; depth < segments.length; depth++)
      folders.add(segments.slice(0, depth).join("/"));
  }
  return [
    ...[...folders].map((path) => ({ path, kind: "directory" as const })),
    ...[...marks.files.keys()].map((path) => ({ path, kind: "file" as const })),
  ];
}

/** The letter lane would repeat "M" on every folder; folders carry their count instead. */
export const LOOM_CHANGE_TREE_UNSAFE_CSS = `
  [data-item-type='folder'][data-item-git-status]:not([data-item-git-status='ignored'])
    > [data-item-section='git'] > span { display: none; }
`;
