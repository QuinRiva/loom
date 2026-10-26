import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useComposerDraftStore } from "../composerDraftStore";
import type { MdxAnchorReviewCommentContext } from "../reviewCommentContext";
import { promotableExchangeAt } from "./DocumentQueryPromoteButton";
import { seedPromotedQueryComments } from "./useSeedPromotedQueryComments";
import { useWorkstreamUiStore } from "./workstreamUiStore";

const run = (n: number, userMessageId: string) => ({
  id: RunId.make(`run-${n}`),
  ordinal: n,
  userMessageId: MessageId.make(userMessageId),
});

describe("promotableExchangeAt", () => {
  const questions = [
    { messageId: MessageId.make("message:server:loom:query:q:1"), askedAt: "t1" },
    { messageId: MessageId.make("message:server:loom:query:q:2"), askedAt: "t2" },
  ];
  const runs = [
    run(1, "message:server:loom:query:q:1"),
    run(2, "message:typed-follow-up"),
    run(3, "message:server:loom:query-promote:q:abc"),
    run(4, "message:server:loom:query:q:2"),
  ];

  it("names the latest question at or before the answer's run; a promote reply has none", () => {
    expect(promotableExchangeAt(runs, questions, RunId.make("run-1"))).toBe("t1");
    // A follow-up typed in the thread continues the exchange it follows.
    expect(promotableExchangeAt(runs, questions, RunId.make("run-2"))).toBe("t1");
    expect(promotableExchangeAt(runs, questions, RunId.make("run-3"))).toBeNull();
    expect(promotableExchangeAt(runs, questions, RunId.make("run-4"))).toBe("t2");
    expect(promotableExchangeAt([run(1, "message:kickoff")], questions, RunId.make("run-1"))).toBe(
      null,
    );
  });
});

describe("seedPromotedQueryComments", () => {
  const author = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("author"));
  const chip = (id: string): MdxAnchorReviewCommentContext => ({
    kind: "mdx-anchor",
    id,
    filePath: "plans/x/plan.mdx",
    sectionId: "s2",
    sectionTitle: "2. Reads",
    rangeLabel: "promoted",
    text: "Say why the writer stays in-process.",
    anchor: { textQuote: "the writer stays" },
    quotedText: "the writer stays in-process",
    queryThreadId: ThreadId.make("query"),
    promotionId: id,
  });
  const chipIds = () =>
    (useComposerDraftStore.getState().getComposerDraft(author)?.reviewComments ?? []).map(
      (comment) => comment.id,
    );

  beforeEach(() => {
    useWorkstreamUiStore.setState({ seededPromotionIdsByThreadKey: {} });
    useComposerDraftStore.getState().clearComposerContent(author);
  });

  it("seeds each promotion once, and a deleted chip never comes back", () => {
    seedPromotedQueryComments(author, [chip("p1")]);
    expect(chipIds()).toEqual(["p1"]);
    seedPromotedQueryComments(author, [chip("p1")]);
    expect(chipIds()).toEqual(["p1"]);

    useComposerDraftStore.getState().removeReviewComment(author, "p1");
    seedPromotedQueryComments(author, [chip("p1"), chip("p2")]);
    expect(chipIds()).toEqual(["p2"]);
  });
});
