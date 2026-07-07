import { describe, expect, it } from "vite-plus/test";

import { useLoomScrollStore } from "./loomScrollStore";

describe("useLoomScrollStore", () => {
  it("requestScrollToDispatch sets scrollRequest and consultReveal", () => {
    useLoomScrollStore
      .getState()
      .requestScrollToDispatch("thread-1", "2026-01-01T00:00:00.000Z", "target-1");
    const state = useLoomScrollStore.getState();
    expect(state.scrollRequest).toEqual({
      threadId: "thread-1",
      anchorAtIso: "2026-01-01T00:00:00.000Z",
    });
    expect(state.consultReveal).toEqual({ threadId: "thread-1", targetThreadId: "target-1" });
  });

  it("requestScrollToDispatch without a consult target leaves consultReveal null", () => {
    useLoomScrollStore.getState().requestScrollToDispatch("thread-2", "2026-02-02T00:00:00.000Z");
    const state = useLoomScrollStore.getState();
    expect(state.scrollRequest).toEqual({
      threadId: "thread-2",
      anchorAtIso: "2026-02-02T00:00:00.000Z",
    });
    expect(state.consultReveal).toBeNull();
  });

  it("clears are idempotent no-ops when already null", () => {
    useLoomScrollStore.getState().clearScrollRequest();
    useLoomScrollStore.getState().clearConsultReveal();
    const before = useLoomScrollStore.getState();
    expect(before.scrollRequest).toBeNull();
    expect(before.consultReveal).toBeNull();

    // Calling clear again returns the same state object (identity guard).
    useLoomScrollStore.getState().clearScrollRequest();
    useLoomScrollStore.getState().clearConsultReveal();
    const after = useLoomScrollStore.getState();
    expect(after.scrollRequest).toBeNull();
    expect(after.consultReveal).toBeNull();
  });

  it("clear removes an existing request", () => {
    useLoomScrollStore
      .getState()
      .requestScrollToDispatch("thread-3", "2026-03-03T00:00:00.000Z", "target-3");
    useLoomScrollStore.getState().clearScrollRequest();
    useLoomScrollStore.getState().clearConsultReveal();
    const state = useLoomScrollStore.getState();
    expect(state.scrollRequest).toBeNull();
    expect(state.consultReveal).toBeNull();
  });
});
