import { describe, expect, it } from "vite-plus/test";

import { shouldShowStagedBriefPreview } from "./StagedBriefPreviewCard";

describe("shouldShowStagedBriefPreview", () => {
  const base = {
    kickoffBriefPath: "/state/workstream-briefs/thread-1.md",
    hasStarted: false,
    composerDraftPrompt: "",
  };

  it("shows for an unstarted node that has a brief on disk", () => {
    expect(shouldShowStagedBriefPreview(base)).toBe(true);
  });

  it("hides when there is no brief yet", () => {
    expect(shouldShowStagedBriefPreview({ ...base, kickoffBriefPath: null })).toBe(false);
  });

  it("hides once the thread has started", () => {
    expect(shouldShowStagedBriefPreview({ ...base, hasStarted: true })).toBe(false);
  });

  it("hides while the human is typing in the composer", () => {
    expect(shouldShowStagedBriefPreview({ ...base, composerDraftPrompt: "  draft " })).toBe(false);
  });
});
