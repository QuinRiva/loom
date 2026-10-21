import { DOCUMENT_QUERY_ROLE, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { shell, workstream } from "../preview/loomFixtures";
import { documentQueryPinsOf } from "./documentQueryPins";

const AUTHOR = ThreadId.make("author");
const FILE = "plans/x/plan.mdx";

const queryThread = (
  id: string,
  fields: {
    authorId?: ThreadId;
    filePath?: string;
    askedAt?: ReadonlyArray<string>;
    outcome?: "done" | null;
    archived?: boolean;
  } = {},
) => {
  const threadId = ThreadId.make(id);
  return shell(
    id,
    workstream(threadId, {
      parentThreadId: null,
      rootThreadId: threadId,
      role: DOCUMENT_QUERY_ROLE,
      forkFromThreadId: fields.authorId ?? AUTHOR,
      outcome: fields.outcome ?? null,
      documentQuery: {
        filePath: fields.filePath ?? FILE,
        revision: "abcdefabcdef",
        authorSource: "signature",
        questions: (fields.askedAt ?? ["2026-10-21T10:00:00.000Z"]).map((askedAt) => ({
          messageId: `message:${id}:${askedAt}` as never,
          askedAt,
          anchor: { anchorKind: "text", textQuote: `quote at ${askedAt}` },
          quotedText: `quote at ${askedAt}`,
          sectionTitle: "§2",
        })),
        promotions: [],
      },
    }),
    fields.archived ? { archivedAt: DateTime.makeUnsafe("2026-10-21T11:00:00.000Z") } : {},
  );
};

describe("documentQueryPinsOf", () => {
  it("flattens the live query threads' questions on this author and file, oldest first", () => {
    const pins = documentQueryPinsOf(
      [
        queryThread("q1", { askedAt: ["2026-10-21T10:05:00.000Z", "2026-10-21T10:01:00.000Z"] }),
        queryThread("q2", { askedAt: ["2026-10-21T10:03:00.000Z"] }),
      ],
      AUTHOR,
      FILE,
    );
    expect(pins.map((pin) => [pin.queryThreadId, pin.askedAt])).toEqual([
      ["q1", "2026-10-21T10:01:00.000Z"],
      ["q2", "2026-10-21T10:03:00.000Z"],
      ["q1", "2026-10-21T10:05:00.000Z"],
    ]);
    expect(pins[0]!.quotedText).toBe("quote at 2026-10-21T10:01:00.000Z");
    expect(pins[0]!.anchor.textQuote).toBe("quote at 2026-10-21T10:01:00.000Z");
  });

  it("draws nothing for archived, settled, other-author, other-file or non-query threads", () => {
    const plain = shell("plain", workstream(ThreadId.make("plain"), { forkFromThreadId: AUTHOR }));
    expect(
      documentQueryPinsOf(
        [
          queryThread("archived", { archived: true, outcome: "done" }),
          queryThread("done", { outcome: "done" }),
          queryThread("other-author", { authorId: ThreadId.make("someone-else") }),
          queryThread("other-file", { filePath: "plans/y/plan.mdx" }),
          plain,
        ],
        AUTHOR,
        FILE,
      ),
    ).toEqual([]);
  });
});
