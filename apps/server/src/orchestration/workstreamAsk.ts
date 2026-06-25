/**
 * workstreamAsk - the `ask_thread` frozen-oracle mechanism.
 *
 * Answers a question from a READ-ONLY fork of a target workstream thread's pi
 * session, without resuming or mutating the target. Mirrors `consult_manager`:
 * a throwaway `pi --mode rpc` process forks the target's frozen session
 * (`--fork <targetSessionId> --session-id <freshId>`), runs ONE turn, and is
 * discarded. The read-only guarantee is structural, not prompt-based:
 *
 *  - the fork is a SEPARATE session file (pi's `forkFrom` never touches the
 *    source), so the target is byte-for-byte unchanged and never re-activated;
 *  - the fork is launched WITHOUT the workstream extension or any
 *    `T3_WORKSTREAM_*` env, so it physically cannot dispatch/spawn/mutate
 *    orchestration;
 *  - the fork's tool surface is constrained to read-only tools
 *    (`read,grep,find,ls`) — no bash/edit/write — the strongest restriction pi
 *    supports.
 *
 * Lifecycle is `acquireUseRelease`, so the throwaway process is always stopped
 * and its fork file deleted — on success, timeout, error, or interruption
 * (client disconnect).
 *
 * @module workstreamAsk
 */
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import { unlink } from "node:fs/promises";

import { withLocalNodeModulesBin } from "@t3tools/shared/shell";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  createPiRpcProcess,
  type PiRpcProcess,
  type PiRpcSessionState,
  type PiRpcStdoutMessage,
} from "../provider/Layers/Pi/RpcProcess.ts";

/** Read-only tool allowlist for the fork — no bash/edit/write possible. */
const READONLY_FORK_TOOLS = ["read", "grep", "find", "ls"] as const;

const READONLY_FORK_SYSTEM_PROMPT =
  "You are a READ-ONLY frozen snapshot of a prior agent session, consulted as an oracle by a peer in the same workstream. Answer the single question that follows using ONLY the knowledge already in this session's context. You cannot modify anything: you have no write/edit/command tools and no workstream tools, and nothing you do affects the original session. If the session's context does not actually resolve the question, say so plainly (e.g. \"This session does not resolve that\") rather than guessing or fabricating an answer.";

/** Clean, single error type for every ask failure (mapped to a tool error). */
export class WorkstreamAskError extends Schema.TaggedErrorClass<WorkstreamAskError>()(
  "WorkstreamAskError",
  { detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface AskWorkstreamThreadInput {
  /** Configured pi binary path (defaults to "pi" → bundled CLI). */
  readonly binaryPath: string;
  /** The target's deterministic pi session id (its thread id, sanitized). */
  readonly targetSessionId: string;
  /** A fresh, unique session id for the throwaway fork. */
  readonly freshSessionId: string;
  /** The target's worktree path so pi resolves the target session id locally. */
  readonly cwd: string;
  readonly question: string;
  readonly timeoutMs: number;
}

/** Strip any `T3_WORKSTREAM_*` keys so the fork cannot reach orchestration. */
export const envWithoutWorkstream = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith("T3_WORKSTREAM_")));

/** Read-only fork tool allowlist, exposed for invariant tests. */
export const readonlyForkTools = (): ReadonlyArray<string> => [...READONLY_FORK_TOOLS];

const isAssistantMessageEnd = (message: PiRpcStdoutMessage): boolean =>
  message.type === "message_end" &&
  (message.message as { readonly role?: unknown }).role === "assistant";

/** Wait for the fork's single turn to finish and return its assistant answer. */
const collectAnswer = (proc: PiRpcProcess, timeoutMs: number): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    let lastAssistantText = "";
    let currentText = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("Timed out waiting for the fork to answer."))),
      timeoutMs,
    );
    const unsubscribe = proc.subscribe((message) => {
      switch (message.type) {
        case "message_start":
          currentText = "";
          break;
        case "message_update": {
          const event = message.assistantMessageEvent;
          if (event?.type === "text_delta" && typeof event.delta === "string") {
            currentText += event.delta;
          }
          break;
        }
        case "message_end":
          if (isAssistantMessageEnd(message)) lastAssistantText = currentText;
          break;
        case "agent_end":
          finish(() => resolve(lastAssistantText));
          break;
        default:
          break;
      }
    });
    // An early exit (e.g. fork target not found) surfaces pi's stderr; a clean
    // exit after agent_end already settled is a no-op.
    proc.child.once("exit", () =>
      finish(() =>
        reject(new Error(proc.stderrTail().trim() || "The fork process exited before answering.")),
      ),
    );
  });

const toCleanError = (cause: unknown): WorkstreamAskError => {
  const message = cause instanceof Error ? cause.message : String(cause);
  return new WorkstreamAskError({
    detail: /No session found matching/i.test(message)
      ? "The target thread has no inspectable pi session yet (it may not have taken a turn)."
      : message,
    cause,
  });
};

/**
 * Fork the target's frozen pi session, ask one question read-only, and return
 * the answer. Fails with a clean Error (mapped to a tool error by the handler).
 */
export const askWorkstreamThread = Effect.fn("askWorkstreamThread")(function* (
  input: AskWorkstreamThreadInput,
) {
  const platform = yield* HostProcessPlatform;
  // Captured in `use`, read in `release` so the fork file is always deleted.
  let forkSessionFile: string | undefined;
  return yield* Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () =>
        createPiRpcProcess({
          binaryPath: input.binaryPath,
          platform,
          cwd: input.cwd,
          forkFrom: input.targetSessionId,
          sessionId: input.freshSessionId,
          tools: READONLY_FORK_TOOLS,
          appendSystemPrompt: READONLY_FORK_SYSTEM_PROMPT,
          // No `extensions` + a workstream-free env: the fork is structurally
          // incapable of mutating orchestration.
          env: withLocalNodeModulesBin(envWithoutWorkstream(), input.cwd, platform),
        }),
      catch: toCleanError,
    }),
    (proc) =>
      Effect.tryPromise({
        try: async () => {
          const state = await proc.request<PiRpcSessionState>({ type: "get_state" });
          forkSessionFile = state.data?.sessionFile;
          await proc.request({ type: "prompt", message: input.question });
          return (await collectAnswer(proc, input.timeoutMs)).trim();
        },
        catch: toCleanError,
      }),
    (proc) =>
      Effect.promise(async () => {
        await proc.stop().catch(() => undefined);
        if (forkSessionFile) await unlink(forkSessionFile).catch(() => undefined);
      }),
  );
});
