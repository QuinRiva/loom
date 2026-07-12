import { describe, expect, it } from "vite-plus/test";

import {
  isAbsolutePreviewablePath,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "./markdown-links";

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

  it("unwraps angle-bracketed file uri hrefs", () => {
    expect(
      rewriteMarkdownFileUriHref(" <file:///D:/Programme/t3code/apps/web/src/markdown-links.ts> "),
    ).toBe("D:/Programme/t3code/apps/web/src/markdown-links.ts");
  });
});

describe("resolveMarkdownFileLinkTarget", () => {
  it("resolves absolute posix file paths", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/AGENTS.md")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("resolves relative file paths against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("src/processRunner.ts:71", "/Users/julius/project")).toBe(
      "/Users/julius/project/src/processRunner.ts:71",
    );
  });

  it("does not treat filename line references as external schemes", () => {
    expect(resolveMarkdownFileLinkTarget("script.ts:10", "/Users/julius/project")).toBe(
      "/Users/julius/project/script.ts:10",
    );
  });

  it("resolves bare file names against cwd", () => {
    expect(resolveMarkdownFileLinkTarget("AGENTS.md", "/Users/julius/project")).toBe(
      "/Users/julius/project/AGENTS.md",
    );
  });

  it("maps #L line anchors to editor line suffixes", () => {
    expect(resolveMarkdownFileLinkTarget("/Users/julius/project/src/main.ts#L42C7")).toBe(
      "/Users/julius/project/src/main.ts:42:7",
    );
  });

  it("ignores external urls", () => {
    expect(resolveMarkdownFileLinkTarget("https://example.com/docs")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("formats tooltip display paths relative to the cwd when possible", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "file:///C:/Users/mike/dev-stuff/t3code/apps/web/src/session-logic.ts#L501",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath: "t3code/apps/web/src/session-logic.ts:501",
      workspaceRelativePath: "apps/web/src/session-logic.ts",
    });
  });

  it("formats tooltip display paths relative to the cwd for slash-prefixed windows paths", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/C:/Users/mike/dev-stuff/t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
        "C:/Users/mike/dev-stuff/t3code",
      ),
    ).toMatchObject({
      displayPath:
        "t3code/apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
      workspaceRelativePath:
        "apps/web/src/components/chat/MessagesTimeline.virtualization.browser.tsx",
    });
  });

  it("does not create a preview path for files outside the workspace", () => {
    expect(resolveMarkdownFileLinkMeta("/tmp/report.ts", "/repo/project")).toMatchObject({
      workspaceRelativePath: null,
    });
  });

  it("normalizes slash-prefixed windows drive paths before resolving", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "/D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx#L69",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/chat/OpenInPicker.tsx:69");
  });

  it("resolves angle-bracketed windows drive paths", () => {
    expect(
      resolveMarkdownFileLinkTarget(
        "</D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1>",
      ),
    ).toBe("D:/Programme/t3code/apps/web/src/components/ChatMarkdown.tsx:1");
  });

  it("does not treat app routes as file links", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
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
