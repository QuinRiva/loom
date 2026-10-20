import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { LEGACY_REPORT_HEAD_LIMIT, reportResponse, synthesisedReportFileName } from "./report.ts";

const block = (text: string) => `<!-- response -->\n${text}\n<!-- /response -->`;

describe("reportResponse", () => {
  it("relays the first non-empty block verbatim, trimmed", () => {
    assert.deepEqual(reportResponse(`${block("  The gist.  ")}\n\n## Detail\n${block("second")}`), {
      text: "The gist.",
      source: "block",
      truncated: false,
    });
  });

  it("matches a block inside a code fence: the guard covers the pathological case", () => {
    assert.equal(reportResponse(`\`\`\`\n${block("fenced")}\n\`\`\``).text, "fenced");
  });

  it("falls back to the head cut without a block, or with an empty one", () => {
    const long = "x".repeat(LEGACY_REPORT_HEAD_LIMIT + 50);
    for (const report of [long, `<!-- response --> <!-- /response -->\n${long}`])
      assert.deepEqual(reportResponse(report), {
        text: `${report.trim().slice(0, LEGACY_REPORT_HEAD_LIMIT)}…`,
        source: "head",
        truncated: true,
      });
    assert.deepEqual(reportResponse("  short  "), {
      text: "short",
      source: "head",
      truncated: false,
    });
  });

  it("cuts a block past the 4,000-character guard", () => {
    const response = reportResponse(block("y".repeat(4_050)));
    assert.equal(response.text, `${"y".repeat(4_000)}…`);
    assert.isTrue(response.truncated);
    assert.equal(response.source, "block");
  });
});

describe("synthesisedReportFileName", () => {
  it("keeps a spawned child's quiescent report name under the 255-byte filename limit (DL-470)", () => {
    // The real ids from the Phase 3 smoke: an MCP-scaffolded child and its V2 run id.
    const threadId = ThreadId.make(
      "thread:mcp:6f9beece-7c35-4437-95ef-a90f2a2f700c:workstream-scaffold:33a5daaf-a8e5-4e7a-94b3-6be0793f5ace:0",
    );
    const runId = `run:thread:${encodeURIComponent(threadId)}:ordinal:2`;
    const name = synthesisedReportFileName(threadId, runId);
    assert.equal(
      name,
      "thread_mcp_6f9beece-7c35-4437-95ef-a90f2a2f700c_workstream-scaffold_33a5daaf-a8e5-4e7a-94b3-6be0793f5ace_0.quiescent-ordinal_2.md",
    );
    assert.isAtMost(Buffer.byteLength(name), 255);
  });

  it("keeps a run id that does not embed the thread id whole", () => {
    assert.equal(
      synthesisedReportFileName(ThreadId.make("quiet-x"), "run-1"),
      "quiet-x.quiescent-run-1.md",
    );
  });
});
