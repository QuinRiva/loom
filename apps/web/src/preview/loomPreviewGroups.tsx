/**
 * loom: control cards, consult row, handoff receipt, goal tasks panel and user-input panel
 * additions, rendered against `loomFixtures.ts`. Registered by one line in `fixtures.tsx`.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { LOOM_SEED } from "@t3tools/shared/loomSeedFixture.loom";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  type LoomMessageFields,
  type LoomThreadShellFields,
  type OrchestrationV2ThreadShell,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { OpenQuestionsRail } from "../loom/openQuestions/OpenQuestionsRail";

import { GoalPanelView } from "../components/GoalTasksPanel";
import { ControlDigestCardView } from "../loom/ControlDigestCard";
import { controlCardModel } from "../loom/controlMessages";
import { GoalThreadsSection } from "../loom/GoalThreadsSection";
import { LoomTimelineRowView } from "../loom/LoomTimelineRowView";
import type { LoomTimelineRow } from "../loom/loomTimelineRows";
import { CACHE_LIVENESS_PREVIEW_GROUP } from "./cacheLivenessFixtures";
import { CONSULT_CARD_FIXTURES } from "./consultCardFixtures";
import { CONTEXT_VIZ_PREVIEW_GROUP } from "./contextVizFixtures";
import { FILE_CHANGE_VIEW_PREVIEW_GROUP } from "./fileChangeViewFixtures";
import type { PreviewGroup } from "./fixtures";
import {
  loomPreviewAnchoredThreadId,
  loomPreviewControlMessages,
  loomPreviewEnvironmentId,
  loomPreviewGoal,
  loomPreviewHandbackMessages,
  loomPreviewOpenQuestions,
  loomPreviewThreads,
  loomPreviewWorkspaceRoot,
  shell,
  workstream,
} from "./loomFixtures";
import { TimelineLayoutFrame } from "./TimelineLayoutFrame";

const shells = Object.values(loomPreviewThreads).map((thread) =>
  presentThreadShell(loomPreviewEnvironmentId, thread),
);
const senderLabels = new Map(shells.map((thread) => [thread.id, thread.title] as const));

const run = { latestRunId: RunId.make("preview-goal-thread-run") };

/** A goal root thread for the Threads section; the numeric key fixes the handoff order. */
const goalThread = (
  key: string,
  title: string,
  loom: Partial<LoomThreadShellFields> = {},
  v2: Partial<OrchestrationV2ThreadShell> = {},
  present: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell => {
  const id = ThreadId.make(`preview-goal-thread-${key}`);
  return {
    ...presentThreadShell(
      loomPreviewEnvironmentId,
      shell(title, workstream(id, { parentThreadId: null, rootThreadId: id, ...loom }), v2),
    ),
    ...present,
  };
};

/** One root per chip state, in `resolveChip` precedence order; the last continues the one before. */
const goalThreadShells = [
  goalThread("01", "Fix the lease-date parser", { attention: ["error"] }),
  goalThread("02", "Decide which amendment wins", { attention: ["needs_guidance"] }),
  goalThread("03", "Accept the clause extractor", { attention: ["awaiting_acceptance"] }),
  goalThread("04", "Run the migration", {}, {}, { hasPendingApprovals: true }),
  goalThread("05", "Pick the export format", {}, {}, { hasPendingUserInput: true }),
  goalThread("06", "Extract clauses from the lease PDFs", {}, { ...run, status: "running" }),
  goalThread("07", "Wait on the reviewer gate", {}, { ...run, status: "idle" }),
  goalThread("08", "Rebuild the document index", {}, { ...run, status: "failed" }),
  goalThread("09", "Ship the parser fix", { held: true }),
  goalThread("10", "Plan the clause model", {
    outcome: "done",
    outcomeAt: "2026-10-05T09:00:00.000Z",
  }),
  goalThread("11", "Draft the next plan", {
    continuesThreadId: ThreadId.make("preview-goal-thread-10"),
  }),
];

function ControlCard({
  loom,
  text,
  live = false,
}: {
  loom: LoomMessageFields | undefined;
  text: string;
  /** Collapsed, with a thread and workspace: rows open reports and chips are stat'd. */
  live?: boolean;
}) {
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
      cwd={live ? loomPreviewWorkspaceRoot : undefined}
      threadRef={live ? scopeThreadRef(loomPreviewEnvironmentId, LOOM_SEED.threads.root) : null}
      skills={[]}
      onOpenThread={live ? () => undefined : null}
      defaultExpanded={!live}
    />
  );
}

const OPEN_QUESTIONS_THREAD = {
  environmentId: loomPreviewEnvironmentId,
  threadId: ThreadId.make("preview-open-questions-thread"),
};

/**
 * The open-questions rail: a blocking ask first, then two the agent carried on past. Typing in the
 * composer stand-in minimises every row; answering or dismissing shows what would be sent.
 */
function LoomOpenQuestionsRailPreview() {
  const [answered, setAnswered] = useState<ReadonlyArray<string>>([]);
  const [sent, setSent] = useState<string | null>(null);
  const prompt = useComposerDraftStore(
    (store) => store.getComposerDraft(OPEN_QUESTIONS_THREAD)?.prompt ?? "",
  );
  return (
    <div className="mx-auto flex h-[85vh] w-full min-w-0 max-w-3xl flex-col justify-end p-6">
      <OpenQuestionsRail
        threadRef={OPEN_QUESTIONS_THREAD}
        composerDraftTarget={OPEN_QUESTIONS_THREAD}
        questions={loomPreviewOpenQuestions.filter(
          (question) => !answered.includes(question.requestId),
        )}
        cwd={undefined}
        disabled={false}
        respondingRequestIds={[]}
        onAnswer={(requestId, answers) => {
          setAnswered((current) => [...current, requestId]);
          setSent(`answer ${JSON.stringify(answers)}`);
        }}
        onDismiss={(requestId) => {
          setAnswered((current) => [...current, requestId]);
          setSent("nothing (dismissed)");
        }}
      />
      <textarea
        aria-label="Composer text"
        placeholder="Composer stand-in: chat, never an answer"
        className="rounded-md border border-border bg-transparent p-2 text-sm"
        value={prompt}
        onChange={(event) =>
          useComposerDraftStore.getState().setPrompt(OPEN_QUESTIONS_THREAD, event.target.value)
        }
      />
      <p className="mt-2 text-xs text-muted-foreground" data-loom-preview-sent>
        {sent === null ? "Nothing sent yet." : `Sent: ${sent}`}
      </p>
    </div>
  );
}

const FALLBACK_TEXT =
  "## Future notice\n\nA control message whose notice kind this build does not know. The card falls back to the message text.";

const receipt = (
  key: string,
  fields: Omit<LoomTimelineRow, "kind" | "id" | "createdAt" | "sourceThreadId">,
): LoomTimelineRow => ({
  kind: "loom-handoff",
  id: `loom-handoff:${key}`,
  createdAt: "2026-10-05T09:00:00.000Z",
  sourceThreadId: loomPreviewAnchoredThreadId,
  ...fields,
});
const held = {
  threadId: loomPreviewThreads.held.id,
  title: loomPreviewThreads.held.title,
  state: "staged" as const,
};
const EXPLANATION = "The flaky retry test in the sync worker is out of scope here; hand it off.";

const timelineRows: ReadonlyArray<LoomTimelineRow> = [
  receipt("drafting", {
    state: "drafting",
    drafterThreadId: loomPreviewThreads.reviewerInGate.id,
    explanation: EXPLANATION,
    destinations: [],
  }),
  receipt("failed", {
    state: "failed",
    drafterThreadId: loomPreviewThreads.reviewerInGate.id,
    explanation: EXPLANATION,
    destinations: [],
  }),
  receipt("handed-off", {
    state: "handed-off",
    drafterThreadId: null,
    explanation: null,
    destinations: [held],
  }),
];

/**
 * DL-610: V1 rows as the importer (and migration 1052) stamp them, from the
 * QA copy: V1 payloads carry no item `kind`, `notice` or `synthesised`.
 */
const IMPORTED_V1_TEXT =
  '[T3 Workstream control plane: automated notice, not from the human]\n\nThe flattened notice the model received, behind "show raw payload".';

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
            title: "Yielded to you: outcome `fixed_inline`",
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
        heading: "FYI digest: thread updates since you last heard.",
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
      ...loomPreviewHandbackMessages.map((message) => ({
        id: `loom-control-handback-${message.loom?.controlPayload?.kind}`,
        title: `${message.loom?.controlPayload?.kind}: handed-back documents`,
        description:
          'Collapsed, as in a timeline: a row with a report opens it (hover says so) and ↗ opens the thread; the report\'s documents are chips (a one-word name leads with its folder, three then "+n more", a missing one struck through); a row with no report opens the thread itself, under the same ↗.',
        render: () => (
          <TimelineLayoutFrame>
            <ControlCard loom={message.loom} text={message.text} live />
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
        id: "loom-handoff-receipts",
        title: "Handoff receipts",
        description:
          "A `/handoff` drafting and failed (explanation copyable), and a handed-off `goal_handoff` / `goal_continue`.",
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
    id: "loom-consult-card",
    title: "Loom consult card",
    fixtures: CONSULT_CARD_FIXTURES,
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
      {
        id: "loom-goal-threads-section",
        title: "Goal threads section",
        description:
          "One root thread per status chip: error and other attention, approval, input, working, waiting, failed, staged, an outcome, and ready (a continuation, and the current thread).",
        render: () => (
          <div className="w-[420px] rounded-lg border border-border p-4">
            <GoalThreadsSection
              goalId={loomPreviewGoal.id}
              environmentId={loomPreviewEnvironmentId}
              activeThreadId={ThreadId.make("preview-goal-thread-11")}
              shells={goalThreadShells}
            />
          </div>
        ),
      },
    ],
  },
  {
    id: "loom-user-input",
    title: "Loom questions",
    fixtures: [
      {
        id: "loom-open-questions-rail",
        title: "Open-questions rail",
        description:
          "Three open questions, one blocking: one row expanded at a time, digits select and never submit, typing in the composer minimises every row.",
        render: () => <LoomOpenQuestionsRailPreview />,
      },
    ],
  },
  CACHE_LIVENESS_PREVIEW_GROUP,
  CONTEXT_VIZ_PREVIEW_GROUP,
  FILE_CHANGE_VIEW_PREVIEW_GROUP,
];
