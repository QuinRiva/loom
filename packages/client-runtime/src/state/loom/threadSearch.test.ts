import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import type { EnvironmentThreadSearchMatch } from "../threadSearch.ts";
import { threadSearchExcerptLabel, threadSearchMatchedSubThreadTitle } from "./threadSearch.ts";

const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");
const match = (
  id: string,
  overrides: Partial<EnvironmentThreadSearchMatch> = {},
): EnvironmentThreadSearchMatch => ({
  environmentId,
  threadId: ThreadId.make(id),
  projectId,
  source: "brief",
  snippet: "",
  messageCreatedAt: null,
  title: id,
  archivedAt: null,
  updatedAt: "2026-10-01T00:00:00.000Z",
  matchedThreadId: null,
  matchedThreadTitle: null,
  ...overrides,
});

it("labels sub-thread hits and stays silent on the root's own title", () => {
  expect(threadSearchExcerptLabel(match("r", { source: "title" }))).toBeNull();
  const subThreadReport = match("r", {
    source: "report",
    matchedThreadId: ThreadId.make("c"),
    matchedThreadTitle: "C",
  });
  expect(threadSearchExcerptLabel(subThreadReport)).toBe("Report:");
  expect(threadSearchMatchedSubThreadTitle(subThreadReport)).toBe("C");
});
