#!/usr/bin/env node
// An eval script, not server code: it reads files and shells out to git directly.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { LOOM_PREAMBLE, threadIdentityClause } from "../../apps/server/src/loom/prompt/prose.ts";
import { addendumParts } from "../../apps/server/src/loom/prompt/sessionComposerLive.ts";
import { LOOM_TOOL_DEFS } from "../../apps/server/src/mcp/toolkits/workstream/defs.ts";
import {
  agentToolName,
  HUMAN_INPUT,
} from "../../apps/server/src/mcp/toolkits/workstream/families.ts";
import { LOOM_TOOL_PROSE } from "../../apps/server/src/mcp/toolkits/workstream/prose.ts";
import { renderNotifyDisposition } from "../../apps/server/src/mcp/toolkits/workstream/render.ts";
import { ASK_USER_QUESTION_PARAMETERS } from "../../apps/server/src/provider/Drivers/Pi/loomExtension.ts";
import {
  BG_START_PARAMETERS,
  BG_WAIT_PARAMETERS,
} from "../../apps/server/src/provider/Drivers/Pi/loomExtensionParts/backgroundJobs.ts";
import { proxyConfig } from "../shared/proxy.ts";
import {
  BRIEFS_DIR,
  type Case,
  cases,
  type Message,
  REPORTS_DIR,
  skillLocation,
  WORKTREE,
} from "./cases.ts";
import { type Call, decides, grade } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "claude-fable-5-2" },
    "coder-model": { type: "string", default: "claude-opus-5-5" },
    samples: { type: "string", default: "5" },
    case: { type: "string", multiple: true },
    baseline: { type: "string" },
    concurrency: { type: "string", default: "4" },
    effort: { type: "string", default: "high" },
    "simulator-model": { type: "string", default: "claude-sonnet-5-5" },
  },
});
if (!values.out) throw new Error("Use --out <directory>.");
const outDirectory = values.out;
const repo = NodePath.resolve(import.meta.dirname, "../..");

// Loom's own Claude pool where it exists, as `explainer-density` reaches it; else `vibeproxy`.
const localKey = NodePath.join(NodeOS.homedir(), "cli-proxy/.apikey");
const proxy = NodeFS.existsSync(localKey)
  ? {
      url: "http://localhost:8317/v1",
      headers: { Authorization: `Bearer ${NodeFS.readFileSync(localKey, "utf8").trim()}` },
    }
  : proxyConfig();

const git = (args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

const selected = values.case?.flatMap((ids) => ids.split(","));
const unknown = selected?.filter((id) => !cases.some((entry) => entry.id === id)) ?? [];
if (unknown.length > 0) throw new Error(`Unknown case: ${unknown.join(", ")}`);
const chosen = cases.filter((entry) => selected === undefined || selected.includes(entry.id));
/** Every case on the default model; coder-role cases also on the model coders launch on. */
const runs = chosen.flatMap((entry) => [
  { model: values.model, entry },
  ...(entry.role === "coder" &&
  values["coder-model"] !== "none" &&
  values["coder-model"] !== values.model
    ? [{ model: values["coder-model"], entry }]
    : []),
]);

// ── Assembly: what pi sends this thread, from this checkout's source.

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly input_schema: unknown;
}

const object = (properties: Record<string, unknown>, required: ReadonlyArray<string>) => ({
  type: "object",
  properties,
  required,
});
/** pi's native tools and pi-craft's `sign_document`, stubbed: what matters is that they exist. */
const NATIVE_TOOLS: ReadonlyArray<ToolDef> = [
  {
    name: "read",
    description: "Read the contents of a file.",
    input_schema: object(
      { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } },
      ["path"],
    ),
  },
  {
    name: "bash",
    description:
      "Execute a bash command in the current working directory. Returns stdout and stderr.",
    input_schema: object({ command: { type: "string" }, timeout: { type: "number" } }, ["command"]),
  },
  {
    name: "edit",
    description: "Edit a single file using exact text replacement.",
    input_schema: object(
      {
        path: { type: "string" },
        edits: {
          type: "array",
          items: object({ oldText: { type: "string" }, newText: { type: "string" } }, [
            "oldText",
            "newText",
          ]),
        },
      },
      ["path", "edits"],
    ),
  },
  {
    name: "sign_document",
    description:
      "Call immediately after writing a planning, intent, or architecture document: records this session as the document's author, whom implementation agents can later consult.",
    input_schema: object({ path: { type: "string" }, role: { type: "string" } }, ["path"]),
  },
  {
    name: "tool_search",
    description:
      "Searches over deferred tool metadata and exposes matching tools for the next model call. Some tools, such as tools of MCP servers, are not provided upfront; use tool_search to find them.",
    input_schema: object({ query: { type: "string" }, limit: { type: "number" } }, ["query"]),
  },
];

const extensionTools: ReadonlyArray<ToolDef> = [
  {
    name: "bg_start",
    description: LOOM_TOOL_PROSE.bg_start.description,
    input_schema: BG_START_PARAMETERS,
  },
  {
    name: "bg_wait",
    description: LOOM_TOOL_PROSE.bg_wait.description,
    input_schema: BG_WAIT_PARAMETERS,
  },
];
const mcpTools: ReadonlyArray<ToolDef> = [
  ...LOOM_TOOL_DEFS.map((def) => ({
    name: agentToolName(def.name),
    description: def.description,
    input_schema: def.parameters,
  })),
  {
    name: agentToolName("ask_user_question"),
    description: LOOM_TOOL_PROSE.ask_user_question.description,
    input_schema: ASK_USER_QUESTION_PARAMETERS,
  },
];

/** pi's listing of the role's skills, each SKILL.md's `name` and folded `description`. */
const skillsBlock = (skills: ReadonlyArray<string>) => {
  const entries = skills.map((dir) => {
    const head =
      /^---\n([\s\S]*?)\n---/.exec(
        NodeFS.readFileSync(NodePath.join(dir, "SKILL.md"), "utf8"),
      )?.[1] ?? "";
    const name = /^name: (.+)$/m.exec(head)?.[1] ?? NodePath.basename(dir);
    const description = (/^description: >-\n((?:  .*\n?)+)/m.exec(head)?.[1] ?? "")
      .replaceAll(/\s+/g, " ")
      .trim();
    return `  <skill>\n    <name>${name}</name>\n    <description>${description}</description>\n    <location>${skillLocation(NodePath.basename(dir))}</location>\n  </skill>`;
  });
  return entries.length === 0
    ? ""
    : `\n\n<skills>\nThe following skills provide specialized instructions for specific tasks.\nUse the read tool to load a skill's file when the task matches its description.\n\n<available_skills>\n${entries.join("\n")}\n</available_skills>\n</skills>`;
};

/**
 * The composer's system prompt (pi's preamble, the addendum in the composer's order, the role's
 * skills as pi lists them) and the
 * tools pi declares: the role's profile, human input when a person can read the thread, and what the
 * session profile adds once a person has written to a child (`loomExtension.ts`, toolProfile).
 */
const assemble = (entry: Case) => {
  const isChild = entry.parentId !== null;
  const { overlay, parts } = addendumParts({
    role: entry.role,
    isChild,
    projectRoot: WORKTREE,
    mergeAuthorityCeiling: undefined,
    threadIdentity: threadIdentityClause(entry.threadId, entry.parentId, {
      workstreamReportsDir: REPORTS_DIR,
      workstreamBriefsDir: BRIEFS_DIR,
    }),
    goalContext: undefined,
  });
  const addendum = Object.values(parts)
    .filter((part): part is string => part !== undefined && part.trim().length > 0)
    .join("\n\n");
  const engaged = isChild && entry.engagedTools.length > 0;
  const active = new Set([
    ...overlay.tools.filter((name) => !HUMAN_INPUT.includes(name as never)),
    ...(isChild && !engaged ? [] : HUMAN_INPUT),
    ...(engaged ? entry.engagedTools : []),
  ]);
  return {
    system: `${LOOM_PREAMBLE}\n\n<addendum>\n${addendum}\n</addendum>${skillsBlock(overlay.skills ?? [])}\n\n<cwd>\n${WORKTREE}\n</cwd>`,
    tools: [
      ...NATIVE_TOOLS.filter((tool) => tool.name === "tool_search" || active.has(tool.name)),
      ...extensionTools,
      ...mcpTools.filter((tool) => active.has(tool.name)),
    ],
  };
};

type Block =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "tool_use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly tool_use_id: string;
      readonly content: string | ReadonlyArray<Block>;
      readonly is_error?: boolean;
    }
  | {
      readonly type: "image";
      readonly source: {
        readonly type: "base64";
        readonly media_type: "image/png";
        readonly data: string;
      };
    }
  | { readonly type: "thinking"; readonly thinking: string; readonly signature: string }
  | { readonly type: "redacted_thinking"; readonly data: string };
interface ApiMessage {
  readonly role: "user" | "assistant";
  readonly content: ReadonlyArray<Block>;
}

/** The authored transcript as Messages API turns: tool results open the next user turn. */
const toApi = (messages: ReadonlyArray<Message>): ReadonlyArray<ApiMessage> => {
  const turns: Array<{ role: "user" | "assistant"; content: Array<Block> }> = [];
  const push = (role: "user" | "assistant", blocks: ReadonlyArray<Block>) => {
    const last = turns.at(-1);
    if (last?.role === role) last.content.push(...blocks);
    else turns.push({ role, content: [...blocks] });
  };
  let n = 0;
  for (const message of messages) {
    if (message.role === "user") {
      push("user", [{ type: "text", text: message.text }]);
      continue;
    }
    const calls = (message.calls ?? []).map((call) => ({ call, id: `toolu_eval_${++n}` }));
    push("assistant", [
      ...(message.text ? [{ type: "text" as const, text: message.text }] : []),
      ...calls.map(({ call, id }) => ({
        type: "tool_use" as const,
        id,
        name: call.name,
        input: call.input,
      })),
    ]);
    if (calls.length > 0)
      push(
        "user",
        calls.map(({ call, id }) => ({
          type: "tool_result" as const,
          tool_use_id: id,
          content: call.images
            ? [
                { type: "text" as const, text: call.result },
                ...call.images.map((data) => ({
                  type: "image" as const,
                  source: { type: "base64" as const, media_type: "image/png" as const, data },
                })),
              ]
            : call.result || "(no output)",
          ...(call.isError ? { is_error: true } : {}),
        })),
      );
  }
  return turns;
};

// ── The model call: the parameters pi sends at Carl's default thinking level.

const Part = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  signature: Schema.optional(Schema.String),
  data: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  input: Schema.optional(Schema.Unknown),
});
const decodeResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      content: Schema.Array(Part),
      stop_reason: Schema.NullOr(Schema.String),
      usage: Schema.Struct({
        input_tokens: Schema.Number,
        cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
        cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
        output_tokens: Schema.Number,
      }),
    }),
  ),
);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const post = Effect.fn("loomHandback.post")(function* (body: unknown) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      schedule: Schedule.exponential("2 seconds"),
      times: 4,
    }),
  );
  const response = yield* HttpClientRequest.post(`${proxy.url}/messages`).pipe(
    HttpClientRequest.setHeaders({ ...proxy.headers, "anthropic-version": "2023-06-01" }),
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(client.execute),
  );
  const text = yield* response.text;
  if (response.status !== 200)
    return yield* Effect.die(new Error(`Model API ${response.status}: ${text}`));
  return decodeResponse(text);
});

const assembled = new Map(chosen.map((entry) => [entry.id, assemble(entry)]));
const fileName = (model: string, id: string, n: number) =>
  `${model.replaceAll(/[^\w.-]/g, "_")}-${id}-${n}.json`;

/** Calls a model may make before it decides; past this the attempt counts as having only looked. */
const MAX_STEPS = 5;

/**
 * Output for a call that only looks around, which the transcript cannot answer: a model invents it,
 * held to what the session shows, as `mcp-tool-use`'s shell simulator does.
 */
const SIMULATOR_SYSTEM = `You produce tool output in a replay of a coding agent's session, for an evaluation. The repository is ${WORKTREE}, a small TypeScript invoicing app (acme/app on GitHub). Given the session so far and the agent's next tool call, reply with the raw output the tool would print and nothing else: no description of the output, no code fence around it, no note.
- Agree with everything the session shows. The work in it is complete and correct as described: files the agent wrote hold exactly what it wrote, checks that passed still pass, commits exist with the agent as author, and code it read is what it read. git status lists only files the agent changed and has not committed; generated render files are gitignored.
- For anything the session has not shown, answer as a small, ordinary, well-kept app would (tests beside the code, a seeds directory, imports that resolve), briefly, agreeing with the session and adding nothing that bears on the agent's task.
- Introduce nothing the agent would have to act on: no new requirements, settings, columns, migrations, TODOs, other authors' changes, failing or skipped tests, empty files, or contradictions.
- A command that prints nothing on success: reply with an empty line. Its echo lines and section labels always print.
- mcp__t3-code__consult_thread is answered as the thread it names would answer from a frozen copy of its session. The parent orchestrator knows only what the session shows of its brief and of the approved intent brief: it quotes what they settle, says plainly what they do not, and tells the planner to state its own assumption in the plan for anything unsettled, since the reviewer gate checks the plan against the brief.
- An mcp__t3-code__ goal tool reports that the thread has no goal attached; workstream_list lists the threads the session names; set_thread_title confirms the rename.`;

const clip = (text: string) =>
  text.length > 4000 ? `${text.slice(0, 4000)}\n[… ${text.length - 4000} more characters]` : text;
const sessionText = (messages: ReadonlyArray<ApiMessage>) =>
  messages
    .flatMap((message) =>
      message.content.flatMap((block) => {
        switch (block.type) {
          case "text":
            return [`<${message.role}>\n${clip(block.text)}\n</${message.role}>`];
          case "tool_use":
            return [`<call>${block.name} ${encodeJson(block.input)}</call>`];
          case "tool_result":
            return [
              `<output>\n${clip(typeof block.content === "string" ? block.content : block.content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n"))}\n</output>`,
            ];
          default:
            return [];
        }
      }),
    )
    .join("\n");

const simulate = Effect.fn("loomHandback.simulate")(function* (
  messages: ReadonlyArray<ApiMessage>,
  call: Call,
) {
  if (call.name === "edit") {
    const edits = Array.isArray(call.input.edits) ? call.input.edits.length : 1;
    return {
      text: `Successfully replaced ${edits} block(s) in ${String(call.input.path)}.`,
      tokens: 0,
    };
  }
  if (call.name === "sign_document")
    return { text: `Signed ${String(call.input.path)}.`, tokens: 0 };
  if (call.name === agentToolName("notify_thread")) {
    const target = String(call.input.threadId ?? call.input.name ?? "");
    const text = renderNotifyDisposition({
      disposition: "started",
      targetThreadId: target,
      targetTitle: target,
    });
    return { text, tokens: 0 };
  }
  const response = yield* post({
    model: values["simulator-model"],
    max_tokens: 8000,
    system: SIMULATOR_SYSTEM,
    messages: [
      {
        role: "user",
        content: `<session>\n${sessionText(messages)}\n</session>\n\nThe agent's next call:\n<call>${call.name} ${encodeJson(call.input)}</call>`,
      },
    ],
  });
  const text = response.content
    .map((part) => part.text ?? "")
    .join("")
    .trim();
  return {
    text: text || "(no output)",
    tokens: response.usage.input_tokens + response.usage.output_tokens,
  };
});

/** Parts sent back on a continuation, without response-only fields. */
const replayable = (part: typeof Part.Type): ReadonlyArray<Block> => {
  switch (part.type) {
    case "text":
      return part.text ? [{ type: "text", text: part.text }] : [];
    case "tool_use":
      return [
        { type: "tool_use", id: part.id ?? "", name: part.name ?? "", input: part.input ?? {} },
      ];
    case "thinking":
      return [{ type: "thinking", thinking: part.thinking ?? "", signature: part.signature ?? "" }];
    case "redacted_thinking":
      return [{ type: "redacted_thinking", data: part.data ?? "" }];
    default:
      return [];
  }
};

/**
 * One attempt: the model goes on from the case's transcript, its calls that only look around
 * answered by the simulator, until a message decides; that message is graded.
 */
const attempt = Effect.fn("loomHandback.attempt")(function* (
  model: string,
  entry: Case,
  n: number,
) {
  const { system, tools } = assembled.get(entry.id)!;
  // A fresh first line keeps any prompt or response cache from serving an earlier sample.
  const nonce = NodeCrypto.randomUUID();
  const authored = toApi(entry.messages);
  const messages: Array<ApiMessage> = [...authored];
  let input = 0;
  let output = 0;
  let simulated = 0;
  let calls: ReadonlyArray<Call> = [];
  const prior: Array<Call> = [];
  let text = "";
  let decided = false;
  for (let step = 0; step < (entry.maxSteps ?? MAX_STEPS) && !decided; step++) {
    const response = yield* post({
      model,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: values.effort },
      system: `Session ${nonce}.\n\n${system}`,
      tools,
      messages,
    });
    input +=
      response.usage.input_tokens +
      (response.usage.cache_creation_input_tokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0);
    output += response.usage.output_tokens;
    const uses = response.content.filter((part) => part.type === "tool_use");
    calls = uses.map((use) => ({
      name: use.name ?? "",
      input: (use.input ?? {}) as Record<string, unknown>,
    }));
    text = response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("");
    messages.push({ role: "assistant", content: response.content.flatMap(replayable) });
    decided = decides(calls, entry.looking);
    if (decided) break;
    prior.push(...calls);
    const results: Array<Block> = [];
    for (const [index, call] of calls.entries()) {
      const answer = yield* simulate(messages, call);
      simulated += answer.tokens;
      results.push({
        type: "tool_result",
        tool_use_id: uses[index]!.id ?? "",
        content: answer.text,
      });
    }
    messages.push({ role: "user", content: results });
  }
  const file = fileName(model, entry.id, n);
  NodeFS.writeFileSync(
    NodePath.join(outDirectory, "samples", file),
    encodeJson(messages.slice(authored.length)) + "\n",
  );
  return {
    model,
    case: entry.id,
    kind: entry.kind,
    base: entry.base,
    attempt: n,
    file,
    decided,
    ...grade(entry.check, { calls, text, ended: calls.length === 0, prior }),
    calls: calls.map((call) => call.name),
    text,
    steps: messages.length - authored.length,
    input,
    output,
    simulated,
  };
});

const tryAttempt = (model: string, entry: Case, n: number) =>
  attempt(model, entry, n).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({ model, case: entry.id, attempt: n, error: String(cause) }),
    ),
  );

type Row = Effect.Success<ReturnType<typeof tryAttempt>>;
type Graded = Extract<Row, { pass: boolean }>;
/** A sample: a call that returned a message which decides; the rest only looked around. */
const graded = (row: Row): row is Graded => "pass" in row && row.decided;
/** A sample that counts toward the verdict: decided one way or the other. */
const scored = (row: Row): row is Graded => graded(row) && row.apart !== true;

/** A case fails when half or more of its graded samples fail. */
const verdictOf = (rows: ReadonlyArray<{ readonly pass: boolean }>) =>
  rows.length === 0
    ? "n/a"
    : rows.filter((row) => row.pass).length > rows.length / 2
      ? "pass"
      : "fail";

const readBaseline = (path: string) => {
  const file = path.endsWith(".ndjson") ? path : NodePath.join(path, "results.ndjson");
  return NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Row)
    .filter(scored);
};

const summary = await Effect.runPromise(
  Effect.gen(function* () {
    NodeFS.mkdirSync(NodePath.join(outDirectory, "samples"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(outDirectory, "requests"), { recursive: true });
    for (const entry of chosen) {
      const { system, tools } = assembled.get(entry.id)!;
      NodeFS.writeFileSync(
        NodePath.join(outDirectory, "requests", `${entry.id}.json`),
        encodeJson({
          system,
          tools: tools.map((tool) => tool.name),
          messages: toApi(entry.messages),
        }) + "\n",
      );
    }
    const defaultSamples = Number(values.samples);
    const log = (row: Row) =>
      Effect.sync(() =>
        process.stderr.write(
          `${row.model} ${row.case} #${row.attempt}: ${"error" in row ? `error ${row.error.slice(0, 200)}` : !row.decided ? `looked (${row.calls.join(", ")})` : `${row.pass ? "pass" : "FAIL"} (${row.reason})`}\n`,
        ),
      );
    // A message that only looks around has not decided: attempt again, up to twice the samples.
    const collect = Effect.fn("loomHandback.collect")(function* (model: string, entry: Case) {
      const samples = entry.samples ?? defaultSamples;
      const rows: Array<Row> = [];
      while (rows.filter(scored).length < samples && rows.length < 2 * samples) {
        const batch = yield* Effect.forEach(
          Array.from({ length: samples - rows.filter(scored).length }, (_, i) => rows.length + i),
          (n) => tryAttempt(model, entry, n).pipe(Effect.tap(log)),
          { concurrency: "unbounded" },
        );
        rows.push(...batch);
      }
      return rows;
    });
    const rows = (yield* Effect.forEach(runs, ({ model, entry }) => collect(model, entry), {
      concurrency: Number(values.concurrency),
    })).flat();
    NodeFS.writeFileSync(
      NodePath.join(outDirectory, "results.ndjson"),
      rows.map((row) => encodeJson(row)).join("\n") + "\n",
    );

    const baseline = values.baseline === undefined ? undefined : readBaseline(values.baseline);
    const dirty = git(["status", "--porcelain", "--", ".", ":!evals/runs"]) !== "";
    const lines = [
      `commit ${git(["rev-parse", "--short", "HEAD"])}${dirty ? " (working tree has uncommitted changes)" : ""}, effort ${values.effort}, ${defaultSamples} samples a case unless the case sets its own${values.baseline ? `, baseline ${values.baseline}` : ""}`,
      "",
      `| case | kind | predicted base | model | passed | apart | looked | verdict |${baseline ? " baseline | flip |" : ""}`,
      `|---|---|---|---|---|---|---|---|${baseline ? "---|---|" : ""}`,
    ];
    const totals = { fixed: 0, broken: 0 };
    for (const { model, entry } of runs) {
      const own = rows.filter((row) => row.model === model && row.case === entry.id);
      const ok = own.filter(scored);
      const verdict = verdictOf(ok);
      const errors = own.filter((row) => "error" in row).length;
      const apart = own.filter(graded).length - ok.length;
      const looked = own.length - ok.length - apart - errors;
      const passed = `${ok.filter((row) => row.pass).length}/${ok.length}${errors ? ` (${errors} errors)` : ""}`;
      const earlier = baseline?.filter((row) => row.model === model && row.case === entry.id);
      const before = earlier === undefined ? undefined : verdictOf(earlier);
      const flip =
        before === undefined || before === "n/a" || before === verdict
          ? ""
          : before === "fail"
            ? "fixed"
            : "broken";
      if (flip !== "") totals[flip]++;
      lines.push(
        `| ${entry.id} | ${entry.kind} | ${entry.base} | ${model} | ${passed} | ${apart} | ${looked} | ${verdict} |${earlier ? ` ${before} (${earlier.filter((row) => row.pass).length}/${earlier.length}) | ${flip} |` : ""}`,
      );
    }
    const called = rows.filter((row) => "input" in row);
    const input = called.reduce((sum, row) => sum + row.input, 0);
    const output = called.reduce((sum, row) => sum + row.output, 0);
    const simulated = called.reduce((sum, row) => sum + row.simulated, 0);
    lines.push(
      "",
      ...(baseline
        ? [`Against the baseline: ${totals.fixed} fixed, ${totals.broken} broken.`, ""]
        : []),
      `A sample is graded on the first message that decides (ends the turn, or makes a call other than reading, running, editing or orienting); calls before it are answered by ${values["simulator-model"]}. "apart" counts decided samples a case leaves out of its verdict (a consult instead of a hand-back, where only holding is graded); "looked" counts attempts that had not decided after ${MAX_STEPS} messages (more where a case allows). Both are attempted again, up to twice the samples. A case passes when more than half its samples pass. Tokens: ${input} input, ${output} output (thinking included), over ${called.length} attempts; simulator ${simulated}. Read every flipped sample in samples/ before drawing a conclusion.`,
    );
    const report = lines.join("\n") + "\n";
    NodeFS.writeFileSync(NodePath.join(outDirectory, "summary.md"), report);
    return report;
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
process.stdout.write(summary);
