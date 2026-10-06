/**
 * loom: 3d-3's preview groups — the control cards (every seam-6 kind plus the
 * raw-text fallback), the consult row and handoff receipt, and the goal tasks
 * panel — rendered against `loomFixtures.ts` (the dev seed's payloads).
 * Registered by one line in `fixtures.tsx`.
 */
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import type { LoomMessageFields } from "@t3tools/contracts";

import { GoalPanelView } from "../components/GoalTasksPanel";
import { ControlDigestCardView } from "../loom/ControlDigestCard";
import { controlCardModel } from "../loom/controlMessages";
import { LoomTimelineRowView } from "../loom/LoomTimelineRowView";
import type { LoomTimelineRow } from "../loom/loomTimelineRows";
import type { PreviewGroup } from "./fixtures";
import {
  loomPreviewAnchoredThreadId,
  loomPreviewControlMessages,
  loomPreviewEnvironmentId,
  loomPreviewGoal,
  loomPreviewThreads,
} from "./loomFixtures";
import { TimelineLayoutFrame } from "./TimelineLayoutFrame";

const shells = Object.values(loomPreviewThreads).map((thread) =>
  presentThreadShell(loomPreviewEnvironmentId, thread),
);
const senderLabels = new Map(shells.map((thread) => [thread.id, thread.title] as const));

function ControlCard({ loom, text }: { loom: LoomMessageFields | undefined; text: string }) {
  const model = controlCardModel(loom, text);
  return model === null ? (
    <p className="text-sm text-muted-foreground">Not a control arrival: renders upstream's bubble.</p>
  ) : (
    <ControlDigestCardView
      model={model}
      text={text}
      senderLabels={senderLabels}
      cwd={undefined}
      threadRef={null}
      skills={[]}
      onOpenThread={null}
      defaultExpanded
    />
  );
}

const FALLBACK_TEXT =
  "## Future notice\n\nA control message whose notice kind this build does not know. The card falls back to the message text.";

const timelineRows: ReadonlyArray<LoomTimelineRow> = [
  {
    kind: "loom-consult",
    id: "loom-consult:preview",
    createdAt: "2026-10-05T09:00:00.000Z",
    consult: {
      targetThreadId: loomPreviewThreads.reviewerInGate.id,
      targetTitle: loomPreviewThreads.reviewerInGate.title,
      count: 3,
      lastConsultAt: "2026-10-05T09:00:00.000Z",
      lastQuestionPreview: "Which of the two must-fix findings blocks the release?",
    },
  },
  {
    kind: "loom-handoff",
    id: "loom-handoff:preview",
    createdAt: "2026-10-05T09:00:00.000Z",
    successor: {
      threadId: loomPreviewThreads.held.id,
      title: loomPreviewThreads.held.title,
      state: "staged",
    },
  },
];

export const LOOM_PREVIEW_GROUPS: ReadonlyArray<PreviewGroup> = [
  {
    id: "loom-control-cards",
    title: "Loom control cards",
    fixtures: [
      ...loomPreviewControlMessages.map((message) => ({
        id: `loom-control-${message.id}`,
        title: message.loom?.controlPayload?.notice
          ? `notice: ${message.loom.controlPayload.notice}`
          : (message.loom?.controlPayload?.kind ?? "message"),
        description:
          "From `message.loom.controlPayload` (the dev seed's payload for this kind), expanded.",
        render: () => (
          <TimelineLayoutFrame>
            <ControlCard loom={message.loom} text={message.text} />
          </TimelineLayoutFrame>
        ),
      })),
      {
        id: "loom-control-unknown-notice",
        title: "Unknown notice → raw text",
        description:
          "A notice this build does not know renders the message's text, never throws (DL-434).",
        render: () => (
          <TimelineLayoutFrame>
            <ControlCard
              loom={{
                origin: "control_notice",
                // A kind added after this build; the decoder would carry it as data.
                controlPayload: { kind: "notice", notice: "future-kind" as never, items: [] },
              }}
              text={FALLBACK_TEXT}
            />
          </TimelineLayoutFrame>
        ),
      },
    ],
  },
  {
    id: "loom-timeline-rows",
    title: "Loom timeline rows",
    fixtures: [
      {
        id: "loom-consult-and-handoff",
        title: "Consult row and handoff receipt",
        description:
          "From `shell.workstream.consults` and a root whose `continuesThreadId` is this thread.",
        render: () => (
          <TimelineLayoutFrame>
            {timelineRows.map((row) => (
              <LoomTimelineRowView key={row.id} row={row} environmentId={loomPreviewEnvironmentId} />
            ))}
          </TimelineLayoutFrame>
        ),
      },
    ],
  },
  {
    id: "loom-goal-panel",
    title: "Loom goal tasks panel",
    fixtures: [
      {
        id: "loom-goal-tasks-panel",
        title: "Goal tasks panel",
        description:
          "The seeded goal with its nested tree, anchor chips on the anchored tasks, and the root threads in handoff order. Edits need a server.",
        render: () => (
          <div className="flex h-[640px] w-[420px] flex-col overflow-auto rounded-lg border border-border p-4">
            <GoalPanelView
              goal={loomPreviewGoal}
              thread={{ id: loomPreviewAnchoredThreadId, environmentId: loomPreviewEnvironmentId }}
              shells={shells}
            />
          </div>
        ),
      },
    ],
  },
];
