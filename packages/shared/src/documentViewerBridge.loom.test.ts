import { describe, expect, it } from "vite-plus/test";

import {
  acceptDocumentViewerPageMessage,
  readDocumentViewerAppMessage,
} from "./documentViewerBridge.loom.ts";

const token = "0123456789abcdef-token";
const accept = (message: unknown) =>
  acceptDocumentViewerPageMessage(JSON.stringify(message), token);

// A document's <Prototype> frame can reach the app's message channel on Android but never
// sees the token, so everything it can post must be dropped except a harmless `ready`.
describe("acceptDocumentViewerPageMessage", () => {
  it("takes `ready` without a token, since it precedes init", () => {
    expect(accept({ type: "ready", protocol: 1 })).toEqual({ type: "ready", protocol: 1 });
  });

  it("takes a message carrying this load's token", () => {
    expect(accept({ type: "link", token, href: "plans/x.mdx" })).toEqual({
      type: "link",
      token,
      href: "plans/x.mdx",
    });
  });

  it("drops a message with no token or another load's token", () => {
    expect(accept({ type: "link", href: "https://example.com" })).toBeNull();
    expect(
      accept({ type: "image-request", token: "another-load-token-0000", id: 1, path: "/x.png" }),
    ).toBeNull();
  });

  it("drops unknown types, malformed fields and non-JSON", () => {
    expect(accept({ type: "comment-upsert", token, record: {} })).toBeNull();
    expect(accept({ type: "image-request", token, id: "1", path: "/x.png" })).toBeNull();
    expect(acceptDocumentViewerPageMessage("not json", token)).toBeNull();
  });

  it("ignores fields it does not know, so a newer page still talks to this app", () => {
    expect(accept({ type: "rendered", token, ok: true, later: 1 })).toEqual({
      type: "rendered",
      token,
      ok: true,
    });
  });
});

const answerRecord = {
  version: 1,
  kind: "review-comment",
  contextId: "review-comment_mdx-question-plans-x-intent-mdx-go-0123",
  label: "intent.mdx answer: go",
  sectionId: "file:plans/x/intent.mdx",
  sectionTitle: "intent.mdx",
  filePath: "plans/x/intent.mdx",
  startIndex: 0,
  endIndex: 0,
  rangeLabel: "answer: go",
  text: 'Q: Build it? → chose: "Yes"',
  diff: "",
  mdxAnchor: {
    anchor: { anchorKind: "visual", targetKind: "control", blockType: "question-form" },
    quotedText: "Build it?",
  },
};

describe("answers over the bridge", () => {
  it("takes an answer only as a valid review record carrying this load's token", () => {
    expect(accept({ type: "comment-upsert", token, record: answerRecord })).toEqual({
      type: "comment-upsert",
      token,
      record: answerRecord,
    });
    expect(accept({ type: "comment-upsert", record: answerRecord })).toBeNull();
    expect(
      accept({ type: "comment-upsert", token, record: { ...answerRecord, kind: "terminal" } }),
    ).toBeNull();
    expect(accept({ type: "comment-remove", token, contextId: answerRecord.contextId })).toEqual({
      type: "comment-remove",
      token,
      contextId: answerRecord.contextId,
    });
  });

  // The app and the server are installed apart, so either can be one PR ahead of the other.
  it("lets a page read an init with fields it does not know, and drop messages it does not", () => {
    const init = {
      type: "init",
      protocol: 1,
      token,
      source: "# Doc",
      filePath: "plans/x/plan.mdx",
      baseDir: "/repo/plans/x",
      appearance: "dark",
    };
    expect(readDocumentViewerAppMessage({ ...init, later: { a: 1 } })).toEqual(init);
    expect(
      readDocumentViewerAppMessage({
        ...init,
        answers: { draftTarget: "env:thread", present: ["a"] },
      }),
    ).toMatchObject({ answers: { draftTarget: "env:thread", present: ["a"] } });
    expect(readDocumentViewerAppMessage({ type: "answers-later", present: [] })).toBeNull();
  });
});
