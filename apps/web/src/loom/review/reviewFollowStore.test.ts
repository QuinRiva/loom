import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { useDiffPanelStore } from "../../diffPanelStore";
import { useConversationJumpStore } from "../conversationJump";
import { useReviewBaselineStore } from "./reviewBaselineStore";
import {
  followReviewToAuthor,
  resolveReviewFollow,
  useReviewFollowStore,
} from "./reviewFollowStore";

const environmentId = EnvironmentId.make("environment-1");
const REVIEWING = scopeThreadRef(environmentId, ThreadId.make("reviewing"));
const AUTHOR = scopeThreadRef(environmentId, ThreadId.make("author"));

function setup() {
  useReviewFollowStore.setState({ followByThreadKey: {}, focusByThreadKey: {} });
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  useReviewBaselineStore.setState({ intervalIdByThreadKey: {}, authorFilterByThreadKey: {} });
  useConversationJumpStore.setState({ request: null });
}

describe("following a review to its author", () => {
  it("writes the follow and the jump, and never the author's own diff state", () => {
    setup();
    useDiffPanelStore.getState().selectBranchBaseRef(REVIEWING, "origin/main");
    useReviewBaselineStore.getState().selectInterval(REVIEWING, "live");
    followReviewToAuthor({
      reviewing: REVIEWING,
      author: AUTHOR,
      authoredAt: "2026-11-17T12:46:04+11:00",
    });

    expect(useReviewFollowStore.getState().followByThreadKey[scopedThreadKey(AUTHOR)]).toEqual(
      REVIEWING,
    );
    expect(useConversationJumpStore.getState().request).toEqual({
      threadId: AUTHOR.threadId,
      at: "2026-11-17T01:46:04.000Z",
    });
    const authorKey = scopedThreadKey(AUTHOR);
    expect(useDiffPanelStore.getState().byThreadKey[authorKey]).toBeUndefined();
    expect(useDiffPanelStore.getState().branchBaseRefByThreadKey[authorKey]).toBeUndefined();
    expect(useReviewBaselineStore.getState().intervalIdByThreadKey[authorKey]).toBeUndefined();
  });

  it("only parks the jump when the author is the reviewing thread", () => {
    setup();
    followReviewToAuthor({
      reviewing: REVIEWING,
      author: REVIEWING,
      authoredAt: "2026-11-17T01:00:00Z",
    });
    expect(useReviewFollowStore.getState().followByThreadKey).toEqual({});
    expect(useConversationJumpStore.getState().request?.threadId).toBe(REVIEWING.threadId);
  });
});

describe("resolveReviewFollow", () => {
  const resolve = (input: Partial<Parameters<typeof resolveReviewFollow>[0]>) =>
    resolveReviewFollow({
      routed: AUTHOR,
      reviewing: REVIEWING,
      shell: "absent",
      family: "pending",
      shellless: "pending",
      ...input,
    }).threadRef;

  it("resolves a follow to a thread that is gone to the routed thread", () => {
    expect(resolve({ shell: "deleted" })).toBe(AUTHOR);
    expect(resolve({ family: "settled", shellless: "missing" })).toBe(AUTHOR);
  });

  it("keeps a follow whose reviewing thread's shell is only absent", () => {
    expect(resolve({ shell: "present" })).toBe(REVIEWING);
    expect(resolve({})).toBe(REVIEWING);
    expect(resolve({ family: "failed", shellless: "missing" })).toBe(REVIEWING);
    expect(resolve({ family: "settled", shellless: "pending" })).toBe(REVIEWING);
    expect(resolve({ family: "pending", shellless: "missing" })).toBe(REVIEWING);
  });

  it("reads the routed thread when nothing is followed", () => {
    expect(resolve({ reviewing: null, shell: "present" })).toBe(AUTHOR);
  });
});
