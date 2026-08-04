/**
 * workstreamAsk - the frozen-oracle mechanism behind `consult_thread`.
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
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { withLocalNodeModulesBin } from "@t3tools/shared/shell";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { piRunOutcome } from "../provider/Drivers/piTurnRetryPolicy.ts";
import {
  createPiRpcProcess,
  type PiRpcProcess,
  type PiRpcSessionState,
  type PiRpcStdoutEvent,
  type PiRpcStdoutMessage,
} from "../provider/Layers/Pi/RpcProcess.ts";

/** Read-only tool allowlist for the fork — no bash/edit/write possible. */
const READONLY_FORK_TOOLS = ["read", "grep", "find", "ls"] as const;

const READONLY_FORK_SYSTEM_PROMPT =
  "You are a READ-ONLY frozen snapshot of a prior agent session, consulted as an oracle by a peer in the same workstream. Answer the single question that follows using ONLY the knowledge already in this session's context. You cannot modify anything: you have no write/edit/command tools and no workstream tools, and nothing you do affects the original session. If the session's context does not actually resolve the question, say so plainly (e.g. \"This session does not resolve that\") rather than guessing or fabricating an answer.";

/**
 * Frame the consult in the QUESTION TURN, not the system prompt.
 *
 * The fork replays 100+ turns of a session that DID have bash/edit/write and
 * every workstream tool, so a read-only instruction sitting in the system
 * prompt, ahead of all that, loses to recency: consulted forks narrate tool
 * calls they cannot make and offer to go and do work. The same words in the
 * last turn are the most recent thing the model has read when it answers.
 *
 * Positioning is also the cache-friendly choice: the fork's prefix (system
 * prompt + replayed transcript) is byte-identical across every consult of the
 * same target, so keeping the framing in the trailing turn preserves whatever
 * cross-consult prefix reuse the provider path offers, whereas growing
 * `READONLY_FORK_SYSTEM_PROMPT` would invalidate every warmed consult prefix.
 */
export const composeConsultTurn = (input: {
  /** Short descriptor of who is asking, e.g. `thread «Title» (role, id; relationship)`. */
  readonly asker?: string;
  readonly question: string;
}): string =>
  `Consult from ${input.asker ?? "a peer thread"}, via consult_thread. What follows is a read-only fork of the session above: a copy of it, frozen at its last turn. The original thread is untouched by anything that happens here, and this fork is discarded once you have answered.

Question:

${input.question}

Answering: reply from the knowledge already in this session's context, addressed to the asker, who sees your reply and nothing else. Your tools here are read-only (read, grep, find, ls); the bash, edit, write and workstream tools this transcript shows you using are gone, so do not narrate work, promise follow-up, or offer to go and do something. You may still read a file to check a detail, but the tree has moved on since this session's last turn, so treat remembered paths and contents as historical. If this session's context does not resolve the question, say so plainly (for example "this session does not resolve that") and say what it does cover; that is a useful answer, not a failure.`;

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
  /**
   * Short descriptor of who is asking (the call site owns identity; this module
   * owns the read-only contract), e.g. `thread «Title» (role, id; relationship)`.
   * Omit for a generic "a peer thread".
   */
  readonly asker?: string;
  readonly timeoutMs: number;
  /**
   * Durable directory to move the read-only fork's session jsonl into when the
   * turn completes (filename `<freshSessionId>.jsonl`), retaining it for deep
   * inspection instead of deleting it. Omit to keep the original
   * delete-on-release behaviour. Retention is best-effort: on any move failure
   * the fork file is deleted and no path is returned.
   */
  readonly forkRetentionDir?: string;
}

export interface AskWorkstreamThreadResult {
  /** The fork's single-turn assistant answer (trimmed). */
  readonly answer: string;
  /** Retained fork session jsonl path, when retention succeeded. */
  readonly forkSessionPath?: string;
}

/** Strip any `T3_WORKSTREAM_*` keys so the fork cannot reach orchestration. */
export const envWithoutWorkstream = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith("T3_WORKSTREAM_")));

/** Read-only fork tool allowlist, exposed for invariant tests. */
export const readonlyForkTools = (): ReadonlyArray<string> => [...READONLY_FORK_TOOLS];

const isAssistantMessageEnd = (message: PiRpcStdoutMessage): boolean =>
  message.type === "message_end" &&
  (message.message as { readonly role?: unknown }).role === "assistant";

/**
 * Wait for the fork's single turn to finish and return its assistant answer.
 *
 * A fork's turn can "succeed" at the RPC level while producing NOTHING useful:
 * the target session may be un-resumable (e.g. a codex→anthropic corruption
 * case) so the model's replay of the forked history errors in-band, surfacing
 * as an `agent_end` whose last assistant message carries `stopReason: "error"`
 * (and possibly no text). Resolving with the empty `lastAssistantText` in that
 * case makes `consult_thread` report silent success with a blank answer. So
 * treat an errored run, or an empty/whitespace answer, as a failure with a
 * useful detail (the in-band error text and/or pi's stderr tail).
 */
export const collectAnswer = (proc: PiRpcProcess, timeoutMs: number): Promise<string> =>
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
    const failEmpty = (detail: string) => {
      const stderr = proc.stderrTail().trim();
      reject(
        new Error(
          `cannot fork/replay target session: ${detail}${stderr ? `\n${stderr}` : ""}`.trim(),
        ),
      );
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
        case "agent_end": {
          const event = message as Extract<PiRpcStdoutEvent, { type: "agent_end" }>;
          // `willRetry` means pi's built-in auto-retry will re-run the agent:
          // this is an INTERMEDIATE end (the run/turn is not over), so the
          // errored/empty assistant message here is transient and a later
          // `agent_end` carries the real outcome. Ignore it, exactly as
          // PiDriver does, or a retryable provider blip becomes a spurious
          // WorkstreamAskError.
          if (event.willRetry === true) break;
          const outcome = piRunOutcome(event.messages);
          const answer = lastAssistantText.trim();
          if (outcome.stopReason === "error") {
            finish(() =>
              failEmpty(
                outcome.errorMessage?.trim() ||
                  "the fork's turn ended in a provider error with no message.",
              ),
            );
            break;
          }
          if (answer.length === 0) {
            finish(() =>
              failEmpty("the fork produced no answer (the session history may not be replayable)."),
            );
            break;
          }
          finish(() => resolve(lastAssistantText));
          break;
        }
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
  // Captured in `use`, read in `release` so the fork file is always retained or
  // deleted. `retainedForkPath` is set in `release` (which completes before the
  // overall effect resolves) so the caller can event-source the pointer.
  let forkSessionFile: string | undefined;
  let retainedForkPath: string | undefined;
  const answer = yield* Effect.acquireUseRelease(
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
          await proc.request({
            type: "prompt",
            message: composeConsultTurn({
              question: input.question,
              ...(input.asker !== undefined ? { asker: input.asker } : {}),
            }),
          });
          return (await collectAnswer(proc, input.timeoutMs)).trim();
        },
        catch: toCleanError,
      }),
    (proc) =>
      Effect.promise(async () => {
        await proc.stop().catch(() => undefined);
        if (!forkSessionFile) return;
        if (input.forkRetentionDir) {
          const destination = NodePath.join(
            input.forkRetentionDir,
            `${input.freshSessionId}.jsonl`,
          );
          if (await retainForkSession(forkSessionFile, destination)) {
            retainedForkPath = destination;
            return;
          }
        }
        await NodeFSP.unlink(forkSessionFile).catch(() => undefined);
      }),
  );
  return {
    answer,
    ...(retainedForkPath !== undefined ? { forkSessionPath: retainedForkPath } : {}),
  } satisfies AskWorkstreamThreadResult;
});

/**
 * Move the fork's session jsonl to a durable location. Handles cross-device
 * moves (rename → copy+unlink fallback). Best-effort: returns false on any
 * failure so the caller deletes the original instead.
 */
const retainForkSession = async (source: string, destination: string): Promise<boolean> => {
  try {
    await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
    await NodeFSP.rename(source, destination);
    return true;
  } catch {
    try {
      await NodeFSP.copyFile(source, destination);
      await NodeFSP.unlink(source).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }
};
