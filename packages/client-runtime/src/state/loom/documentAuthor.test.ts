import { DOCUMENT_QUERY_ROLE, type DocumentQueryAuthorResult, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { documentFollowTarget } from "./documentAuthor.ts";

const viewer = ThreadId.make("orchestrator");
const planner = ThreadId.make("planner");

const signedBy = (
  author: ThreadId,
  overrides: Partial<DocumentQueryAuthorResult> = {},
): DocumentQueryAuthorResult => ({
  authorThreadId: author,
  authorTitle: "Planner: intent brief",
  authorSource: "signature",
  filePath: "plans/x/intent.mdx",
  authoringSignature: true,
  authorArchived: false,
  sameFile: true,
  laterEditors: [],
  ...overrides,
});

describe("documentFollowTarget", () => {
  it("follows only another live author's own signature on the same file", () => {
    const follows = (result: DocumentQueryAuthorResult, role: string | null = null) =>
      documentFollowTarget(result, viewer, role) !== null;
    expect(follows(signedBy(planner))).toBe(true);
    expect(follows(signedBy(viewer))).toBe(false);
    expect(follows(signedBy(planner, { authorSource: "viewing-thread" }))).toBe(false);
    expect(follows(signedBy(planner, { authoringSignature: false }))).toBe(false);
    expect(follows(signedBy(planner, { authorArchived: true }))).toBe(false);
    expect(follows(signedBy(planner, { sameFile: false }))).toBe(false);
    expect(follows(signedBy(planner), DOCUMENT_QUERY_ROLE)).toBe(false);
  });
});
