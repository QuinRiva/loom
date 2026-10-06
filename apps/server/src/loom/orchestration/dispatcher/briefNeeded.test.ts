/** Brief-needed eligibility, clock, ladder and notice, ported from V1's tests and retyped onto the sidecar. */
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  IsoDateTime,
  type LoomThreadWorkstream,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { isEligibleToStart } from "@t3tools/shared/workstreamStart.loom";

import { emptyWorkstream } from "../../projection/LoomStore.ts";
import {
  BRIEF_NEEDED_ATTENTION_MS,
  briefNeededAttentionParentIds,
  briefNeededRungKey,
  briefNeededSinceMs,
  buildBriefNeededMessage,
  isBriefNeeded,
  rungFor,
} from "./briefNeeded.ts";
import { WORKSTREAM_CONTROL_PLANE_MARKER } from "./wakes.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const iso = (hour: number) =>
  IsoDateTime.make(`2026-06-24T${String(hour).padStart(2, "0")}:00:00.000Z`);
const node = (id: string, patch: Partial<LoomThreadWorkstream> = {}) => ({
  ...emptyWorkstream({
    threadId: ThreadId.make(id),
    projectId: ProjectId.make("p"),
    parentThreadId: ThreadId.make("parent-1"),
    rootThreadId: ThreadId.make("parent-1"),
    at: iso(0),
  }),
  ...patch,
  id: ThreadId.make(id),
});
type Node = ReturnType<typeof node>;
const map = (nodes: ReadonlyArray<Node>) => new Map(nodes.map((n) => [n.id, n]));
const done = (id: string, hour: number, patch: Partial<LoomThreadWorkstream> = {}) =>
  node(id, { outcome: "done", outcomeAt: iso(hour), kickoffAt: iso(0), ...patch });

describe("isBriefNeeded", () => {
  it("is true for an unheld, deps-satisfied, unbriefed child; false once briefed, held or blocked", () => {
    const t = node("c");
    assert.isTrue(isBriefNeeded(t, map([t])));
    assert.isFalse(isBriefNeeded(node("c", { kickoffBriefPath: "/b.md" }), map([t])));
    assert.isFalse(isBriefNeeded(node("c", { held: true }), map([t])));
    const dep = node("dep", { kickoffAt: iso(1) });
    const blocked = node("c", { blockedBy: [dep.id] });
    assert.isFalse(isBriefNeeded(blocked, map([dep, blocked])));
  });

  it("is disjoint from isEligibleToStart: a child is in exactly one set", () => {
    const unbriefed = node("c1");
    const briefed = node("c2", { kickoffBriefPath: "/b.md" });
    const byId = map([unbriefed, briefed]);
    assert.deepEqual(
      [isBriefNeeded(unbriefed, byId), isEligibleToStart(unbriefed, byId)],
      [true, false],
    );
    assert.deepEqual(
      [isBriefNeeded(briefed, byId), isEligibleToStart(briefed, byId)],
      [false, true],
    );
  });
});

describe("briefNeededSinceMs", () => {
  it("dates a born-eligible node from its createdAt", () => {
    const t = node("c", { createdAt: iso(1) });
    assert.equal(briefNeededSinceMs(t, map([t])), Date.parse(iso(1)));
  });

  it("dates a dep-gated node from its LAST dependency's completion (submit or outcome-set)", () => {
    const early = done("early", 3);
    const late = done("late", 2, {
      lastOutcome: {
        outcome: "done",
        decision: "terminal",
        round: 0,
        eventId: EventId.make("e"),
        at: iso(6),
      },
    });
    const child = node("c", { blockedBy: [early.id, late.id] });
    assert.equal(briefNeededSinceMs(child, map([early, late, child])), Date.parse(iso(6)));
  });

  it("ignores an unfinished dep's stamps and dependenciesSince while the set is unsatisfied", () => {
    const dep = node("dep", { kickoffAt: iso(8) });
    const child = node("c", { blockedBy: [dep.id], dependenciesSince: iso(9) });
    assert.equal(briefNeededSinceMs(child, map([dep, child])), Date.parse(iso(0)));
  });

  it("advances on a dependencies.set that re-enters eligibility with an already-done dep", () => {
    const dep = done("dep", 1);
    const child = node("c", { blockedBy: [dep.id], dependenciesSince: iso(10) });
    assert.equal(briefNeededSinceMs(child, map([dep, child])), Date.parse(iso(10)));
  });
});

describe("rungFor and briefNeededRungKey", () => {
  it("rung 0 immediately, 1 at 1 h, 2 at 6 h, then daily, monotonic", () => {
    assert.deepEqual(
      [0, HOUR - 1, HOUR, 6 * HOUR - 1, 6 * HOUR, DAY, 2 * DAY, 30 * DAY].map(rungFor),
      [0, 0, 1, 1, 2, 3, 4, 32],
    );
    let previous = -1;
    for (let ageMs = 0; ageMs <= 5 * DAY; ageMs += HOUR / 4) {
      assert.isAtLeast(rungFor(ageMs), previous);
      previous = rungFor(ageMs);
    }
  });

  it("re-arms on a fresh episode or a crossed rung, and is order-independent", () => {
    const a = { childId: ThreadId.make("a"), sinceMs: 1000, rung: 0 };
    const b = { childId: ThreadId.make("b"), sinceMs: 2000, rung: 0 };
    assert.equal(briefNeededRungKey([a, b]), briefNeededRungKey([b, a]));
    assert.notEqual(briefNeededRungKey([a]), briefNeededRungKey([{ ...a, rung: 1 }]));
    assert.notEqual(briefNeededRungKey([a]), briefNeededRungKey([{ ...a, sinceMs: 1001 }]));
  });
});

describe("briefNeededAttentionParentIds", () => {
  const now = Date.parse(iso(0)) + BRIEF_NEEDED_ATTENTION_MS;
  it("flags the parent at 24 h and self-clears when the node is briefed, held or finished", () => {
    const aged = node("c");
    assert.deepEqual([...briefNeededAttentionParentIds([aged], map([aged]), now)], ["parent-1"]);
    assert.equal(briefNeededAttentionParentIds([aged], map([aged]), now - 1).size, 0);
    for (const exit of [
      { kickoffBriefPath: "/b.md" },
      { held: true },
      { outcome: "cancelled" as const },
    ]) {
      const t = node("c", exit);
      assert.equal(briefNeededAttentionParentIds([t], map([t]), now).size, 0);
    }
  });
});

describe("buildBriefNeededMessage", () => {
  const child = (patch: Partial<Parameters<typeof buildBriefNeededMessage>[0][number]> = {}) => ({
    id: ThreadId.make("child-a"),
    graphKey: "api" as string | null,
    role: "coder" as string | null,
    title: "Dedup endpoint",
    ageMs: 0,
    rung: 0,
    ...patch,
  });

  it("names every child by graph key (else id), role and title", () => {
    const text = buildBriefNeededMessage([
      child(),
      child({ id: ThreadId.make("child-b"), graphKey: null, role: "reviewer", title: "Review it" }),
    ]);
    for (const fragment of [
      WORKSTREAM_CONTROL_PLANE_MARKER,
      "2 of your Workstream sub-threads",
      "`api`",
      "Dedup endpoint",
      "`child-b`",
    ])
      assert.include(text, fragment);
    assert.include(buildBriefNeededMessage([child()]), "One of your Workstream sub-threads");
  });

  it("names the three sanctioned moves with prefixed tools and no lane vocabulary", () => {
    const text = buildBriefNeededMessage([child()]);
    for (const fragment of [
      "mcp__t3-code__workstream_brief",
      "mcp__t3-code__workstream_set_dependencies",
      "mcp__t3-code__workstream_set_outcome",
      "cancelled",
    ])
      assert.include(text, fragment);
    for (const gone of ["set_lane", "planned", "workstream_release"]) assert.notInclude(text, gone);
  });

  it("says how long a node has stalled once past the first rung", () => {
    assert.include(buildBriefNeededMessage([child({ ageMs: 6 * HOUR, rung: 2 })]), "stalled 6h");
    assert.include(buildBriefNeededMessage([child({ ageMs: 3 * DAY, rung: 5 })]), "stalled 3d");
    assert.notInclude(buildBriefNeededMessage([child()]), "— stalled");
  });
});
