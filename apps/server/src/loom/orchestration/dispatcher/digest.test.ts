/** The FYI digest, ported from V1's `WorkstreamDispatcher.test.ts` and retyped (items carry seam-6 kinds). */
import { assert, describe, it } from "@effect/vitest";
import {
  EventId,
  IsoDateTime,
  ThreadId,
  type WorkOutcomeRecord,
  type WorkstreamRoute,
} from "@t3tools/contracts";

import {
  buildDigestPayload,
  buildDigestPiggyback,
  buildStandaloneDigest,
  type DigestExtra,
  digestEpisodeHash,
  digestShouldFlush,
  FYI_DIGEST_FLUSH_MS,
  parentWorkstreamQuiet,
  renderDeadEpisodeDigestLine,
  renderRecoveredDigestLine,
  renderSlowToolDigestLine,
  terminalEpisodeKey,
} from "./digest.ts";
import { WAKE_REPORT_EXCERPT_LIMIT, type WakeMember } from "./wakes.ts";
import { buildYieldPayload, buildYieldWakeMessage } from "./yield.ts";

const at = IsoDateTime.make("2026-07-07T14:32:00.000Z");
const member = (
  overrides: Omit<Partial<WakeMember>, "id"> & { readonly id: string },
): WakeMember => ({
  role: "coder",
  outcome: "done",
  attention: [],
  reportPath: null,
  report: null,
  lastOutcome: null,
  gateRounds: 0,
  routes: [],
  eventAt: at,
  ...overrides,
  id: ThreadId.make(overrides.id),
});
const resolveRoutes = (to: string): ReadonlyArray<WorkstreamRoute> => [
  { on: ["needs_rework"], kind: "loop", to: ThreadId.make(to), maxRounds: 2 },
  { on: ["clean", "fixed_inline"], kind: "resolve" },
];
const resolved = (outcome: string): WorkOutcomeRecord => ({
  outcome,
  decision: "resolve",
  round: 0,
  eventId: EventId.make("evt-1"),
  at,
});
const assertContentSubsetOfText = (
  items: ReadonlyArray<{
    readonly excerpt?: string | undefined;
    readonly timestamp?: string | undefined;
  }>,
  text: string,
) => {
  for (const item of items) {
    if (item.excerpt !== undefined) assert.include(text, item.excerpt);
    if (item.timestamp !== undefined) assert.include(text, item.timestamp);
  }
};

describe("buildStandaloneDigest", () => {
  it("carries each child's role, id, outcome, report reference and a short report inline", () => {
    const text = buildStandaloneDigest([
      member({
        id: "child-1",
        role: "researcher",
        reportPath: "child-1.md",
        report: "# Findings\nAll good.",
      }),
      member({ id: "child-2", role: "reviewer", outcome: "cancelled" }),
    ]);
    for (const fragment of [
      "researcher",
      "child-1",
      "done",
      "cancelled",
      "All good.",
      "child-1.md",
      "No report was filed",
      "Nothing below is blocked on you",
    ])
      assert.include(text, fragment);
    assert.notInclude(text, "has finished");
  });

  it("bounds an oversized report to a 400-character excerpt + reference", () => {
    assert.equal(WAKE_REPORT_EXCERPT_LIMIT, 400);
    const tail = "TAIL_MARKER_SHOULD_NOT_APPEAR";
    const report = `${"x".repeat(WAKE_REPORT_EXCERPT_LIMIT + 50)}${tail}`;
    const text = buildStandaloneDigest([
      member({ id: "child-1", reportPath: "child-1.md", report }),
    ]);
    assert.include(text, "excerpt truncated");
    assert.notInclude(text, tail);
  });

  it("gate-resolved items carry the no-review-owed closing; unreviewed completions the ☑️ first look", () => {
    const gate = buildStandaloneDigest([
      member({
        id: "rev",
        routes: resolveRoutes("cod"),
        lastOutcome: resolved("clean"),
        reportPath: "/r/rev.md",
        report: "Clean.",
      }),
      member({ id: "cod" }),
    ]);
    assert.include(gate, "No first-pass review is owed");
    const solo = buildStandaloneDigest([member({ id: "solo", role: "researcher" })]);
    assert.include(solo, "☑️");
    assert.include(solo, "deserve the usual first look");
  });

  it("an info-only digest never claims anything completed", () => {
    const slow: DigestExtra = {
      kind: "slow-tool",
      line: renderSlowToolDigestLine({
        id: ThreadId.make("cod"),
        role: "coder",
        toolName: "pytest",
        inFlightMs: 22 * 60_000,
        quietMs: 20 * 60_000,
      }),
    };
    const text = buildStandaloneDigest([], [slow]);
    assert.include(text, "still executing");
    assert.include(text, "status notices");
    assert.notInclude(text, "the following items completed");
    assert.notInclude(text, "deserve the usual first look");
  });
});

describe("buildDigestPayload", () => {
  it("one item per member plus each extra, with kind, icon, status and bounded excerpt", () => {
    const payload = buildDigestPayload(
      [
        member({
          id: "child-1",
          role: "researcher",
          reportPath: "child-1.md",
          report: "All good.",
        }),
        member({ id: "child-2", role: "reviewer", outcome: "cancelled" }),
      ],
      [
        {
          kind: "recovered",
          childId: ThreadId.make("child-3"),
          role: "coder",
          line: "- ♻️ recovered",
        },
        { kind: "dead-episode", childId: ThreadId.make("child-4"), line: "- ⚠️ rejected" },
      ],
    );
    assert.equal(payload.kind, "digest");
    const [done, cancelled, recovered, dead] = payload.items;
    assert.deepInclude(done!, {
      kind: "terminal",
      threadId: ThreadId.make("child-1"),
      status: "done",
      icon: "☑️",
      reportPath: "child-1.md",
    });
    assert.include(done!.excerpt, "All good.");
    assert.deepInclude(cancelled!, { kind: "terminal", status: "cancelled", icon: "🚫" });
    assert.notProperty(cancelled, "reportPath");
    assert.deepInclude(recovered!, {
      kind: "recovered",
      threadId: ThreadId.make("child-3"),
      status: "recovered",
      icon: "♻️",
    });
    assert.deepInclude(dead!, { kind: "dead-episode", status: "dead-episode" });
  });

  it("a resolved gate source is a gate-resolved item carrying the verdict", () => {
    const [item] = buildDigestPayload([
      member({
        id: "rev",
        role: "reviewer",
        reportPath: "rev-1.md",
        report: "verified",
        lastOutcome: resolved("clean"),
      }),
    ]).items;
    assert.deepInclude(item!, { kind: "gate-resolved", status: "clean", icon: "✅" });
    assert.include(item!.title, "Gate resolved");
  });

  it("parity: a resolved pair's target is reference-only in both text and payload", () => {
    const members = [
      member({
        id: "rev",
        role: "reviewer",
        routes: resolveRoutes("cod"),
        lastOutcome: resolved("clean"),
        reportPath: "/r/rev.md",
        report: "SOURCE_VERDICT_EXCERPT clean.",
      }),
      member({
        id: "cod",
        reportPath: "/r/cod-r2.md",
        report: "TARGET_ROUND_REPORT_MUST_NOT_APPEAR",
      }),
    ];
    const text = buildStandaloneDigest(members);
    const payload = buildDigestPayload(members);
    const target = payload.items.find((i) => i.threadId === "cod")!;
    assert.equal(target.kind, "gate-resolved");
    assert.isUndefined(target.excerpt);
    assert.isUndefined(target.status);
    assert.isUndefined(target.timestamp);
    assert.notInclude(text, "TARGET_ROUND_REPORT_MUST_NOT_APPEAR");
    assert.notInclude(JSON.stringify(payload), "TARGET_ROUND_REPORT_MUST_NOT_APPEAR");
    assertContentSubsetOfText(payload.items, text);
  });

  it("parity: a yield with a piggybacked digest carries the piggyback items its text carries", () => {
    const child = { id: ThreadId.make("cod"), role: "coder", reportPath: "/r/cod.md" };
    const piggyback = {
      members: [
        member({
          id: "sib",
          role: "researcher",
          reportPath: "/r/sib.md",
          report: "PIGGYBACK_SIBLING_EXCERPT routed.",
        }),
      ],
      extras: [] as DigestExtra[],
    };
    const text = `${buildYieldWakeMessage(child, "rework_approach", "YIELD_CHILD_EXCERPT")}\n${buildDigestPiggyback(piggyback.members, piggyback.extras)}`;
    const payload = buildYieldPayload(
      child,
      "rework_approach",
      "YIELD_CHILD_EXCERPT",
      undefined,
      piggyback,
    );
    assert.isTrue(payload.items.some((i) => i.threadId === "sib"));
    assertContentSubsetOfText(payload.items, text);
  });
});

describe("digest lines, flush predicates and episode keys", () => {
  it("buildDigestPiggyback leads with a separator + no-action header and the closing", () => {
    const text = buildDigestPiggyback([
      member({ id: "a1b2", reportPath: "/r/a1b2.md", report: "done" }),
    ]);
    assert.include(text, "---");
    assert.include(text, "Also, FYI since you last heard");
    assert.include(text, "a1b2");
  });

  it("a recovered-only piggyback never claims nothing completed", () => {
    const text = buildDigestPiggyback(
      [],
      [
        {
          kind: "recovered",
          line: renderRecoveredDigestLine({
            id: ThreadId.make("c9"),
            role: "coder",
            reportPath: null,
            eventAt: at,
          }),
        },
      ],
    );
    assert.include(text, "recovered");
    assert.include(text, "already resolved themselves");
    assert.notInclude(text, "deserve the usual first look");
  });

  it("recovered, slow-tool and dead-episode lines are one-liners with no excerpt", () => {
    const rec = renderRecoveredDigestLine({
      id: ThreadId.make("c1"),
      role: "coder",
      reportPath: "/r/c1.md",
      eventAt: at,
    });
    assert.include(rec, "2026-07-07 14:32Z");
    assert.include(rec, "/r/c1.md");
    const slow = renderSlowToolDigestLine({
      id: ThreadId.make("c2"),
      role: "coder",
      toolName: "bash",
      inFlightMs: 7 * 60_000,
      quietMs: 6 * 60_000,
    });
    assert.include(slow, "`bash`");
    assert.include(slow, "7 min");
    const dead = renderDeadEpisodeDigestLine({
      threadId: ThreadId.make("c3"),
      commandId: "server:loom:fork-prepare:c3",
      commandType: "thread.fork.prepare",
      error: "no strong native thread ref",
    });
    assert.include(dead, "`thread.fork.prepare` on `c3`");
    assert.include(dead, "will not be retried");
  });

  it("parentWorkstreamQuiet: false with an in-progress or briefed-ready child, true otherwise", () => {
    const p = ThreadId.make("p");
    const child = (
      lane: Parameters<typeof parentWorkstreamQuiet>[1][number]["lane"],
      kickoffBriefPath: string | null = null,
    ) => ({
      parentThreadId: p,
      lane,
      kickoffBriefPath,
    });
    assert.isFalse(parentWorkstreamQuiet(p, [child("in_progress")]));
    assert.isFalse(parentWorkstreamQuiet(p, [child("ready", "/b.md")]));
    assert.isTrue(parentWorkstreamQuiet(p, [child("ready")]));
    assert.isTrue(parentWorkstreamQuiet(p, [child("held"), child("blocked"), child("done")]));
  });

  it("digestShouldFlush: quiet flushes now; age flushes past the window; else withholds", () => {
    const flush = (oldestEventAtMs: number | null, now: number, quiet: boolean) =>
      digestShouldFlush({ oldestEventAtMs, now, quiet, flushMs: FYI_DIGEST_FLUSH_MS });
    assert.isTrue(flush(null, 0, true));
    assert.isTrue(flush(0, FYI_DIGEST_FLUSH_MS, false));
    assert.isFalse(flush(0, FYI_DIGEST_FLUSH_MS - 1, false));
  });

  it("terminalEpisodeKey prefers the outcome-set event; digestEpisodeHash is order-independent", () => {
    assert.equal(
      terminalEpisodeKey({
        outcomeEventId: EventId.make("evt-set"),
        lastOutcome: resolved("done"),
      }),
      "evt-set",
    );
    assert.equal(
      terminalEpisodeKey({ outcomeEventId: null, lastOutcome: resolved("done") }),
      "evt-1",
    );
    assert.equal(terminalEpisodeKey({ outcomeEventId: null, lastOutcome: null }), "terminal");
    assert.equal(digestEpisodeHash(["a", "b"]), digestEpisodeHash(["b", "a"]));
    assert.notEqual(digestEpisodeHash(["a"]), digestEpisodeHash(["a", "b"]));
  });
});
