/** The deadlock notice and its episode key, retyped onto the sidecar. */
import { assert, describe, it } from "@effect/vitest";
import { IsoDateTime, ThreadId } from "@t3tools/contracts";
import { deadlockedNodes } from "@t3tools/shared/workstreamDependencies";

import { buildDeadlockMessage, deadlockEpisode } from "./deadlock.ts";

const parent = ThreadId.make("p");
const stuck = (
  id: string,
  blockedBy: ReadonlyArray<string>,
  dependenciesSince: string | null = null,
) => ({
  id: ThreadId.make(id),
  threadId: ThreadId.make(id),
  parentThreadId: parent,
  blockedBy: blockedBy.map((dep) => ThreadId.make(dep)),
  outcome: null,
  held: false,
  kickoffAt: null,
  role: "coder",
  title: `Node ${id}`,
  outcomeAt: null,
  heldSince: null,
  dependenciesSince: dependenciesSince === null ? null : IsoDateTime.make(dependenciesSince),
});

describe("deadlock", () => {
  const a = stuck("a", ["b"]);
  const b = stuck("b", ["a"]);
  const byId = new Map([a, b].map((n) => [n.id, n]));

  it("names every stuck child, what it waits on, and the prefixed ways out", () => {
    const nodes = deadlockedNodes([a, b], byId)!;
    const text = buildDeadlockMessage(nodes, byId);
    for (const fragment of [
      "all 2 of your unfinished sub-threads",
      "coder `a` (“Node a”): dependency 'b' is not done yet",
      "mcp__t3-code__workstream_set_dependencies",
      "mcp__t3-code__workstream_set_outcome",
    ])
      assert.include(text, fragment);
    for (const gone of ["fan", "isolated", "set_lane", "merge"]) assert.notInclude(text, gone);
  });

  it("the episode is stable across ticks and re-arms on a real graph change", () => {
    assert.equal(deadlockEpisode([a, b]), deadlockEpisode([b, a]));
    assert.notEqual(
      deadlockEpisode([a, b]),
      deadlockEpisode([stuck("a", ["b"], "2026-01-01T00:00:00.000Z"), b]),
    );
  });
});
