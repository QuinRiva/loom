import { assert, describe, it } from "@effect/vitest";

import { piThreadForkPath } from "./piThreadForkCut.loom.ts";

const line = (id: string, parentId: string | null, message: object) =>
  JSON.stringify({ type: "message", id, parentId, message });
const result = (id: string, parentId: string, toolName: string, text: string) =>
  line(id, parentId, { role: "toolResult", toolName, content: [{ type: "text", text }] });

const session = [
  JSON.stringify({ type: "session", id: "source" }),
  line("u1", null, { role: "user", content: "the codeword is heron" }),
  line("a1", "u1", { role: "assistant", content: [{ type: "toolCall" }, { type: "toolCall" }] }),
  result(
    "r1",
    "a1",
    "mcp__t3-code__thread_fork",
    "Forked this thread into staged session thread:fork-1 (x).",
  ),
  result("r2", "r1", "bash", "sibling result"),
  line("a2", "r2", { role: "assistant", content: "after the fork" }),
  '{"type":"message","id":"partial',
].join("\n");

describe("piThreadForkPath", () => {
  it("ends at the tool batch holding the fork's own thread_fork result", () => {
    assert.deepEqual(
      piThreadForkPath(session, "thread:fork-1")?.map((entry) => JSON.parse(entry).id),
      ["u1", "a1", "r1", "r2"],
    );
  });

  it("leaves any other fork to upstream's cut", () => {
    assert.isUndefined(piThreadForkPath(session, "thread:fork-2"));
  });
});
