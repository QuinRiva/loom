import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { migrateDiffPanelState, useDiffPanelStore } from "../../diffPanelStore";
import { useReviewBaselineStore } from "./reviewBaselineStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));
const OTHER_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-2"));
const KEY = scopedThreadKey(THREAD_REF);

describe("diffPanelStore v5 migration", () => {
  it("drops a persisted By coder selection and keeps every other choice", () => {
    const turn = { kind: "turn", turnId: "run-1", filePath: null, revealRequestId: 2 };
    expect(
      migrateDiffPanelState(
        {
          byThreadKey: {
            a: { kind: "coder", threadId: "child-1", turnId: null },
            b: turn,
            c: { kind: "branch", baseRef: "origin/main" },
          },
          branchBaseRefByThreadKey: { c: "origin/main" },
        },
        4,
      ),
    ).toEqual({
      byThreadKey: { b: turn, c: { kind: "branch", baseRef: "origin/main" } },
      branchBaseRefByThreadKey: { c: "origin/main" },
    });
  });

  it("resets state older than v3", () => {
    expect(migrateDiffPanelState({ byThreadKey: { a: { kind: "unstaged" } } }, 2)).toEqual({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
    });
  });
});

describe("reviewBaselineStore", () => {
  beforeEach(() => {
    useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
    useReviewBaselineStore.setState({ intervalIdByThreadKey: {}, sources: "everything" });
  });

  it("seeds the live interval once, never over a recorded choice", () => {
    useReviewBaselineStore.getState().seedLive(THREAD_REF);
    expect(useReviewBaselineStore.getState().intervalIdByThreadKey[KEY]).toBe("live");
    useReviewBaselineStore.getState().selectInterval(THREAD_REF, null);
    useReviewBaselineStore.getState().seedLive(THREAD_REF);
    expect(useReviewBaselineStore.getState().intervalIdByThreadKey[KEY]).toBeNull();
  });

  it("opening the panel on Changes keeps the interval; picking a turn clears it", () => {
    useReviewBaselineStore.getState().selectInterval(THREAD_REF, "live");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");
    useDiffPanelStore.getState().reconcileTurnSelection(THREAD_REF, [RunId.make("run-1")]);
    expect(useReviewBaselineStore.getState().intervalIdByThreadKey[KEY]).toBe("live");
  });

  it("a turn picked on a thread never seen yet is not overridden by the seed", () => {
    useDiffPanelStore.getState().selectTurn(THREAD_REF, RunId.make("run-1"));
    useReviewBaselineStore.getState().seedLive(THREAD_REF);
    expect(useReviewBaselineStore.getState().intervalIdByThreadKey[KEY]).toBeNull();
  });

  it("picking a turn for a thread clears that thread's interval only", () => {
    useReviewBaselineStore.getState().selectInterval(THREAD_REF, "live");
    useReviewBaselineStore.getState().selectInterval(OTHER_REF, "message-2");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, RunId.make("run-1"));
    expect(useReviewBaselineStore.getState().intervalIdByThreadKey).toEqual({
      [KEY]: null,
      [scopedThreadKey(OTHER_REF)]: "message-2",
    });
    // Choosing an interval leaves upstream's selection as it was.
    useReviewBaselineStore.getState().selectInterval(THREAD_REF, "live");
    expect(useDiffPanelStore.getState().byThreadKey[KEY]?.kind).toBe("turn");
  });
});
