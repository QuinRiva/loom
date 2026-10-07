/**
 * Preview fixtures for the Workstream board, graph, timeline, quick facts and
 * active strip (Phase 3 track 3d-2), rendered from 3d-1's fixture shells. The
 * board's outcome and dependency controls write to local state, so both
 * directions of each control can be exercised without a backend.
 */
import { workstreamRollupOf } from "@t3tools/client-runtime/state/loom/rollup";
import { workstreamIndexOf } from "@t3tools/client-runtime/state/loom/workstream";
import type { LoomOutcome, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { LOOM_SEED } from "@t3tools/shared/loomSeedFixture.loom";
import { subtreeOf } from "@t3tools/shared/workstreamGraph";
import { Suspense, useMemo, useState } from "react";

import WorkstreamGraph from "../components/WorkstreamGraph";
import { WorkstreamActiveStrip } from "../components/WorkstreamActiveStrip";
import { WorkstreamBoard } from "../components/WorkstreamPanel";
import { WorkstreamQuickFacts } from "../components/WorkstreamQuickFacts";
import { WorkstreamTimelineDrawer } from "../components/WorkstreamTimeline";
import { buildWorkstreamNodes, liveNodes } from "../lib/workstreamPresentation";
import type { WorkstreamCommands } from "../loom/workstreamState";
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

function usePreviewWorkstream() {
  const [shells, setShells] = useState(PREVIEW_SHELLS);
  return useMemo(() => {
    const nodes = buildWorkstreamNodes(shells);
    const startIndex = workstreamIndexOf(shells);
    const commands: WorkstreamCommands = {
      setOutcome: (threadId, outcome: LoomOutcome | null) =>
        setShells((current) =>
          withWorkstream(current, threadId, {
            outcome,
            outcomeAt: outcome === null ? null : new Date().toISOString(),
          }),
        ),
      setDependencies: (node, blockedBy) =>
        setShells((current) =>
          withWorkstream(current, node.id, {
            blockedBy: [...blockedBy],
            dependenciesSince: new Date().toISOString(),
          }),
        ),
      clearAttention: (threadId) =>
        setShells((current) => withWorkstream(current, threadId, { attention: [] })),
      stop: () => {},
    };
    return {
      nodes,
      commands,
      rollupOf: (threadId: ThreadId) => {
        const rollup = workstreamRollupOf(threadId, shells, startIndex);
        return rollup.plan.total === 0 ? null : rollup;
      },
      titleOf: (threadId: ThreadId) => nodes.get(threadId)?.title ?? threadId,
    };
  }, [shells]);
}

const noop = () => {};

function BoardFixture() {
  const { nodes, commands } = usePreviewWorkstream();
  return (
    <div className="mx-auto w-[460px] rounded-lg border border-border bg-background p-3">
      <WorkstreamBoard
        threadId={T.root}
        nodes={nodes}
        commands={commands}
        onOpenThread={noop}
        onOpenTimeline={noop}
        onOpenReport={noop}
        onJump={noop}
      />
    </div>
  );
}

function GraphFixture() {
  const { nodes, rollupOf, titleOf } = usePreviewWorkstream();
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
  const { nodes, rollupOf, titleOf } = usePreviewWorkstream();
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
  const { nodes, titleOf } = usePreviewWorkstream();
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
      id: "workstream-board",
      title: "Board — every column",
      description:
        "The root's board: held (staged root), blocked (dependency, brief-needed), ready (a forkFrom child), in progress (gated pair, quiescent yield, pending requests), done, cancelled. Outcome and dependency controls write to local state.",
      render: () => <BoardFixture />,
    },
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
