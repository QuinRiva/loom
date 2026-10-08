import {
  EventId,
  type LoomAttentionReason,
  type OrchestrationV2ThreadShell,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { workstreamFields, workstreamShell } from "./loomTestFixtures.ts";
import { v2Now } from "../orchestrationV2TestFixtures.ts";
import { attentionReasonsOf, workstreamBadgeTone, workstreamRollupOf } from "./rollup.ts";
import { workstreamIndexOf } from "./workstream.ts";

const STARTED = "2026-10-05T01:00:00.000Z";

type Spec = {
  readonly id: string;
  readonly parent?: string | null;
  readonly started?: boolean;
  readonly outcome?: "done" | "cancelled";
  readonly held?: boolean;
  readonly brief?: boolean;
  readonly blockedBy?: ReadonlyArray<string>;
  readonly attention?: ReadonlyArray<LoomAttentionReason>;
  readonly activity?: OrchestrationV2ThreadShell["activityRunStatus"];
  readonly request?: NonNullable<OrchestrationV2ThreadShell["pendingRuntimeRequest"]>["kind"];
  readonly archived?: boolean;
  readonly shell?: Partial<OrchestrationV2ThreadShell>;
  readonly fields?: Partial<NonNullable<OrchestrationV2ThreadShell["workstream"]>>;
};

const node = (spec: Spec) =>
  workstreamShell(
    workstreamFields(spec.id, {
      parentThreadId: ThreadId.make(spec.parent === undefined ? "root" : (spec.parent ?? "root")),
      kickoffAt: spec.started || spec.outcome === "done" ? STARTED : null,
      outcome: spec.outcome ?? null,
      held: spec.held ?? false,
      kickoffBriefPath: spec.brief === false ? null : `/briefs/${spec.id}.md`,
      blockedBy: (spec.blockedBy ?? []).map((id) => ThreadId.make(id)),
      attention: spec.attention ?? [],
      ...spec.fields,
    }),
    {
      activityRunStatus: spec.activity ?? null,
      pendingRuntimeRequest:
        spec.request === undefined
          ? null
          : {
              id: RuntimeRequestId.make(`request-${spec.id}`),
              kind: spec.request,
              createdAt: v2Now,
            },
      archivedAt: spec.archived ? v2Now : null,
      ...spec.shell,
    },
  );

const graph = (specs: ReadonlyArray<Spec>, root: Partial<OrchestrationV2ThreadShell> = {}) => [
  workstreamShell(workstreamFields("root", { parentThreadId: null }), root),
  ...specs.map(node),
];

const rollup = (specs: ReadonlyArray<Spec>, root: Partial<OrchestrationV2ThreadShell> = {}) => {
  const threads = graph(specs, root);
  return workstreamRollupOf(ThreadId.make("root"), threads, workstreamIndexOf(threads));
};

const tone = (specs: ReadonlyArray<Spec>, root: Partial<OrchestrationV2ThreadShell> = {}) =>
  workstreamBadgeTone(rollup(specs, root));

/** Minutes after STARTED, as ISO. */
const at = (minutes: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(STARTED), { minutes }));
const rootRanUntil = (minutes: number): Partial<OrchestrationV2ThreadShell> => ({
  status: "completed",
  latestRunCompletedAt: DateTime.makeUnsafe(at(minutes)),
});
const rootRunning: Partial<OrchestrationV2ThreadShell> = { activityRunStatus: "running" };

describe("workstream rollups", () => {
  it("an empty graph rolls up to nothing on every axis", () => {
    const { plan, activity, attention } = rollup([]);
    expect(plan).toMatchObject({ total: 0, settled: false, deadlocked: null });
    expect(activity).toEqual({ running: 0, active: 0 });
    expect(attention).toEqual({ count: 0, highest: null, nodes: [] });
  });

  it("all nodes done or cancelled → the plan is settled", () => {
    const { plan } = rollup([
      { id: "a", outcome: "done" },
      { id: "b", outcome: "cancelled" },
    ]);
    expect(plan).toMatchObject({ settled: true, columns: { done: 1, cancelled: 1 } });
  });

  it("a node blocked on a running sibling: blocked in the plan, running in the activity, never deadlocked", () => {
    const { plan, activity } = rollup([
      { id: "a", blockedBy: ["b"] },
      { id: "b", started: true, activity: "running" },
    ]);
    expect(plan).toMatchObject({ columns: { blocked: 1, in_progress: 1 }, deadlocked: null });
    expect(activity).toEqual({ running: 1, active: 1 });
  });

  it("a node blocked on a flagged sibling surfaces the stored reason", () => {
    const { attention } = rollup([
      { id: "a", blockedBy: ["b"] },
      { id: "b", started: true, attention: ["awaiting_acceptance"] },
    ]);
    expect(attention).toMatchObject({ count: 1, highest: "awaiting_acceptance" });
  });

  it("a dependency cycle of released, unstarted nodes is deadlocked", () => {
    const { plan } = rollup([
      { id: "a", blockedBy: ["b"] },
      { id: "b", blockedBy: ["a"] },
    ]);
    expect([...(plan.deadlocked ?? [])].sort()).toEqual(["a", "b"]);
  });

  it("a held subtree awaiting release is idle, not deadlocked", () => {
    const { plan } = rollup([
      { id: "a", held: true },
      { id: "b", held: true, blockedBy: ["a"] },
    ]);
    expect(plan).toMatchObject({ columns: { held: 2 }, deadlocked: null });
  });

  it("a stale in-progress node with no activity is neither running nor deadlocked", () => {
    const { plan, activity } = rollup([
      { id: "a", started: true },
      { id: "b", outcome: "done" },
    ]);
    expect(plan.deadlocked).toBeNull();
    expect(activity).toEqual({ running: 0, active: 0 });
  });

  it("derives awaiting_approval and awaiting_input from the pending request, highest priority first", () => {
    const { attention } = rollup([
      { id: "a", request: "user_input" },
      { id: "b", request: "command" },
      { id: "c", outcome: "done" },
    ]);
    expect(attention.nodes.map(({ id, reason }) => ({ id, reason }))).toEqual([
      { id: "b", reason: "awaiting_approval" },
      { id: "a", reason: "awaiting_input" },
    ]);
  });

  it("a stored error outranks a derived approval", () => {
    const { attention } = rollup([
      { id: "a", started: true, attention: ["error"] },
      { id: "b", request: "file-change" },
    ]);
    expect(attention.highest).toBe("error");
  });

  it("a starting run is active but not running", () => {
    const { activity } = rollup([{ id: "a", started: true, activity: "starting" }]);
    expect(activity).toEqual({ running: 0, active: 1 });
  });

  it("archived nodes are excluded from every axis", () => {
    const { plan, activity, attention } = rollup([
      { id: "a", started: true, activity: "running", attention: ["error"], archived: true },
      { id: "b" },
    ]);
    expect(plan.total).toBe(1);
    expect(activity.running).toBe(0);
    expect(attention.count).toBe(0);
  });

  it("covers grandchildren through lineage", () => {
    const { plan } = rollup([
      { id: "a", started: true },
      { id: "g", parent: "a", outcome: "cancelled" },
    ]);
    expect(plan.total).toBe(2);
  });
});

describe("attentionReasonsOf", () => {
  const reasonsOf = (id: string, specs: ReadonlyArray<Spec>) => {
    const threads = graph(specs);
    return attentionReasonsOf(
      threads.find((thread) => thread.id === id)!,
      workstreamIndexOf(threads),
    );
  };

  it("adds brief-needed only for a live, unbriefed, unstarted child", () => {
    expect(reasonsOf("a", [{ id: "a", brief: false }])).toEqual(["brief-needed"]);
    expect(reasonsOf("b", [{ id: "b", brief: false, started: true }])).toEqual([]);
    expect(reasonsOf("c", [{ id: "c", brief: false, outcome: "cancelled" }])).toEqual([]);
    expect(reasonsOf("root", [])).toEqual([]);
  });

  it("derives brief-needed exactly when the server would: never held, never queued behind a sibling", () => {
    expect(reasonsOf("a", [{ id: "a", brief: false, held: true }])).toEqual([]);
    expect(
      reasonsOf("a", [
        { id: "a", brief: false, blockedBy: ["b"] },
        { id: "b", started: true, activity: "running" },
      ]),
    ).toEqual([]);
    expect(
      reasonsOf("a", [
        { id: "a", brief: false, blockedBy: ["b"] },
        { id: "b", outcome: "done" },
      ]),
    ).toEqual(["brief-needed"]);
  });

  it("keeps a yield (awaiting_orchestrator) as attention, not a column", () => {
    expect(
      reasonsOf("a", [{ id: "a", started: true, attention: ["awaiting_orchestrator"] }]),
    ).toEqual(["awaiting_orchestrator"]);
  });
});

describe("workstreamBadgeTone", () => {
  it.each<[string, ReadonlyArray<Spec>, ReturnType<typeof workstreamBadgeTone>]>([
    ["a stored error", [{ id: "a", started: true, attention: ["error"] }], "failed"],
    [
      "a failed latest run",
      [{ id: "a", started: true, shell: { status: "failed", lastErrorClass: "provider_error" } }],
      "failed",
    ],
    [
      "a deadlock with nothing running",
      [
        { id: "a", blockedBy: ["b"] },
        { id: "b", blockedBy: ["a"] },
      ],
      "failed",
    ],
    [
      "a human gate beside a running sibling",
      [
        { id: "a", started: true, attention: ["awaiting_acceptance"] },
        { id: "b", started: true, activity: "running" },
      ],
      "needs_you",
    ],
    [
      "a child queued, unbriefed, behind a running sibling",
      [
        { id: "a", brief: false, blockedBy: ["b"] },
        { id: "b", started: true, activity: "running" },
      ],
      "working",
    ],
    [
      "every child settled",
      [
        { id: "a", outcome: "done" },
        { id: "b", outcome: "cancelled" },
      ],
      "done",
    ],
    [
      "a usage-limited run (auto-resumed) and a held child",
      [
        { id: "a", started: true, shell: { status: "failed", lastErrorClass: "usage_limit" } },
        { id: "b", held: true, brief: false },
      ],
      "waiting",
    ],
  ])("%s → %s", (_, specs, expected) => {
    expect(tone(specs)).toBe(expected);
  });

  const yielded = (eventId: string | null): Spec => ({
    id: "a",
    started: true,
    attention: ["awaiting_orchestrator"],
    fields: {
      lastOutcome: {
        outcome: "awaiting_decision",
        decision: "yield",
        round: 0,
        eventId: eventId === null ? null : EventId.make(eventId),
        at: at(10),
      },
    },
  });

  it("a yield is the parent's work until the parent's turn ends without resolving it", () => {
    // Yielded at +10; the wake has not landed (the parent last ran before it).
    expect(tone([yielded("evt")], rootRanUntil(5))).toBe("working");
    expect(tone([yielded("evt")], rootRunning)).toBe("working");
    expect(tone([yielded("evt")], { status: "queued" })).toBe("working");
    expect(tone([yielded("evt")], rootRanUntil(12))).toBe("needs_you");
    // The parent resumed the child before its turn ended; the flag clears when that turn starts.
    expect(tone([{ ...yielded("evt"), shell: { status: "queued" } }], rootRanUntil(12))).toBe(
      "working",
    );
    // An imported yield has no event, so no wake is coming.
    expect(tone([yielded(null)])).toBe("needs_you");
  });

  it("a brief owed since a dependency finished waits on the parent's next turn", () => {
    const specs: ReadonlyArray<Spec> = [
      { id: "a", brief: false, blockedBy: ["b"] },
      { id: "b", outcome: "done", fields: { outcomeAt: at(10) } },
    ];
    expect(tone(specs, rootRanUntil(5))).toBe("working");
    expect(tone(specs, rootRanUntil(12))).toBe("needs_you");
  });

  it("only red and amber flag the human: parent-owed nodes are not counted for the !", () => {
    const { attention } = rollup([yielded("evt")], rootRunning);
    expect(attention.nodes).toMatchObject([{ id: "a", withAgents: true }]);
  });
});
