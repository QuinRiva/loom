import { type ReactNode, useState } from "react";

import type { ApprovalRequestId, UserInputQuestion } from "@t3tools/contracts";
import type { UserInputAnswerDraft } from "@t3tools/shared/userInputAnswers";
import {
  buildUserInputAnswers,
  setUserInputCustomAnswer,
  toggleUserInputOptionSelection,
} from "@t3tools/shared/userInputAnswers";

import ChatMarkdown from "../components/ChatMarkdown";
import WorkstreamGraph from "../components/WorkstreamGraph";
import { DraftId } from "../composerDraftStore";
import { MdxPlanAnnotationLayer } from "../components/files/mdx-plan/annotation/MdxPlanAnnotationLayer";
import { PendingQuestionCard } from "../components/chat/PendingQuestionCard";
import type { SidebarThreadSummary } from "../types";
import { TimelineLayoutFrame } from "./TimelineLayoutFrame";

/**
 * A single previewable case. `render` returns the component already wrapped in
 * whatever layout context it needs to render faithfully (see
 * {@link TimelineLayoutFrame}). Add new components by appending groups — no
 * harness wiring changes required.
 */
export interface PreviewFixture {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly render: () => ReactNode;
}

export interface PreviewGroup {
  readonly id: string;
  readonly title: string;
  readonly fixtures: ReadonlyArray<PreviewFixture>;
}

/**
 * Wide table seeded from the PR #68 fix (markdown tables bleeding past the
 * `max-w-3xl` prose measure on wide displays). Kept here so the harness doubly
 * serves as a regression guard for that layout.
 */
const WIDE_TABLE_MARKDOWN = `Comparison of provider capabilities across a wide set of columns that overflows the prose measure:

| Provider | Model | Context | Streaming | Tools | Vision | Reasoning | Max output | Pricing tier | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenAI | gpt-5.5 | 400k | Yes | Yes | Yes | High | 128k | Enterprise | Flagship general-purpose model with strong tool use |
| Anthropic | claude-opus-4-8 | 1M | Yes | Yes | Yes | High | 64k | Enterprise | Very large context, excellent long-document synthesis |
| Google | gemini-3-pro | 2M | Yes | Yes | Yes | Medium | 64k | Standard | Enormous context window, competitive multimodal |
| Meta | llama-4-405b | 256k | Yes | Partial | No | Medium | 32k | Open | Self-hostable, strong price/performance on-prem |
`;

const NARROW_TABLE_MARKDOWN = `A small table should stay narrow and hug its content — it must not stretch to the bleed budget:

| Key | Value |
| --- | --- |
| Status | Ready |
| Region | ap-southeast-2 |
`;

const CODE_BLOCK_MARKDOWN = `Here is a TypeScript snippet with a filename title and a long line that should scroll (or wrap when toggled):

\`\`\`ts title="timelineLayout.ts"
export function publishTimelineAvailableWidth(element: HTMLElement, viewportWidth: number): void {
  element.style.setProperty("--timeline-available-width", \`\${Math.round(viewportWidth)}px\`);
}
\`\`\`

And an inline \`const x = 1\` plus a plain fence:

\`\`\`
plain preformatted text
  with indentation preserved
\`\`\`
`;

const LONG_PROSE_MARKDOWN = `# Rendering long prose

This fixture exercises headings, paragraphs, lists, blockquotes and links at the real prose measure.

## A subheading

Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.

- First item with a [link to the docs](https://example.com/docs)
- Second item with **bold** and _italic_ emphasis
- Third item with \`inline code\`

1. Ordered one
2. Ordered two
3. Ordered three

> A blockquote to check the left border and muted colour treatment across multiple lines of wrapped text.

### Task list

- [x] Reproduce the timeline layout chain
- [ ] Add more component fixtures
`;

const INLINE_CODE_FILE_LINKS_MARKDOWN = `An orchestrator-style message that references files as plain inline code, the way agents actually write them.

The change lives in \`apps/web/src/components/ChatMarkdown.tsx\` and the detection rules in \`apps/web/src/markdown-links.ts\`. The failing assertion was around \`src/markdown-links.test.ts:138\`, and the absolute path \`/etc/hosts\` should link too. Config lives in \`package.json\` and \`tsconfig.json\`; docs in \`AGENTS.md\`.

None of these should become links: run \`vp run typecheck\` then \`vp run test\`, guard against \`foo.bar()\`, a \`HashMap<string, number>\`, the flag value \`a/b\`, a url like \`https://example.com/docs\`, and \`host:8080\`.

A fenced block must keep its normal code treatment, not linkify its contents:

\`\`\`ts
import foo from "src/foo.ts";
const path = "apps/web/src/index.ts";
\`\`\`
`;

const PROSE_AND_CODE_PATH_LINKS_MARKDOWN = `An orchestrator-style reply that hands back file paths as plain prose and inside a fenced block, the two shapes agents actually produce.

The verdict and the register are at /Users/julius/project/_findings/verdict.md and /Users/julius/project/_findings/findings_register.md — open both.

A relative hit with a position carries through: src/markdown-links.ts:42 should link too.

The same paths inside a fenced block stay exactly as typed but each path line is clickable:

\`\`\`text
/Users/julius/project/_findings/verdict.md
/Users/julius/project/_findings/findings_register.md
\`\`\`

None of these should link: a date like 01/02/2026, the words and/or, a flag value a/b, or a url like https://example.com/docs/guide.md.
`;

const MIXED_DOCUMENT_MARKDOWN = `# Release notes

A representative mixed document combining prose, a wide table, code and a collapsible section.

Some introductory prose explaining the change with an [external reference](https://example.com).

| Change | Area | Impact | Reviewer | Shipped |
| --- | --- | --- | --- | --- |
| Wide-table bleed | web/chat | Medium | carl | Yes |
| Preview harness | web/dx | Low | carl | Pending |

\`\`\`bash
pnpm --filter @t3tools/web dev
\`\`\`

<details>
<summary>Implementation detail</summary>

The bleed budget is derived from \`--timeline-available-width\`, published by a ResizeObserver on the timeline viewport.

</details>
`;

const CONSULT_REPORT_CODE_BLOCKS_MARKDOWN = `To the reviewer:

1. **Sample selection is not fully reproducible from the submitted artefacts.**

   The source population is clear: \`measure.py::population()\` reads the full deterministic pipeline outputs from:

   \`\`\`text
   /home/Carl/data/tenant_name_role_strategy/population_runs/*/*building_audit.json
   \`\`\`

   It selects every case where both the new strategy and party history fired but their \`fold_name\` values differed, then writes all 196 rows to:

   \`\`\`text
   /home/Carl/data/tenant_name_role_strategy/party_history_disagreements.jsonl
   \`\`\`

   The report records: seed \`2271\`, 15 unique buildings, stratified as 11 multi-name and 4 single-name disagreements.

   However, the exact sampling command/code was not preserved. \`workbench/tenant-name-role-strategy/measure.py\` contains no \`random\`, seed, or \`sample15\` logic; it stops after writing the full disagreement population. Therefore this session does **not** establish the exact algorithm or command that transformed those 196 rows into \`disagreement_sample15.jsonl\`. The seed claim is not independently reproducible from the committed workbench.

2. **There is no artefact containing verbatim packet-document quotations for the 15 judgements.**

   \`/home/Carl/data/tenant_name_role_strategy/disagreement_sample15.jsonl\` contains extracted values:

   - register and party-history strategy outputs;
   - target values;
   - complete extracted \`parties\` blocks, including role, legal name, ACN/ABN, etc.

   Examples include verbatim extracted role strings such as:

   - \`"Other Tenant"\`
   - \`"Tenant's Representative"\`
   - \`"Insured party (Parent of Tenant)"\`
   - \`"Original Lessee/Tenant and Customer"\` / \`"Current Lessee/Tenant and Customer"\`
   - \`"Tenant's Consultant"\`
   - \`"Tenant's Solicitors"\`
   - \`"Tenant Consultant"\`

   Those support many conclusions, but they are extraction fields—not quotations from packet pages with provenance/citations. \`measurement_report.md\` only provides summary conclusions. No separate quote/citation file was committed, so the assertion that packet evidence was read is not auditable at the requested verbatim-document level.

3. **Why generic entity-absence semantics changed**

   The strategy follows the existing declarative pattern:

   \`\`\`python
   iterate_over_entity="party"
   \`\`\`

   \`party_name\` and \`party_role\` inherit \`_source_input(..., null_handling="skip_strategy")\`; ACN uses \`use_default\`.

   Before the change, the outer entity-list checks happened before per-input null handling:

   - missing \`party\` raised an ordinary \`InputResolutionError\`;
   - empty \`party: []\` raised \`EmptyEntityListError\`;
   - because tenant-name’s \`_NAME_COMPARISON\` does not declare one-sided absence acceptable, both paths became failed strategies with execution risks.

   Thus \`skip_strategy\` could handle a missing field within an existing party item, but could not express that the optional top-level party register itself was absent. Leaving the existing pattern unchanged violated the requirement that missing optional \`party[]\` skip cleanly.

   The generic changes close that semantic gap:

   - \`input_resolver.py\` prefixes missing-entity errors with \`SKIP_STRATEGY:\` when a descriptor declares \`skip_strategy\`;
   - \`source/executor.py\` maps that condition to \`status="skipped"\` with no risks;
   - it likewise maps an empty entity list to skipped when any descriptor uses \`skip_strategy\`.

   The required test exercises both exact shapes:

   \`\`\`python
   for extraction_data in ({}, {"party": []}):
       ...
       assert result.status == "skipped"
       assert result.risk_factors == []
   \`\`\`

   A strategy-specific special case would duplicate semantics in the tenant strategy, while changing comparison absence policy would only address empty lists—not missing entities—and would conflate input optionality with comparison meaning.

4. **Fast-forward/no-force evidence**

   Immediately before pushing:

   \`\`\`bash
   git fetch origin PE-2271-retarget-tenant-name-derivation-strategies-at-the-registered
   git merge-base --is-ancestor FETCH_HEAD HEAD
   echo fast_forward=$?
   \`\`\`

   Output:

   \`\`\`text
   7e2a191f9 PE-2271: strip registration tails from tenant identifiers
   ...
   fast_forward=0
   \`\`\`

   Exit code \`0\` established that remote head \`7e2a191f9\` was an ancestor of local \`HEAD\`.

   The push command contained no force option:

   \`\`\`bash
   git push origin HEAD:PE-2271-retarget-tenant-name-derivation-strategies-at-the-registered
   \`\`\`

   Git reported:

   \`\`\`text
   7e2a191f9..26aab4f8b  HEAD -> PE-2271-retarget-tenant-name-derivation-strategies-at-the-registered
   \`\`\`

   Afterwards, \`gh pr view 3972\` reported:

   \`\`\`json
   {
     "headRefOid": "26aab4f8b73b99db7723337edf7138d565216b1c",
     "state": "OPEN"
   }
   \`\`\`

   Together, the ancestor check, absence of \`--force\`, normal \`old..new\` push output, and matching PR head establish a fast-forward push.`;

/**
 * Minimal repro for the empty-code-block defect (#: fenced blocks nested inside
 * a list item render chrome only — language badge, wrap/copy buttons, rounded
 * container — with a completely empty body, and the copy button yields "").
 *
 * The five cases below are a discriminator, not decoration: the two OUTSIDE a
 * list item (top level, blockquote) render their body correctly, and the three
 * INSIDE a list item render empty. That isolates the trigger to the `p`/`li`
 * component overrides' `renderSkillInlineMarkdownChildren` pass rewriting the
 * nested `code` element's string child into a `<SkillInlineText>` element, which
 * `extractCodeBlock`/`nodeToPlainText` cannot read (the text lives in a `text`
 * prop, not `children`), so Shiki is handed "".
 *
 * A correct fix shows the body text in ALL FIVE blocks.
 */
const LIST_NESTED_CODE_BLOCK_MARKDOWN = `A: top level (renders correctly today):

\`\`\`text
A top-level fence keeps its body
\`\`\`

B: inside a bullet list item (EMPTY today):

- Bullet item:

  \`\`\`text
  B bullet-nested fence loses its body
  \`\`\`

C: inside an ordered list item (EMPTY today):

1. Ordered item:

   \`\`\`python
   print("C ordered-nested fence loses its body")
   \`\`\`

D: inside a nested list item (EMPTY today):

- Outer item
  - Inner item:

    \`\`\`json
    { "d": "nested-nested fence loses its body" }
    \`\`\`

E: inside a blockquote, not a list item (renders correctly today):

> Quoted:
>
> \`\`\`text
> E blockquote-nested fence keeps its body
> \`\`\`
`;

function markdownFixture(
  id: string,
  title: string,
  text: string,
  description?: string,
  cwd?: string,
  isStreaming = false,
): PreviewFixture {
  return {
    id,
    title,
    ...(description ? { description } : {}),
    render: () => (
      <TimelineLayoutFrame>
        <ChatMarkdown text={text} cwd={cwd} isStreaming={isStreaming} />
      </TimelineLayoutFrame>
    ),
  };
}

/**
 * Reproduces the user-message bubble wrapper from `UserTimelineRow` in
 * `MessagesTimeline.tsx` (right-aligned, bordered, `max-w-[80%]`) so the
 * wide-table bleed can be exercised in the bordered-bubble context, not just
 * the open assistant prose column.
 */
function userBubbleFixture(
  id: string,
  title: string,
  text: string,
  description?: string,
): PreviewFixture {
  return {
    id,
    title,
    ...(description ? { description } : {}),
    render: () => (
      <TimelineLayoutFrame>
        <div className="group flex flex-col items-end gap-1">
          <div className="chat-user-bubble relative max-w-[80%] rounded-2xl border border-border bg-secondary p-3">
            <ChatMarkdown text={text} cwd={undefined} className="text-foreground" />
          </div>
        </div>
      </TimelineLayoutFrame>
    ),
  };
}

// ---------------------------------------------------------------------------
// Workstream graph fixture — a representative orchestration exercising the C2
// node card's states (docs/design/workstream-graph-node-redesign.html): a live
// coder mid-rework with its gated reviewer, a blocked coder→reviewer wave, a
// done (receded) node, and an attention-flagged node. The layout only reads
// lineage/generation/deps/routes; the card reads status/gate/footer fields —
// build the minimal shape and cast, like the layout unit tests do.
// ---------------------------------------------------------------------------

const wsThread = (over: Record<string, unknown>): SidebarThreadSummary =>
  ({
    parentThreadId: "root",
    spawnGeneration: "g1",
    blockedBy: [],
    routes: [],
    consults: [],
    attention: [],
    planLane: "in_progress",
    gateRounds: 0,
    pendingRework: false,
    lastOutcome: null,
    latestTurn: null,
    session: null,
    isolation: "shared",
    fanInState: "none",
    forkFromThreadId: null,
    continuesThreadId: null,
    kickoffBriefPath: "/brief.md",
    toolUses: null,
    role: "coder",
    purpose: "Preview fixture thread.",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    archivedAt: null,
    lastActivityPreview: null,
    cumulativeCostUsd: null,
    reportPath: null,
    modelSelection: { instanceId: "pi", model: "google-vertex-claude/claude-opus-4-8" },
    updatedAt: "2026-07-21T04:00:00.000Z",
    ...over,
  }) as unknown as SidebarThreadSummary;

const WS_GRAPH_THREADS: ReadonlyArray<SidebarThreadSummary> = [
  wsThread({
    id: "root",
    parentThreadId: null,
    title: "v2.20 sweep + trace analysis",
    createdAt: "2026-07-21T00:00:00.000Z",
  }),
  // Wave 1: a gate pair mid-rework — live coder, waiting reviewer with verdict.
  wsThread({
    id: "coder-1",
    title: "P2 patch-apply retry hardening",
    createdAt: "2026-07-21T01:00:00.000Z",
    planLane: "in_progress",
    pendingRework: true,
    lastOutcome: { outcome: "needs_rework", decision: "loop", round: 1 },
    latestTurn: { state: "running" },
    toolUses: 67,
  }),
  wsThread({
    id: "reviewer-1",
    role: "reviewer",
    title: "P2 P3 adversarial review",
    createdAt: "2026-07-21T01:00:01.000Z",
    blockedBy: ["coder-1"],
    routes: [{ kind: "loop", on: ["needs_rework"], to: "coder-1", maxRounds: 2 }],
    gateRounds: 1,
    lastOutcome: { outcome: "needs_rework", decision: "loop", round: 1 },
    toolUses: 37,
  }),
  // Wave 2: a blocked pair — not-yet-run coder + its gated reviewer.
  wsThread({
    id: "coder-2",
    spawnGeneration: "g2",
    title: "tenant_id priming migration",
    createdAt: "2026-07-21T02:00:00.000Z",
    planLane: "ready",
    blockedBy: ["coder-1"],
  }),
  wsThread({
    id: "reviewer-2",
    spawnGeneration: "g2",
    role: "reviewer",
    title: "tenant_id migration review",
    createdAt: "2026-07-21T02:00:01.000Z",
    planLane: "ready",
    blockedBy: ["coder-2"],
    routes: [{ kind: "loop", on: ["needs_rework"], to: "coder-2", maxRounds: 2 }],
  }),
  // Wave 3: terminal recession + attention pulse + a long title wrapping.
  wsThread({
    id: "done-1",
    spawnGeneration: "g3",
    title: "Receipt-dedup merge",
    createdAt: "2026-07-21T03:00:00.000Z",
    planLane: "done",
    isolation: "isolated",
    fanInState: "completed",
  }),
  wsThread({
    id: "stuck-1",
    spawnGeneration: "g3",
    role: "researcher",
    title: "Spawn-generation dispatch ordering investigation",
    createdAt: "2026-07-21T03:00:01.000Z",
    planLane: "yielded",
    attention: ["needs_guidance"],
    toolUses: 112,
  }),
];

const WS_GRAPH_INDEX: ReadonlyMap<string, SidebarThreadSummary> = new Map(
  WS_GRAPH_THREADS.map((thread) => [thread.id, thread]),
);

const workstreamGraphFixture: PreviewFixture = {
  id: "workstream-graph-c2",
  title: "Node card states (C2)",
  description:
    "The C2 header-band node card across its states: live coder mid-rework, gated reviewer with verdict chip, blocked wave, receded done node with fan-in badge, attention-pulsing yielded node with a wrapped two-line title.",
  render: () => (
    <div className="h-full overflow-auto bg-[#0a0e13] p-6">
      <WorkstreamGraph
        viewKey="preview"
        threads={WS_GRAPH_THREADS}
        threadById={WS_GRAPH_INDEX as never}
        onOpenThread={() => {}}
        onOpenHistory={() => {}}
        onNodeContextMenu={() => {}}
        onOpenDispatch={() => {}}
      />
    </div>
  ),
};

// ---------------------------------------------------------------------------
// Pending user-input panel — the pi `ask_user_question` chooser. Options may
// carry a markdown `preview` (single-select only), so the panel must stay
// bounded when an agent hands it a wide table or a long code fence.
// ---------------------------------------------------------------------------

const PENDING_USER_INPUT_QUESTIONS: ReadonlyArray<UserInputQuestion> = [
  {
    id: "panel_layout",
    header: "Composer layout",
    question: "Which pending-input layout should ship?",
    multiSelect: false,
    options: [
      {
        label: "Stacked preview",
        description: "Preview sits below the option list",
        preview: `### Stacked\n\n\`\`\`ts title="panel.tsx"\nexport function Panel() {\n  return <div className="flex flex-col gap-2">{options}{preview}</div>;\n}\n\`\`\`\n\n| Viewport | Behaviour |\n| --- | --- |\n| Narrow | Preview under the options, scrolls internally |\n| Wide | Same, full composer width |\n`,
      },
      {
        label: "Side-by-side preview",
        description: "Preview sits beside the option list on wide viewports",
        preview: `### Side-by-side\n\n\`\`\`\n+----------------+  +--------------------------------+\n| 1 Stacked      |  | # Preview                      |\n| 2 Side-by-side |  | a very long line of preview co |\n| 3 No preview   |  | ntent that must not blow out t |\n+----------------+  +--------------------------------+\n\`\`\`\n\nThe option column keeps its measure; the preview pane takes the rest.\n`,
      },
      {
        label: "No preview at all",
        description: "This option deliberately carries no preview — it must look unchanged",
      },
    ],
  },
];

const PENDING_USER_INPUT_STAKES_AND_RECOMMENDED: ReadonlyArray<UserInputQuestion> = [
  {
    id: "title_model",
    header: "Title model",
    question: "Auto-naming shares the 'Text generation model' setting. What do you want?",
    stakes:
      "A dedicated setting is a new persisted preference we cannot quietly remove later; relabelling is reversible in a line.",
    multiSelect: false,
    options: [
      {
        label: "Relabel only",
        description:
          "Smallest change and hard to break, but anyone wanting a cheap model for titles must accept it for all text generation.",
        recommended: true,
      },
      {
        label: "Dedicated picker",
        description:
          "Full control over cost per title, at the price of a second model setting to keep migrated and explained forever.",
      },
    ],
  },
];

const PENDING_USER_INPUT_STAKES_ONLY: ReadonlyArray<UserInputQuestion> = [
  {
    id: "stakes_only",
    header: "Migration",
    question: "Should the rename run as one migration or in two deploys?",
    stakes: "Getting this wrong drops rows that are already live; a rollback cannot recover them.",
    multiSelect: false,
    options: [
      {
        label: "Single migration",
        description: "One deploy, but a brief window where old clients read a column that is gone.",
      },
      {
        label: "Two deploys",
        description: "No client ever sees a missing column, at the cost of a second release.",
      },
    ],
  },
];

const PENDING_USER_INPUT_RECOMMENDED_ONLY: ReadonlyArray<UserInputQuestion> = [
  {
    id: "recommended_only",
    header: "Badge only",
    question: "Which package manager should the scripts assume?",
    multiSelect: false,
    options: [
      {
        label: "pnpm",
        description: "Matches the lockfile already committed; no contributor has to switch.",
        recommended: true,
      },
      { label: "npm", description: "Ubiquitous, but re-resolves the whole tree on every install." },
    ],
  },
];

const PENDING_USER_INPUT_MULTI_QUESTIONS: ReadonlyArray<UserInputQuestion> = [
  {
    id: "panel_targets",
    header: "Targets",
    question: "Which clients should render previews?",
    multiSelect: true,
    options: [
      { label: "Web", description: "The composer panel" },
      { label: "Mobile", description: "The pending-input card" },
      { label: "Desktop", description: "Hosts the web renderer" },
    ],
  },
];

const PENDING_USER_INPUT_THREE_QUESTIONS: ReadonlyArray<UserInputQuestion> = [
  {
    id: "principles_home",
    header: "Principles home",
    question: "Where should the shared principles live?",
    stakes: "Getting this wrong means every agent reads a different rulebook.",
    multiSelect: false,
    options: [
      {
        label: "Global AGENTS.md + posture",
        description: "One file every project inherits, with a per-project posture override.",
        recommended: true,
      },
      {
        label: "Per-project only",
        description: "Each project restates what it needs; nothing is inherited.",
      },
      { label: "Skill module", description: "Loaded on demand rather than always in context." },
    ],
  },
  {
    id: "enforcement",
    header: "Enforcement",
    question: "How hard should the rules bind?",
    multiSelect: false,
    options: [
      { label: "Advisory", description: "Guidance the agent may depart from with a reason." },
      { label: "Checked", description: "A lint rule fails the run when the shape is violated." },
      { label: "Blocking", description: "The tool refuses outright." },
    ],
  },
  {
    id: "rollout",
    header: "Rollout",
    question: "Which surfaces adopt it first?",
    multiSelect: true,
    options: [
      { label: "Web", description: "The composer and the chat surfaces." },
      { label: "Mobile", description: "The pending-input card." },
      { label: "Slack bridge", description: "Announcements and structured replies." },
    ],
  },
];

/**
 * The card wired to real answer drafts through the shared transitions, the way
 * `ChatView` wires it. Answering is the whole of the accordion's behaviour — a
 * fixture holding `drafts={{}}` could never show a question collapsing to its
 * summary or the next one opening. Submit and dismiss are inert here: the preview
 * harness has no backend, and dispatch is not what these fixtures are for.
 */
function PendingUserInputPreview({
  questions,
}: {
  readonly questions: ReadonlyArray<UserInputQuestion>;
}) {
  const [drafts, setDrafts] = useState<Record<string, UserInputAnswerDraft>>({});

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl p-6">
      <div className="overflow-hidden rounded-[19px] border border-border/65">
        <PendingQuestionCard
          pendingUserInput={{
            requestId: "preview-request" as ApprovalRequestId,
            createdAt: "2026-02-23T00:00:00.000Z",
            questions,
          }}
          pendingCount={1}
          drafts={drafts}
          answers={buildUserInputAnswers(questions, drafts)}
          isResponding={false}
          isDismissing={false}
          supersededByMessage={false}
          onToggleOption={(question, optionLabel) =>
            setDrafts((current) => ({
              ...current,
              [question.id]: toggleUserInputOptionSelection(
                question,
                current[question.id],
                optionLabel,
              ),
            }))
          }
          onChangeCustomAnswer={(questionId, customAnswer) =>
            setDrafts((current) => ({
              ...current,
              [questionId]: setUserInputCustomAnswer(current[questionId], customAnswer),
            }))
          }
          onSubmit={() => {}}
          onDismiss={() => {}}
        />
      </div>
    </div>
  );
}

function pendingUserInputFixture(
  id: string,
  title: string,
  questions: ReadonlyArray<UserInputQuestion>,
  description: string,
): PreviewFixture {
  return {
    id,
    title,
    description,
    // Keyed by fixture id: switching fixtures renders the same component type, so
    // without it one fixture's answers would carry into the next.
    render: () => <PendingUserInputPreview key={id} questions={questions} />,
  };
}

/**
 * The annotation-layer defect case: a `<Card>` wrapping a **closed** `<Details>`
 * wrapping a 12-cell `<Table>`, with wrapping prose before and after. It
 * exercises all four MDX-annotation rendering defects at once:
 *  - **A** — toggle the panel button (container width changes while the viewport
 *    stays wide, so the capped `max-w-4xl` root only re-centres); highlights must
 *    track, not drift into the gutter.
 *  - **B** — hover the card / table and "Comment on this block": a block anchor
 *    must draw ONE outline ring, not a card-sized fill plus a pill per cell.
 *  - **C** — comment on content inside the closed `<Details>`: it must collapse
 *    to a badge on the summary, never paint phantom pills over the prose below.
 *  - **D** — add `dark` to `<html>` and hover the floating "Comment" button: it
 *    must stay opaque, not go transparent.
 */
const MDX_ANNOTATION_FIXTURE_SOURCE = [
  "# Annotation layer defect fixture",
  "",
  "This paragraph before the card is deliberately long prose so a reviewer can select a multi-line span and comment on it, exercising the text-anchor per-line highlight path. It needs enough words to wrap across several lines at the capped measure — no PR trains, merge order, benchmark tables, scale considerations, just filler that wraps and wraps.",
  "",
  '<Card heading="S4 — the face-rent finding" tone="warning" badge="STAGE">',
  "",
  "The body of the card is prose too, so commenting on the whole card must draw a single outline ring rather than a giant translucent fill plus a loose grid of pills.",
  "",
  '<Details summary="Full production records (closed by default)">',
  "",
  "Hidden evidence prose inside a closed disclosure. Commenting on content in here must collapse to a badge on the summary, not paint phantom pills over the paragraphs that follow the card.",
  "",
  '<Table columns={["Field", "Before", "After"]} rows={[["rent", "100", "120"], ["term", "5y", "7y"], ["area", "200", "260"], ["parking", "no", "yes"]]} />',
  "",
  "</Details>",
  "",
  "</Card>",
  "",
  "This paragraph after the card is exactly where the closed-details phantom rects used to land — a rect covering “— no PR trains, merge order, benchmark tables, scale co” at non-word-aligned offsets. With defect C fixed it stays clean.",
].join("\n");

/**
 * Renders the annotation layer inside a container whose width toggles between two
 * wide states (both > the 896px `max-w-4xl` cap), reproducing the file-explorer
 * panel toggle that triggers defect A without ever narrowing the viewport.
 */
function MdxAnnotationPreview() {
  const [panelOpen, setPanelOpen] = useState(false);
  return (
    <div className="flex min-h-[600px] gap-3">
      <button
        type="button"
        onClick={() => setPanelOpen((open) => !open)}
        className="h-8 shrink-0 self-start rounded-md border border-border bg-background px-3 text-xs font-medium hover:bg-muted"
      >
        {panelOpen ? "Close panel" : "Open panel"} (defect A)
      </button>
      {panelOpen ? (
        <div className="w-72 shrink-0 rounded-lg border border-dashed border-border bg-muted/20 p-3 text-xs text-muted-foreground">
          Simulated file-explorer panel. Opening/closing it changes the document container width
          while the viewport stays wide — highlights must track.
        </div>
      ) : null}
      <div className="min-w-0 flex-1 rounded-lg border border-border">
        <MdxPlanAnnotationLayer
          source={MDX_ANNOTATION_FIXTURE_SOURCE}
          filePath="plans/preview/plan.mdx"
          composerDraftTarget={DraftId.make("preview-scratch")}
        />
      </div>
    </div>
  );
}

const mdxAnnotationFixture: PreviewFixture = {
  id: "mdx-annotation-defects",
  title: "Card › closed Details › Table",
  description:
    "All four annotation-rendering defects in one document. A: toggle the panel and watch highlights track (not drift). B: hover the card/table → 'Comment on this block' → one ring, not a fill + per-cell pills. C: comment inside the closed Details → a collapsed badge on the summary, no phantom pills below. D: set the app to dark and hover the floating 'Comment' button → stays opaque.",
  render: () => <MdxAnnotationPreview key="mdx-annotation-defects" />,
};

export const PREVIEW_GROUPS: ReadonlyArray<PreviewGroup> = [
  {
    id: "mdx-annotation",
    title: "MDX annotation layer",
    fixtures: [mdxAnnotationFixture],
  },
  {
    id: "pending-user-input",
    title: "Pending user input",
    fixtures: [
      pendingUserInputFixture(
        "pending-user-input-previews",
        "Single-select with markdown previews",
        PENDING_USER_INPUT_QUESTIONS,
        "Hovering or focusing an option swaps the bordered preview pane. Wide tables and long code fences must stay inside the panel and scroll rather than blowing it out; the option without a preview looks exactly as it does today.",
      ),
      pendingUserInputFixture(
        "pending-user-input-stakes-recommended",
        "Stakes + recommended option",
        PENDING_USER_INPUT_STAKES_AND_RECOMMENDED,
        "The decision the fields exist for: `stakes` frames what the choice costs to get wrong above the options, and the badged option carries the agent's pick. The badge must read as a suggestion, not as a pre-selected answer — nothing is selected until the user clicks.",
      ),
      pendingUserInputFixture(
        "pending-user-input-stakes-only",
        "Stakes only",
        PENDING_USER_INPUT_STAKES_ONLY,
        "An agent that framed the consequences but would not pick a side: framing renders, no badge appears.",
      ),
      pendingUserInputFixture(
        "pending-user-input-recommended-only",
        "Recommended only",
        PENDING_USER_INPUT_RECOMMENDED_ONLY,
        "A pick with no stakes line: the badge renders and the question spacing is unchanged from today.",
      ),
      pendingUserInputFixture(
        "pending-user-input-accordion",
        "Three questions (accordion)",
        PENDING_USER_INPUT_THREE_QUESTIONS,
        "The height case the accordion exists for: rendered in parallel this request cost ~1600px. At rest exactly one question is expanded and the other two keep a one-line header row, so the card reads as a prompt. Click any header to move the expansion; the free-text field stays behind its affordance until asked for.",
      ),
      pendingUserInputFixture(
        "pending-user-input-multi",
        "Multi-select (no previews, neither field)",
        PENDING_USER_INPUT_MULTI_QUESTIONS,
        "Multi-select questions never show previews, and with neither `stakes` nor `recommended` set the card is the plain option list — every non-pi provider sends questions in this shape.",
      ),
    ],
  },
  {
    id: "workstream-graph",
    title: "Workstream graph",
    fixtures: [workstreamGraphFixture],
  },
  {
    id: "chat-markdown",
    title: "ChatMarkdown",
    fixtures: [
      markdownFixture(
        "wide-table",
        "Wide table (bleed)",
        WIDE_TABLE_MARKDOWN,
        "Regression guard for PR #68: table bleeds past max-w-3xl up to the viewport budget.",
      ),
      markdownFixture(
        "narrow-table",
        "Narrow table",
        NARROW_TABLE_MARKDOWN,
        "A small table must hug its content, not stretch to the bleed budget.",
      ),
      markdownFixture("code-blocks", "Code blocks", CODE_BLOCK_MARKDOWN),
      markdownFixture(
        "inline-code-file-links",
        "Inline-code file links",
        INLINE_CODE_FILE_LINKS_MARKDOWN,
        "Plain inline-code path references become clickable file chips; non-path code spans and fenced blocks stay plain.",
        "/Users/julius/project",
      ),
      markdownFixture(
        "prose-and-code-path-links",
        "Prose & code-block path links",
        PROSE_AND_CODE_PATH_LINKS_MARKDOWN,
        "Plain-prose paths become file chips; paths inside a fenced block become terminal-style clickable regions with unchanged text. Non-paths (dates, and/or, urls) stay plain.",
        "/Users/julius/project",
      ),
      markdownFixture(
        "prose-and-code-path-links-streaming",
        "Prose & code path links (streaming)",
        PROSE_AND_CODE_PATH_LINKS_MARKDOWN,
        "While streaming, prose linking and code-block decoration are deferred: the SAME content renders as plain text (no chips, no clickable code paths) until the message completes — satisfying the 'no per-token rescans' requirement.",
        "/Users/julius/project",
        true,
      ),
      markdownFixture("long-prose", "Long prose", LONG_PROSE_MARKDOWN),
      markdownFixture("mixed-document", "Mixed document", MIXED_DOCUMENT_MARKDOWN),
      markdownFixture(
        "list-nested-code-block-empty",
        "Empty code block (list-nested)",
        LIST_NESTED_CODE_BLOCK_MARKDOWN,
        "Minimal repro: A + E (not in a list item) keep their bodies; B, C and D (inside list items) render chrome only with an empty body. A correct fix shows text in all five.",
      ),
      markdownFixture(
        "list-nested-code-blocks",
        "Empty code blocks (real corpus)",
        CONSULT_REPORT_CODE_BLOCKS_MARKDOWN,
        "Ground truth: the verbatim reviewer message from the reported session. Nine fences (text/python/bash/json), every one indented inside an ordered-list item — all nine bodies are empty today.",
      ),
    ],
  },
  {
    id: "user-message",
    title: "User message bubble",
    fixtures: [
      userBubbleFixture(
        "user-wide-table",
        "Wide table in bubble",
        WIDE_TABLE_MARKDOWN,
        "A wide table inside the bordered user bubble should use the surrounding whitespace, not compress or break out of the border.",
      ),
      userBubbleFixture(
        "user-narrow-table",
        "Narrow table in bubble",
        NARROW_TABLE_MARKDOWN,
        "A small table must keep the bubble hugging its content, unchanged.",
      ),
      userBubbleFixture(
        "user-long-prose",
        "Long prose in bubble",
        LONG_PROSE_MARKDOWN,
        "Prose-only messages must keep today's readable width and not stretch.",
      ),
      userBubbleFixture(
        "user-mixed-document",
        "Mixed document in bubble",
        MIXED_DOCUMENT_MARKDOWN,
        "Prose stays at the readable measure while the wide table bleeds to use whitespace.",
      ),
    ],
  },
];

export const PREVIEW_FIXTURES: ReadonlyArray<PreviewFixture> = PREVIEW_GROUPS.flatMap(
  (group) => group.fixtures,
);
