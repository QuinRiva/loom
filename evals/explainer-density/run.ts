#!/usr/bin/env node
// An eval script, not server code: it shells out to git and reads files directly.
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
import { proxyConfig } from "../shared/proxy.ts";
import { cases } from "./cases.ts";
import { grade, type Grade } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "claude-fable-5-1" },
    "skills-ref": { type: "string", multiple: true },
    samples: { type: "string", default: "5" },
    concurrency: { type: "string", default: "5" },
    effort: { type: "string", default: "high" },
  },
});
if (!values.out || !values["skills-ref"])
  throw new Error("Use --out <directory> --skills-ref <ref> [--skills-ref <ref> ...].");
const outDirectory = values.out;
const repo = NodePath.resolve(import.meta.dirname, "../..");
const skillFiles = [
  "skills/mdx-visual-explainer/SKILL.md",
  "skills/mdx-doc-core/references/document-quality.md",
  "skills/mdx-doc-core/references/exemplar.md",
];

// Loom's own Claude pool (pi's `cliproxy` provider) where it exists, so the model is reached
// exactly as Carl's sessions reach it; otherwise the shared `vibeproxy` route.
const localKey = NodePath.join(NodeOS.homedir(), "cli-proxy/.apikey");
const proxy = NodeFS.existsSync(localKey)
  ? {
      url: "http://localhost:8317/v1",
      headers: { Authorization: `Bearer ${NodeFS.readFileSync(localKey, "utf8").trim()}` },
    }
  : proxyConfig();

const git = (args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

/** One arm per `--skills-ref`; a repeated ref is a second run of that arm, the noise floor. */
const arms = values["skills-ref"].map((ref, index, all) => {
  const repeat = all.slice(0, index).filter((earlier) => earlier === ref).length;
  const sha = git(["rev-parse", "--short", ref]);
  const body = skillFiles
    .map((path) => `<skill_file path="${path}">\n${git(["show", `${sha}:${path}`])}\n</skill_file>`)
    .join("\n\n");
  return {
    name: repeat ? `${ref}#${repeat + 1}` : ref,
    sha,
    system: [
      "You are a coding agent. The maintainer, Carl, reads the documents you write in an MDX document panel.",
      "You have loaded these skill files and follow them.",
      "",
      body,
    ].join("\n"),
  };
});

const decodeResponse = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      content: Schema.Array(
        Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
      ),
      // The proxy marks the system prompt for caching, so input arrives split three ways.
      usage: Schema.Struct({
        input_tokens: Schema.Number,
        cache_creation_input_tokens: Schema.optional(Schema.Number),
        cache_read_input_tokens: Schema.optional(Schema.Number),
        output_tokens: Schema.Number,
      }),
    }),
  ),
);
const encodeRow = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

// The parameters pi sends this model at Carl's default thinking level.
const post = Effect.fn("explainerDensity.post")(function* (system: string, prompt: string) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      schedule: Schedule.exponential("2 seconds"),
      times: 4,
    }),
  );
  const response = yield* HttpClientRequest.post(`${proxy.url}/messages`).pipe(
    HttpClientRequest.setHeaders({ ...proxy.headers, "anthropic-version": "2023-06-01" }),
    HttpClientRequest.bodyJson({
      model: values.model,
      max_tokens: 32000,
      thinking: { type: "adaptive" },
      output_config: { effort: values.effort },
      system,
      messages: [{ role: "user", content: prompt }],
    }),
    Effect.flatMap(client.execute),
  );
  const text = yield* response.text;
  if (response.status !== 200)
    return yield* Effect.die(new Error(`Model API ${response.status}: ${text}`));
  return decodeResponse(text);
});

/** The reply is the section; an agent sometimes fences it, which the panel would not. */
const unfence = (reply: string) =>
  reply.trim().replace(/^```(?:mdx|markdown|md)?\n([\s\S]*?)\n```$/, "$1");

const runSample = Effect.fn("explainerDensity.sample")(function* (
  arm: (typeof arms)[number],
  entry: (typeof cases)[number],
  n: number,
) {
  // A fresh first line keeps any prompt or response cache from serving an earlier sample.
  const nonce = NodeCrypto.randomUUID();
  const response = yield* post(`Session ${nonce}.\n\n${arm.system}`, entry.prompt);
  const mdx = unfence(
    response.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join(""),
  );
  const file = `${arm.name.replaceAll(/[^\w.-]/g, "_")}-${entry.id}-${n}.mdx`;
  NodeFS.writeFileSync(NodePath.join(outDirectory, "samples", file), mdx + "\n");
  return {
    arm: arm.name,
    sha: arm.sha,
    case: entry.id,
    sample: n,
    file,
    ...grade(mdx),
    input:
      response.usage.input_tokens +
      (response.usage.cache_creation_input_tokens ?? 0) +
      (response.usage.cache_read_input_tokens ?? 0),
    output: response.usage.output_tokens,
  };
});

const sample = (arm: (typeof arms)[number], entry: (typeof cases)[number], n: number) =>
  runSample(arm, entry, n).pipe(
    Effect.catchCause((cause) =>
      Effect.succeed({ arm: arm.name, case: entry.id, sample: n, error: String(cause) }),
    ),
  );

type Row = Effect.Success<ReturnType<typeof sample>>;
const graded = (row: Row): row is Extract<Row, Grade> => "meanSentence" in row;

const mean = (numbers: ReadonlyArray<number>) =>
  numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : 0;

const summary = await Effect.runPromise(
  Effect.gen(function* () {
    NodeFS.mkdirSync(NodePath.join(outDirectory, "samples"), { recursive: true });
    const samples = Number(values.samples);
    const rows = yield* Effect.forEach(
      arms.flatMap((arm) =>
        cases.flatMap((entry) => Array.from({ length: samples }, (_, n) => ({ arm, entry, n }))),
      ),
      ({ arm, entry, n }) => sample(arm, entry, n),
      { concurrency: Number(values.concurrency) },
    );
    NodeFS.writeFileSync(
      NodePath.join(outDirectory, "results.ndjson"),
      rows.map((row) => encodeRow(row)).join("\n") + "\n",
    );

    const lines = [
      `model ${values.model}, effort ${values.effort}, ${samples} samples per arm, cases ${cases.map((entry) => entry.id).join(", ")}`,
      "",
      "| arm | sha | mean sentence (per-output means) | sentences > 30 | paragraphs > 100 | bracketed citations | sidenotes | em-dashes | verdict | table | labelled | words | errors |",
      "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ];
    for (const arm of arms) {
      const own = rows.filter((row) => row.arm === arm.name);
      const ok = own.filter(graded);
      const sum = (
        key: "longSentences" | "longParagraphs" | "bracketedCitations" | "sidenotes" | "emDashes",
      ) => ok.reduce((total, row) => total + row[key], 0);
      const count = (key: "verdict" | "table" | "labelled") =>
        `${ok.filter((row) => row[key]).length}/${ok.length}`;
      lines.push(
        `| ${arm.name} | ${arm.sha} | ${mean(ok.map((row) => row.meanSentence)).toFixed(1)} (${ok.map((row) => row.meanSentence.toFixed(1)).join(", ")}) | ${sum("longSentences")} | ${sum("longParagraphs")} | ${sum("bracketedCitations")} | ${sum("sidenotes")} | ${sum("emDashes")} | ${count("verdict")} | ${count("table")} | ${count("labelled")} | ${Math.round(mean(ok.map((row) => row.words)))} | ${own.length - ok.length} |`,
      );
    }
    const all = rows.filter(graded);
    const input = all.reduce((sum, row) => sum + row.input, 0);
    const output = all.reduce((sum, row) => sum + row.output, 0);
    lines.push(
      "",
      `Counts are sums over each arm's outputs. Tokens: ${input} input, ${output} output (thinking included), ${input + output} total.`,
    );
    const report = lines.join("\n") + "\n";
    NodeFS.writeFileSync(NodePath.join(outDirectory, "summary.md"), report);
    return report;
  }).pipe(Effect.provide(FetchHttpClient.layer)),
);
process.stdout.write(summary);
