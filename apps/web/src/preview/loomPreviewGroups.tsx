/**
 * loom: 3d-3's preview groups — the control cards (every seam-6 kind plus the
 * raw-text fallback), the consult row and handoff receipt, and the goal tasks
 * panel — rendered against `loomFixtures.ts` (the dev seed's payloads); and
 * 3d-4's user-input panel additions (DT-36).
 * Registered by one line in `fixtures.tsx`.
 */
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import type { LoomMessageFields, RuntimeRequestId, UserInputQuestion } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { ComposerPendingUserInputPanel } from "../components/chat/ComposerPendingUserInputPanel";
import { hostLoomPendingInputForPreview } from "../loom/pendingUserInputLoom";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "../pendingUserInput";

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
    <p className="text-sm text-muted-foreground">
      Not a control arrival: renders upstream's bubble.
    </p>
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

const LOOM_QUESTIONS: ReadonlyArray<UserInputQuestion> = [
  {
    id: "loom-q-1",
    header: "Diff scope for the review gate",
    question:
      "The reviewer flagged `apps/web/src/components/DiffPanel.tsx` and `apps/web/src/diffPanelStore.ts`.\n\n- **Option 1** keeps the per-run diff (honest with the turn baseline).\n- **Option 2** shows the child's whole range.\n\nWhich should *By coder* show?",
    options: [
      { label: "Per-run diff", description: "The child's own checkpoint turns." },
      { label: "Whole range", description: "First to last checkpoint." },
    ],
    multiSelect: false,
  },
];

/**
 * DT-36 on V2's RuntimeRequest panel: a markdown body (paths become file chips
 * in the app), digit-select that never submits (press 1 or 2: the option is
 * selected and nothing advances), and "reply in chat instead", which in the app
 * sends the composer text as an ordinary message.
 */
function LoomPendingUserInputPreview() {
  const requestId = "preview-loom-request" as RuntimeRequestId;
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [sent, setSent] = useState<string | null>(null);
  const progress = derivePendingUserInputProgress(LOOM_QUESTIONS, answers, 0);
  const customAnswer = progress.customAnswer;
  useEffect(() => {
    hostLoomPendingInputForPreview(requestId, {
      cwd: undefined,
      threadRef: undefined,
      onReplyInChat: () => setSent(customAnswer.trim()),
    });
  }, [customAnswer, requestId]);
  return (
    <div className="mx-auto flex h-[85vh] w-full min-w-0 max-w-3xl flex-col justify-end p-6">
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            requestId,
            createdAt: "2026-10-06T04:00:00.000Z",
            questions: LOOM_QUESTIONS.map((question) => ({
              ...question,
              multiSelect: question.multiSelect ?? false,
            })),
            responseCapability: "live",
            dismissible: true,
          },
        ]}
        respondingRequestIds={[]}
        answers={answers}
        questionIndex={0}
        onToggleOption={(questionId, optionValue) =>
          setAnswers((current) => ({
            ...current,
            [questionId]: togglePendingUserInputOptionSelection(
              LOOM_QUESTIONS[0]!,
              current[questionId],
              optionValue,
            ),
          }))
        }
        onAdvance={() => setSent("(answers submitted)")}
        onDismiss={() => {}}
      />
      <textarea
        aria-label="Composer text"
        placeholder="Composer stand-in: type to reply in chat instead"
        className="mt-2 rounded-md border border-border bg-transparent p-2 text-sm"
        value={customAnswer}
        onChange={(event) => {
          const value = event.target.value;
          setAnswers((current) => ({
            ...current,
            "loom-q-1": setPendingUserInputCustomAnswer(current["loom-q-1"], value),
          }));
        }}
      />
      <p className="mt-2 text-xs text-muted-foreground" data-loom-preview-sent>
        {sent === null ? "Nothing sent yet." : `Sent: ${sent}`}
      </p>
    </div>
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

/**
 * DL-610: V1 rows as the importer (and migration 1053) stamp them, from the
 * QA copy: V1 payloads carry no item `kind`, `notice` or `synthesised`.
 */
const IMPORTED_V1_TEXT =
  '[T3 Workstream control plane \u2014 automated notice, not from the user]\n\nThe flattened notice the model received, behind "show raw payload".';

const IMPORTED_V1_CONTROL: ReadonlyArray<{
  readonly title: string;
  readonly loom: LoomMessageFields;
}> = [
  {
    title: "Imported V1 yield",
    loom: {
      origin: "control_notice",
      controlPayload: {
        kind: "yield",
        heading: "A sub-thread yielded to you (unmatched outcome).",
        items: [
          {
            threadId: loomPreviewThreads.reviewerInGate.id,
            role: "reviewer",
            title: "Yielded to you \u2014 outcome `fixed_inline`",
            status: "yielded",
            icon: "\u21a9\ufe0f",
            reportPath: "/home/dev/.t3/userdata/workstream-reports/a61d9843.md",
            excerpt:
              "# Gate check: the theme-token change is clean\n\nI found no code problems, so the shipper can go ahead.",
          },
        ],
      },
    },
  },
  {
    title: "Imported V1 digest",
    loom: {
      origin: "control_notice",
      controlPayload: {
        kind: "digest",
        heading:
          "FYI digest \u2014 the following items completed and were fully routed since you last heard.",
        items: [
          {
            threadId: loomPreviewThreads.done.id,
            role: "shipper",
            title: "Completed",
            status: "done",
            icon: "\u2611\ufe0f",
            reportPath: "/home/dev/.t3/userdata/workstream-reports/97c74d3b.md",
            excerpt: "Pull 8 is landed on `origin/main`: #323, #324 and #325 are all merged.",
            timestamp: "2026-10-05 10:42Z",
          },
        ],
      },
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
      ...IMPORTED_V1_CONTROL.map(({ title, loom }) => ({
        id: `loom-control-${title.toLowerCase().replaceAll(" ", "-")}`,
        title,
        description: "A V1 control message after import: the same card as a new one (DL-610).",
        render: () => (
          <TimelineLayoutFrame>
            <ControlCard loom={loom} text={IMPORTED_V1_TEXT} />
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
              <LoomTimelineRowView
                key={row.id}
                row={row}
                environmentId={loomPreviewEnvironmentId}
              />
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
  {
    id: "loom-user-input",
    title: "Loom user-input panel additions",
    fixtures: [
      {
        id: "loom-pending-user-input",
        title: "Question with markdown body and reply in chat",
        description:
          "DT-36: markdown body, digit-select never submits (the single question waits for Send), reply in chat instead.",
        render: () => <LoomPendingUserInputPreview />,
      },
    ],
  },
];
