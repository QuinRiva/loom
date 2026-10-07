/**
 * Preview fixtures for the Workstream graph, timeline, quick facts and active
 * strip (Phase 3 track 3d-2), rendered from 3d-1's fixture shells.
 */
import { workstreamRollupOf } from "@t3tools/client-runtime/state/loom/rollup";
import { workstreamIndexOf } from "@t3tools/client-runtime/state/loom/workstream";
import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { LOOM_SEED } from "@t3tools/shared/loomSeedFixture.loom";
import { subtreeOf } from "@t3tools/shared/workstreamGraph";
import { Suspense } from "react";

import WorkstreamGraph from "../components/WorkstreamGraph";
import { WorkstreamActiveStrip } from "../components/WorkstreamActiveStrip";
import { WorkstreamQuickFacts } from "../components/WorkstreamQuickFacts";
import { WorkstreamTimelineDrawer } from "../components/WorkstreamTimeline";
import { buildWorkstreamNodes, liveNodes } from "../lib/workstreamPresentation";
import type { PreviewGroup } from "./fixtures";
import { loomPreviewThreads } from "./loomFixtures";

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
  ],
};
