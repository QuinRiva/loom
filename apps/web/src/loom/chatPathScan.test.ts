// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";

import type { MarkdownFileLinkMeta } from "~/markdown-links";

import { extractMessagePathCandidates, matchTextPathSpans } from "./chatPathScan";
import { SCANNED_PATH_LINK_CLASS_NAME, decorateCodeBlockPaths } from "./codePathDecorations";

describe("matchTextPathSpans", () => {
  it("finds prose paths and skips the shapes that only look like one", () => {
    const text =
      "See /Users/j/p/_findings/verdict.md and src/markdown-links.ts:42, but not 01/02/2026, and/or, a/b, or https://example.com/docs/guide.md.";
    expect(matchTextPathSpans(text).map((span) => span.text)).toEqual([
      "/Users/j/p/_findings/verdict.md",
      "src/markdown-links.ts:42",
    ]);
  });

  it("reports offsets of the trimmed span so the caller can slice the source", () => {
    const text = "(see docs/guide.md).";
    const [span] = matchTextPathSpans(text);
    expect(text.slice(span?.start, span?.end)).toBe("docs/guide.md");
  });
});

describe("extractMessagePathCandidates", () => {
  it("collects prose and fenced-block paths, prose first", () => {
    expect(
      extractMessagePathCandidates(
        "Prose /a/one.md here.\n\n```text\n/a/two.md\n```\n\nMore /a/three.md.",
      ),
    ).toEqual(["/a/one.md", "/a/three.md", "/a/two.md"]);
  });

  it("skips an over-long fenced block entirely, matching the decorator's guard", () => {
    const huge = ["```text", ...Array.from({ length: 401 }, (_, i) => `/a/f${i}.md`), "```"].join(
      "\n",
    );
    expect(extractMessagePathCandidates(huge)).toEqual([]);
  });
});

function metaFor(filePath: string): MarkdownFileLinkMeta {
  return {
    filePath,
    targetPath: filePath,
    displayPath: filePath,
    workspaceRelativePath: null,
    basename: filePath.slice(filePath.lastIndexOf("/") + 1),
  };
}

/** Build a Shiki-like code block: one `.line` per line, each with a token span. */
function shikiBlock(lines: string[]): HTMLElement {
  const container = document.createElement("div");
  const code = document.createElement("code");
  for (const line of lines) {
    const lineSpan = document.createElement("span");
    lineSpan.className = "line";
    const token = document.createElement("span");
    token.style.color = "#abc";
    token.textContent = line;
    lineSpan.append(token);
    code.append(lineSpan, document.createTextNode("\n"));
  }
  container.append(code);
  return container;
}

const existingFileTarget = (existing: ReadonlySet<string>) => (rawPath: string) =>
  existing.has(rawPath) ? { meta: metaFor(rawPath) } : null;

describe("decorateCodeBlockPaths", () => {
  it("wraps verified paths without changing the block text", () => {
    const line1 = "/home/carl/findings/verdict.md";
    const line2 = "/home/carl/register/findings_register.md";
    const container = shikiBlock([line1, line2]);
    const originalText = container.textContent;

    decorateCodeBlockPaths(container, {
      resolveTarget: existingFileTarget(new Set([line1, line2])),
      onActivate: () => {},
    });

    expect(
      [...container.querySelectorAll(`a.${SCANNED_PATH_LINK_CLASS_NAME}`)].map(
        (a) => a.textContent,
      ),
    ).toEqual([line1, line2]);
    // Copy fidelity: wrapping only reparents existing text nodes.
    expect(container.textContent).toBe(originalText);
  });

  it("leaves unverified lookalike paths as plain text", () => {
    const real = "/home/carl/verdict.md";
    const container = shikiBlock([`${real} /home/carl/missing.md`]);

    decorateCodeBlockPaths(container, {
      resolveTarget: existingFileTarget(new Set([real])),
      onActivate: () => {},
    });

    expect(
      [...container.querySelectorAll(`a.${SCANNED_PATH_LINK_CLASS_NAME}`)].map(
        (a) => a.textContent,
      ),
    ).toEqual([real]);
  });

  it("activates the resolved target on click", () => {
    const path = "/home/carl/verdict.md";
    const container = shikiBlock([path]);
    const onActivate = vi.fn();

    decorateCodeBlockPaths(container, {
      resolveTarget: existingFileTarget(new Set([path])),
      onActivate,
    });

    container
      .querySelector(`a.${SCANNED_PATH_LINK_CLASS_NAME}`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0]?.[0]?.meta.filePath).toBe(path);
  });

  it("is idempotent across repeated passes (e.g. existence revalidation)", () => {
    const path = "/home/carl/verdict.md";
    const container = shikiBlock([`wrote ${path} ok`]);
    const options = { resolveTarget: existingFileTarget(new Set([path])), onActivate: () => {} };

    decorateCodeBlockPaths(container, options);
    decorateCodeBlockPaths(container, options);

    expect(container.querySelectorAll(`a.${SCANNED_PATH_LINK_CLASS_NAME}`)).toHaveLength(1);
    expect(container.textContent).toBe(`wrote ${path} ok\n`);
  });
});
