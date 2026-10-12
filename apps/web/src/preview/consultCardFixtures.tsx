/**
 * loom: the consult card's states for `/preview` — running (with and without
 * the fork's narration, one with a stuck step), answered, failed, stopped, and
 * a finished card after a reload (no live figures). Times are relative to the
 * moment the fixture renders, so the elapsed figures tick as in the app.
 */
import {
  consultQuestionKey,
  type LoomConsultStep,
  type LoomLiveConsult,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { ConsultCardView, type ConsultStatus } from "../loom/ConsultCardRow";
import { ThreadLinkChip } from "../loom/verifiedFileChips";
import type { PreviewFixture } from "./fixtures";
import { loomPreviewEnvironmentId, loomPreviewThreads } from "./loomFixtures";
import { TimelineLayoutFrame } from "./TimelineLayoutFrame";

const QUESTION =
  "Which code path produced the empty tenant_name for building 7f3a9c on the 8 Oct production run? Give file:line evidence from the resolver and the Langfuse trace id of the extraction call that returned the blank value.";
const ANSWER = `The blank comes from the fallback branch, not the extractor.

- \`packages/lease_extraction/tenant_audit/resolve.py:178\` — \`resolve_tenant()\` returns \`candidates[0].name or ""\` when the top candidate has no name.
- \`packages/lease_extraction/tenant_audit/fallbacks.py:41\` — \`from_schedule()\` yields a candidate with \`name=None\` when the schedule row carries only a lot number.
- Langfuse trace \`7c1d0e42-…\`, observation \`resolve_tenant\`: input \`candidates=[{name: null, lot: "L12"}]\`, output \`""\`.`;
const LIVE_PATH =
  "/home/dev/.pi/agent/sessions/--home-dev-fathom--/2026-10-12T03-21-08_fork-7f3a9c.jsonl";
const KEPT_PATH =
  "/home/dev/.t3/userdata/workstream-consults/2026-10-12T03-21-08_fork-7f3a9c.jsonl";

const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
const S = 1000;
const M = 60 * S;

/** A finished step `agoMs` ago that took `ms`. */
const done = (title: string, detail: string, agoMs: number, ms: number, ok = true) =>
  ({
    title,
    detail,
    startedAt: iso(agoMs + ms),
    endedAt: iso(agoMs),
    ok,
  }) satisfies LoomConsultStep;
const runningStep = (title: string, detail: string, agoMs: number): LoomConsultStep => ({
  title,
  detail,
  startedAt: iso(agoMs),
  endedAt: null,
  ok: null,
});

const consult = (fields: Partial<LoomLiveConsult> & Pick<LoomLiveConsult, "startedAt">) =>
  ({
    consultId: "preview-consult",
    askerThreadId: ThreadId.make("preview-asker"),
    questionKey: consultQuestionKey(QUESTION),
    targetThreadId: loomPreviewThreads.done.id,
    endedAt: null,
    model: "cliproxy/claude-opus-5-5",
    step: null,
    toolCalls: 0,
    spend: null,
    recent: [],
    narration: null,
    forkSessionPath: LIVE_PATH,
    ...fields,
  }) satisfies LoomLiveConsult;

const recentSteps = () => [
  done("rg", "tenant_name packages/lease_extraction/tenant_audit", 6 * M, 1400),
  done("read", "packages/lease_extraction/tenant_audit/resolve.py", 5 * M + 40 * S, 300),
  done("read", "packages/lease_extraction/tenant_audit/fallbacks.py", 5 * M + 30 * S, 200),
  done("bash", "scripts/langfuse_trace.sh --building 7f3a9c --since 2026-10-08", 2 * M, 38 * S),
  done(
    "bash",
    `jq '.observations[] | select(.name=="resolve_tenant")' /tmp/trace-7c1d.json`,
    40 * S,
    2100,
  ),
];
const spend = (costUsd: number, input: number, output: number, cached: number) => ({
  costUsd,
  inputTokens: input,
  outputTokens: output,
  cachedTokens: cached,
});

interface CardState {
  readonly status: ConsultStatus;
  readonly expanded: boolean;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly live: LoomLiveConsult | null;
  readonly body?: string;
}

const STATES: ReadonlyArray<{
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly make: () => CardState;
}> = [
  {
    id: "running-narration",
    title: "Running, collapsed, with narration",
    description: "The strip: an 8 s read, ⚒ 11 · $0.84, and the fork's last sentence beneath.",
    make: () => ({
      status: "waiting",
      expanded: false,
      startedAt: iso(7 * M + 12 * S),
      completedAt: null,
      live: consult({
        startedAt: iso(7 * M + 12 * S),
        step: {
          kind: "tool",
          since: iso(8 * S),
          title: "read",
          detail: "packages/lease_extraction/tenant_audit/resolve.py",
        },
        toolCalls: 11,
        spend: spend(0.84, 412_000, 2_900, 398_000),
        narration:
          "The trace shows the blank came from resolve_tenant; checking the fallback branch around line 178.",
      }),
    }),
  },
  {
    id: "running-expanded",
    title: "Running, expanded, with narration",
    description:
      "Facts row, the last six steps (the live one ticking), the live transcript chip and Stop.",
    make: () => ({
      status: "waiting",
      expanded: true,
      startedAt: iso(7 * M + 12 * S),
      completedAt: null,
      live: consult({
        startedAt: iso(7 * M + 12 * S),
        step: {
          kind: "tool",
          since: iso(8 * S),
          title: "read",
          detail: "packages/lease_extraction/tenant_audit/resolve.py (lines 140–210)",
        },
        toolCalls: 11,
        spend: spend(0.84, 412_000, 2_900, 398_000),
        recent: [
          ...recentSteps(),
          runningStep(
            "read",
            "packages/lease_extraction/tenant_audit/resolve.py (lines 140–210)",
            8 * S,
          ),
        ],
        narration:
          "The trace shows the blank came from resolve_tenant; checking the fallback branch.",
      }),
    }),
  },
  {
    id: "running-stuck",
    title: "Running, collapsed, a stuck step, no narration",
    description:
      "A 6-minute bash reads amber; the 13-minute total does not. A tool-heavy fork that has said nothing shows no narration line.",
    make: () => ({
      status: "waiting",
      expanded: false,
      startedAt: iso(13 * M + 5 * S),
      completedAt: null,
      live: consult({
        startedAt: iso(13 * M + 5 * S),
        step: {
          kind: "tool",
          since: iso(6 * M + 12 * S),
          title: "bash",
          detail: "scripts/langfuse_trace.sh --building 7f3a9c --since 2026-10-08",
        },
        toolCalls: 4,
        spend: spend(0.61, 300_000, 1_200, 290_000),
      }),
    }),
  },
  {
    id: "running-starting",
    title: "Running, expanded, just started",
    description:
      "The fork is replaying the target's transcript: thinking, no steps, no narration yet.",
    make: () => ({
      status: "waiting",
      expanded: true,
      startedAt: iso(14 * S),
      completedAt: null,
      live: consult({
        startedAt: iso(14 * S),
        step: { kind: "model", since: iso(12 * S), title: null, detail: null },
      }),
    }),
  },
  {
    id: "answered",
    title: "Answered, expanded",
    description:
      "Frozen at 9m 40s; the totals above the answer, the steps folded to one line with the retained transcript.",
    make: () => ({
      status: "answered",
      expanded: true,
      startedAt: iso(12 * M),
      completedAt: iso(2 * M + 20 * S),
      live: consult({
        startedAt: iso(12 * M),
        endedAt: iso(2 * M + 20 * S),
        toolCalls: 14,
        spend: spend(1.12, 540_000, 4_100, 521_000),
        recent: recentSteps(),
        narration: "The blank comes from the fallback branch, not the extractor.",
        forkSessionPath: KEPT_PATH,
      }),
      body: ANSWER,
    }),
  },
  {
    id: "failed",
    title: "Failed (model error), expanded",
    description: "The totals it reached, its steps, and the reason.",
    make: () => ({
      status: "failed",
      expanded: true,
      startedAt: iso(8 * M),
      completedAt: iso(3 * M + 9 * S),
      live: consult({
        startedAt: iso(8 * M),
        endedAt: iso(3 * M + 9 * S),
        toolCalls: 6,
        spend: spend(0.47, 208_000, 1_100, 201_000),
        recent: recentSteps().slice(0, 4),
        forkSessionPath: KEPT_PATH,
      }),
      body: "The fork's model request failed: overloaded_error (529) after 3 retries.",
    }),
  },
  {
    id: "stopped",
    title: "Stopped from the card, expanded",
    description:
      "The cut-short step is marked ✗; the reason is the sentence the asker's model read.",
    make: () => ({
      status: "failed",
      expanded: true,
      startedAt: iso(11 * M + 3 * S),
      completedAt: iso(0),
      live: consult({
        startedAt: iso(11 * M + 3 * S),
        endedAt: iso(0),
        toolCalls: 9,
        spend: spend(0.79, 388_000, 2_400, 371_000),
        recent: [
          ...recentSteps().slice(0, 4),
          done(
            "bash",
            "scripts/langfuse_trace.sh --building 7f3a9c --since 2026-10-08",
            0,
            6 * M + 12 * S,
            false,
          ),
        ],
        forkSessionPath: KEPT_PATH,
      }),
      body: "Stopped from the consult card after 11m 03s.",
    }),
  },
  {
    id: "answered-reloaded",
    title: "Answered, after a reload",
    description: "No live figures survive a reload: the exchange and its frozen duration only.",
    make: () => ({
      status: "answered",
      expanded: false,
      startedAt: iso(12 * M),
      completedAt: iso(2 * M + 20 * S),
      live: null,
    }),
  },
];

function ConsultCardPreview({ make }: { readonly make: () => CardState }) {
  const [state] = useState(make);
  const [expanded, setExpanded] = useState(state.expanded);
  const [stopping, setStopping] = useState(false);
  const markdown = (text: string) => <ChatMarkdown text={text} cwd={undefined} />;
  return (
    <ConsultCardView
      status={state.status}
      target={
        <ThreadLinkChip
          label="Langfuse triage — 8 Oct tenant audit"
          threadId={loomPreviewThreads.done.id}
          environmentId={loomPreviewEnvironmentId}
        />
      }
      targetLabel="Langfuse triage — 8 Oct tenant audit"
      question={QUESTION}
      startedAt={state.startedAt}
      completedAt={state.completedAt}
      live={state.live}
      expanded={expanded}
      onToggle={() => setExpanded((value) => !value)}
      body={
        state.body === undefined ? null : state.status === "answered" ? (
          markdown(state.body)
        ) : (
          <p className="text-muted-foreground/80 text-xs leading-5">{state.body}</p>
        )
      }
      renderTranscript={(path) => markdown(`\`${path}\``)}
      onStop={() => setStopping(true)}
      stopping={stopping}
    />
  );
}

export const CONSULT_CARD_FIXTURES: ReadonlyArray<PreviewFixture> = STATES.map((state) => ({
  id: `loom-consult-${state.id}`,
  title: state.title,
  description: state.description,
  render: () => (
    <TimelineLayoutFrame>
      <p className="mb-3 text-sm text-foreground">
        Before I touch the resolver I'll ask the thread that triaged the 8 Oct production batch
        which path produced the blank name.
      </p>
      <ConsultCardPreview key={state.id} make={state.make} />
    </TimelineLayoutFrame>
  ),
}));
