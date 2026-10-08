import type { OrchestrationV2Run } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";

import { insertModelChangeRows, type ModelChangeRun, modelChangeRows } from "./modelChangeRows";

const run = (
  ordinal: number,
  instanceId: string,
  model: string,
  options?: OrchestrationV2Run["modelSelection"]["options"],
) =>
  ({
    id: `run-${ordinal}`,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model, ...(options ? { options } : {}) },
    userMessageId: `message-${ordinal}`,
    requestedAt: DateTime.makeUnsafe(Date.UTC(2026, 9, 7, 12, ordinal)),
  }) as unknown as ModelChangeRun;

const changes = (runs: ReadonlyArray<ModelChangeRun>) =>
  modelChangeRows(runs).map((row) => [row.messageId, row.fromModel, row.toModel]);

describe("modelChangeRows", () => {
  it("rows a model change on the same instance, never the first run", () => {
    expect(
      changes([
        run(1, "pi", "cliproxy/claude-opus-5"),
        run(2, "pi", "cliproxy/claude-opus-5"),
        run(3, "pi", "cliproxy/claude-opus-5-5"),
      ]),
    ).toEqual([["message-3", "cliproxy/claude-opus-5", "cliproxy/claude-opus-5-5"]]);
    expect(changes([run(1, "pi", "cliproxy/claude-opus-5")])).toEqual([]);
  });

  it("leaves an instance change to the context-handoff row", () => {
    expect(changes([run(1, "codex", "gpt-5.6-sol"), run(2, "pi", "claude-fable-5")])).toEqual([]);
  });

  it("ignores a thinking-level-only change", () => {
    expect(
      changes([
        run(1, "pi", "claude-opus-5", [{ id: "thinking", value: "low" }]),
        run(2, "pi", "claude-opus-5", [{ id: "thinking", value: "high" }]),
      ]),
    ).toEqual([]);
  });

  it("compares runs in ordinal order", () => {
    expect(changes([run(2, "pi", "b"), run(1, "pi", "a"), run(3, "pi", "a")])).toEqual([
      ["message-2", "a", "b"],
      ["message-3", "b", "a"],
    ]);
  });

  it("lands immediately before the run's user message, and nowhere when it is not shown", () => {
    const runs = [run(1, "pi", "a"), run(2, "pi", "b"), run(3, "pi", "c")];
    const message = (id: string) => ({ kind: "message", id }) as unknown as MessagesTimelineRow;
    const work = { kind: "work", id: "message-2-work" } as unknown as MessagesTimelineRow;
    expect(
      insertModelChangeRows([message("message-1"), work, message("message-2")], runs).map(
        (row) => row.id,
      ),
    ).toEqual(["message-1", "message-2-work", "loom-model-change:run-2", "message-2"]);
  });
});
