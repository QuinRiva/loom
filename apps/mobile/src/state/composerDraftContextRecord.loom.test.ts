import { ComposerContextId, type ReviewCommentContextRecord } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-file-system", () => ({
  Directory: class {
    create() {}
    list() {
      return [];
    }
  },
  File: class {
    exists = false;
    create() {}
    write() {}
    async text() {
      return JSON.stringify({ schemaVersion: 1, drafts: {} });
    }
  },
  Paths: { document: { uri: "file:///documents" } },
}));
vi.mock("./assets", () => ({ assetEnvironment: {} }));
vi.mock("./attachments", () => ({ attachmentEnvironment: {} }));
vi.mock("./session", () => ({ environmentSession: {} }));

import { appAtomRegistry } from "./atom-registry";
import {
  removeComposerDraftContextRecord,
  upsertComposerDraftContextRecord,
} from "./composerDraftContextRecord.loom";
import { composerDraftsAtom, getComposerDraftSnapshot } from "./use-composer-drafts";

const KEY = "environment-1:thread-1";

const answer = (text: string): ReviewCommentContextRecord => ({
  version: 1,
  kind: "review-comment",
  contextId: ComposerContextId.make("review-comment_mdx-question-plans-x-intent-mdx-go-0123"),
  label: "intent.mdx answer: go",
  sectionId: "file:plans/x/intent.mdx",
  sectionTitle: "intent.mdx",
  filePath: "plans/x/intent.mdx",
  startIndex: 0,
  endIndex: 0,
  rangeLabel: "answer: go",
  text,
  diff: "",
  mdxAnchor: {
    anchor: { anchorKind: "visual", targetKind: "control", blockType: "question-form" },
    quotedText: "Build it?",
  },
});

const chip = formatComposerContextReference(answer(""));

afterEach(() => appAtomRegistry.set(composerDraftsAtom, {}));

describe("a document answer in the composer draft", () => {
  it("joins the end of the draft as one chip, and a re-answer replaces its record", () => {
    appAtomRegistry.set(composerDraftsAtom, { [KEY]: { text: "Looks good", attachments: [] } });
    expect(upsertComposerDraftContextRecord(KEY, answer('chose: "Yes"'))).toBe(true);
    expect(upsertComposerDraftContextRecord(KEY, answer('chose: "No"'))).toBe(true);
    const draft = getComposerDraftSnapshot(KEY);
    expect(draft.text).toBe(`Looks good ${chip} `);
    expect(draft.context?.records).toEqual([answer('chose: "No"')]);
  });

  it("leaves neither the chip nor its record once removed", () => {
    appAtomRegistry.set(composerDraftsAtom, { [KEY]: { text: "Looks good", attachments: [] } });
    upsertComposerDraftContextRecord(KEY, answer('chose: "Yes"'));
    removeComposerDraftContextRecord(KEY, answer("").contextId);
    const draft = getComposerDraftSnapshot(KEY);
    expect(draft.text).toBe("Looks good");
    expect(draft.context).toBeUndefined();
  });

  it("keeps the words around a chip the user moved into the middle of the text", () => {
    const record = answer('chose: "Yes"');
    appAtomRegistry.set(composerDraftsAtom, {
      [KEY]: {
        text: `First ${chip} then more`,
        context: { version: 1, records: [record] },
        attachments: [],
      },
    });
    removeComposerDraftContextRecord(KEY, record.contextId);
    expect(getComposerDraftSnapshot(KEY).text).toBe("First then more");
  });
});
