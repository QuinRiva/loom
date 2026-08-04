import * as NodeEvents from "node:events";

import { describe, expect, it } from "vite-plus/test";

import type { PiRpcProcess, PiRpcStdoutMessage } from "../provider/Layers/Pi/RpcProcess.ts";
import { buildPiRpcArgs } from "../provider/Layers/Pi/RpcProcess.ts";
import {
  collectAnswer,
  composeConsultTurn,
  envWithoutWorkstream,
  readonlyForkTools,
} from "./workstreamAsk.ts";

/**
 * A scriptable stand-in for a `PiRpcProcess` that replays a sequence of stdout
 * messages to `collectAnswer`'s subscriber, then optionally exits. Only the
 * surface `collectAnswer` touches (`subscribe`, `child.once('exit')`,
 * `stderrTail`) is implemented.
 */
const fakeProc = (
  script: ReadonlyArray<PiRpcStdoutMessage>,
  options: { readonly stderr?: string; readonly exitAfter?: boolean } = {},
): PiRpcProcess => {
  const child = new NodeEvents.EventEmitter() as PiRpcProcess["child"];
  const listeners = new Set<(message: PiRpcStdoutMessage) => void>();
  const proc = {
    child,
    stderrTail: () => options.stderr ?? "",
    subscribe: (listener: (message: PiRpcStdoutMessage) => void) => {
      listeners.add(listener);
      // Drive the script on the next tick so the subscription is in place.
      queueMicrotask(() => {
        for (const message of script) for (const l of listeners) l(message);
        if (options.exitAfter) child.emit("exit", 0, null);
      });
      return () => listeners.delete(listener);
    },
  } as unknown as PiRpcProcess;
  return proc;
};

const textTurn = (text: string): ReadonlyArray<PiRpcStdoutMessage> => [
  { type: "message_start", message: { role: "assistant" } },
  {
    type: "message_update",
    message: { role: "assistant" },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
  },
  { type: "message_end", message: { role: "assistant" } },
  { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] },
];

describe("collectAnswer empty/error handling (consult_thread un-resumable target)", () => {
  it("resolves with the assistant answer on a normal turn", async () => {
    const answer = await collectAnswer(fakeProc(textTurn("the answer")), 1_000);
    expect(answer).toBe("the answer");
  });

  it("rejects with an in-band error detail when the fork's turn stops with an error", async () => {
    const script: ReadonlyArray<PiRpcStdoutMessage> = [
      {
        type: "agent_end",
        messages: [
          {
            role: "assistant",
            stopReason: "error",
            errorMessage: "messages.0: cannot replay codex tool result",
          },
        ],
      },
    ];
    await expect(collectAnswer(fakeProc(script), 1_000)).rejects.toThrow(
      /cannot fork\/replay target session: messages\.0: cannot replay codex tool result/,
    );
  });

  it("rejects when the turn ends with no assistant text (silent empty success)", async () => {
    const script: ReadonlyArray<PiRpcStdoutMessage> = [
      { type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] },
    ];
    await expect(
      collectAnswer(fakeProc(script, { stderr: "replay failed" }), 1_000),
    ).rejects.toThrow(/cannot fork\/replay target session:.*no answer[\s\S]*replay failed/);
  });

  it("rejects a whitespace-only answer", async () => {
    await expect(collectAnswer(fakeProc(textTurn("   \n  ")), 1_000)).rejects.toThrow(
      /cannot fork\/replay target session/,
    );
  });

  it("ignores an intermediate errored agent_end (willRetry) and resolves with the retried answer", async () => {
    // pi's built-in auto-retry: a transient provider error ends the first run
    // with `willRetry: true`, then pi re-runs the agent and the final run
    // produces the real answer. The intermediate errored end must NOT fail the
    // consult.
    const script: ReadonlyArray<PiRpcStdoutMessage> = [
      {
        type: "agent_end",
        willRetry: true,
        messages: [{ role: "assistant", stopReason: "error", errorMessage: "transient 529" }],
      },
      ...textTurn("the retried answer"),
    ];
    const answer = await collectAnswer(fakeProc(script), 1_000);
    expect(answer).toBe("the retried answer");
  });
});

// The consult read-only guarantee is structural: the fork is launched with
// no workstream extension and no `T3_WORKSTREAM_*` env, and with a read-only tool
// surface. These cover the two invariants that don't need a live pi process.
describe("consult_thread read-only invariants", () => {
  it("strips every T3_WORKSTREAM_* key from the fork env, keeping the rest", () => {
    const stripped = envWithoutWorkstream({
      PATH: "/usr/bin",
      T3_WORKSTREAM_ENDPOINT: "http://x",
      T3_WORKSTREAM_AUTHORIZATION: "Bearer secret",
      HOME: "/home/u",
    });
    expect(stripped).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
    expect(Object.keys(stripped).some((key) => key.startsWith("T3_WORKSTREAM_"))).toBe(false);
  });

  it("builds a read-only fork invocation: --fork + read-only --tools, and NO extension", () => {
    const args = buildPiRpcArgs({
      binaryPath: "pi-test-binary",
      platform: "linux",
      forkFrom: "target-session-id",
      sessionId: "fresh-fork-id",
      tools: readonlyForkTools(),
      appendSystemPrompt: "read-only oracle",
      // No `extensions` — the fork cannot load the workstream MCP tools.
    });
    expect(args).toContain("--mode");
    expect(args).toContain("rpc");
    expect(args).toEqual(expect.arrayContaining(["--fork", "target-session-id"]));
    expect(args).toEqual(expect.arrayContaining(["--session-id", "fresh-fork-id"]));
    expect(args).toEqual(expect.arrayContaining(["--tools", "read,grep,find,ls"]));
    expect(args).not.toContain("--extension");
  });

  it("read-only tools are exactly read,grep,find,ls (no bash/edit/write)", () => {
    expect(readonlyForkTools()).toEqual(["read", "grep", "find", "ls"]);
  });
});

// CAPABILITY: at the moment it answers, the fork knows it is a frozen read-only
// snapshot being asked a question by a peer. The framing rides the QUESTION TURN
// (recency beats 100+ replayed turns that DID have bash/edit/write; and the
// prefix stays byte-identical across consults of the same target).
describe("consult framing (composeConsultTurn)", () => {
  const turn = composeConsultTurn({
    asker: "thread «Receipt dedup» (reviewer, thread-asker; one of your sub-threads)",
    question: "Why did you drop the merge-by-hash approach?",
  });

  it("names the asker and the consult_thread mechanism", () => {
    expect(turn).toContain(
      "thread «Receipt dedup» (reviewer, thread-asker; one of your sub-threads)",
    );
    expect(turn).toContain("consult_thread");
  });

  it("states the frozen, non-mutating, discarded-fork facts", () => {
    expect(turn).toMatch(/read-only fork/);
    expect(turn).toMatch(/frozen at its last turn/);
    expect(turn).toMatch(/original thread is untouched/);
    expect(turn).toMatch(/discarded once you have answered/);
  });

  it("names the read-only tools it still has and the tools it has lost", () => {
    expect(turn).toContain("read, grep, find, ls");
    expect(turn).toMatch(/bash, edit, write and workstream tools .* are gone/);
    expect(turn).toMatch(/do not narrate work/);
    // Not helpless: it may still read, but remembered paths are historical.
    expect(turn).toMatch(/may still read a file/);
    expect(turn).toMatch(/historical/);
  });

  it('licenses "this session does not resolve that" as a useful answer', () => {
    expect(turn).toContain("this session does not resolve that");
    expect(turn).toMatch(/useful answer, not a failure/);
  });

  it("carries the question verbatim, last-word position aside", () => {
    expect(turn).toContain("Why did you drop the merge-by-hash approach?");
  });

  it("falls back to a neutral asker when the call site supplies none", () => {
    const anonymous = composeConsultTurn({ question: "What is the schema?" });
    expect(anonymous).toContain("Consult from a peer thread");
    expect(anonymous).toContain("What is the schema?");
  });
});
