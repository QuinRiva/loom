/**
 * Preview fixtures for the Workstream graph, timeline, quick facts and active
 * strip (Phase 3 track 3d-2), rendered from 3d-1's fixture shells.
 */
import {
  type WorkstreamRollup,
  workstreamRollupOf,
} from "@t3tools/client-runtime/state/loom/rollup";
import { workstreamIndexOf } from "@t3tools/client-runtime/state/loom/workstream";
import {
  EventId,
  type LoomThreadShellFields,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import { LOOM_SEED } from "@t3tools/shared/loomSeedFixture.loom";
import { subtreeOf } from "@t3tools/shared/workstreamGraph";
import * as DateTime from "effect/DateTime";
import { Suspense } from "react";

import WorkstreamGraph from "../components/WorkstreamGraph";
import { WorkstreamActiveStrip } from "../components/WorkstreamActiveStrip";
import { WorkstreamQuickFacts } from "../components/WorkstreamQuickFacts";
import { WorkstreamTimelineDrawer } from "../components/WorkstreamTimeline";
import { buildWorkstreamNodes, liveNodes } from "../lib/workstreamPresentation";
import { LoomRollupPill } from "../loom/LoomRollupBadge";
import type { PreviewGroup } from "./fixtures";
import { loomPreviewThreads, shell, workstream } from "./loomFixtures";

const T = LOOM_SEED.threads;

const withWorkstream = (
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  threadId: ThreadId,
  patch: Partial<NonNullable<OrchestrationV2ThreadShell["workstream"]>>,
) =>
  shells.map((shell) =>
    shell.id === threadId && shell.workstream
      ? { ...shell, workstream: { ...shell.workstream, ...patch } }
      : shell,
  );

/**
 * The fixture set with the waves real spawns carry (the gated pair, the survey
 * and its dependent), its ready child turned into a `forkFrom` child of the
 * done coder.
 */
const PREVIEW_PATCHES: ReadonlyArray<
  readonly [ThreadId, Partial<NonNullable<OrchestrationV2ThreadShell["workstream"]>>]
> = [
  [T.gateCoder, { spawnGeneration: "wave-gate" }],
  [T.gateReviewer, { spawnGeneration: "wave-gate" }],
  [T.quiescent, { spawnGeneration: "wave-survey" }],
  [T.blocked, { spawnGeneration: "wave-survey" }],
  [loomPreviewThreads.ready.id, { forkFromThreadId: T.coderDone, blockedBy: [T.coderDone] }],
];
const PREVIEW_SHELLS = PREVIEW_PATCHES.reduce(
  (current, [threadId, patch]) => withWorkstream(current, threadId, patch),
  Object.values(loomPreviewThreads) as ReadonlyArray<OrchestrationV2ThreadShell>,
);

const nodes = buildWorkstreamNodes(PREVIEW_SHELLS);
const startIndex = workstreamIndexOf(PREVIEW_SHELLS);
const rollupOf = (threadId: ThreadId) => {
  const rollup = workstreamRollupOf(threadId, PREVIEW_SHELLS, startIndex);
  return rollup.plan.total === 0 ? null : rollup;
};
const titleOf = (threadId: ThreadId) => nodes.get(threadId)?.title ?? threadId;
const noop = () => {};

function GraphFixture() {
  const subtree = subtreeOf(T.root, liveNodes(nodes.values()));
  const rollup = rollupOf(T.root);
  return (
    <div className="mx-auto w-[720px] p-3">
      {rollup ? (
        <WorkstreamActiveStrip
          nodes={subtree.filter((node) => node.id !== T.root)}
          rollup={rollup}
          onOpenThread={noop}
        />
      ) : null}
      <Suspense fallback={null}>
        <WorkstreamGraph
          viewKey="preview:workstream-graph"
          nodes={subtree}
          byId={nodes}
          rollupOf={rollupOf}
          titleOf={titleOf}
          onOpenThread={noop}
          onOpenTimeline={noop}
          onNodeContextMenu={noop}
        />
      </Suspense>
    </div>
  );
}

function QuickFactsFixture({ threadId }: { threadId: ThreadId }) {
  const node = nodes.get(threadId)!;
  return (
    <div className="relative mx-auto h-[360px] w-[300px] [&>div]:top-2 [&>div]:left-2">
      <WorkstreamQuickFacts
        node={node}
        byId={nodes}
        rollup={rollupOf(threadId)}
        titleOf={titleOf}
      />
    </div>
  );
}

function TimelineFixture({ threadId }: { threadId: ThreadId }) {
  return (
    <div className="relative mx-auto h-[420px] w-[400px] overflow-hidden rounded-lg border border-border">
      <WorkstreamTimelineDrawer
        node={nodes.get(threadId)}
        history={null}
        titleOf={titleOf}
        onClose={noop}
        onOpenThread={noop}
        onOpenReport={noop}
        onJump={noop}
      />
    </div>
  );
}

// ---- the sidebar rollup badge: one row per tone, the yield cases, the real rows ----

const BADGE_T0 = DateTime.makeUnsafe("2026-10-05T09:00:00.000Z");
/** An ISO stamp `minutes` after the fixtures' clock. */
const at = (minutes: number) => DateTime.formatIso(DateTime.add(BADGE_T0, { minutes }));
const ranUntil = (minutes: number): Partial<OrchestrationV2ThreadShell> => ({
  status: "completed",
  latestRunCompletedAt: DateTime.makeUnsafe(at(minutes)),
});
const running: Partial<OrchestrationV2ThreadShell> = {
  status: "running",
  activityRunStatus: "running",
};
const begun = { kickoffAt: at(-60) };
const finished = { ...begun, outcome: "done", outcomeAt: at(-30) } as const;

interface BadgeChild {
  readonly title: string;
  /** Sidecar fields; `sibling(i)` names the i-th child of the same root. */
  readonly fields?: (sibling: (index: number) => ThreadId) => Partial<LoomThreadShellFields>;
  readonly shell?: Partial<OrchestrationV2ThreadShell>;
}

interface BadgeRow {
  readonly key: string;
  readonly title: string;
  readonly branch: string;
  readonly rollup: WorkstreamRollup;
}

/** A root and its children as real shells, rolled up the way the sidebar does it. */
function badgeRow(
  key: string,
  title: string,
  children: ReadonlyArray<BadgeChild>,
  rootShell: Partial<OrchestrationV2ThreadShell> = ranUntil(-40),
): BadgeRow {
  const rootId = ThreadId.make(`badge-${key}`);
  const sibling = (index: number) => ThreadId.make(`badge-${key}-${index}`);
  const shells = [
    shell(
      title,
      workstream(rootId, {
        parentThreadId: null,
        rootThreadId: rootId,
        role: null,
        kickoffBriefPath: null,
        ...begun,
      }),
      rootShell,
    ),
    ...children.map((child, index) =>
      shell(
        child.title,
        workstream(sibling(index), {
          parentThreadId: rootId,
          rootThreadId: rootId,
          createdAt: at(-90),
          ...child.fields?.(sibling),
        }),
        child.shell,
      ),
    ),
  ];
  return {
    key,
    title,
    branch: `t3/${key}`,
    rollup: workstreamRollupOf(rootId, shells, workstreamIndexOf(shells)),
  };
}

const yielded = (eventId: string | null): Partial<LoomThreadShellFields> => ({
  ...begun,
  attention: ["awaiting_orchestrator"],
  lastOutcome: {
    outcome: "awaiting_decision",
    decision: "yield",
    round: 0,
    eventId: eventId === null ? null : EventId.make(eventId),
    at: at(0),
  },
});

const BADGE_TONES = {
  failed: badgeRow("badge-failed", "Port the loader to the new config", [
    { title: "Add config loader", fields: () => finished },
    {
      title: "Benchmark the parser",
      fields: () => begun,
      shell: { status: "failed", lastErrorClass: "provider_error" },
    },
  ]),
  needsYou: badgeRow("badge-needs-you", "Parser with review gate", [
    { title: "Add config loader", fields: () => finished },
    {
      title: "Review the parser",
      fields: () => ({ ...begun, attention: ["awaiting_acceptance"] }),
    },
  ]),
  working: badgeRow("badge-working", "Survey then plan the migration", [
    { title: "Survey the call sites", fields: () => begun, shell: running },
    {
      title: "Plan the migration",
      fields: (sibling) => ({ kickoffBriefPath: null, blockedBy: [sibling(0)] }),
    },
  ]),
  done: badgeRow("badge-done", "Model picker: dedupe same-name models", [
    { title: "Survey the picker", fields: () => finished },
    { title: "Dedupe by provider", fields: () => finished },
    { title: "Review the dedupe", fields: () => finished },
  ]),
  waiting: badgeRow("badge-waiting", "Explain the patch later", [
    { title: "Land the patch", fields: () => finished },
    {
      title: "Explain the patch",
      fields: () => ({ kickoffBriefPath: null, held: true, heldSince: at(-20) }),
    },
  ]),
};

const yieldChild = (eventId: string | null): BadgeChild => ({
  title: "Decide the incentive strategy",
  fields: () => yielded(eventId),
});

/** A child yields at t=0; the orchestrator's state decides who owns it. */
const BADGE_YIELDS = [
  badgeRow(
    "yield-wake-pending",
    "Yield — wake on its way",
    [yieldChild("evt-yield")],
    ranUntil(-5),
  ),
  badgeRow("yield-answering", "Yield — orchestrator answering", [yieldChild("evt-yield")], running),
  badgeRow(
    "yield-unresolved",
    "Yield — turn ended unresolved",
    [yieldChild("evt-yield")],
    ranUntil(2),
  ),
];

const many = (count: number, title: string, fields: NonNullable<BadgeChild["fields"]>) =>
  Array.from({ length: count }, (_, index) => ({ title: `${title} ${index + 1}`, fields }));

/** The three rows from the plan, rebuilt from their live sidecar states. */
const BADGE_REAL_ROWS = [
  badgeRow(
    "gold-eval-extraction-fix",
    "Evaluate Golden Dataset via Extraction Fix",
    [
      ...many(17, "Golden eval step", () => finished),
      { title: "Superseded extraction pass", fields: () => ({ ...begun, outcome: "cancelled" }) },
      {
        title: "Explain the AIT-35 patch",
        fields: () => ({ kickoffBriefPath: null, held: true, heldSince: at(-10) }),
      },
    ],
    {},
  ),
  badgeRow("disk-usage-cleanup-audit", "Disk Cleanup and Deletion Candidates", [
    { title: "Disk usage researcher", fields: () => begun, shell: running },
  ]),
  badgeRow("nested-id-bloat", "V2 nested-ID bloat investigation", [
    { title: "Trace the nested IDs", fields: () => begun, shell: running },
    { title: "Measure the ID bloat", fields: () => begun, shell: running },
    {
      title: "Derived-ID shortening plan",
      fields: (sibling) => ({
        role: "planner",
        kickoffBriefPath: null,
        blockedBy: [sibling(0), sibling(1)],
      }),
    },
  ]),
];

/** Sidebar-shaped rows: title, the root's label (badge Q5), branch and the pill. */
function BadgeRows({ rows }: { rows: ReadonlyArray<BadgeRow> }) {
  return (
    <div className="mx-auto flex w-[300px] flex-col gap-1 rounded-lg border border-border bg-card p-1.5">
      {rows.map((row) => (
        <div key={row.key} className="flex flex-col gap-0.5 rounded-md px-2 py-1.5">
          <div className="flex items-center gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate font-medium text-foreground">{row.title}</span>
            {row.rollup.plan.settled ? (
              <span className="text-3xs text-success">Done</span>
            ) : (
              <span className="text-3xs text-muted-foreground">Waiting</span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-3xs text-muted-foreground">
            <span className="min-w-0 flex-1 truncate">{row.branch}</span>
            <LoomRollupPill
              rollup={row.rollup}
              dataKey={row.key}
              onOpenThread={noop}
              onOpenPanel={noop}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

const BADGE_TONE_FIXTURES = [
  ["failed", "Failed — a sub-thread's latest run failed", BADGE_TONES.failed],
  ["needs-you", "Needs you — a sub-thread awaits acceptance", BADGE_TONES.needsYou],
  ["working", "Working — one runs, one is queued behind it", BADGE_TONES.working],
  ["done", "Done — every sub-thread settled", BADGE_TONES.done],
  ["waiting", "Waiting — nothing moves, nothing asked", BADGE_TONES.waiting],
] as const;

export const WORKSTREAM_PREVIEW_GROUP: PreviewGroup = {
  id: "workstream",
  title: "Workstream",
  fixtures: [
    {
      id: "workstream-graph",
      title: "Graph — gated pair with round badge",
      description:
        "The whole orchestration with the active strip: the reviewer→coder loop edge carries ⟲ rounds/cap and the open-rework dot; the forkFrom child carries the fork badge.",
      render: () => <GraphFixture />,
    },
    {
      id: "workstream-quick-facts-root",
      title: "Quick facts — orchestrator rollups",
      render: () => <QuickFactsFixture threadId={T.root} />,
    },
    {
      id: "workstream-quick-facts-reviewer",
      title: "Quick facts — reviewer in gate",
      render: () => <QuickFactsFixture threadId={T.gateReviewer} />,
    },
    {
      id: "workstream-timeline",
      title: "Timeline — reviewer in gate",
      render: () => <TimelineFixture threadId={T.gateReviewer} />,
    },
    ...BADGE_TONE_FIXTURES.map(([id, title, row]) => ({
      id: `workstream-badge-${id}`,
      title: `Sidebar badge — ${title}`,
      render: () => <BadgeRows rows={[row]} />,
    })),
    {
      id: "workstream-badge-yield",
      title: "Sidebar badge — a yield, by orchestrator state",
      description:
        "A child yields at t=0. Before the orchestrator's wake turn lands, and while it runs, the yield is its work (blue); once its turn ends without resolving it, the yield is yours (amber).",
      render: () => <BadgeRows rows={BADGE_YIELDS} />,
    },
    {
      id: "workstream-badge-real-rows",
      title: "Sidebar badge — the three rows from the plan",
      description:
        "Golden dataset (18 settled, one held child): grey. Disk cleanup (one researcher running): blue. Nested-ID (two running, a planner queued behind both): blue.",
      render: () => <BadgeRows rows={BADGE_REAL_ROWS} />,
    },
  ],
};
