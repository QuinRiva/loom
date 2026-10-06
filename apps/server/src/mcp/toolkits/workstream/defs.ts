/**
 * The 21 Loom tools served on `/mcp`: input schema, error mode and hints per
 * tool, with the prose (description, snippet, guidelines) read from
 * `prose.ts`. The Effect schema is the single source: handlers receive its
 * decoded type and `parameters` (the JSON schema `tools/list` serves) is
 * derived from it, so the two cannot drift (DL-336). `ask_user_question` and
 * `enable_toolset` are registered by Loom's pi extension, not here.
 *
 * @module mcp/toolkits/workstream/defs
 */
import * as Effect from "effect/Effect";
import type * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";
import * as Tool from "effect/ai/Tool";

import type { WorkstreamCaller } from "./authorisation.ts";
import { agentToolName as t } from "./families.ts";
import { LOOM_TOOL_PROSE, type LoomProseToolName } from "./prose.ts";

/** The longest task text the goal tools accept. */
export const MAX_GOAL_TASK_TEXT_LENGTH = 300;

/** The one failure a Loom handler returns; its message is the text the agent reads. */
export class LoomToolError extends Schema.TaggedError<LoomToolError>()("LoomToolError", {
  message: Schema.String,
}) {}

export type LoomMcpToolName = Exclude<LoomProseToolName, "enable_toolset" | "ask_user_question">;

const described = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description });
const optionalText = (description: string) =>
  Schema.optionalKey(described(Schema.String, description));
const optionalThreadId = optionalText(
  "Id of the thread to act on; defaults to the calling thread when omitted.",
);
const clientRequestId = optionalText(
  "Optional idempotency key. Reuse the same value only when retrying this exact call; a retry with it repeats nothing that already happened.",
);

const ModelSelectionInput = Schema.Struct({
  instanceId: described(
    Schema.String,
    "Configured provider instance id to route to. Must be a configured instance in this build — an unknown id is rejected at spawn with the available instance ids.",
  ),
  model: described(
    Schema.String,
    "Model slug for that instance — an unknown slug is rejected at spawn with guidance.",
  ),
  options: Schema.optionalKey(
    described(
      Schema.Array(
        Schema.Struct({ id: Schema.String, value: Schema.Union([Schema.String, Schema.Boolean]) }),
      ),
      "Optional per-model options, e.g. thinking level.",
    ),
  ),
});

const GateInput = Schema.Struct({
  rework: described(
    Schema.String,
    "The sibling this gate loops rework back to (the work under review). Must be a thread you directly parent (or, in a scaffold, a node key or `thread:<id>`).",
  ),
  maxRounds: Schema.optionalKey(
    described(
      Schema.Int,
      "Maximum rework loops before the gate yields to you instead of looping again. Default 2.",
    ),
  ),
});

/** Model and placement fields shared by a spawn and a scaffold node. */
const childFields = {
  role: optionalText(
    "Role label for the child agent, e.g. coder, reviewer, researcher. Required for a normal spawn; OMIT it when forkFrom is set (a fork inherits the source's role, and passing role with forkFrom is rejected).",
  ),
  title: described(
    Schema.String,
    "Short label naming the work at a glance, the card's bold name, roughly ≤6 words. Lead with the distinguishing subject rather than a verb shared by every sibling: 'Receipt-dedup merge', not 'Implement receipt-dedup merge'.",
  ),
  purpose: described(
    Schema.String,
    "Short (1-3 sentence) summary shown on the sidebar card as the thread's 'Goal'. State the value the work delivers — the capability, fix, or decision it produces — not the role or the mechanical steps.",
  ),
  blockedBy: Schema.optionalKey(
    described(
      Schema.Array(Schema.String),
      "Threads this child waits on; it does not start until every listed thread's outcome is 'done'.",
    ),
  ),
  gate: Schema.optionalKey(
    described(
      GateInput,
      `Declare a review gate on this child (typically a reviewer): its ${t("workstream_submit")} outcomes route in the control plane — 'needs_rework' loops the sibling named by rework, 'clean'/'fixed_inline' resolve the gate and complete both. gate.rework is added to blockedBy automatically.`,
    ),
  ),
  forkFrom: optionalText(
    "Fork this child's session from an active sibling (the source) once the source is done: the child starts from a copy of the source's final transcript and inherits its role, model and anchor. Do NOT pass role / modelSelection / modelPreset / taskShape / sensitive with it. forkFrom is added to blockedBy automatically and cannot be combined with gate.",
  ),
  anchorTaskId: optionalText(
    `Bind this child to ONE task of the goal task tree: that task and its subtree become the branch the child owns. Anchor a child whose work IS a task in the tree; leave unbound a child with no task of its own (a reviewer, a researcher answering a brief). Pass the id from the trailing '(id)' of a task line in ${t("goal_task_list")}. When you are yourself anchored you may only pass your own anchor or a task beneath it.`,
  ),
  taskShape: Schema.optionalKey(
    described(
      Schema.Literals(["explore", "thorough", "mechanical"]),
      "Server-resolved model hint; omit for most spawns. 'explore' (open-ended, plan likely to change); 'thorough' (edge cases, migrations, review gates); 'mechanical' (bounded, high-volume work). A shape with no matching server profile falls through to the role preset.",
    ),
  ),
  sensitive: Schema.optionalKey(
    described(
      Schema.Literals(["security"]),
      "Optional sensitivity marker paired with taskShape: 'security' excludes models flagged unsuitable for security-adjacent work.",
    ),
  ),
  modelPreset: optionalText(
    `Escape hatch: a named model preset (see modelPresets in ${t("workstream_list")}); an unknown name is rejected with the available names.`,
  ),
  modelSelection: Schema.optionalKey(
    described(
      ModelSelectionInput,
      "Escape hatch: an explicit model override, taking precedence over modelPreset and taskShape.",
    ),
  ),
};

const brief = described(
  Schema.String,
  `The child's full, self-contained first-turn assignment. State the outcome it owes and the contract it works under (why it matters, constraints, definition of done, where the code and artefacts live) and leave how to its role. Do not restate what the child's system prompt already carries (AGENTS.md, the work-model doctrine, the shipping policy, its role overlay, the goal and its task tree).`,
);

interface LoomToolSpec {
  readonly label: string;
  readonly input: Schema.Codec<object, object>;
  /** throw: a failure reaches the agent as a failed call; soft: as ordinary text. */
  readonly errorMode: "throw" | "soft";
  readonly readOnly: boolean;
  readonly idempotent: boolean;
}

const spec = <const S extends Schema.Codec<object, object>>(
  label: string,
  input: S,
  errorMode: "throw" | "soft",
  hints: { readonly readOnly?: boolean; readonly idempotent?: boolean } = {},
) => ({
  label,
  input,
  errorMode,
  readOnly: hints.readOnly ?? false,
  idempotent: hints.idempotent ?? false,
});

const LOOM_TOOL_SPECS = {
  workstream_spawn: spec(
    "Spawn Workstream Sub-thread",
    Schema.Struct({
      ...childFields,
      brief: Schema.optionalKey(brief),
      clientRequestId,
    }),
    "throw",
  ),
  workstream_scaffold: spec(
    "Scaffold Workstream Graph",
    Schema.Struct({
      nodes: described(
        Schema.Array(
          Schema.Struct({
            key: described(
              Schema.String,
              "Symbolic key, unique forever among the parent's children, used by other nodes' blockedBy / gate / forkFrom. Must NOT be UUID-shaped (reference an existing thread as `thread:<id>`).",
            ),
            ...childFields,
          }),
        ),
        `The nodes to create (or add, for a delta call): each is a ${t("workstream_spawn")} node minus brief, plus a key. References are a node key in this call or \`thread:<id>\` for an existing child.`,
      ),
      clientRequestId,
    }),
    "throw",
  ),
  workstream_brief: spec(
    "Brief Workstream Node",
    Schema.Struct({
      node: described(
        Schema.String,
        "The scaffolded node to brief: its key or its thread id (optionally `thread:`-prefixed). Must be a direct child that has not started.",
      ),
      markdown: brief,
    }),
    "throw",
    { idempotent: true },
  ),
  workstream_set_outcome: spec(
    "Set Workstream Outcome",
    Schema.Struct({
      threadId: optionalThreadId,
      outcome: described(
        Schema.Literals(["done", "cancelled", "none"]),
        "'done' releases dependents; 'cancelled' abandons the work and cascades to every non-terminal descendant, interrupting their in-flight turns; 'none' reopens a done or cancelled thread.",
      ),
    }),
    "throw",
    { idempotent: true },
  ),
  workstream_request_attention: spec(
    "Request Workstream Attention",
    Schema.Struct({
      threadId: optionalThreadId,
      reason: described(
        Schema.Literals(["awaiting_acceptance", "needs_guidance"]),
        "'awaiting_acceptance' (output needs sign-off before done) or 'needs_guidance' (cannot proceed without a human).",
      ),
    }),
    "throw",
    { idempotent: true },
  ),
  workstream_stop: spec(
    "Stop Workstream Child",
    Schema.Struct({
      threadId: described(Schema.String, "Id of the direct child thread to stop."),
    }),
    "throw",
    { idempotent: true },
  ),
  workstream_prompt: spec(
    "Prompt Workstream Child",
    Schema.Struct({
      threadId: described(Schema.String, "Id of the direct child thread to prompt."),
      message: described(
        Schema.String,
        `The markdown message for the child. A steer into a running turn is a course-correction, not a fresh assignment; a message to an idle child starts its next turn; on an unstarted node it is appended to that node's brief, so write it to ${t("workstream_spawn")}'s brief contract.`,
      ),
    }),
    "throw",
  ),
  workstream_set_dependencies: spec(
    "Set Workstream Dependencies",
    Schema.Struct({
      threadId: optionalThreadId,
      blockedBy: described(
        Schema.Array(Schema.String),
        "Full set of thread ids this thread waits on. Replaces any existing dependencies.",
      ),
    }),
    "throw",
    { idempotent: true },
  ),
  workstream_submit: spec(
    "Submit Workstream Work",
    Schema.Struct({
      markdown: described(
        Schema.String,
        "The markdown report to hand back, stored on disk and shown to whoever receives your work next. Make it a deliberate handoff: what you did, the key results and decisions, and anything the parent must act on, not a transcript dump.",
      ),
      outcome: optionalText(
        "Structured outcome token. Omitted ⇒ 'done'. Reserved: 'done', 'needs_human'. Review-gate verdicts: 'clean', 'fixed_inline', 'needs_rework'. Any unmatched token yields you to your parent — use a short snake_case token like 'rework_approach'.",
      ),
      contested: Schema.optionalKey(
        described(
          Schema.Array(Schema.String),
          "Optional: findings you reject, verbatim-quotable — preserved on the audit trail (opaque to routing).",
        ),
      ),
      counts: Schema.optionalKey(
        described(
          Schema.Struct({
            mustFix: described(Schema.Int, "Number of must-fix findings."),
            niceToHave: described(Schema.Int, "Number of nice-to-have findings."),
          }),
          "Optional reviewer finding counts for the verdict chip (opaque to routing).",
        ),
      ),
    }),
    "throw",
  ),
  workstream_list: spec("List Workstream", Tool.EmptyParams, "throw", {
    readOnly: true,
    idempotent: true,
  }),
  consult_thread: spec(
    "Consult Thread",
    Schema.Struct({
      threadId: optionalText(
        "Exact id of the target thread, preferred when known (e.g. from an @-mention [Title](thread://<id>)). Provide threadId OR name, not both.",
      ),
      name: optionalText(
        "Fuzzy sidebar title of the target thread, when you have no exact id; an ambiguous name returns ranked candidates.",
      ),
      question: described(
        Schema.String,
        "The question to answer from the target thread's frozen session context. That fork shares none of your context, so make the question self-contained.",
      ),
    }),
    "throw",
    { readOnly: true },
  ),
  notify_thread: spec(
    "Notify Thread",
    Schema.Struct({
      threadId: optionalText(
        "Exact id of the target thread, preferred when known. Provide exactly one of threadId or name.",
      ),
      name: optionalText(
        "Fuzzy sidebar title of the target thread; an ambiguous match returns ranked candidates without sending.",
      ),
      message: described(
        Schema.String,
        "The markdown message the recipient receives, framed as a notification from your thread. Write it self-contained, reference outputs by absolute path, and say plainly if you want anything back. A notification informs; it never re-tasks.",
      ),
    }),
    "throw",
  ),
  set_thread_title: spec(
    "Set Thread Title",
    Schema.Struct({
      title: described(Schema.String, "The new sidebar title for this thread (non-empty)."),
    }),
    "throw",
    { idempotent: true },
  ),
  thread_fork: spec(
    "Fork Thread",
    Schema.Struct({
      threadTitle: optionalText(
        "Optional sidebar name for the staged fork (≤6 words). Defaults to this thread's title + ' (fork)'.",
      ),
      clientRequestId,
    }),
    "throw",
  ),
  goal_task_list: spec(
    "List Goal Tasks",
    Schema.Struct({
      scope: Schema.optionalKey(
        described(
          Schema.Literals(["branch", "tree"]),
          '"branch" (default when you are anchored): your anchor\'s subtree, preceded by the read-only spine. "tree": the complete goal task tree.',
        ),
      ),
    }),
    "soft",
    { readOnly: true, idempotent: true },
  ),
  goal_task_add: spec(
    "Add Goal Task",
    Schema.Struct({
      text: described(
        Schema.String,
        `A short plain-language work item naming the outcome (at most ${MAX_GOAL_TASK_TEXT_LENGTH} characters) — never a finding, verdict, or status note.`,
      ),
      parentTaskId: optionalText(
        "Id of an existing task in this goal to nest the new task under. Omit to add under your own anchor (or, unanchored, as a new top-level phase).",
      ),
      clientRequestId,
    }),
    "soft",
  ),
  goal_task_update: spec(
    "Update Goal Task",
    Schema.Struct({
      taskId: described(
        Schema.String,
        "Id of the task to update; must belong to this thread's goal.",
      ),
      text: optionalText(
        `New task text: a short plain-language work item naming the outcome (at most ${MAX_GOAL_TASK_TEXT_LENGTH} characters).`,
      ),
      done: Schema.optionalKey(
        described(Schema.Boolean, "Mark the task done (true) or reopen it (false)."),
      ),
    }),
    "soft",
    { idempotent: true },
  ),
  goal_tasks_rewrite: spec(
    "Rewrite Goal Tasks",
    Schema.Struct({
      markdown: described(
        Schema.String,
        `The complete revised tree at your scope as an indented markdown checklist, one task per line: \`- [ ] Open task\`, \`- [x] Finished task (task-id)\`. Two spaces of indent per level; keep the trailing \`(id)\` on every retained task; omit it for new tasks. New or changed text is at most ${MAX_GOAL_TASK_TEXT_LENGTH} characters.`,
      ),
    }),
    "soft",
    { idempotent: true },
  ),
  goal_handoff: spec(
    "Hand Off New Goal",
    Schema.Struct({
      title: described(
        Schema.String,
        "A short (≤6-word) noun-phrase label leading with the distinguishing subject of the work. Names the goal.",
      ),
      brief: described(
        Schema.String,
        "The new session's first turn: a self-contained problem statement — context, motivation, constraints, and where things live. State what and why, never how.",
      ),
      description: described(
        Schema.String,
        "One or two sentences stating the objective, focused on the value or pain point rather than the implementation.",
      ),
      project: optionalText(
        "Optional target project (title or id) when the work belongs in a different project than this thread's.",
      ),
      clientRequestId,
    }),
    "soft",
  ),
  goal_continue: spec(
    "Continue Goal in Fresh Session",
    Schema.Struct({
      brief: described(
        Schema.String,
        "The continuation session's first turn, self-contained: current state, what was done, what to do next, and where key artefacts live.",
      ),
      threadTitle: optionalText(
        "Optional sidebar name for the staged continuation (≤6 words). Defaults to the goal title + ' (continued)'.",
      ),
      clientRequestId,
    }),
    "soft",
  ),
  goal_update: spec(
    "Update Goal",
    Schema.Struct({
      title: optionalText("New goal title."),
      description: optionalText(
        "New short goal objective statement, not a journal (may be empty to clear it).",
      ),
      slug: optionalText("New stable goal slug."),
    }),
    "soft",
    { idempotent: true },
  ),
} satisfies { readonly [N in LoomMcpToolName]: LoomToolSpec };

type Specs = typeof LOOM_TOOL_SPECS;

export type LoomToolInput<N extends LoomMcpToolName> = Specs[N]["input"]["Type"];

export interface LoomToolDef<N extends LoomMcpToolName = LoomMcpToolName> extends LoomToolSpec {
  readonly name: N;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: string;
  /** JSON schema derived from `input`, served as the MCP `inputSchema`. */
  readonly parameters: JsonSchema.JsonSchema;
}

/** Closed objects, as the decoder runs (`onExcessProperty: "error"`) and V1's schemas were. */
const jsonSchemaOf = (input: Schema.Top): JsonSchema.JsonSchema => {
  const document = Schema.toJsonSchemaDocument(input, { onExcessProperty: "error" });
  return Object.keys(document.definitions).length === 0
    ? document.schema
    : { ...document.schema, $defs: document.definitions };
};

export const LOOM_TOOL_DEFS: ReadonlyArray<LoomToolDef> = (
  Object.keys(LOOM_TOOL_SPECS) as ReadonlyArray<LoomMcpToolName>
).map((name) => ({
  name,
  ...LOOM_TOOL_PROSE[name],
  ...LOOM_TOOL_SPECS[name],
  parameters: jsonSchemaOf(LOOM_TOOL_SPECS[name].input),
}));

/**
 * One handler per tool. It receives the decoded input and the authorised
 * caller (the credential's own thread — never a parameter) and returns the
 * rendered markdown the agent reads; services are captured when the record is
 * built, so a handler needs nothing from its context.
 */
export type LoomToolHandlers = {
  readonly [N in LoomMcpToolName]: (
    input: LoomToolInput<N>,
    caller: WorkstreamCaller,
  ) => Effect.Effect<string, LoomToolError>;
};
