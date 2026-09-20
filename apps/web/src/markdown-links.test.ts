import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";

import {
  CODE_BLOCK_MAX_LINES,
  CODE_LINE_MAX_LENGTH,
  MAX_MESSAGE_PATH_CANDIDATES,
  collectMessageDirectoryBases,
  directoryReferenceBase,
  extractMessagePathCandidates,
  extractTextPathCandidates,
  isAbsolutePreviewablePath,
  isLinkablePathText,
  matchTextPathSpans,
  resolveInlineCodeFileLinkCandidates,
  extractMarkdownLinkHrefs,
  isWindowsDrivePathHref,
  resolveInlineCodeFileLinkMeta,
  resolveMarkdownFileLinkMeta,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
  selectChipBinding,
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

describe("directoryReferenceBase", () => {
  it("accepts trailing-slash references and strips the separator", () => {
    expect(directoryReferenceBase("/home/carl/data/_findings/")).toBe("/home/carl/data/_findings");
    expect(directoryReferenceBase("/home/carl/my.data/")).toBe("/home/carl/my.data");
  });

  it("rejects references without a trailing separator — no directory guessing", () => {
    // Extension-less spans are plausible files (README, Makefile) and known-file
    // spans are files; neither may be guessed to be a directory base.
    expect(directoryReferenceBase("/home/carl/data/_findings")).toBeNull();
    expect(directoryReferenceBase("/repo/src/components")).toBeNull();
    expect(directoryReferenceBase("/home/carl/verdict.md")).toBeNull();
  });
});

describe("resolveInlineCodeFileLinkCandidates", () => {
  const cwd = "/home/carl/project";
  const findings = "/home/carl/data/lease/_findings";
  const otherDir = "/home/carl/data/other";

  it("returns no candidates for a span that is not a file link", () => {
    expect(resolveInlineCodeFileLinkCandidates("foo.bar", cwd, [findings])).toEqual([]);
  });

  it("resolves a bare filename against cwd first, then message directories", () => {
    const candidates = resolveInlineCodeFileLinkCandidates("verdict.md", cwd, [findings]);
    expect(candidates.map((meta) => meta.filePath)).toEqual([
      "/home/carl/project/verdict.md",
      "/home/carl/data/lease/_findings/verdict.md",
    ]);
  });

  it("expands an unprefixed relative path against message directories", () => {
    const candidates = resolveInlineCodeFileLinkCandidates("reports/verdict.md", cwd, [findings]);
    expect(candidates.map((meta) => meta.filePath)).toEqual([
      "/home/carl/project/reports/verdict.md",
      "/home/carl/data/lease/_findings/reports/verdict.md",
    ]);
  });

  it("orders directory candidates by the order they are supplied (message appearance)", () => {
    const candidates = resolveInlineCodeFileLinkCandidates("verdict.md", cwd, [otherDir, findings]);
    expect(candidates.map((meta) => meta.filePath)).toEqual([
      "/home/carl/project/verdict.md",
      "/home/carl/data/other/verdict.md",
      "/home/carl/data/lease/_findings/verdict.md",
    ]);
  });

  it("deduplicates a directory that resolves to the cwd candidate", () => {
    const candidates = resolveInlineCodeFileLinkCandidates("verdict.md", cwd, [cwd, findings]);
    expect(candidates.map((meta) => meta.filePath)).toEqual([
      "/home/carl/project/verdict.md",
      "/home/carl/data/lease/_findings/verdict.md",
    ]);
  });

  it("preserves a line/column suffix when joining onto a directory", () => {
    const candidates = resolveInlineCodeFileLinkCandidates("verdict.md:12:3", cwd, [findings]);
    expect(candidates.map((meta) => meta.targetPath)).toEqual([
      "/home/carl/project/verdict.md:12:3",
      "/home/carl/data/lease/_findings/verdict.md:12:3",
    ]);
    expect(candidates[1]).toMatchObject({ line: 12, column: 3, basename: "verdict.md" });
  });

  it("does not expand absolute, ~/, or explicit-relative spans", () => {
    expect(
      resolveInlineCodeFileLinkCandidates("/etc/hosts", cwd, [findings]).map((m) => m.filePath),
    ).toEqual(["/etc/hosts"]);
    expect(
      resolveInlineCodeFileLinkCandidates("~/notes.md", cwd, [findings]).map((m) => m.filePath),
    ).toEqual(["/home/carl/notes.md"]);
    expect(
      resolveInlineCodeFileLinkCandidates("./notes.md", cwd, [findings]).map((m) => m.filePath),
    ).toEqual(["/home/carl/project/./notes.md"]);
  });
});

describe("collectMessageDirectoryBases", () => {
  const cwd = "/home/carl/project";

  it("discovers a directory mentioned AFTER the filename (whole-message scan)", () => {
    const text =
      "Deliverables `verdict.md` and `findings.md` live at `/home/carl/data/_findings/`.";
    expect(collectMessageDirectoryBases(text, cwd)).toEqual(["/home/carl/data/_findings"]);
  });

  it("expands a `~/` directory reference against the cwd home", () => {
    expect(collectMessageDirectoryBases("See `verdict.md` in `~/reports/gold/`.", cwd)).toEqual([
      "/home/carl/reports/gold",
    ]);
  });

  it("keeps appearance order and ignores file (non-directory) references", () => {
    const text = "In `~/a/` then `~/b/` — but not `plain.md` or `/etc/hosts`.";
    expect(collectMessageDirectoryBases(text, cwd)).toEqual(["/home/carl/a", "/home/carl/b"]);
  });

  it("discovers a directory named via an explicit markdown link", () => {
    expect(
      collectMessageDirectoryBases("Outputs in [findings](/home/carl/out/_findings/).", cwd),
    ).toEqual(["/home/carl/out/_findings"]);
  });
});

describe("selectChipBinding", () => {
  const cwd = "/home/carl/project";
  const findings = "/home/carl/data/_findings";
  const other = "/home/carl/data/other";
  const candidatesFor = (dirs: string[]) =>
    resolveInlineCodeFileLinkCandidates("verdict.md", cwd, dirs);
  const lookupExisting = (existing: Record<string, "file" | "directory">) => (filePath: string) =>
    filePath in existing
      ? { exists: true, isDirectory: existing[filePath] === "directory" }
      : { exists: false, isDirectory: false };

  it("binds the first directory that contains the name when several do", () => {
    const binding = selectChipBinding(
      candidatesFor([findings, other]),
      lookupExisting({
        [`${findings}/verdict.md`]: "file",
        [`${other}/verdict.md`]: "file",
      }),
    );
    expect(binding?.meta.filePath).toBe(`${findings}/verdict.md`);
    expect(binding?.isDirectory).toBe(false);
  });

  it("prefers the cwd candidate when both cwd and a directory contain the name", () => {
    const binding = selectChipBinding(
      candidatesFor([findings]),
      lookupExisting({
        [`${cwd}/verdict.md`]: "file",
        [`${findings}/verdict.md`]: "file",
      }),
    );
    expect(binding?.meta.filePath).toBe(`${cwd}/verdict.md`);
  });

  it("waits (null) while a higher-priority candidate is still unverified", () => {
    // cwd candidate unverified (undefined); must not skip ahead to the directory
    // candidate even though it is a confirmed file — the choice stays deterministic.
    const binding = selectChipBinding(candidatesFor([findings]), (filePath) =>
      filePath === `${findings}/verdict.md` ? { exists: true, isDirectory: false } : undefined,
    );
    expect(binding).toBeNull();
  });

  it("returns null when every candidate is confirmed missing", () => {
    expect(
      selectChipBinding(candidatesFor([findings]), () => ({ exists: false, isDirectory: false })),
    ).toBeNull();
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

describe("matchTextPathSpans", () => {
  it("finds two absolute paths in a prose sentence joined by 'and'", () => {
    const text =
      "See /home/carl/findings/verdict.md and /home/carl/register/findings_register.md for details.";
    const spans = matchTextPathSpans(text);
    expect(spans.map((span) => span.text)).toEqual([
      "/home/carl/findings/verdict.md",
      "/home/carl/register/findings_register.md",
    ]);
    // Offsets must point back at the trimmed substring in the original text.
    for (const span of spans) {
      expect(text.slice(span.start, span.end)).toBe(span.text);
    }
  });

  it("trims trailing punctuation and unbalanced delimiters", () => {
    expect(matchTextPathSpans("edit /home/carl/verdict.md.").map((s) => s.text)).toEqual([
      "/home/carl/verdict.md",
    ]);
    expect(matchTextPathSpans("(/home/carl/verdict.md)").map((s) => s.text)).toEqual([
      "/home/carl/verdict.md",
    ]);
    expect(matchTextPathSpans("try ~/notes.md, then stop").map((s) => s.text)).toEqual([
      "~/notes.md",
    ]);
  });

  it("carries a :line:col suffix through the matched span", () => {
    expect(matchTextPathSpans("failed at /home/carl/x.ts:42:7 here").map((s) => s.text)).toEqual([
      "/home/carl/x.ts:42:7",
    ]);
  });

  it("does not match urls, slashed words, dates, or bare filenames", () => {
    expect(matchTextPathSpans("visit https://example.com/docs/guide.md now")).toEqual([]);
    expect(matchTextPathSpans("either and/or both a/b work")).toEqual([]);
    expect(matchTextPathSpans("dated 01/02/2026 today")).toEqual([]);
    expect(matchTextPathSpans("open verdict.md please")).toEqual([]);
  });

  it("extractTextPathCandidates returns just the trimmed strings", () => {
    expect(
      extractTextPathCandidates("a /home/carl/x.md and ./rel/y.ts:3 plus and/or noise"),
    ).toEqual(["/home/carl/x.md", "./rel/y.ts:3"]);
  });
});

describe("extractMessagePathCandidates", () => {
  it("includes prose and in-bounds fenced-code paths", () => {
    const text = [
      "Prose path /home/carl/verdict.md here.",
      "",
      "```text",
      "/home/carl/register.md",
      "```",
    ].join("\n");
    expect(extractMessagePathCandidates(text).sort()).toEqual(
      ["/home/carl/register.md", "/home/carl/verdict.md"].sort(),
    );
  });

  it("contributes NOTHING from an over-limit fenced block, but keeps prose eligible", () => {
    const codeLines = Array.from(
      { length: CODE_BLOCK_MAX_LINES + 1 },
      (_, index) => `/home/carl/gen/file${index}.md`,
    );
    const text = ["The real one is /home/carl/verdict.md.", "```text", ...codeLines, "```"].join(
      "\n",
    );
    const candidates = extractMessagePathCandidates(text);
    // Prose path survives; not one of the over-limit block's paths leaks in.
    expect(candidates).toContain("/home/carl/verdict.md");
    expect(candidates.some((candidate) => candidate.startsWith("/home/carl/gen/"))).toBe(false);
  });

  it("skips over-length lines inside an in-bounds block", () => {
    const longLine = `/home/carl/${"x".repeat(CODE_LINE_MAX_LENGTH)}.md`;
    const text = ["```text", longLine, "/home/carl/ok.md", "```"].join("\n");
    const candidates = extractMessagePathCandidates(text);
    expect(candidates).toContain("/home/carl/ok.md");
    expect(candidates).not.toContain(longLine);
  });

  it("caps the total number of discovered candidates", () => {
    const codeLines = Array.from(
      { length: CODE_BLOCK_MAX_LINES },
      (_, index) => `/home/carl/a/f${index}.md /home/carl/b/f${index}.md`,
    );
    const text = ["```text", ...codeLines, "```"].join("\n");
    expect(extractMessagePathCandidates(text).length).toBeLessThanOrEqual(
      MAX_MESSAGE_PATH_CANDIDATES,
    );
  });

  it("does not treat an indented '```' inside prose as an unterminated fence swallowing later paths", () => {
    // A normal prose message with a real fenced block, then more prose paths.
    const text = ["```ts", "const a = 1;", "```", "Afterwards see /home/carl/after.md too."].join(
      "\n",
    );
    expect(extractMessagePathCandidates(text)).toContain("/home/carl/after.md");
    expect(resolveInlineCodeFileLinkMeta("/Users/julius/project/AGENTS.md")).toMatchObject({
      targetPath: "/Users/julius/project/AGENTS.md",
    });
    expect(resolveInlineCodeFileLinkMeta("/usr/local/bin/tool")).toMatchObject({
      targetPath: "/usr/local/bin/tool",
    });
    expect(resolveInlineCodeFileLinkMeta("/workspace/Makefile")).toMatchObject({
      basename: "Makefile",
    });
    expect(resolveInlineCodeFileLinkMeta("/chat/settings")).toBeNull();
  });

  it("links windows drive paths", () => {
    expect(resolveInlineCodeFileLinkMeta("C:\\Users\\mike\\project\\src\\main.ts")).toMatchObject({
      basename: "main.ts",
    });
  });

  it("links relative paths with line positions", () => {
    expect(
      resolveInlineCodeFileLinkMeta("src/processRunner.ts:71", "/Users/julius/project"),
    ).toMatchObject({
      targetPath: "/Users/julius/project/src/processRunner.ts:71",
      line: 71,
    });
  });

  it("links bare filenames with a line suffix", () => {
    expect(resolveInlineCodeFileLinkMeta("script.ts:10", "/Users/julius/project")).toMatchObject({
      targetPath: "/Users/julius/project/script.ts:10",
      line: 10,
    });
    // loom divergence: a bare `AGENTS.md` links too (see the known-extension
    // case above) — chips are existence-verified before they render.
    expect(resolveInlineCodeFileLinkMeta("AGENTS.md", "/Users/julius/project")).not.toBeNull();
  });

  it("links extensionless bare filenames with a line suffix", () => {
    expect(resolveInlineCodeFileLinkMeta("Makefile:12", "/Users/julius/project")).toMatchObject({
      targetPath: "/Users/julius/project/Makefile:12",
      basename: "Makefile",
      line: 12,
    });
    expect(resolveInlineCodeFileLinkMeta("Dockerfile:8:2", "/Users/julius/project")).toMatchObject({
      line: 8,
      column: 2,
    });
    expect(resolveInlineCodeFileLinkMeta("Makefile:12")).toBeNull();
  });

  it("does not treat arbitrary name:digits shapes as files", () => {
    expect(resolveInlineCodeFileLinkMeta("error:1", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("TODO:12", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("exit:0", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("port:3000", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("http:80", "/Users/julius/project")).toBeNull();
  });

  it("links dot-prefixed relative paths without extensions", () => {
    expect(
      resolveInlineCodeFileLinkMeta("./scripts/deploy", "/Users/julius/project"),
    ).toMatchObject({
      basename: "deploy",
    });
  });

  it("links relative windows-style paths by normalizing backslashes", () => {
    expect(resolveInlineCodeFileLinkMeta("src\\main.ts", "/Users/julius/project")).toMatchObject({
      targetPath: "/Users/julius/project/src/main.ts",
      basename: "main.ts",
    });
    expect(
      resolveInlineCodeFileLinkMeta(".\\scripts\\deploy", "/Users/julius/project"),
    ).toMatchObject({
      basename: "deploy",
    });
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

  it("still links files whose extension merely resembles a tld", () => {
    expect(resolveInlineCodeFileLinkMeta("script.ts:10", "/Users/julius/project")).not.toBeNull();
    expect(resolveInlineCodeFileLinkMeta("src/setup.sh:3", "/Users/julius/project")).not.toBeNull();
    expect(resolveInlineCodeFileLinkMeta("Makefile.in:12", "/Users/julius/project")).not.toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("conf.d/nginx.conf", "/Users/julius/project"),
    ).not.toBeNull();
  });

  it("prefers file over country-code host when a line suffix is present", () => {
    expect(resolveInlineCodeFileLinkMeta("script.pl:10", "/Users/julius/project")).toMatchObject({
      targetPath: "/Users/julius/project/script.pl:10",
      line: 10,
    });
    expect(resolveInlineCodeFileLinkMeta("model.pt:3", "/Users/julius/project")).not.toBeNull();
    expect(
      resolveInlineCodeFileLinkMeta("example.pl/index.html", "/Users/julius/project"),
    ).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("example.com:8080", "/Users/julius/project")).toBeNull();
  });

  it("ignores commands, flags, and expressions", () => {
    expect(resolveInlineCodeFileLinkMeta("git worktree list --porcelain")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("node.meta", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("pnpm install", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("src/**/*.ts", "/Users/julius/project")).toBeNull();
  });

  it("ignores extension-less relative segments like git refs and directories", () => {
    expect(resolveInlineCodeFileLinkMeta("origin/main", "/Users/julius/project")).toBeNull();
    expect(resolveInlineCodeFileLinkMeta("apps/web", "/Users/julius/project")).toBeNull();
  });

  it("ignores external urls", () => {
    expect(resolveInlineCodeFileLinkMeta("https://example.com/docs.html")).toBeNull();
  });

  it("ignores relative paths without a cwd to resolve against", () => {
    expect(resolveInlineCodeFileLinkMeta("docs/internals/workspace-layout.md")).toBeNull();
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
