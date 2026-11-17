import { ThreadId, type LoomReviewAuthorshipResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { authorshipOf, narrowAuthorship } from "./authorship";

const commit = (sha: string, thread: string) => ({
  sha,
  subject: sha,
  gitAuthor: "Loom agent",
  authoredAt: "2026-11-17T05:13:53Z",
  threadIds: [ThreadId.make(thread)],
});
const thread = (id: string) => ({
  threadId: ThreadId.make(id),
  title: id,
  role: "coder",
  archived: false,
  lastRunAt: null,
});

// The branch: `early` wrote lines 1-10 of config.ts before the message; `late` rewrote 4-5 after it.
const reply: LoomReviewAuthorshipResult = {
  mergeBase: "base",
  headSha: "head",
  commits: [commit("aaa", "early"), commit("bbb", "late")],
  threads: [thread("early"), thread("late")],
  files: [
    {
      path: "src/config.ts",
      runs: [
        [1, 3, 0],
        [4, 5, 1],
        [6, 10, 0],
      ],
    },
    { path: "src/other.ts", runs: [[1, 2, 0]] },
  ],
  incomplete: false,
};

// "Since your message": line 4 and 5 replaced, line 6 kept as context.
const patch = [
  "diff --git a/src/config.ts b/src/config.ts",
  "--- a/src/config.ts",
  "+++ b/src/config.ts",
  "@@ -3,4 +3,4 @@",
  " three",
  "-four",
  "-five",
  "+FOUR",
  "+FIVE",
  " six",
  "",
].join("\n");

describe("narrowAuthorship", () => {
  it("names only the authors of the lines the interval adds", () => {
    const authorship = authorshipOf(narrowAuthorship(reply, patch));
    expect(authorship.groups.map((group) => group.key)).toEqual(["thread:late"]);
    expect(authorship.at("src/config.ts", 4)?.group.key).toBe("thread:late");
    // Context lines the branch changed before the message carry no author in the hunk label.
    expect(authorship.between("src/config.ts", 3, 6).map((owner) => owner.sha)).toEqual(["bbb"]);
    expect(authorship.at("src/other.ts", 1)).toBeNull();
  });
});
