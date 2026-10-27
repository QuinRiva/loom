import { DOCUMENT_QUERY_ROLE, HANDOFF_DRAFTER_ROLE, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { workstreamFields, workstreamShell } from "./loomTestFixtures.ts";
import {
  hostedThreadIds,
  isListedThread,
  isSubRow,
  isTopLevelRow,
  presentationParentsOf,
} from "./sideThread.ts";

const root = (id: string) =>
  workstreamShell(
    workstreamFields(id, { parentThreadId: null, rootThreadId: ThreadId.make(id), role: null }),
  );
const child = (id: string, parent: string) =>
  workstreamShell(workstreamFields(id, { parentThreadId: ThreadId.make(parent) }));
const side = (
  id: string,
  anchor: string,
  role: string,
  attention: ReadonlyArray<"needs_guidance"> = [],
) =>
  workstreamShell(
    workstreamFields(id, {
      parentThreadId: null,
      rootThreadId: ThreadId.make(id),
      role,
      forkFromThreadId: ThreadId.make(anchor),
      attention,
    }),
  );

const hostedOf = (...shells: ReturnType<typeof root>[]) =>
  hostedThreadIds(presentationParentsOf(shells));

describe("side-thread row rules", () => {
  it("nests a query thread under its anchor, including an anchor that is a workstream child", () => {
    const onRoot = side("query-1", "author", DOCUMENT_QUERY_ROLE);
    const onChild = side("query-2", "planner", DOCUMENT_QUERY_ROLE);
    const hosted = hostedOf(root("author"), child("planner", "author"), onRoot, onChild);
    expect([onRoot, onChild].map((shell) => isSubRow(shell, hosted))).toEqual([true, true]);
    expect([onRoot, onChild].map((shell) => isTopLevelRow(shell, hosted))).toEqual([false, false]);
  });

  it("gives a query thread its own row when its anchor, or the anchor's host, is not live", () => {
    const orphan = side("query-1", "gone", DOCUMENT_QUERY_ROLE);
    // The anchor is loaded but its workstream root is not, so the host row does not exist.
    const unhosted = side("query-2", "planner", DOCUMENT_QUERY_ROLE);
    const hosted = hostedOf(child("planner", "unloaded-root"), orphan, unhosted);
    for (const shell of [orphan, unhosted]) {
      expect(isTopLevelRow(shell, hosted)).toBe(true);
      expect(isSubRow(shell, hosted)).toBe(false);
    }
  });

  it("lifts a flagged side thread to its own row and keeps it out of the sub-rows", () => {
    const query = side("query-1", "author", DOCUMENT_QUERY_ROLE, ["needs_guidance"]);
    const drafter = side("drafter-1", "author", HANDOFF_DRAFTER_ROLE, ["needs_guidance"]);
    const hosted = hostedOf(root("author"), query, drafter);
    expect([query, drafter].map((shell) => isTopLevelRow(shell, hosted))).toEqual([true, true]);
    expect([query, drafter].map((shell) => isSubRow(shell, hosted))).toEqual([false, false]);
  });

  it("hides a healthy drafter everywhere and lists it once it is flagged", () => {
    const drafter = side("drafter-1", "author", HANDOFF_DRAFTER_ROLE);
    const hosted = hostedOf(root("author"), drafter);
    expect(isTopLevelRow(drafter, hosted)).toBe(false);
    expect(isSubRow(drafter, hosted)).toBe(false);
    expect(isListedThread(drafter)).toBe(false);
    expect(
      isListedThread(side("drafter-2", "author", HANDOFF_DRAFTER_ROLE, ["needs_guidance"])),
    ).toBe(true);
    expect(isListedThread(side("query-1", "author", DOCUMENT_QUERY_ROLE))).toBe(true);
  });

  it("leaves an ordinary root or fork a top-level row", () => {
    const fork = side("fork-1", "author", "coder");
    expect(isTopLevelRow(fork, hostedOf(root("author"), fork))).toBe(true);
    expect(isTopLevelRow(root("author"), new Set())).toBe(true);
  });
});
