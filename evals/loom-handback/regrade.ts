#!/usr/bin/env node
// An eval script: it reads a run's files directly.
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Grades a finished run again with this checkout's grader, from the samples it saved: for a grader
 * fix found after the run. A sample this grader would not have stopped at, or of a case since
 * deleted, is left out.
 * Usage: pnpm loom-handback:regrade runs/<name> [runs/<baseline>]
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { cases } from "./cases.ts";
import { type Call, decides, grade } from "./grade.ts";

interface Row {
  readonly model: string;
  readonly case: string;
  readonly file?: string;
  readonly decided?: boolean;
  readonly pass?: boolean;
  readonly apart?: boolean;
  readonly text?: string;
}
interface Block {
  readonly type: string;
  readonly name?: string;
  readonly input?: Record<string, unknown>;
}

const regrade = (dir: string) =>
  NodeFS.readFileSync(NodePath.join(dir, "results.ndjson"), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Row)
    .flatMap((row) => {
      const entry = cases.find((candidate) => candidate.id === row.case);
      return row.decided === true && row.file !== undefined && entry !== undefined
        ? [{ row, entry }]
        : [];
    })
    .map(({ row, entry }) => {
      const messages = JSON.parse(
        NodeFS.readFileSync(NodePath.join(dir, "samples", row.file!), "utf8"),
      ) as ReadonlyArray<{ readonly role: string; readonly content: ReadonlyArray<Block> }>;
      const callsOf = (content: ReadonlyArray<Block>): ReadonlyArray<Call> =>
        content
          .filter((block) => block.type === "tool_use")
          .map((block) => ({ name: block.name ?? "", input: block.input ?? {} }));
      const assistant = messages.filter((message) => message.role === "assistant");
      const calls = callsOf(assistant.at(-1)?.content ?? []);
      if (!decides(calls, entry.looking)) return { ...row, pass: false, apart: true };
      const graded = grade(entry.check, {
        calls,
        text: row.text ?? "",
        ended: calls.length === 0,
        prior: assistant.slice(0, -1).flatMap((message) => callsOf(message.content)),
        looking: entry.looking ?? [],
      });
      return { ...row, ...graded, apart: graded.apart === true };
    });

const tally = (rows: ReadonlyArray<Row>, model: string, id: string) => {
  const own = rows.filter((row) => row.model === model && row.case === id && row.apart !== true);
  const passed = own.filter((row) => row.pass).length;
  return {
    passed,
    total: own.length,
    verdict: own.length === 0 ? "n/a" : passed > own.length / 2 ? "pass" : "fail",
  };
};

const [run, baseline] = process.argv.slice(2);
if (run === undefined) throw new Error("Usage: regrade.ts <run dir> [baseline run dir]");
const rows = regrade(run);
const before = baseline === undefined ? undefined : regrade(baseline);
const pairs = [...new Set(rows.map((row) => `${row.model}\t${row.case}`))].map((key) =>
  key.split("\t"),
);
const lines = [
  `Regraded ${run} with this checkout's grader${baseline ? `, baseline ${baseline} regraded too` : ""}.`,
  "",
  `| case | model | passed | verdict |${before ? " baseline | flip |" : ""}`,
  `|---|---|---|---|${before ? "---|---|" : ""}`,
  ...pairs.map(([model, id]) => {
    const now = tally(rows, model!, id!);
    const then = before && tally(before, model!, id!);
    const flip =
      then === undefined || then.verdict === "n/a" || then.verdict === now.verdict
        ? ""
        : then.verdict === "fail"
          ? "fixed"
          : "broken";
    return `| ${id} | ${model} | ${now.passed}/${now.total} | ${now.verdict} |${then ? ` ${then.verdict} (${then.passed}/${then.total}) | ${flip} |` : ""}`;
  }),
];
NodeFS.writeFileSync(
  NodePath.join(run, "results.regraded.ndjson"),
  rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
);
NodeFS.writeFileSync(NodePath.join(run, "summary.regraded.md"), lines.join("\n") + "\n");
process.stdout.write(lines.join("\n") + "\n");
