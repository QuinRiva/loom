// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CODE_PATH_LINK_CLASS_NAME,
  decorateCodeBlockPaths,
  type CodePathTarget,
} from "./codePathDecorations";
import type { MarkdownFileLinkMeta } from "./markdown-links";

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

const existingFileTarget =
  (existing: ReadonlySet<string>) =>
  (rawPath: string): CodePathTarget | null =>
    existing.has(rawPath) ? { meta: metaFor(rawPath), isDirectory: false } : null;

describe("decorateCodeBlockPaths", () => {
  it("wraps existence-verified paths without changing the block text", () => {
    const line1 = "/home/carl/findings/verdict.md";
    const line2 = "/home/carl/register/findings_register.md";
    const container = shikiBlock([line1, line2]);
    const originalText = container.textContent;

    decorateCodeBlockPaths(container, {
      resolveTarget: existingFileTarget(new Set([line1, line2])),
      onActivate: () => {},
    });

    const links = container.querySelectorAll(`a.${CODE_PATH_LINK_CLASS_NAME}`);
    expect([...links].map((link) => link.textContent)).toEqual([line1, line2]);
    // Copy fidelity: wrapping only reparents text nodes.
    expect(container.textContent).toBe(originalText);
  });

  it("leaves non-existent lookalike paths as plain text", () => {
    const real = "/home/carl/verdict.md";
    const container = shikiBlock([`${real} /home/carl/missing.md`]);

    decorateCodeBlockPaths(container, {
      resolveTarget: existingFileTarget(new Set([real])),
      onActivate: () => {},
    });

    const links = container.querySelectorAll(`a.${CODE_PATH_LINK_CLASS_NAME}`);
    expect([...links].map((link) => link.textContent)).toEqual([real]);
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
      .querySelector(`a.${CODE_PATH_LINK_CLASS_NAME}`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0]?.[0]?.meta.filePath).toBe(path);
  });

  it("is idempotent across repeated passes (e.g. existence revalidation)", () => {
    const path = "/home/carl/verdict.md";
    const container = shikiBlock([path]);
    const options = {
      resolveTarget: existingFileTarget(new Set([path])),
      onActivate: () => {},
    };

    decorateCodeBlockPaths(container, options);
    const originalText = container.textContent;
    decorateCodeBlockPaths(container, options);

    expect(container.querySelectorAll(`a.${CODE_PATH_LINK_CLASS_NAME}`)).toHaveLength(1);
    expect(container.textContent).toBe(originalText);
  });

  it("wraps only the path substring within a longer line", () => {
    const path = "/home/carl/verdict.md";
    const container = shikiBlock([`wrote ${path} ok`]);

    decorateCodeBlockPaths(container, {
      resolveTarget: existingFileTarget(new Set([path])),
      onActivate: () => {},
    });

    const link = container.querySelector(`a.${CODE_PATH_LINK_CLASS_NAME}`);
    expect(link?.textContent).toBe(path);
    expect(container.textContent).toBe(`wrote ${path} ok\n`);
  });
});
