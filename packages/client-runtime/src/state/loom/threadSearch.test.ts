import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import type { EnvironmentThreadSearchMatch } from "../threadSearch.ts";
import {
  rankThreadSearchResults,
  threadSearchExcerptLabel,
  threadSearchMatchedSubThreadTitle,
  threadSearchHighlightParts,
} from "./threadSearch.ts";

const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");
const shell = (id: string) => ({ environmentId, id: ThreadId.make(id) });
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

it("keeps the server's order, draws archived roots from the match, and appends local title hits", () => {
  const [live, other, local] = [shell("live"), shell("other"), shell("local")];
  const results = rankThreadSearchResults({
    threads: [live, other, local],
    localMatches: [local, live],
    matches: [
      match("archived", { archivedAt: "2026-09-01T00:00:00.000Z" }),
      match("filtered-out"), // a live root the list itself hides
      match("live"),
    ],
    isInScope: () => true,
  });
  expect(results.map((result) => [result.threadRef.threadId, result.thread !== null])).toEqual([
    ["archived", false],
    ["live", true],
    ["local", true],
  ]);
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

it("highlights words that start with a query token, not mid-word fragments", () => {
  const parts = threadSearchHighlightParts("Rehoming the sidebar; prehome stays", "rehom side");
  expect(parts.filter((part) => part.highlighted).map((part) => part.text)).toEqual([
    "Rehom",
    "side",
  ]);
});
