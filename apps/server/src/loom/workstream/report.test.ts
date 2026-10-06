import { ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import { synthesisedReportFileName } from "./report.ts";

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
