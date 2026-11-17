import type { LoomReviewAuthorshipThread, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { authorOf } from "./reviewAuthorship.loom.ts";

const thread = (id: string, archived = false): LoomReviewAuthorshipThread => ({
  threadId: id as ThreadId,
  title: id,
  role: "coder",
  archived,
  lastRunAt: null,
});
const threads = [thread("coder"), thread("old", true)];
const commit = (...ids: ReadonlyArray<string>) => ({
  threadIds: ids as ReadonlyArray<ThreadId>,
  gitAuthor: "Carl",
});

describe("authorOf", () => {
  it("names a thread only for exactly one trailer naming a thread held here", () => {
    expect(authorOf(commit("coder"), threads)).toEqual({ kind: "thread", thread: threads[0] });
    expect(authorOf(commit("old"), threads)).toEqual({ kind: "thread", thread: threads[1] });
    expect(authorOf(commit("coder", "old"), threads)).toEqual({
      kind: "threads",
      threadIds: ["coder", "old"],
    });
    expect(authorOf(commit(), threads)).toEqual({ kind: "git", name: "Carl" });
    expect(authorOf(commit("deleted-or-elsewhere"), threads)).toEqual({
      kind: "git",
      name: "Carl",
    });
  });
});
