// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

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

export type PiRpcRequestCommand =
  | { readonly type: "get_state" }
  | { readonly type: "get_available_models" }
  | { readonly type: "set_model"; readonly provider: string; readonly modelId: string }
  | { readonly type: "set_thinking_level"; readonly level: string }
  | {
      readonly type: "prompt";
      readonly message: string;
      readonly images?: ReadonlyArray<PiRpcImage>;
      readonly streamingBehavior?: "steer" | "followUp";
    }
  | { readonly type: "abort" };

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
  | { readonly type: "agent_end" }
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
  readonly sessionFile?: string | undefined;
  readonly appendSystemPrompt?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export interface PiRpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly stderrTail: () => string;
  readonly request: <TData = unknown>(
    command: PiRpcRequestCommand,
    timeoutMs?: number,
  ) => Promise<PiRpcResponse<TData>>;
  readonly write: (command: PiRpcCommand) => Promise<void>;
  readonly subscribe: (listener: (message: PiRpcStdoutMessage) => void) => () => void;
  readonly stop: () => Promise<void>;
}

interface PendingResponse {
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly resolve: (response: PiRpcResponse) => void;
  readonly reject: (error: Error) => void;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STDERR_TAIL_MAX_CHARS = 4_096;

function nextStderrTail(previous: string, chunk: string): string {
  const next = `${previous}${chunk}`;
  return next.length > STDERR_TAIL_MAX_CHARS ? next.slice(-STDERR_TAIL_MAX_CHARS) : next;
}

function isPiRpcResponse(message: PiRpcStdoutMessage): message is PiRpcResponse {
  return message.type === "response";
}

function writeJsonLine(
  child: ChildProcessWithoutNullStreams,
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

export function createPiRpcProcess(options: PiRpcProcessOptions): Promise<PiRpcProcess> {
  const invocation = buildPiRpcInvocation(options.binaryPath);
  const args = [
    ...invocation.args,
    ...(options.sessionFile ? ["--session", options.sessionFile] : []),
    ...(options.appendSystemPrompt ? ["--append-system-prompt", options.appendSystemPrompt] : []),
  ];
  const useWindowsShell = shouldUseWindowsPiShell(invocation.command, options.platform);
  const command = useWindowsShell
    ? quoteWindowsPiShellCommand(invocation.command, options.platform)
    : invocation.command;
  const child = spawn(command, args, {
    ...(options.cwd ? { cwd: options.cwd } : {}),
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: useWindowsShell,
  });

  const listeners = new Set<(message: PiRpcStdoutMessage) => void>();
  const pending = new Map<string, PendingResponse>();
  const decoder = new StringDecoder("utf8");
  let stdoutBuffer = "";
  let stderrTail = "";
  let closed = false;
  let exitPromise: Promise<void> | undefined;

  const rejectAllPending = (error: Error) => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timeout);
      entry.reject(error);
      pending.delete(id);
    }
  };

  const handleMessage = (message: PiRpcStdoutMessage) => {
    if (isPiRpcResponse(message) && typeof message.id === "string") {
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        clearTimeout(entry.timeout);
        if (message.success) {
          entry.resolve(message);
        } else {
          entry.reject(new Error(message.error ?? `Pi RPC command '${message.command}' failed.`));
        }
      }
    }
    for (const listener of listeners) listener(message);
  };

  const handleLine = (line: string) => {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!trimmed) return;
    try {
      handleMessage(JSON.parse(trimmed) as PiRpcStdoutMessage);
    } catch {
      // Pi may print non-RPC noise; ignore it.
    }
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdoutBuffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    for (;;) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) break;
      handleLine(stdoutBuffer.slice(0, newlineIndex));
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
    }
  });
  child.stdout.on("end", () => {
    stdoutBuffer += decoder.end();
    if (stdoutBuffer) handleLine(stdoutBuffer);
    stdoutBuffer = "";
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
    const id = `pi-${randomUUID()}`;
    const response = await new Promise<PiRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for Pi RPC response to '${rpcCommand.type}'.`));
      }, timeoutMs);
      pending.set(id, { timeout, resolve, reject });
      void writeJsonLine(child, { ...rpcCommand, id }).catch((error) => {
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        clearTimeout(entry.timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    return response as PiRpcResponse<TData>;
  };

  const killPiChild = (signal: NodeJS.Signals) => {
    if (options.platform === "win32" && child.pid !== undefined) {
      try {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
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
