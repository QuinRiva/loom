import { describe, expect, it } from "@effect/vitest";

import {
  messageDirectoryBases,
  messageFileCandidates,
  unanchoredFileLink,
} from "./messageFileLinks.loom";

const ROOT = "/home/carl/wt";

describe("unanchoredFileLink", () => {
  it("looks up relative paths and keeps their position", () => {
    expect(unanchoredFileLink("viz/pages/index.html", ROOT)).toEqual({
      reference: "viz/pages/index.html",
      rootPath: `${ROOT}/viz/pages/index.html`,
      position: "",
    });
    expect(unanchoredFileLink("src/x.py:12:3", ROOT)?.position).toBe(":12:3");
  });

  it("leaves paths that name one place, and folders, to open as written", () => {
    for (const href of ["/abs/x.md", "~/x.md", "./x.md", "../x.md", "docs/", "https://a.b/c.md"]) {
      expect(unanchoredFileLink(href, ROOT), href).toBeNull();
    }
    expect(unanchoredFileLink("viz/x.html", null)).toBeNull();
  });
});

describe("messageDirectoryBases", () => {
  // Web's order: inline code first, then links.
  it("collects folders named by inline code, then by link, outside code blocks", () => {
    const markdown = [
      "Files are in `/home/carl/wt/workbench/study/`: `results/a.md`.",
      "Also [out](/home/carl/out/) and `./local/`, not `README.md` or `https://x.y/`.",
      "```",
      "`/home/carl/fenced/`",
      "```",
    ].join("\n");
    expect(messageDirectoryBases(markdown, ROOT)).toEqual([
      "/home/carl/wt/workbench/study",
      `${ROOT}/local`,
      "/home/carl/out",
    ]);
  });
});

describe("messageFileCandidates", () => {
  it("tries the root, the path without a repeated project prefix, then named folders", () => {
    const root = "/repo/apps/web";
    const link = unanchoredFileLink("apps/web/src/x.ts", root)!;
    expect(messageFileCandidates(link, "See `/repo/other/`.", root)).toEqual([
      "/repo/apps/web/apps/web/src/x.ts",
      "/repo/apps/web/src/x.ts",
      "/repo/other/apps/web/src/x.ts",
    ]);
  });
});
