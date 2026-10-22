/**
 * The 22 Loom tools served on `/mcp`: input schema, error mode and hints per
 * tool, with the prose (description, snippet) read from `prose.ts`. The
 * Effect schema is the single source: handlers receive its
 * decoded type and `parameters` (the JSON schema `tools/list` serves) is
 * derived from it, so the two cannot drift (DL-336). `mcp__t3-code__ask_user_question` is
 * registered by Loom's pi extension, not here.
 *
 * @module mcp/toolkits/workstream/defs
 */
import * as Effect from "effect/Effect";
import type * as JsonSchema from "effect/JsonSchema";
import * as Schema from "effect/Schema";

import { MAX_GOAL_TASK_TEXT_LENGTH } from "../../../loom/goals/goalTaskMarkdown.ts";
import type { WorkstreamCaller } from "./authorisation.ts";
import { agentToolName as t } from "./families.ts";
import { LOOM_TOOL_PROSE, type LoomProseToolName } from "./prose.ts";

/** The one failure a Loom handler returns; its message is the text the agent reads. */
export class LoomToolError extends Schema.TaggedError<LoomToolError>()("LoomToolError", {
  message: Schema.String,
}) {}

// ask_user_question and the bg_* job tools are pi-extension tools, not served over MCP.
export type LoomMcpToolName = Exclude<
  LoomProseToolName,
  "ask_user_question" | "bg_start" | "bg_wait"
>;

const described = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description });
const optionalText = (description: string) =>
  Schema.optionalKey(described(Schema.String, description));
const optionalThreadId = optionalText("This thread when omitted, else a direct child's id.");
const clientRequestId = optionalText(
  "Idempotency key: reuse a value only when retrying this exact call, and the retry repeats nothing that already happened.",
);

const ModelSelectionInput = Schema.Struct({
  instanceId: described(Schema.String, "A configured provider instance id."),
  model: described(Schema.String, "Model slug on that instance."),
  options: Schema.optionalKey(
    described(
      Schema.Array(
        Schema.Struct({ id: Schema.String, value: Schema.Union([Schema.String, Schema.Boolean]) }),
      ),
      "Per-model options, e.g. thinking level.",
    ),
  ),
});

const GateInput = Schema.Struct({
  rework: described(
    Schema.String,
    "The sibling under review, whose rework this gate loops: a direct child's id (in a scaffold, a node key or `thread:<id>`).",
  ),
  maxRounds: Schema.optionalKey(
    described(
      Schema.Int,
      "Rework loops before the gate yields to you instead of looping again. Default 2.",
    ),
  ),
});

const taskText = (noun: string) =>
  `${noun}: a short plain-language work item naming the outcome (at most ${MAX_GOAL_TASK_TEXT_LENGTH} characters), never a finding, verdict or status note.`;

/** The node fields of a spawn; a scaffold node carries the same fields and points here. */
const childFields = {
  role: optionalText(
    "The child's role: one of the built-in roles orchestrator, planner, coder, reviewer, researcher, assessor or shipper; a role the project adds under `.t3code/roles/`; or free text when none fits. Omit it when forkFrom is set: a fork inherits its source's role.",
  ),
  title: described(
    Schema.String,
    "The card's name, roughly six words at most, leading with the distinguishing subject rather than a verb every sibling shares: 'Receipt-dedup merge', not 'Implement receipt-dedup merge'.",
  ),
  purpose: described(
    Schema.String,
    "One to three sentences shown on the sidebar card as the thread's goal: the value the work delivers, not the role or the steps.",
  ),
  blockedBy: Schema.optionalKey(
    described(
      Schema.Array(Schema.String),
      "Threads this child waits on; it starts once every one is done.",
    ),
  ),
  gate: Schema.optionalKey(
    described(
      GateInput,
      `A review gate on this child, typically a reviewer: its ${t("workstream_submit")} verdicts route in the control plane; 'needs_rework' loops the sibling named by rework, 'clean' or 'fixed_inline' resolve the gate and complete both. rework is added to blockedBy. Hang downstream work on this gated child, not on the rework sibling alone, since a rework round reopens that sibling's done.`,
    ),
  ),
  forkFrom: optionalText(
    "Fork this child's session from a direct sibling once that sibling is done: it starts from a copy of the sibling's final transcript and inherits its role, model and anchor, so pass none of role, modelSelection, modelPreset, taskShape, sensitive or gate with it.",
  ),
  anchorTaskId: optionalText(
    `The goal task this child owns, with its subtree, from the trailing '(id)' of a ${t("goal_task_list")} line. Anchor a child whose work is a task in the tree; leave a reviewer or a researcher unbound. When you are anchored yourself, only your own anchor or a task beneath it.`,
  ),
  taskShape: Schema.optionalKey(
    described(
      Schema.Literals(["explore", "thorough", "mechanical"]),
      "Server-resolved model hint; omit for most spawns. 'explore' for open-ended work whose plan will change, 'thorough' for edge cases, migrations and review gates, 'mechanical' for bounded high-volume work.",
    ),
  ),
  sensitive: Schema.optionalKey(
    described(
      Schema.Literals(["security"]),
      "'security', with taskShape, excludes models flagged unsuitable for security-adjacent work.",
    ),
  ),
  modelPreset: optionalText(
    "A named model preset, for the rare spawn that needs a specific model.",
  ),
  modelSelection: Schema.optionalKey(
    described(
      ModelSelectionInput,
      "An explicit model, overriding modelPreset and taskShape, for the rare spawn that needs one.",
    ),
  ),
};

/** The same fields on a scaffold node: a few words each, with the contract on the spawn's field. */
const asSpawn = (field: keyof typeof childFields) => `As ${t("workstream_spawn")}'s \`${field}\`.`;
const scaffoldNodeFields = {
  role: optionalText(asSpawn("role")),
  title: described(Schema.String, asSpawn("title")),
  purpose: described(Schema.String, asSpawn("purpose")),
  blockedBy: Schema.optionalKey(
    described(Schema.Array(Schema.String), `Node keys or \`thread:<id>\`s this node waits on.`),
  ),
  gate: Schema.optionalKey(
    described(
      Schema.Struct({ rework: Schema.String, maxRounds: Schema.optionalKey(Schema.Int) }),
      `A review gate on this node; \`rework\` names the sibling it loops, by key or \`thread:<id>\`. Semantics as ${t("workstream_spawn")}'s \`gate\`.`,
    ),
  ),
  forkFrom: optionalText(`${asSpawn("forkFrom")} By key or \`thread:<id>\`.`),
  anchorTaskId: optionalText(asSpawn("anchorTaskId")),
  taskShape: Schema.optionalKey(
    described(Schema.Literals(["explore", "thorough", "mechanical"]), asSpawn("taskShape")),
  ),
  sensitive: Schema.optionalKey(described(Schema.Literals(["security"]), asSpawn("sensitive"))),
  modelPreset: optionalText(asSpawn("modelPreset")),
  modelSelection: Schema.optionalKey(
    described(
      Schema.Struct({
        instanceId: Schema.String,
        model: Schema.String,
        options: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              id: Schema.String,
              value: Schema.Union([Schema.String, Schema.Boolean]),
            }),
          ),
        ),
      }),
      asSpawn("modelSelection"),
    ),
  ),
};

/** The brief contract, owned by `mcp__t3-code__workstream_brief`'s `markdown`; the spawn's `brief` points here. */
const brief = described(
  Schema.String,
  `The child's first-turn assignment, read by an agent told it is your writing and free to depart from it with reasons. State the outcome it owes and the contract it works under: why it matters, the constraints, the definition of done, where the code and artefacts live; leave how to its role. Mark which constraints are the human's stated decisions, quoted, and which are your own assumptions, so the child knows what it may challenge. When the deliverable is a document a human will read, include its reader brief (who reads it and to do what, what they already know, what they must be able to say or decide after the first screen), since the child has never met that reader. Do not restate what its system prompt already carries: AGENTS.md, the work model, the shipping policy, its role, the goal and its task tree.`,
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
      brief: Schema.optionalKey(
        described(
          Schema.String,
          `The child's first-turn assignment; the contract is ${t("workstream_brief")}'s \`markdown\`. Omitted, the purpose serves as the brief.`,
        ),
      ),
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
              "Symbolic key, unique forever among this parent's children, that other nodes' blockedBy, gate and forkFrom name. Not UUID-shaped: an existing thread is `thread:<id>`.",
            ),
            ...scaffoldNodeFields,
          }),
        ),
        "The nodes to create, or to add in a delta call: a key plus the fields of a spawn, minus its brief.",
      ),
      clientRequestId,
    }),
    "throw",
  ),
  workstream_brief: spec(
    "Brief Workstream Node",
    Schema.Struct({
      node: described(Schema.String, "The node to brief: its scaffold key or its thread id."),
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
        "'done' releases dependents. 'cancelled' abandons the work without releasing dependents and cascades: every unfinished descendant is cancelled and its in-flight turn interrupted. 'none' clears a done or cancelled outcome.",
      ),
    }),
    "throw",
    { idempotent: true },
  ),
  workstream_request_attention: spec(
    "Request Workstream Attention",
    Schema.Struct({
      threadId: optionalThreadId,
      reason: Schema.Literals(["awaiting_acceptance", "needs_guidance"]),
    }),
    "throw",
    { idempotent: true },
  ),
  workstream_stop: spec(
    "Stop Workstream Child",
    Schema.Struct({
      threadId: described(Schema.String, "The direct child's id."),
    }),
    "throw",
    { idempotent: true },
  ),
  workstream_prompt: spec(
    "Prompt Workstream Child",
    Schema.Struct({
      threadId: described(Schema.String, "The direct child's id."),
      message: described(
        Schema.String,
        `The message. Into a running turn it is a course-correction, not a fresh assignment; to an idle child it is the next turn's prompt; on an unlaunched child it is appended to the brief, so write it to ${t("workstream_brief")}'s \`markdown\` contract.`,
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
        "The full set of thread ids this thread waits on; replaces the existing set.",
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
        "The report, stored on disk and shown to whoever receives your work next: what you did, the key results and decisions, and anything they must act on; not a transcript. Open with a <!-- response --> … <!-- /response --> block summarising the hand-back (the gist, and what the receiver must act on). Every notice carries that block verbatim and the rest is read from the file on demand, so a long answer is summarised in the block rather than contained in it.",
      ),
      outcome: optionalText(
        "Omitted means 'done'; otherwise 'needs_human', a gate verdict, or a short snake_case token such as 'rework_approach'.",
      ),
      contested: Schema.optionalKey(
        described(
          Schema.Array(Schema.String),
          "Findings you reject, quotable verbatim, kept on the audit trail.",
        ),
      ),
      counts: Schema.optionalKey(
        described(
          Schema.Struct({
            mustFix: described(Schema.Int, "Must-fix findings."),
            niceToHave: described(Schema.Int, "Nice-to-have findings."),
          }),
          "Reviewer finding counts, for the verdict chip.",
        ),
      ),
    }),
    "throw",
  ),
  workstream_list: spec(
    "List Workstream",
    Schema.Struct({
      detail: Schema.optionalKey(
        described(
          Schema.Literals(["full"]),
          "'full' adds each thread's purpose, anchor task and pi session path.",
        ),
      ),
    }),
    "throw",
    { readOnly: true, idempotent: true },
  ),
  consult_thread: spec(
    "Consult Thread",
    Schema.Struct({
      threadId: optionalText(
        "The target's exact id, preferred when known; an @-mentioned thread arrives as [Title](t3-thread://v1/<id>). One of threadId or name.",
      ),
      name: optionalText(
        "Fuzzy sidebar-title match when you have no id; an ambiguous name returns ranked candidates to call again with.",
      ),
      question: described(
        Schema.String,
        "Self-contained: the fork answering it shares none of your context.",
      ),
    }),
    "throw",
    { readOnly: true },
  ),
  notify_thread: spec(
    "Notify Thread",
    Schema.Struct({
      threadId: optionalText(
        "The target's exact id, preferred when known. One of threadId or name.",
      ),
      name: optionalText(
        "Fuzzy sidebar-title match when you have no id; an ambiguous name sends nothing and returns ranked candidates.",
      ),
      message: described(
        Schema.String,
        "Self-contained, framed to the recipient as a notification from your thread: reference outputs by absolute path and say plainly if you want anything back.",
      ),
    }),
    "throw",
  ),
  set_thread_title: spec(
    "Set Thread Title",
    Schema.Struct({
      title: described(Schema.String, "The new title."),
    }),
    "throw",
    { idempotent: true },
  ),
  snooze_thread: spec(
    "Snooze Thread",
    Schema.Struct({
      until: optionalText(
        "ISO-8601 datetime at which the snooze lapses, at most 30 days ahead; pass the same value on every re-snooze so the quiet period does not creep.",
      ),
      cancel: Schema.optionalKey(
        described(Schema.Boolean, "true withdraws a request made earlier this turn."),
      ),
    }),
    "throw",
    { idempotent: true },
  ),
  thread_fork: spec(
    "Fork Thread",
    Schema.Struct({
      threadTitle: optionalText(
        "Sidebar name for the fork; defaults to this thread's title + ' (fork)'.",
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
          "'branch', the default when anchored: your anchor's subtree under the read-only spine. 'tree': the whole goal.",
        ),
      ),
    }),
    "soft",
    { readOnly: true, idempotent: true },
  ),
  goal_task_add: spec(
    "Add Goal Task",
    Schema.Struct({
      text: described(Schema.String, taskText("The task")),
      parentTaskId: optionalText(
        "The task to nest under; omitted, your own anchor. Unanchored and omitted, a new top-level phase, for a genuinely new phase of the goal only.",
      ),
      clientRequestId,
    }),
    "soft",
  ),
  goal_task_update: spec(
    "Update Goal Task",
    Schema.Struct({
      taskId: described(Schema.String, "The task's id."),
      text: optionalText(taskText("New text")),
      done: Schema.optionalKey(
        described(Schema.Boolean, "true marks the task done, false reopens it."),
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
        `The complete revised tree at your scope, in the \`- [ ] Open task\` / \`- [x] Finished task (task-id)\` form ${t("goal_task_list")} returns, two spaces of indent per level. A line keeping an existing \`(id)\` is that task, with the text, done-state, parent and order you submit; a line without one is a new task; a task you omit is deleted, and comes back with its id if you resubmit its line. Text is at most ${MAX_GOAL_TASK_TEXT_LENGTH} characters, a plain-language work item naming the outcome, never a finding, verdict or status note, with concrete work hung under a handful of phase or theme parents. Your anchor line stays, renamed or ticked at most.`,
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
        "A noun phrase of up to six words naming the goal, leading with the distinguishing subject.",
      ),
      brief: described(
        Schema.String,
        "The new root's first turn, read as another agent's writing by an orchestrator that plans the work itself: a self-contained problem statement (context, motivation, constraints, where things live). What and why, never how; quote the human's words where you relay them and mark the rest as your own reading.",
      ),
      description: described(
        Schema.String,
        "One or two sentences on the objective: the value or pain point, not the implementation.",
      ),
      project: optionalText(
        "The target project (title or id) when the work belongs in another project.",
      ),
      notDuplicateOf: Schema.optionalKey(
        described(
          Schema.Array(Schema.String),
          "Thread ids a duplicate check named that you judged to be different work; skips the check.",
        ),
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
        "The continuation's first turn, self-contained and read as your writing, not the human's: current state, what was done, what to do next, where key artefacts live. Quote the human's decisions rather than paraphrasing them.",
      ),
      threadTitle: optionalText("Sidebar name; defaults to the goal title + ' (continued)'."),
      clientRequestId,
    }),
    "soft",
  ),
  goal_update: spec(
    "Update Goal",
    Schema.Struct({
      title: optionalText("New title."),
      description: optionalText("New objective statement, short, not a journal; empty clears it."),
      slug: optionalText("New stable slug."),
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
