// The join on real data: the 58-turn orchestrator's report (P1's reader over its session file,
// labels scrubbed) against that thread's own timeline items.
import { LoomContextReport, type RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { buildContextJoin, type ContextJoinThread } from "./join";
import timelineJson from "./join.fixture.json";
import reportJson from "./preview/report.fixture.json";

const report = Schema.decodeUnknownSync(LoomContextReport)(reportJson);
const timeline = timelineJson as unknown as {
  runs: ReadonlyArray<[string, string]>;
  attempts: ReadonlyArray<[string, string]>;
  providerTurns: ReadonlyArray<[string, string, string, string]>;
  turnItems: ReadonlyArray<[string, string, string, number, string]>;
};
const thread = {
  runs: timeline.runs.map(([id, userMessageId]) => ({ id, userMessageId })),
  attempts: timeline.attempts.map(([id, runId]) => ({ id, runId })),
  providerTurns: timeline.providerTurns.map(([id, runAttemptId, startedAt, completedAt]) => ({
    id,
    runAttemptId,
    startedAt: DateTime.makeUnsafe(startedAt),
    completedAt: DateTime.makeUnsafe(completedAt),
  })),
  turnItems: timeline.turnItems.map(([type, runId, providerTurnId, ordinal, nativeId]) => ({
    type,
    runId,
    providerTurnId,
    ordinal,
    nativeItemRef: { nativeId },
  })),
} as unknown as ContextJoinThread;
const join = buildContextJoin(report, thread);
const isTool = ([type]: (typeof timeline.turnItems)[number]) =>
  type !== "assistant_message" && type !== "reasoning";

describe("buildContextJoin on the fixture thread", () => {
  it("gives every tool row its exact result", () => {
    const tools = timeline.turnItems.filter(isTool);
    expect(tools).toHaveLength(184);
    for (const [, , , , nativeId] of tools) {
      expect(join.byNativeId.get(nativeId)?.kind).toBe("tool_result");
    }
  });

  it("joins prose and thinking by ordinal, withholding rather than guessing", () => {
    const prose = timeline.turnItems.filter((row) => !isTool(row));
    const joined = prose.filter(([, , , , nativeId]) => join.byNativeId.has(nativeId));
    expect(prose).toHaveLength(172);
    expect({ joined: joined.length, withheld: join.withheldProse }).toEqual({
      joined: 171,
      withheld: 0,
    });
    // Call 0's thinking is reported exactly (its `reasoning` usage), so the ordinal join is checked
    // against a measured number, not only a consistent one.
    expect(join.byNativeId.get("turn-1:m1:c0")).toMatchObject({
      kind: "assistant_thinking",
      tokens: 874,
      measured: true,
    });
  });

  it("withholds a turn's prose when its ordinals stop lining up, and keeps its tool rows", () => {
    // As if a steer added an assistant message Loom never saw: every ordinal in turn 1 moves by one.
    const shifted = {
      ...thread,
      turnItems: thread.turnItems.map((item) => {
        const nativeId = item.nativeItemRef?.nativeId ?? "";
        const match = /^turn-1:m(\d+):(c\d+)$/.exec(nativeId);
        return match
          ? {
              ...item,
              nativeItemRef: {
                ...item.nativeItemRef!,
                nativeId: `turn-1:m${Number(match[1]) + 1}:${match[2]}`,
              },
            }
          : item;
      }),
    } as ContextJoinThread;
    const turn1 = shifted.turnItems.filter((item) => item.providerTurnId === "turn-1");
    const isProse = (item: (typeof turn1)[number]) =>
      item.type === "assistant_message" || item.type === "reasoning";
    const prose = turn1.filter(isProse);
    const shiftedJoin = buildContextJoin(report, shifted);
    expect(shiftedJoin.withheldProse).toBe(prose.length);
    for (const item of prose)
      expect(shiftedJoin.byNativeId.has(item.nativeItemRef!.nativeId!)).toBe(false);
    for (const item of turn1.filter((row) => !isProse(row)))
      expect(shiftedJoin.byNativeId.get(item.nativeItemRef!.nativeId!)?.kind).toBe("tool_result");
  });

  it("gives each run its calls, window span and opening message", () => {
    expect(join.runs.size).toBe(58);
    const calls = [...join.runs.values()].flatMap((run) => run.calls);
    expect(new Set(calls).size).toBe(calls.length);
    expect(calls).toHaveLength(report.calls.length);
    const first = join.runs.get("run-1" as RunId)!;
    expect(first.startCtx).toBe(0);
    expect(join.byUserMessageId.get("message-1")).toMatchObject({ userKind: "agent_brief" });
    // The mockup's "Worked for" header on turn 52 reads +34.6K.
    expect(join.runs.get("run-52" as RunId)!.addedTokens).toBeCloseTo(34_600, -2);
  });

  it("accounts for every token a run added in its items", () => {
    const latest = report.calls.at(-1)!;
    for (const run of join.runs.values()) {
      const items = run.items.reduce((sum, item) => sum + item.tokens, 0);
      const pending = run.calls.includes(latest.index) ? latest.output : 0;
      expect(items + pending).toBe(run.addedTokens);
    }
  });
});
