import { ThreadId, type LoomReviewAuthorshipResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { authorshipOf } from "./authorship";
import { type CodeQuestion, marks } from "./codeQueryMarks";

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
// `early` wrote lines 1-10 of config.ts; `late` then rewrote 4-5.
const reply = (runs: ReadonlyArray<[number, number, number]>): LoomReviewAuthorshipResult => ({
  mergeBase: "base",
  headSha: "head",
  commits: [commit("aaa", "early"), commit("bbb", "late")],
  threads: [thread("early"), thread("late")],
  files: [{ path: "src/config.ts", runs: runs.map((run) => [...run]) }],
  incomplete: false,
});
const question = (fields: Partial<CodeQuestion>): CodeQuestion => ({
  queryThreadId: ThreadId.make("query"),
  authorThreadId: ThreadId.make("early"),
  askedAt: "2026-11-18T01:00:00.000Z",
  commitSha: "aaa",
  ownerShas: ["aaa"],
  commitChanged: "lines",
  filePath: "src/config.ts",
  startLine: 2,
  endLine: 6,
  excerpt: "",
  ...fields,
});
// The file as it reads now: line n is "line n", unless the test moves it.
const marked = (
  q: CodeQuestion,
  runs: ReadonlyArray<[number, number, number]>,
  text: (line: number) => string = (line) => `line ${line}`,
) => {
  const authorship = authorshipOf(reply(runs));
  return Array.from({ length: 12 }, (_, i) => i + 1).filter((line) =>
    marks(q, "src/config.ts", line, authorship.at("src/config.ts", line), text(line)),
  );
};

describe("code question marks", () => {
  it("leave the lines a later commit rewrote", () => {
    expect(marked(question({}), [[1, 10, 0]])).toEqual([2, 3, 4, 5, 6]);
    expect(
      marked(question({}), [
        [1, 3, 0],
        [4, 5, 1],
        [6, 10, 0],
      ]),
    ).toEqual([2, 3, 6]);
  });

  it("stay on lines a later commit owns when the question was put to the earlier author", () => {
    // Asked from the earlier-author row: the named commit is `aaa`, the lines' owner `bbb`.
    const earlier = question({ commitSha: "aaa", ownerShas: ["bbb"], startLine: 4, endLine: 5 });
    expect(
      marked(earlier, [
        [1, 3, 0],
        [4, 5, 1],
        [6, 10, 0],
      ]),
    ).toEqual([4, 5]);
  });

  it("are not drawn for a commit outside the answer, or on another file", () => {
    expect(marked(question({ commitSha: "zzz", ownerShas: ["zzz"] }), [[1, 10, 0]])).toEqual([]);
    expect(marked(question({ filePath: "src/other.ts" }), [[1, 10, 0]])).toEqual([]);
  });

  it("on lines a thread only shares a file with, hold while the lines are unowned and unmoved", () => {
    // Asked about lines 11 and 12, which no branch commit wrote, of a thread that changed the file.
    const others = question({
      commitChanged: "file",
      ownerShas: [],
      startLine: 11,
      endLine: 12,
      excerpt: "@@ -11,2 +11,2 @@\n line 11\n line 12",
    });
    expect(marked(others, [[1, 10, 0]])).toEqual([11, 12]);
    // A branch commit now owns line 12: its mark goes.
    expect(
      marked(others, [
        [1, 10, 0],
        [12, 12, 1],
      ]),
    ).toEqual([11]);
    // A line inserted above moved them down: the text no longer matches, so no mark, not a neighbour's.
    expect(marked(others, [[1, 10, 0]], (line) => `line ${line - 1}`)).toEqual([]);
  });
});
