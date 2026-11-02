// @effect-diagnostics nodeBuiltinImport:off - the empty session is written to a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { reportFromSession } from "./contextUsageReport.ts";

describe("contextFindings", () => {
  it("fires the three rules on the identity fixture", async () => {
    const report = (await reportFromSession(
      NodePath.join(import.meta.dirname, "fixtures", "identity.jsonl"),
    ))!;
    expect(
      report.findings.map(({ rule, tokens, avoidableTokens, itemIds }) => ({
        rule,
        tokens,
        avoidableTokens,
        itemIds,
      })),
    ).toEqual([
      // t7's 150-token reply is the floor every echo is measured against.
      { rule: "write_tool_echo", tokens: 3000, avoidableTokens: 2850, itemIds: ["t2"] },
      {
        rule: "unused_tool_schemas",
        tokens: expect.any(Number),
        avoidableTokens: expect.any(Number),
        itemIds: ["e001:demo_schedule_task"],
      },
      { rule: "whole_file_read", tokens: 3500, avoidableTokens: 3500, itemIds: ["t6"] },
    ]);
    expect(report.items.filter((item) => item.wholeFile).map((item) => item.id)).toEqual(["t6"]);
  });

  it("finds nothing in an empty session", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "context-viz-"));
    const path = NodePath.join(dir, "empty.jsonl");
    NodeFS.writeFileSync(path, '{"type":"session","version":3,"id":"x","cwd":"/work"}\n');
    expect(await reportFromSession(path)).toMatchObject({
      calls: [],
      items: [],
      findings: [],
      model: null,
    });
  });
});
