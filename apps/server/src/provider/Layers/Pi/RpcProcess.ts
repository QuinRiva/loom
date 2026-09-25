// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import type * as NodeStream from "node:stream";

import {
  buildPiRpcInvocation,
  quoteWindowsPiShellCommand,
  shouldUseWindowsPiShell,
} from "./Cli.ts";

export interface PiRpcImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface PiRpcModel {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly reasoning?: boolean;
}

export interface PiRpcSessionState {
  readonly model?: PiRpcModel | null;
  readonly thinkingLevel?: string;
  readonly isStreaming?: boolean;
  readonly sessionFile?: string;
  readonly sessionId?: string;
}

export interface PiRpcCommandInfo {
  readonly name: string;
  readonly description?: string;
  readonly source: "extension" | "prompt" | "skill";
  readonly sourceInfo?: {
    readonly path?: string;
    readonly scope?: string;
  };
}

export type PiRpcRequestCommand =
  | { readonly type: "get_state" }
  | { readonly type: "get_available_models" }
  | { readonly type: "get_commands" }
  | { readonly type: "set_model"; readonly provider: string; readonly modelId: string }
  | { readonly type: "set_thinking_level"; readonly level: string }
  | {
      readonly type: "prompt";
      readonly message: string;
      readonly images?: ReadonlyArray<PiRpcImage>;
      readonly streamingBehavior?: "steer" | "followUp";
    }
  | { readonly type: "abort" }
  // Manual context compaction (pi's own `/compact`): summarises older messages
  // and rebuilds the context from the summary onwards. Answers only after the
  // summarisation LLM call returns, so callers must pass a long timeout.
  // pi's `set_auto_compaction` is deliberately not sent: pi auto-compacts by
  // default and T3 has no setting that would turn that off.
  | { readonly type: "compact"; readonly customInstructions?: string };

export type PiRpcWriteOnlyCommand =
  | { readonly type: "extension_ui_response"; readonly id: string; readonly value: string }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly confirmed: boolean }
  | { readonly type: "extension_ui_response"; readonly id: string; readonly cancelled: true };

export type PiRpcCommand = (PiRpcRequestCommand & { readonly id?: string }) | PiRpcWriteOnlyCommand;

export interface PiRpcResponse<TData = unknown> {
  readonly id?: string;
  readonly type: "response";
  readonly command: string;
  readonly success: boolean;
  readonly data?: TData;
  readonly error?: string;
}

export type PiRpcAssistantMessageEvent =
  | { readonly type: "text_delta"; readonly contentIndex: number; readonly delta: string }
  | { readonly type: "thinking_delta"; readonly contentIndex: number; readonly delta: string }
  | { readonly type: "text_end"; readonly contentIndex: number; readonly content: string }
  | { readonly type: "thinking_end"; readonly contentIndex: number; readonly content: string }
  | { readonly type: "done"; readonly reason: string; readonly message: Record<string, unknown> }
  | { readonly type: string; readonly [key: string]: unknown };

export interface PiRpcToolResult {
  readonly content?: ReadonlyArray<Record<string, unknown>>;
  readonly details?: unknown;
}

export type PiRpcStdoutEvent =
  | { readonly type: "agent_start" }
  | {
      readonly type: "agent_end";
      // Full message array for the run; the last assistant message carries
      // `stopReason` ("stop" | "error" | "aborted" | ...) and `errorMessage`.
      readonly messages?: ReadonlyArray<Record<string, unknown>>;
      // True when pi's built-in auto-retry will re-run the agent after this
      // event — the run (and the T3 turn) is NOT over yet.
      readonly willRetry?: boolean;
    }
  | {
      readonly type: "auto_retry_start";
      readonly attempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly errorMessage: string;
    }
  | {
      readonly type: "auto_retry_end";
      readonly success: boolean;
      readonly attempt: number;
      readonly finalError?: string;
    }
  | { readonly type: "turn_start"; readonly turnIndex?: number; readonly timestamp?: number }
  | {
      readonly type: "turn_end";
      readonly turnIndex?: number;
      readonly message?: Record<string, unknown>;
      readonly toolResults?: unknown;
    }
  | { readonly type: "message_start"; readonly message: Record<string, unknown> }
  | {
      readonly type: "message_update";
      readonly message: Record<string, unknown>;
      readonly assistantMessageEvent?: PiRpcAssistantMessageEvent;
    }
  | { readonly type: "message_end"; readonly message: Record<string, unknown> }
  | {
      readonly type: "tool_execution_start";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: Record<string, unknown>;
    }
  | {
      readonly type: "tool_execution_update";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly args?: Record<string, unknown>;
      readonly partialResult?: PiRpcToolResult;
    }
  | {
      readonly type: "tool_execution_end";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly result?: unknown;
      readonly isError?: boolean;
    }
  // Compaction lifecycle, emitted for BOTH a manual `compact` request
  // (`reason: "manual"`) and pi's own auto-compaction (`threshold`/`overflow`).
  // `result` is null when compaction was aborted or failed; `errorMessage`
  // carries the failure when `aborted` is false.
  | { readonly type: "compaction_start"; readonly reason?: string }
  | {
      readonly type: "compaction_end";
      readonly reason?: string;
      readonly result?: {
        readonly summary?: string;
        readonly firstKeptEntryId?: string;
        readonly tokensBefore?: number;
        readonly estimatedTokensAfter?: number;
        readonly usage?: Record<string, unknown>;
      } | null;
      readonly aborted?: boolean;
      readonly willRetry?: boolean;
      readonly errorMessage?: string;
    }
  | {
      readonly type: "queue_update";
      readonly steering?: ReadonlyArray<string>;
      readonly followUp?: ReadonlyArray<string>;
    }
  | {
      // Input-requesting methods (need an extension_ui_response): select | confirm | input | editor.
      // Display-only methods (notify | setStatus | setWidget | setTitle | set_editor_text) are
      // fire-and-forget; pi emits several on startup and they must NOT be surfaced as input prompts.
      readonly type: "extension_ui_request";
      readonly id: string;
      readonly method:
        | "select"
        | "confirm"
        | "input"
        | "editor"
        | "notify"
        | "setStatus"
        | "setWidget"
        | "setTitle"
        | "set_editor_text";
      readonly title?: string;
      readonly message?: string;
      readonly options?: ReadonlyArray<string>;
      readonly placeholder?: string;
      readonly prefill?: string;
    };

export type PiRpcStdoutMessage = PiRpcResponse | PiRpcStdoutEvent;

export interface PiRpcProcessOptions {
  readonly binaryPath: string;
  readonly platform: NodeJS.Platform;
  readonly cwd?: string | undefined;
  // Stable per-thread id; pi create-or-resumes the same session file for it.
  // Used for FIRST launches (no session file yet) and forks. A resume of an
  // existing thread uses `sessionFilePath` + `cwdOverride` instead (never
  // `--session-id` from a possibly-relocated cwd, which silently creates an
  // empty same-id session — the amnesia mode, plan fact 2).
  readonly sessionId?: string | undefined;
  // Resume launch (plan §4.2): the absolute path to an EXISTING session file
  // (`--session <path>`), resolved via `resolveSessionFilePath`. Combined with
  // `cwdOverride` it resumes the same conversation from a possibly-relocated
  // working directory. Mutually exclusive with `sessionId`/`forkFrom`.
  readonly sessionFilePath?: string | undefined;
  // Resume launch (plan §4.2): pins the session's runtime working directory
  // (`--cwd <dir>`) so pi does not read the (possibly deleted) header cwd. Valid
  // ONLY with `sessionFilePath` (the patched pi contract). Absolute path.
  readonly cwdOverride?: string | undefined;
  // Fork the named source session (id or path) into a fresh session. Combined
  // with `sessionId`, pi creates a throwaway fork with that fresh id and never
  // mutates the source (the `consult_thread` frozen-oracle mechanism). pi errors if
  // `sessionId` already exists, so the fresh id must be unique.
  readonly forkFrom?: string | undefined;
  readonly appendSystemPrompt?: string | undefined;
  readonly extensions?: ReadonlyArray<string> | undefined;
  // Allowlist of tool names (`--tools`) — a SANDBOX, not a default. pi applies
  // it to built-in and extension definitions BEFORE building its definition and
  // callable registries, so an unlisted tool is deleted from the session and no
  // extension can activate it later. Sole use: launching a consult fork
  // read-only (`read,grep,find,ls`) so it physically cannot edit, run commands,
  // or reach workstream tools. Role tool profiles must NOT come through here —
  // they are an active-set selection (T3_ACTIVE_TOOLS, applied by the
  // provider-tool extension) precisely so dormant families stay activatable.
  readonly tools?: ReadonlyArray<string> | undefined;
  // Skill files/directories to load (repeated `--skill`), additive to pi's
  // normal skill discovery. Absolute paths.
  readonly skills?: ReadonlyArray<string> | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export interface PiRpcProcess {
  readonly child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly stderrTail: () => string;
  readonly request: <TData = unknown>(
    command: PiRpcRequestCommand,
    timeoutMs?: number,
  ) => Promise<PiRpcResponse<TData>>;
  readonly write: (command: PiRpcCommand) => Promise<void>;
  /**
   * A listener may return a promise that settles once the message has been
   * handed downstream; while too many are unsettled, stdout is paused (see
   * `attachStdoutLineReader`).
   */
  readonly subscribe: (
    listener: (message: PiRpcStdoutMessage) => void | Promise<unknown>,
  ) => () => void;
  readonly stop: () => Promise<void>;
}

interface PendingResponse {
  readonly cancelTimeout: () => void;
  readonly resolve: (response: PiRpcResponse) => void;
  readonly reject: (error: Error) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL_MAX_CHARS = 4_096;
// Backpressure hysteresis, counted in unsettled listener promises (each holds
// one parsed pi message, up to multi-MB tool results): this is the per-child
// memory knob. 16 open → pause; drained to 4 → resume, so a busy child is not
// toggled on every message.
const STDOUT_PAUSE_AT_IN_FLIGHT = 16;
const STDOUT_RESUME_AT_IN_FLIGHT = 4;

/**
 * Process-wide stdout backpressure counters, read by the runtime performance
 * monitor and the ingestion watchdog: pauses begun, milliseconds spent paused
 * (added on resume), and the streams paused right now, each mapped to when its
 * pause began.
 */
export const piStdoutBackpressure = {
  pauses: 0,
  pausedMsTotal: 0,
  pausedSince: new Map<object, number>(),
};

export interface StdoutLineReader {
  /** Paused for backpressure right now. */
  readonly isPaused: () => boolean;
  /** Pauses so far, so a deadline can notice a pause that has already ended. */
  readonly pauseCount: () => number;
  /** The writer is gone: resume for good so the buffered tail drains to `end`. */
  readonly release: () => void;
}

/**
 * Splits a child's stdout into lines and applies backpressure to it.
 *
 * Lines are found by scanning raw bytes for `\n` (0x0A never occurs inside a
 * multi-byte UTF-8 sequence), and only a complete line is concatenated and
 * decoded, so a multi-MB line costs O(n). A trailing `\r` is trimmed and blank
 * lines are skipped.
 *
 * `onLine` may return a promise; while `pauseAt` or more are unsettled the
 * stream is paused, and it resumes once they drain to `resumeAt`. The pipe then
 * becomes the buffer and the child slows down instead of this process holding
 * its backlog. Pausing takes effect after the current chunk's lines have been
 * dispatched, so the true ceiling is `pauseAt` + lines-per-chunk. Emitters that
 * never pass through here (synthetic exit events, retry timers, ask-user
 * resolutions) suspend on a full downstream queue without pausing anything —
 * they are low volume, and that is deliberate.
 */
export function attachStdoutLineReader(
  stream: NodeStream.Readable,
  onLine: (line: string) => void | Promise<unknown>,
  { pauseAt = STDOUT_PAUSE_AT_IN_FLIGHT, resumeAt = STDOUT_RESUME_AT_IN_FLIGHT } = {},
): StdoutLineReader {
  let partial: Buffer[] = [];
  let inFlight = 0;
  let paused = false;
  let released = false;
  let pauses = 0;
  let pausedAtMs = 0;

  const resume = () => {
    if (!paused) return;
    paused = false;
    piStdoutBackpressure.pausedSince.delete(stream);
    piStdoutBackpressure.pausedMsTotal += Date.now() - pausedAtMs;
    stream.resume();
  };
  const settle = () => {
    inFlight -= 1;
    if (inFlight <= resumeAt) resume();
  };
  const dispatch = (line: string) => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!trimmed) return;
    const pending = onLine(trimmed);
    if (!(pending instanceof Promise)) return;
    inFlight += 1;
    void pending.then(settle, settle);
    if (inFlight >= pauseAt && !paused && !released) {
      paused = true;
      pauses += 1;
      pausedAtMs = Date.now();
      piStdoutBackpressure.pauses += 1;
      piStdoutBackpressure.pausedSince.set(stream, pausedAtMs);
      stream.pause();
    }
  };

  stream.on("data", (chunk: Buffer) => {
    let start = 0;
    for (let newline = chunk.indexOf(0x0a); newline !== -1; newline = chunk.indexOf(0x0a, start)) {
      const tail = chunk.subarray(start, newline);
      const line = partial.length === 0 ? tail : Buffer.concat([...partial, tail]);
      partial = [];
      start = newline + 1;
      dispatch(line.toString("utf8"));
    }
    if (start < chunk.length) partial.push(chunk.subarray(start));
  });
  stream.on("end", () => {
    if (partial.length > 0) dispatch(Buffer.concat(partial).toString("utf8"));
    partial = [];
  });

  return {
    isPaused: () => paused,
    pauseCount: () => pauses,
    release: () => {
      released = true;
      resume();
    },
  };
}

/**
 * A request deadline that does not expire while the child's stdout is held by
 * backpressure: a paused child cannot deliver its response, and under
 * saturation a pause lasts as long as the global drain takes. When the timer
 * fires during (or after) a pause since it was armed, it re-arms for another
 * `timeoutMs`; otherwise `onTimeout` runs. Returns the cancel function.
 */
export function setPauseAwareTimeout(
  reader: Pick<StdoutLineReader, "isPaused" | "pauseCount">,
  timeoutMs: number,
  onTimeout: () => void,
): () => void {
  let pausesSeen = reader.pauseCount();
  let timer: ReturnType<typeof setTimeout>;
  const arm = () => {
    timer = setTimeout(() => {
      if (reader.isPaused() || reader.pauseCount() !== pausesSeen) {
        pausesSeen = reader.pauseCount();
        arm();
        return;
      }
      onTimeout();
    }, timeoutMs);
  };
  arm();
  return () => clearTimeout(timer);
}

function nextStderrTail(previous: string, chunk: string): string {
  const next = `${previous}${chunk}`;
  return next.length > STDERR_TAIL_MAX_CHARS ? next.slice(-STDERR_TAIL_MAX_CHARS) : next;
}

function isPiRpcResponse(message: PiRpcStdoutMessage): message is PiRpcResponse {
  return message.type === "response";
}

function writeJsonLine(
  child: NodeChildProcess.ChildProcessWithoutNullStreams,
  command: PiRpcCommand,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.stdin.writable) {
      reject(new Error("Pi RPC stdin is no longer writable."));
      return;
    }
    child.stdin.write(`${JSON.stringify(command)}\n`, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

function describePiExit(input: {
  readonly command: string;
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderrTail: string;
}) {
  const detail = input.stderrTail.trim();
  return new Error(
    `Pi RPC process '${input.command}' exited${input.code === null ? "" : ` with code ${input.code}`}${input.signal ? ` (${input.signal})` : ""}.${detail ? `\n${detail}` : ""}`,
  );
}

/**
 * Pure assembly of the `pi --mode rpc` argv from the process options. Exposed so
 * the fork's read-only invariants (carries `--fork`/`--tools read,...` and NO
 * `--extension`) are unit-testable without spawning pi.
 */
export function buildPiRpcArgs(options: PiRpcProcessOptions): ReadonlyArray<string> {
  const invocation = buildPiRpcInvocation(options.binaryPath);
  // Resume of an existing session (`--session <path> --cwd <dir>`) takes
  // precedence over a first-launch `--session-id`: the patched pi requires
  // `--cwd` to accompany `--session <path>`, and `--session-id` from a
  // relocated cwd would silently fork an empty same-id session (amnesia).
  const isResume = options.sessionFilePath !== undefined;
  return [
    ...invocation.args,
    ...(options.forkFrom ? ["--fork", options.forkFrom] : []),
    ...(isResume ? ["--session", options.sessionFilePath!] : []),
    ...(isResume && options.cwdOverride ? ["--cwd", options.cwdOverride] : []),
    ...(!isResume && options.sessionId ? ["--session-id", options.sessionId] : []),
    ...(options.tools && options.tools.length > 0 ? ["--tools", options.tools.join(",")] : []),
    ...(options.skills ?? []).flatMap((skill) => ["--skill", skill]),
    ...(options.appendSystemPrompt ? ["--append-system-prompt", options.appendSystemPrompt] : []),
    ...(options.extensions ?? []).flatMap((extension) => ["--extension", extension]),
  ];
}

export function createPiRpcProcess(options: PiRpcProcessOptions): Promise<PiRpcProcess> {
  const invocation = buildPiRpcInvocation(options.binaryPath);
  const args = buildPiRpcArgs(options);
  const useWindowsShell = shouldUseWindowsPiShell(invocation.command, options.platform);
  const command = useWindowsShell
    ? quoteWindowsPiShellCommand(invocation.command, options.platform)
    : invocation.command;
  const child = NodeChildProcess.spawn(command, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: useWindowsShell,
  });

  const listeners = new Set<(message: PiRpcStdoutMessage) => void | Promise<unknown>>();
  const pending = new Map<string, PendingResponse>();
  let stderrTail = "";
  let closed = false;
  let exitPromise: Promise<void> | undefined;

  const rejectAllPending = (error: Error) => {
    for (const [id, entry] of pending) {
      entry.cancelTimeout();
      entry.reject(error);
      pending.delete(id);
    }
  };

  const handleMessage = (message: PiRpcStdoutMessage) => {
    if (isPiRpcResponse(message) && typeof message.id === "string") {
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        entry.cancelTimeout();
        if (message.success) {
          entry.resolve(message);
        } else {
          entry.reject(new Error(message.error ?? `Pi RPC command '${message.command}' failed.`));
        }
      }
    }
    let inFlight: Promise<unknown> | undefined;
    for (const listener of listeners) {
      const handled = listener(message);
      if (handled instanceof Promise)
        inFlight = inFlight ? Promise.all([inFlight, handled]) : handled;
    }
    return inFlight;
  };

  const stdout = attachStdoutLineReader(child.stdout, (line) => {
    try {
      return handleMessage(JSON.parse(line) as PiRpcStdoutMessage);
    } catch {
      // Pi may print non-RPC noise; ignore it.
      return undefined;
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = nextStderrTail(stderrTail, chunk);
  });
  child.once("error", (error) => {
    closed = true;
    rejectAllPending(error instanceof Error ? error : new Error(String(error)));
  });
  child.once("exit", (code, signal) => {
    closed = true;
    // Nothing writes to the pipe any more: let the paused tail drain so
    // `end` (and the child's `close`) can fire.
    stdout.release();
    rejectAllPending(describePiExit({ command: invocation.command, code, signal, stderrTail }));
  });

  const request = async <TData = unknown>(
    rpcCommand: PiRpcRequestCommand,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<PiRpcResponse<TData>> => {
    if (closed || child.exitCode !== null)
      throw describePiExit({
        command: invocation.command,
        code: child.exitCode,
        signal: null,
        stderrTail,
      });
    const id = `pi-${NodeCrypto.randomUUID()}`;
    const response = await new Promise<PiRpcResponse>((resolve, reject) => {
      const cancelTimeout = setPauseAwareTimeout(stdout, timeoutMs, () => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for Pi RPC response to '${rpcCommand.type}'.`));
      });
      pending.set(id, { cancelTimeout, resolve, reject });
      void writeJsonLine(child, { ...rpcCommand, id }).catch((error) => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        entry.cancelTimeout();
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    return response as PiRpcResponse<TData>;
  };

  const killPiChild = (signal: NodeJS.Signals) => {
    if (options.platform === "win32" && child.pid !== undefined) {
      try {
        NodeChildProcess.spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
        return;
      } catch {
        // Fall through to direct kill.
      }
    }
    child.kill(signal);
  };

  return Promise.resolve({
    child,
    command: invocation.command,
    args,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stderrTail: () => stderrTail,
    request,
    write: (command) => writeJsonLine(child, command),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop: async () => {
      if (exitPromise) return exitPromise;
      exitPromise = new Promise<void>((resolve) => {
        if (closed || child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        const sigkillTimer = setTimeout(() => {
          if (child.exitCode === null) killPiChild("SIGKILL");
        }, 1_000);
        child.once("exit", () => clearTimeout(sigkillTimer));
        killPiChild("SIGTERM");
      });
      return exitPromise;
    },
  });
}
