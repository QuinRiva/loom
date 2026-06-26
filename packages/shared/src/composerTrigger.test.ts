import { describe, expect, it } from "vite-plus/test";

import {
  serializeComposerFileLink,
  serializeComposerMentionPath,
  serializeComposerThreadLink,
} from "./composerTrigger.ts";

describe("serializeComposerMentionPath", () => {
  it("keeps simple mention paths unquoted", () => {
    expect(serializeComposerMentionPath("src/index.ts")).toBe("src/index.ts");
  });

  it("quotes mention paths containing whitespace", () => {
    expect(serializeComposerMentionPath("docs/My File.md")).toBe('"docs/My File.md"');
  });

  it("escapes quoted mention path content", () => {
    expect(serializeComposerMentionPath('docs/My "File".md')).toBe('"docs/My \\"File\\".md"');
  });
});

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

describe("serializeComposerThreadLink", () => {
  it("emits the title-bearing thread link form", () => {
    expect(serializeComposerThreadLink("Refactor pass", "abc-123")).toBe(
      "[Refactor pass](thread://abc-123)",
    );
  });

  it("escapes brackets and backslashes in the title", () => {
    expect(serializeComposerThreadLink("Fix [urgent] \\bug", "t-1")).toBe(
      "[Fix \\[urgent\\] \\\\bug](thread://t-1)",
    );
  });

  it("collapses newlines and surrounding whitespace in the title", () => {
    expect(serializeComposerThreadLink("  Multi\nline   title  ", "t-2")).toBe(
      "[Multi line title](thread://t-2)",
    );
  });

  it("falls back to a placeholder label when the title is blank", () => {
    expect(serializeComposerThreadLink("   ", "t-3")).toBe("[thread](thread://t-3)");
  });
});
