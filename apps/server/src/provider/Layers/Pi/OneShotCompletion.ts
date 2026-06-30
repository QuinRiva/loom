// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeChildProcess from "node:child_process";

import type { ModelSelection } from "@t3tools/contracts";
import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { normalizeCliError } from "../../../textGeneration/TextGenerationUtils.ts";
import { quoteWindowsPiShellCommand, resolvePiInvocation, shouldUseWindowsPiShell } from "./Cli.ts";

const PI_ONE_SHOT_TIMEOUT_MS = 120_000;

function splitProviderModel(model: string): { provider: string; modelId: string } | undefined {
  const slash = model.indexOf("/");
  return slash > 0 && slash < model.length - 1
    ? { provider: model.slice(0, slash), modelId: model.slice(slash + 1) }
    : undefined;
}

/** Concatenate the text parts of a pi assistant message object. */
function assistantMessageText(message: unknown): string {
  if (typeof message !== "object" || message === null) return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === "object" &&
        part !== null &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("");
}

/**
 * Pi `--mode json` emits one JSON object per line. The terminating `agent_end`
 * event carries the full message list; fall back to the last `message_end`
 * assistant event when no `agent_end` is present.
 */
function lastAssistantText(stdout: string): string {
  let fromAgentEnd: string | undefined;
  let lastMessageEnd = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const event = parsed as { type?: string; message?: unknown; messages?: unknown };
    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      const assistant = [...event.messages]
        .toReversed()
        .find(
          (m) =>
            typeof m === "object" && m !== null && (m as { role?: string }).role === "assistant",
        );
      if (assistant) fromAgentEnd = assistantMessageText(assistant);
    } else if (
      event.type === "message_end" &&
      typeof event.message === "object" &&
      event.message !== null &&
      (event.message as { role?: string }).role === "assistant"
    ) {
      const text = assistantMessageText(event.message);
      if (text.length > 0) lastMessageEnd = text;
    }
  }
  return fromAgentEnd ?? lastMessageEnd;
}

/** Pull a JSON object out of model text, tolerating markdown fences and prose. */
function extractJsonObject(text: string): string | undefined {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1]! : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start === -1 || end < start ? undefined : body.slice(start, end + 1);
}

function runPiOneShot(input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string | undefined;
  readonly shell: boolean;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      env: input.env,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      shell: input.shell,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(stderr.trim() || `pi exited with code ${code ?? "null"}.`)),
    );
  });
}

/**
 * One-shot non-interactive pi completion that returns structured JSON decoded
 * against `outputSchema`. Backs the pi driver's `generateStructured`, so the
 * default `pi` text-generation instance produces real titles/goals without a
 * configured side model.
 */
export const generatePiStructured = Effect.fn("generatePiStructured")(function* <
  S extends Schema.Top,
>(input: {
  readonly binaryPath: string;
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string | undefined;
  readonly prompt: string;
  readonly outputSchema: S;
  readonly modelSelection: ModelSelection;
}): Effect.fn.Return<S["Type"], TextGenerationError, S["DecodingServices"]> {
  const invocation = resolvePiInvocation(input.binaryPath);
  const model = splitProviderModel(input.modelSelection.model);
  const args = [
    ...invocation.args,
    "--print",
    "--mode",
    "json",
    "--no-tools",
    "--no-session",
    "--thinking",
    "off",
    ...(model ? ["--provider", model.provider, "--model", model.modelId] : []),
    input.prompt,
  ];
  const useWindowsShell = shouldUseWindowsPiShell(invocation.command, input.platform);
  const command = useWindowsShell
    ? quoteWindowsPiShellCommand(invocation.command, input.platform)
    : invocation.command;

  const stdout = yield* Effect.tryPromise({
    try: () =>
      runPiOneShot({
        command,
        args,
        env: input.env,
        cwd: input.cwd,
        shell: useWindowsShell,
      }),
    catch: (cause) =>
      normalizeCliError("pi", "generateStructured", cause, "Pi one-shot completion failed"),
  }).pipe(
    Effect.timeoutOption(PI_ONE_SHOT_TIMEOUT_MS),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateStructured",
              detail: "Pi one-shot completion timed out.",
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );

  const jsonString = extractJsonObject(lastAssistantText(stdout));
  if (!jsonString) {
    return yield* new TextGenerationError({
      operation: "generateStructured",
      detail: "Pi returned no structured output.",
    });
  }

  const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(input.outputSchema));
  return yield* decodeOutput(jsonString).pipe(
    Effect.catchTag("SchemaError", (cause) =>
      Effect.fail(
        new TextGenerationError({
          operation: "generateStructured",
          detail: "Pi returned invalid structured output.",
          cause,
        }),
      ),
    ),
  );
});
