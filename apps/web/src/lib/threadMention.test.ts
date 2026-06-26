import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchThreadMentionItems, THREAD_MENTION_MATCH_LIMIT } from "./threadMention";
import type { SidebarThreadSummary } from "../types";

const thread = (id: string, title: string, extra: Partial<SidebarThreadSummary> = {}) =>
  ({
    id: id as ThreadId,
    title,
    role: "coder",
    status: "running",
    branch: "feature/x",
    worktreePath: null,
    ...extra,
  }) as SidebarThreadSummary;

describe("matchThreadMentionItems", () => {
  it("matches titles case-insensitively by substring", () => {
    const items = matchThreadMentionItems(
      [thread("a", "Liveness Detection"), thread("b", "unrelated")],
      "liveness",
      null,
    );
    expect(items.map((item) => item.threadId)).toEqual(["a"]);
    expect(items[0]?.label).toBe("Liveness Detection");
  });

  it("ranks earlier matches first, then by title", () => {
    const items = matchThreadMentionItems(
      [thread("a", "fix the loop bug"), thread("b", "loop detector")],
      "loop",
      null,
    );
    // "loop detector" matches at index 0, "fix the loop bug" at index 8.
    expect(items.map((item) => item.threadId)).toEqual(["b", "a"]);
  });

  it("excludes the active thread and untitled threads", () => {
    const items = matchThreadMentionItems(
      [thread("self", "anything"), thread("blank", "   "), thread("ok", "anything else")],
      "any",
      "self" as ThreadId,
    );
    expect(items.map((item) => item.threadId)).toEqual(["ok"]);
  });

  it("lists all (capped) for an empty query", () => {
    const many = Array.from({ length: 20 }, (_, i) => thread(`t${i}`, `thread ${i}`));
    const items = matchThreadMentionItems(many, "", null);
    expect(items).toHaveLength(THREAD_MENTION_MATCH_LIMIT);
  });

  it("carries a disambiguating role · status · location description", () => {
    const [item] = matchThreadMentionItems([thread("a", "x", { branch: "main" })], "x", null);
    expect(item?.description).toBe("coder · running · main");
  });
});
