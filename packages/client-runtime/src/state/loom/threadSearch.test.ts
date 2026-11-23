import {
  EnvironmentId,
  ProjectId,
  ThreadId,
  type OrchestrationThreadSearchSubThreadMatch,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import {
  makeThreadSearchKey,
  nextShownOrder,
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "../threadSearch.ts";
import {
  DEFAULT_THREAD_SEARCH_FILTERS,
  isDefaultThreadSearchFilters,
  threadSearchExcerptLabel,
  threadSearchMatchedSubThreadTitle,
  threadSearchShowsExcerpt,
  threadSearchSubRows,
  threadSearchTarget,
  withThreadSearchSubRows,
} from "./threadSearch.ts";

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

const sub = (
  id: string,
  overrides: Partial<OrchestrationThreadSearchSubThreadMatch> = {},
): OrchestrationThreadSearchSubThreadMatch => ({
  threadId: ThreadId.make(id),
  title: id,
  source: "title",
  snippet: id,
  messageCreatedAt: null,
  archivedAt: null,
  ...overrides,
});

it("opens the sub-thread that wrote a report, with the report, not the top-level thread", () => {
  const report = match("r", {
    source: "report",
    matchedThreadId: ThreadId.make("c"),
    matchedThreadTitle: "C",
    reportPath: "/reports/c.md",
  });
  expect(threadSearchTarget(report)).toEqual({
    environmentId,
    threadId: ThreadId.make("c"),
    find: null,
    reportPath: "/reports/c.md",
  });
  // With Sub-threads on, the row beneath carries the report and the top-level row is a heading.
  const [row] = threadSearchSubRows([
    { ...report, subThreads: [sub("c", { source: "report", reportPath: "/reports/c.md" })] },
  ]).get(threadSearchMatchKey(report))!;
  expect(row?.kind === "subThread" && threadSearchTarget(row)).toMatchObject({
    threadId: ThreadId.make("c"),
    reportPath: "/reports/c.md",
  });
  expect(threadSearchTarget({ ...report, subThreads: [sub("c")] })).toMatchObject({
    threadId: ThreadId.make("r"),
    reportPath: null,
  });
  // A matched sub-thread with no row of its own (archived, say) keeps the excerpt and its target.
  expect(threadSearchShowsExcerpt({ ...report, subThreads: [sub("c")] })).toBe(false);
  expect(threadSearchShowsExcerpt({ ...report, subThreads: [sub("d")] })).toBe(true);
  expect(threadSearchTarget({ ...report, subThreads: [sub("d")] }).threadId).toBe("c");
});

it("puts sub-thread rows under a top-level thread listed by its title", () => {
  const matches = [
    match("listed-by-title", {
      subThreads: [sub("a"), sub("b")],
      subThreadsOmitted: 4,
    }),
    match("listed-for-messages", { subThreads: [sub("c")], subThreadsOmitted: 0 }),
  ];
  // The surface drops the title-listed thread's result from its messages section.
  const titles = ["listed-by-title", "other"];
  const messages = ["listed-for-messages"];
  const keyOf = (id: string) =>
    threadSearchMatchKey({ environmentId, threadId: ThreadId.make(id) });
  const subRows = threadSearchSubRows(matches);
  const label = (row: string | { kind: string; key: string }) =>
    typeof row === "string" ? row : `${row.kind}:${row.key}`;
  expect(withThreadSearchSubRows([...titles, ...messages], keyOf, subRows).map(label)).toEqual([
    "listed-by-title",
    `subThread:${keyOf("a")}`,
    `subThread:${keyOf("b")}`,
    `fold:${keyOf("listed-by-title")}:more`,
    "other",
    "listed-for-messages",
    `subThread:${keyOf("c")}`,
  ]);
  // Unfolded, the workstream's own search replaces its rows, with no fold after them.
  const unfolded = [match("listed-by-title", { subThreads: [sub("a"), sub("b"), sub("e")] })];
  expect(
    threadSearchSubRows(matches, unfolded)
      .get(keyOf("listed-by-title"))
      ?.map((row) => row.key),
  ).toEqual([keyOf("a"), keyOf("b"), keyOf("e")]);
});

it("starts a fresh shown order when a switch flips on the same words", () => {
  const environments = [environmentId];
  const before = makeThreadSearchKey(environments, "model picker", DEFAULT_THREAD_SEARCH_FILTERS);
  const flipped = { ...DEFAULT_THREAD_SEARCH_FILTERS, archived: true };
  expect(isDefaultThreadSearchFilters(flipped)).toBe(false);
  const after = makeThreadSearchKey(environments, "model picker", flipped);
  const shown = nextShownOrder(null, before, ["live-1", "live-2"], 10);
  // The archived thread that ranks first leads, rather than landing under the rows shown.
  expect(nextShownOrder(shown, after, ["archived", "live-1", "live-2"], 10).keys).toEqual([
    "archived",
    "live-1",
    "live-2",
  ]);
  expect(nextShownOrder(shown, before, ["archived", "live-1", "live-2"], 10).keys).toEqual([
    "live-1",
    "live-2",
    "archived",
  ]);
});
