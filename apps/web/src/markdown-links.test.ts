import { describe, expect, it } from "vite-plus/test";

import {
  isAbsolutePreviewablePath, // loom:
  isLinkablePathText, // loom:
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  rewriteMarkdownFileUriHref,
  shouldOpenMarkdownFileLinkInBrowserByDefault,
  shouldOpenMarkdownFileLinkInEditor,
} from "./markdown-links";

describe("shouldOpenMarkdownFileLinkInEditor", () => {
  it("uses command-click on macOS", () => {
    expect(shouldOpenMarkdownFileLinkInEditor({ metaKey: true, ctrlKey: false }, "MacIntel")).toBe(
      true,
    );
    expect(shouldOpenMarkdownFileLinkInEditor({ metaKey: false, ctrlKey: true }, "MacIntel")).toBe(
      false,
    );
  });

  it("uses control-click on other platforms", () => {
    expect(
      shouldOpenMarkdownFileLinkInEditor({ metaKey: false, ctrlKey: true }, "Linux x86_64"),
    ).toBe(true);
    expect(
      shouldOpenMarkdownFileLinkInEditor({ metaKey: true, ctrlKey: false }, "Linux x86_64"),
    ).toBe(false);
  });
});

describe("shouldOpenMarkdownFileLinkInBrowserByDefault", () => {
  it("keeps PDFs browser-first while source files open in the file viewer", () => {
    expect(shouldOpenMarkdownFileLinkInBrowserByDefault("report.pdf")).toBe(true);
    expect(shouldOpenMarkdownFileLinkInBrowserByDefault("report.PDF?download=1")).toBe(true);
    expect(shouldOpenMarkdownFileLinkInBrowserByDefault("report.html")).toBe(false);
    expect(shouldOpenMarkdownFileLinkInBrowserByDefault("report.xml")).toBe(false);
  });
});

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
  it("rewrites file uri hrefs into direct path hrefs", () => {
    expect(rewriteMarkdownFileUriHref("file:///Users/julius/project/src/main.ts#L42")).toBe(
      "/Users/julius/project/src/main.ts#L42",
    );
  });

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

  it("treats a localhost file uri as a local path", () => {
    expect(rewriteMarkdownFileUriHref("file://localhost/home/me/notes.md")).toBe(
      "/home/me/notes.md",
    );
  });

  it("unwraps angle-bracketed file uri hrefs", () => {
    expect(
      rewriteMarkdownFileUriHref(" <file:///D:/Programme/t3code/apps/web/src/markdown-links.ts> "),
    ).toBe("D:/Programme/t3code/apps/web/src/markdown-links.ts");
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

  it("resolve multi-segment inline code from the workspace root in a workspace file", () => {
    expect(
      resolveInlineCodeFileLinkMeta("docs/ai/design.md", "/repo", "/repo/docs/ai"),
    ).toMatchObject({ filePath: "/repo/docs/ai/design.md" });
    expect(
      resolveInlineCodeFileLinkMeta("src/index.ts:4", "/repo", "/repo/packages/a"),
    ).toMatchObject({ filePath: "/repo/src/index.ts", line: 4 });
  });

  it("keep sibling and explicitly relative inline code beside the file", () => {
    expect(resolveInlineCodeFileLinkMeta("design.md:12", "/repo", "/repo/docs/ai")).toMatchObject({
      filePath: "/repo/docs/ai/design.md",
      line: 12,
    });
    expect(
      resolveInlineCodeFileLinkMeta("./src/index.ts", "/repo", "/repo/packages/a"),
    ).toMatchObject({ filePath: "/repo/packages/a/./src/index.ts" });
    expect(resolveInlineCodeFileLinkMeta("../b/notes.md", "/repo", "/repo/docs/a")).toMatchObject({
      filePath: "/repo/docs/a/../b/notes.md",
    });
  });

  it("keep multi-segment inline code beside a file outside the workspace", () => {
    expect(resolveInlineCodeFileLinkMeta("src/main.ts", "/repo", "/tmp/report")).toMatchObject({
      filePath: "/tmp/report/src/main.ts",
      workspaceRelativePath: null,
    });
  });
});

describe("resolveInlineCodeFileLinkMeta", () => {
  const cwd = "/Users/julius/project";

  const links = (span: string) => resolveInlineCodeFileLinkMeta(span, cwd);

  it("links relative paths with a separator and extension", () => {
    expect(links("apps/web/src/components/ChatMarkdown.tsx")).toMatchObject({
      workspaceRelativePath: "apps/web/src/components/ChatMarkdown.tsx",
      basename: "ChatMarkdown.tsx",
      targetPath: "/Users/julius/project/apps/web/src/components/ChatMarkdown.tsx",
    });
  });

  it("links relative paths with a line suffix", () => {
    expect(links("src/foo.ts:123")).toMatchObject({
      basename: "foo.ts",
      line: 123,
      targetPath: "/Users/julius/project/src/foo.ts:123",
    });
  });

  it("links relative paths with file extensions", () => {
    expect(
      resolveInlineCodeFileLinkMeta("docs/internals/workspace-layout.md", "/Users/julius/project"),
    ).toMatchObject({
      targetPath: "/Users/julius/project/docs/internals/workspace-layout.md",
      basename: "workspace-layout.md",
    });
  });

  it("links absolute posix paths", () => {
    expect(links("/etc/hosts")).toMatchObject({
      targetPath: "/etc/hosts",
      basename: "hosts",
    });
  });

  it("links explicit relative prefixes even without an extension", () => {
    expect(links("./scripts/build")).toMatchObject({
      basename: "build",
    });
  });

  it("links bare filenames with a known extension", () => {
    expect(links("package.json")).toMatchObject({ basename: "package.json" });
    expect(links("AGENTS.md")).toMatchObject({ basename: "AGENTS.md" });
    expect(links("README.md")).toMatchObject({ basename: "README.md" });
  });

  it("links windows drive paths", () => {
    expect(resolveInlineCodeFileLinkMeta("C:/Users/mike/app.ts", cwd)).toMatchObject({
      basename: "app.ts",
    });
  });

  // --- false positives that must NOT linkify ---

  it("does not link property/method accesses", () => {
    expect(links("foo.bar")).toBeNull();
    expect(links("foo.bar()")).toBeNull();
    expect(links("this.state")).toBeNull();
    expect(links("Math.max")).toBeNull();
    expect(links("os.path")).toBeNull();
  });

  it("does not link bare identifiers or keywords", () => {
    expect(links("const")).toBeNull();
    expect(links("useState")).toBeNull();
    expect(links("HHH")).toBeNull();
  });

  it("does not link commands with spaces", () => {
    expect(links("vp run test")).toBeNull();
    expect(links("vp run typecheck")).toBeNull();
    expect(links("git commit -m")).toBeNull();
  });

  it("does not link generic type expressions", () => {
    expect(links("HashMap<string, number>")).toBeNull();
    expect(links("Array<Foo>")).toBeNull();
    expect(links("Record<string, unknown>")).toBeNull();
  });

  it("does not link urls or host:port", () => {
    expect(links("https://example.com/docs")).toBeNull();
    expect(links("example.com:8080")).toBeNull();
    expect(links("http://localhost:3000")).toBeNull();
  });

  it("does not link bare separator flag values", () => {
    expect(links("a/b")).toBeNull();
    expect(links("y/n")).toBeNull();
    expect(links("and/or")).toBeNull();
  });

  it("does not link expressions containing code punctuation", () => {
    expect(links("a || b")).toBeNull();
    expect(links("x = 1")).toBeNull();
    expect(links("arr[0]")).toBeNull();
    expect(links("$HOME")).toBeNull();
  });

  it("does not link an empty or whitespace span", () => {
    expect(links("")).toBeNull();
    expect(links("   ")).toBeNull();
  });
});

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

describe("directory paths with a trailing separator", () => {
  it("keeps the final segment for a POSIX directory path", () => {
    expect(resolveMarkdownFileLinkMeta("/tmp/favicons/", "/repo/project")).toMatchObject({
      basename: "favicons",
    });
  });

  it("keeps the final segment for a Windows directory path", () => {
    expect(
      resolveMarkdownFileLinkMeta("C:\\Users\\kelchm\\.claude\\", "/repo/project"),
    ).toMatchObject({ basename: ".claude" });
  });

  it("matches the label of the same path without a trailing separator", () => {
    const withSlash = resolveMarkdownFileLinkMeta("/tmp/favicons/", "/repo/project");
    const withoutSlash = resolveMarkdownFileLinkMeta("/tmp/favicons", "/repo/project");
    expect(withSlash?.basename).toBe(withoutSlash?.basename);
  });

  it("does not produce an empty label for the filesystem root", () => {
    const meta = resolveMarkdownFileLinkMeta("/tmp/", "/repo/project");
    expect(meta?.basename).not.toBe("");
  });
});

it("routes the project-root code link to the workspace explorer", () => {
  const cwd = "/Users/saphid/.t3/worktrees/ov2-standalone-20260918";
  expect(resolveInlineCodeFileLinkMeta(cwd, cwd)).toMatchObject({
    workspaceRelativePath: ".",
    filePath: cwd,
  });
});
