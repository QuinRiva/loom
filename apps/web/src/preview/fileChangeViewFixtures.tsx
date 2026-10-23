/**
 * loom: `FileChangeView` on the three file sizes the whole-file research measured (516, 3,246 and
 * 9,692 lines), each the real source file as its new side against a synthetic older side with six
 * edits. The 9,692-line file is over the size cap, so it opens from its patch in hunk mode; "Show
 * whole file" is the opt-in. The header's change counter sits above each, as the Files surface
 * shows it. Registered in `loomPreviewGroups.tsx`.
 */
import type { FileDiffContentsLoader } from "@pierre/diffs";

import { DraftId } from "../composerDraftStore";
import {
  FileChangeView,
  WHOLE_FILE_MAX_BYTES,
  WHOLE_FILE_MAX_LINES,
} from "../loom/review/FileChangeView";
import small from "../../../server/src/cli/theme.ts?raw";
import medium from "../../../server/src/git/GitManager.ts?raw";
import large from "../../../server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts?raw";
import { LoomChangeCounter } from "../loom/review/ChangeRuler";
import type { PreviewGroup } from "./fixtures";

const EDITS = [
  { at: 0.05, count: 1 },
  { at: 0.2, count: 3 },
  { at: 0.35, count: 1 },
  { at: 0.5, count: 2 },
  { at: 0.7, count: 1 },
  { at: 0.9, count: 1 },
];

/** An older side with a few lines changed, and the unified patch between the two. */
function synthesise(path: string, contents: string) {
  const lines = contents.split("\n");
  const oldLines = [...lines];
  const hunks: string[] = [];
  for (const { at, count } of EDITS) {
    const start = Math.floor(lines.length * at);
    for (let index = start; index < start + count; index++) {
      oldLines[index] = `${lines[index]} // previously`;
    }
    const from = Math.max(0, start - 3);
    const to = Math.min(lines.length, start + count + 3);
    const context = (index: number) => ` ${lines[index]}`;
    hunks.push(
      `@@ -${from + 1},${to - from} +${from + 1},${to - from} @@`,
      ...Array.from({ length: start - from }, (_, offset) => context(from + offset)),
      ...Array.from({ length: count }, (_, offset) => `-${oldLines[start + offset]}`),
      ...Array.from({ length: count }, (_, offset) => `+${lines[start + offset]}`),
      ...Array.from({ length: to - start - count }, (_, offset) => context(start + count + offset)),
    );
  }
  const patch = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    ...hunks,
    "",
  ].join("\n");
  const loadDiffFiles: FileDiffContentsLoader = async () => ({
    oldFile: { name: path, contents: oldLines.join("\n"), cacheKey: `preview:${path}:old` },
    newFile: { name: path, contents, cacheKey: `preview:${path}:new` },
  });
  return {
    patch,
    loadDiffFiles,
    oversize: contents.length > WHOLE_FILE_MAX_BYTES || lines.length > WHOLE_FILE_MAX_LINES,
  };
}

const FILES = [
  { id: "small", path: "apps/server/src/cli/theme.ts", contents: small },
  { id: "medium", path: "apps/server/src/git/GitManager.ts", contents: medium },
  {
    id: "large",
    path: "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts",
    contents: large,
  },
];

export const FILE_CHANGE_VIEW_PREVIEW_GROUP: PreviewGroup = {
  id: "loom-file-change-view",
  title: "Whole-file change view",
  fixtures: FILES.map(({ id, path, contents }) => {
    const lines = contents.split("\n").length;
    const fixture = synthesise(path, contents);
    return {
      id: `loom-file-change-${id}`,
      title: `${lines.toLocaleString()} lines${fixture.oversize ? " (over the cap)" : ""}`,
      description: fixture.oversize
        ? "Over the size cap: opens from its patch in hunk mode; Show whole file opts in."
        : "Whole file, every unchanged line present, opened on the first change.",
      render: () => (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex justify-end border-b px-2 py-1">
            <LoomChangeCounter />
          </div>
          <FileChangeView
            file={{ path, previousPath: null, status: "modified", bytes: contents.length }}
            revision="preview"
            oversize={fixture.oversize}
            loadDiffFiles={fixture.loadDiffFiles}
            patch={{ text: fixture.patch, error: null }}
            composerDraftTarget={DraftId.make("preview-file-change")}
          />
        </div>
      ),
    };
  }),
};
