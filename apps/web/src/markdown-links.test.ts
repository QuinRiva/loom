import { describe, expect, it } from "vite-plus/test";

import {
  isAbsolutePreviewablePath, // loom:
  isLinkablePathText, // loom:
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";
import {
  markdownFileCopyPaths,
  markdownFileEditorTarget,
  resolveMarkdownFileHostPath,
} from "./markdownFileHostPath";

// loom: out-of-workspace preview paths and the loom inline-code chip rules.
describe("isAbsolutePreviewablePath", () => {
  it("accepts POSIX absolute paths the out-of-workspace preview can serve", () => {
    expect(isAbsolutePreviewablePath("/home/carl/report.md")).toBe(true);
    expect(isAbsolutePreviewablePath("/tmp/x.md")).toBe(true);
  });

  it("rejects Windows drive paths so they fall back to the editor on a POSIX host", () => {
    expect(isAbsolutePreviewablePath("C:\\Users\\carl\\report.md")).toBe(false);
    expect(isAbsolutePreviewablePath("C:/Users/carl/report.md")).toBe(false);
    expect(isAbsolutePreviewablePath("\\\\server\\share\\report.md")).toBe(false);
  });

  it("rejects relative paths", () => {
    expect(isAbsolutePreviewablePath("src/foo.ts")).toBe(false);
    expect(isAbsolutePreviewablePath("./foo.ts")).toBe(false);
  });
});

describe("rewriteMarkdownFileUriHref", () => {
  it("preserves encoded octets so file paths are decoded only once later", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%2520name.md",
    );
  });

  it("normalizes file uri hrefs for windows drive paths", () => {
    expect(
      rewriteMarkdownFileUriHref(
        "file:///D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69");
  });

  it("preserves file uri authorities as windows UNC paths", () => {
    expect(rewriteMarkdownFileUriHref("file://server/share/workspace-image.svg")).toBe(
      "\\\\server\\share\\workspace-image.svg",
    );
  });

  // regression: #6433 workspace images in chat markdown did not render
  it("treats a localhost file uri as a local path", () => {
    expect(rewriteMarkdownFileUriHref("file://localhost/home/me/notes.md")).toBe(
      "/home/me/notes.md",
    );
  });
});

describe("relative links inside a rendered host file", () => {
  it("anchor to the file's directory while workspace membership follows cwd", () => {
    const meta = resolveMarkdownFileLinkMeta("appendix.md", "/repo", "/tmp/report");
    expect(meta).toMatchObject({
      filePath: "/tmp/report/appendix.md",
      workspaceRelativePath: null,
    });
    const inline = resolveInlineCodeFileLinkMeta("Makefile:12", "/repo", "/tmp/report");
    expect(inline).toMatchObject({ filePath: "/tmp/report/Makefile", line: 12 });
    expect(resolveMarkdownFileLinkMeta("src/main.ts", "/repo", "/repo/docs")).toMatchObject({
      filePath: "/repo/docs/src/main.ts",
      workspaceRelativePath: "docs/src/main.ts",
    });
  });
});

describe("resolveInlineCodeFileLinkMeta", () => {
  it("links bare filenames only when a line suffix marks them as file references", () => {
    expect(resolveInlineCodeFileLinkMeta("script.ts:10", "/Users/julius/project")).toMatchObject({
      targetPath: "/Users/julius/project/script.ts:10",
      line: 10,
    });
    // loom: a bare named file resolves; ChatMarkdown keeps it plain code until a file is confirmed.
    expect(resolveInlineCodeFileLinkMeta("AGENTS.md", "/Users/julius/project")).toMatchObject({
      workspaceRelativePath: "AGENTS.md",
    });
  });

  it("does not treat arbitrary name:digits shapes as files", () => {
    expect(resolveInlineCodeFileLinkMeta("error:1", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("TODO:12", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("exit:0", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("port:3000", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("http:80", "/Users/julius/project")).toBeNull();
  });

  it("ignores hosts, ports, and versions", () => {
    expect(resolveInlineCodeFileLinkMeta("127.0.0.1:3000", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("localhost:3000", "/Users/julius/project")).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("example.com/index.html", "/Users/julius/project"),
    ).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("example.com:8080", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("10.0.0.1:80:1", "/Users/julius/project")).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("localhost/index.html", "/Users/julius/project"),
    ).toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("example.uk/index.html", "/Users/julius/project"),
    ).toBeNull();
  });
});

// loom: the loose path scanners' path test (scanned paths).
describe("isLinkablePathText", () => {
  it("accepts absolute, ~/, and explicit-relative paths", () => {
    expect(isLinkablePathText("/home/carl/report.md")).toBe(true);
    expect(isLinkablePathText("~/notes/todo.md")).toBe(true);
    expect(isLinkablePathText("./src/index.ts")).toBe(true);
    expect(isLinkablePathText("../pkg/main.rs")).toBe(true);
  });

  it("accepts relative name/name paths with a known extension", () => {
    expect(isLinkablePathText("src/markdown-links.ts")).toBe(true);
    expect(isLinkablePathText("apps/web/src/index.ts")).toBe(true);
  });

  it("accepts a separator paired with a :line position", () => {
    expect(isLinkablePathText("src/markdown-links.test.ts:138")).toBe(true);
    expect(isLinkablePathText("/etc/hosts:5:2")).toBe(true);
  });

  it("rejects slashed words, dates, and flag values with no path intent", () => {
    expect(isLinkablePathText("and/or")).toBe(false);
    expect(isLinkablePathText("a/b")).toBe(false);
    expect(isLinkablePathText("01/02/2026")).toBe(false);
  });

  it("rejects bare host:port and property accesses", () => {
    expect(isLinkablePathText("example.com:8080")).toBe(false);
    expect(isLinkablePathText("foo.bar")).toBe(false);
    expect(isLinkablePathText("Math.max")).toBe(false);
  });

  it("rejects strings carrying non-path characters", () => {
    expect(isLinkablePathText("foo.bar()")).toBe(false);
    expect(isLinkablePathText("HashMap<string, number>")).toBe(false);
  });
});

describe("chat file chip paths", () => {
  const cwd = String.raw`C:\Users\alice\project`;

  it("opens and copies the indexed file for a bare filename, preserving its line and column", async () => {
    const meta = resolveMarkdownFileLinkMeta("user.ts:261:7", cwd);
    if (!meta) throw new Error("Expected a file link");
    const hostPath = await resolveMarkdownFileHostPath({
      meta,
      cwd,
      findWorkspaceMatch: async () => "src/discord/events/user.ts",
    });

    expect(markdownFileEditorTarget(meta, hostPath)).toBe(
      String.raw`C:\Users\alice\project\src\discord\events\user.ts:261:7`,
    );
    expect(markdownFileCopyPaths(meta, hostPath, cwd)).toEqual({
      fullPath: String.raw`C:\Users\alice\project\src\discord\events\user.ts:261:7`,
      relativePath: "src/discord/events/user.ts:261:7",
    });
  });
});
