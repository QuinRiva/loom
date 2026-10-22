import { describe, expect, it } from "vite-plus/test";

import { loomChangedOnlyEntries, loomChangeTreeStatus } from "./changeMarksTree";
import type { LoomChangeMarks, LoomChangedFile } from "./useLoomChangeMarks";

const marks = (files: ReadonlyArray<LoomChangedFile>): LoomChangeMarks => ({
  scope: "interval",
  label: "Since your message",
  marksOff: false,
  changedOnly: false,
  baseline: null,
  files: new Map(files.map((file) => [file.path, file])),
  revision: "r",
  ignoreWhitespace: false,
  refresh: () => undefined,
});

const file = (path: string, status: LoomChangedFile["status"]): LoomChangedFile => ({
  path,
  previousPath: null,
  status,
  bytes: null,
});

describe("loomChangeTreeStatus", () => {
  it("colours each folder above a change and counts the files beneath it", () => {
    const { entries, folders } = loomChangeTreeStatus(
      [
        { path: ".artifacts/", status: "ignored" },
        { path: "node_modules/", status: "ignored" },
      ],
      marks([
        file("apps/server/src/CheckpointService.ts", "modified"),
        file("apps/web/src/new.ts", "added"),
        file(".artifacts/x.html", "added"),
      ]),
    );
    expect(Object.fromEntries(folders)).toEqual({
      "apps/": { count: 2, status: "modified" },
      "apps/server/": { count: 1, status: "modified" },
      "apps/server/src/": { count: 1, status: "modified" },
      "apps/web/": { count: 1, status: "added" },
      "apps/web/src/": { count: 1, status: "added" },
      ".artifacts/": { count: 1, status: "added" },
    });
    // A marked file inside an ignored folder wins over the folder's ignored style.
    expect(entries.filter((entry) => entry.path === ".artifacts/")).toEqual([
      { path: ".artifacts/", status: "added" },
    ]);
    expect(entries).toContainEqual({ path: "node_modules/", status: "ignored" });
  });

  it("feeds only the ignored entries when there are no marks", () => {
    const ignored = [{ path: ".t3/", status: "ignored" as const }];
    expect(loomChangeTreeStatus(ignored, null)).toEqual({ entries: ignored, folders: new Map() });
  });
});

describe("loomChangedOnlyEntries", () => {
  it("keeps the marked files and every folder on the way to them", () => {
    expect(
      loomChangedOnlyEntries(marks([file("a/b/c.ts", "modified"), file("d.md", "deleted")])),
    ).toEqual([
      { path: "a", kind: "directory" },
      { path: "a/b", kind: "directory" },
      { path: "a/b/c.ts", kind: "file" },
      { path: "d.md", kind: "file" },
    ]);
  });
});
