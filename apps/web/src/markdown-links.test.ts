import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";

import {
  isAbsolutePreviewablePath,
  isLinkablePathText,
  extractMarkdownLinkHrefs,
  isWindowsDrivePathHref,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
  shouldOpenMarkdownFileLinkInBrowserByDefault,
  shouldOpenMarkdownFileLinkInEditor,
} from "./markdown-links";

describe("isWindowsDrivePathHref", () => {
  it.each([
    ["C:\\repo\\image.png", true],
    ["C:%5Crepo%5Cimage.png", true],
    ["https://example.com/image.png", false],
  ])("classifies %s as %s", (href, expected) => {
    expect(isWindowsDrivePathHref(href)).toBe(expected);
  });
});

describe("extractMarkdownLinkHrefs", () => {
  it("extracts angle-bracketed paths containing spaces", () => {
    expect(
      extractMarkdownLinkHrefs(
        "[Open the Bike Receipts folder](</Users/dara/Downloads/Lime Ride Artifacts/Bike Receipts>)",
      ),
    ).toEqual(["/Users/dara/Downloads/Lime Ride Artifacts/Bike Receipts"]);
  });

  it("preserves ordinary destinations and ignores link titles", () => {
    expect(
      extractMarkdownLinkHrefs(
        '[source](apps/web/src/markdown-links.ts "implementation") and [docs](https://example.com)',
      ),
    ).toEqual(["apps/web/src/markdown-links.ts", "https://example.com"]);
  });
});

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

function renderMarkdownLinkHref(markdown: string): string | undefined {
  let renderedHref: string | undefined;
  renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      {
        components: {
          a({ href }) {
            renderedHref = href;
            return createElement("a", { href });
          },
        },
      },
      markdown,
    ),
  );
  return renderedHref;
}

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
    expect(resolveMarkdownFileLinkTarget("//cdn.example.com/clip.mp4", "/workspace")).toBeNull();
  });

  it("does not double-decode file URLs", () => {
    expect(resolveMarkdownFileLinkTarget("file:///Users/julius/project/file%2520name.md")).toBe(
      "/Users/julius/project/file%20name.md",
    );
  });

  it("resolves file uri authorities as windows UNC paths", () => {
    expect(resolveMarkdownFileLinkTarget("file://server/share/workspace-image.svg")).toBe(
      "\\\\server\\share\\workspace-image.svg",
    );
  });

  it("resolves a localhost file uri as a local path", () => {
    expect(resolveMarkdownFileLinkTarget("file://localhost/home/me/notes.md")).toBe(
      "/home/me/notes.md",
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

  it("resolves the encoded spaces emitted by the markdown renderer", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/Users/dara/Downloads/Lime%20Ride%20Artifacts/Bike%20Receipts",
        "/Users/dara/Downloads/Lime Ride Artifacts",
      ),
    ).toMatchObject({
      targetPath: "/Users/dara/Downloads/Lime Ride Artifacts/Bike Receipts",
      workspaceRelativePath: "Bike Receipts",
      basename: "Bike Receipts",
    });
  });

  it("resolves relative spaced folders from the markdown renderer", () => {
    const href = renderMarkdownLinkHref("[folder](<docs/My Folder>)");

    expect(href).toBe("docs/My%20Folder");
    expect(resolveMarkdownFileLinkMeta(href, "/repo/project")).toMatchObject({
      targetPath: "/repo/project/docs/My Folder",
      workspaceRelativePath: "docs/My Folder",
      basename: "My Folder",
    });
  });

  it.each(["md", "html", "xml"])(
    "resolves a bare spaced .%s filename from the markdown renderer",
    (extension) => {
      const href = renderMarkdownLinkHref(`[checklist](<Updated cutover checklist.${extension}>)`);

      expect(href).toBe(`Updated%20cutover%20checklist.${extension}`);
      expect(resolveMarkdownFileLinkMeta(href, "/repo/project")).toMatchObject({
        targetPath: `/repo/project/Updated cutover checklist.${extension}`,
        workspaceRelativePath: `Updated cutover checklist.${extension}`,
        basename: `Updated cutover checklist.${extension}`,
      });
    },
  );

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

  it("does not classify a case-distinct POSIX sibling as a workspace file", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "/tmp/t3code-case-test/project/probe.txt",
        "/tmp/t3code-case-test/Project",
      ),
    ).toMatchObject({
      displayPath: "/tmp/t3code-case-test/project/probe.txt",
      workspaceRelativePath: null,
    });
  });

  it("keeps Windows workspace comparisons case-insensitive", () => {
    expect(
      resolveMarkdownFileLinkMeta("C:/Users/MIKE/Project/src/main.ts", "c:/users/mike/project"),
    ).toMatchObject({
      displayPath: "project/src/main.ts",
      workspaceRelativePath: "src/main.ts",
    });
  });

  it("keeps drive-root workspace comparisons case-insensitive", () => {
    expect(resolveMarkdownFileLinkMeta("C:/Users/MIKE/project.ts", "c:/")).toMatchObject({
      displayPath: "c:/Users/MIKE/project.ts",
      workspaceRelativePath: "Users/MIKE/project.ts",
    });
  });

  it("keeps backslash UNC workspace comparisons case-insensitive", () => {
    expect(
      resolveMarkdownFileLinkMeta(
        "\\\\server\\share\\PROJECT\\src\\main.ts",
        "\\\\Server\\Share\\Project",
      ),
    ).toMatchObject({
      displayPath: "Project/src/main.ts",
      workspaceRelativePath: "src/main.ts",
    });
  });

  it.each([
    ["/tmp/repo/file.ts", "/", "tmp/repo/file.ts"],
    ["C:/Users/MIKE/file.ts", "c:/", "Users/MIKE/file.ts"],
    ["\\\\server\\SHARE\\file.ts", "\\\\Server\\Share\\", "file.ts"],
    ["/tmp/repo/file.ts%20", "/tmp/repo", "file.ts "],
  ])("preserves the preview target for %s in workspace %s", (href, cwd, workspaceRelativePath) => {
    expect(resolveMarkdownFileLinkMeta(href, cwd)).toMatchObject({ workspaceRelativePath });
  });

  it("keeps an encoded final space in the absolute target", () => {
    expect(resolveMarkdownFileLinkTarget("/tmp/repo/file.ts%20", "/tmp/repo")).toBe(
      "/tmp/repo/file.ts ",
    );
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

  it("does not treat app routes as file links, even with a line anchor", () => {
    expect(resolveMarkdownFileLinkTarget("/chat/settings")).toBeNull();
    expect(resolveMarkdownFileLinkTarget("/chat/settings#L3", "/repo")).toBeNull();
  });

  it("decodes an encoded drive colon in a file uri before dropping its slash", () => {
    expect(resolveMarkdownFileLinkTarget("file:///c%3A/Users/x/shot.png")).toBe(
      "c:/Users/x/shot.png",
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
