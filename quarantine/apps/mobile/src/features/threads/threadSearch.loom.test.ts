import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { describe, expect, it } from "vite-plus/test";

import { scopedProjectKey } from "../../lib/scopedEntities";
import { rankThreadSearchItems } from "./threadSearch.loom";

const environmentId = EnvironmentId.make("env");
const projectId = ProjectId.make("project");
const otherProjectId = ProjectId.make("other-project");

const match = (id: string, overrides: Partial<EnvironmentThreadSearchMatch> = {}) =>
  ({
    environmentId,
    threadId: ThreadId.make(id),
    projectId,
    source: "message",
    snippet: `hit in ${id}`,
    messageCreatedAt: null,
    title: id,
    archivedAt: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    matchedThreadId: null,
    matchedThreadTitle: null,
    ...overrides,
  }) as EnvironmentThreadSearchMatch;
const shell = (id: string) =>
  ({ environmentId, id: ThreadId.make(id) }) as unknown as EnvironmentThreadShell;

// PR-11 (pull 8): the surviving v2 list keeps loom's server-ranked search on
// the home list and the iPad sidebar, which both rank through this function.
describe("rankThreadSearchItems", () => {
  const items = ["live-a", "live-b", "untouched"].map((id) => ({ id }));
  const ranked = rankThreadSearchItems({
    items,
    threadOf: (item) => shell(item.id),
    matches: [
      match("live-b"),
      match("archived-root", { archivedAt: "2026-09-01T00:00:00.000Z" }),
      match("live-a"),
      match("filtered-live"),
      match("other-project-archived", { projectId: otherProjectId }),
    ],
    liveThreads: ["live-a", "live-b", "untouched", "filtered-live"].map(shell),
    projectKeys: new Set([scopedProjectKey(environmentId, projectId)]),
  });

  it("lists root hits in server order, archived roots in place, then the rest", () => {
    expect(ranked.map((entry) => ("type" in entry ? entry.key : entry.id))).toEqual([
      "live-b",
      `search-archived:${threadSearchMatchKey(match("archived-root"))}`,
      "live-a",
      "untouched",
    ]);
  });

  it("draws an archived root from the match so it can be opened by id", () => {
    const archived = ranked[1];
    expect(archived && "type" in archived ? archived.match.threadId : null).toBe("archived-root");
  });
});
