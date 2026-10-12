/**
 * The frozen oracle behind `mcp__t3-code__consult_thread` (ported from V1's
 * `workstreamAsk.ts` onto upstream's pi RPC transport). A throwaway
 * `pi --mode rpc --fork <session file>` process answers ONE question from a
 * copy of a thread's session and is discarded; the target is never resumed or
 * touched:
 *
 *  - the fork is a SEPARATE session file (pi's fork never writes the source);
 *  - it carries no MCP credential (`buildPiRpcLaunch` strips the T3 bridge
 *    env), so it cannot act as the target in the workstream;
 *  - otherwise it keeps the target's own tools, so it can inspect whatever the
 *    answer needs; not modifying anything is an instruction in the consult turn.
 *    Narrowing the tools would make pi declare a mid-conversation tool removal,
 *    which the request then has to replay (DL-634).
 *
 * The process runs in the SERVER's cwd, so a thread whose worktree has been
 * deleted still answers (smoke step 20). The session file is the caller's to
 * resolve — always the provider thread's strong `nativeThreadRef`, never a
 * name or path guess. The fork writes its transcript straight into
 * `workstream-consults/` (`--session-dir`), where it is kept for inspection.
 *
 * There is deliberately no duration bound: a consult exists so the asker gets
 * an answer without spending its own context on the digging, and real digging
 * can take many minutes. A quiet fork is not a hung one either (a long bash
 * command emits nothing), so no stall bound would be anything but arbitrary.
 * The bound is the asker's turn: stopping it aborts the tool call, which
 * interrupts this effect, and the connection's scope kills the fork's process
 * group. A fork that dies or loses its provider fails the transport instead.
 *
 * @module loom/workstream/consult
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/process";

import { ServerConfig } from "../../config.ts";
import { agentToolName } from "../../mcp/toolkits/workstream/families.ts";
import { makePiRpcConnection, piRecordString } from "../../orchestration-v2/Adapters/PiRpc.ts";
import {
  buildPiRpcLaunch,
  resolvePiLaunchArgs,
} from "../../orchestration-v2/Adapters/piT3McpInjection.ts";
import { resolveLoomPiBinaryPath } from "../../provider/Drivers/Pi/bundledPi.loom.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { loomPaths } from "../loomPaths.ts";

/**
 * The consult framing rides the QUESTION TURN, not the system prompt: only the
 * most recent text reliably wins over the replayed transcript, and it keeps the
 * fork's prefix byte-identical to the target's (a warm prompt cache).
 */
export const composeConsultTurn = (input: { readonly asker: string; readonly question: string }) =>
  `Consult from ${input.asker}, via ${agentToolName("consult_thread")}. What follows is a read-only fork of the session above: a copy of it, frozen at its last turn. The original thread is untouched by anything that happens here, and this fork is discarded once you have answered.

Question:

${input.question}

Answering: reply from the knowledge already in this session's context, addressed to the asker, who sees your reply and nothing else. You may inspect anything that helps you answer (run commands, read files, git log/diff), but do not modify files, git state or any thread; the workstream tools this transcript shows you using are gone, so do not narrate work, promise follow-up, or offer to go and do something. The tree has moved on since this session's last turn, so treat remembered paths and contents as historical. If this session's context does not resolve the question, say so plainly (for example "this session does not resolve that") and say what it does cover; that is a useful answer, not a failure.`;

export class LoomConsultError extends Schema.TaggedError<LoomConsultError>()("LoomConsultError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface ConsultForkInput {
  /** The target's pi session file: its provider thread's strong `nativeThreadRef`. */
  readonly sessionFile: string;
  readonly question: string;
  /** Who is asking, e.g. `thread «Title» (role, id; relationship)`. */
  readonly asker: string;
}

export interface ConsultForkResult {
  readonly answer: string;
  /** The fork transcript pi wrote into `workstream-consults/`, when it reported one. */
  readonly forkSessionPath?: string;
}

export class LoomThreadConsult extends Context.Service<
  LoomThreadConsult,
  {
    readonly ask: (input: ConsultForkInput) => Effect.Effect<ConsultForkResult, LoomConsultError>;
  }
>()("t3/loom/workstream/consult/LoomThreadConsult") {}

const consultError = (detail: string) => (cause: unknown) =>
  new LoomConsultError({
    detail: cause instanceof Error ? `${detail}: ${cause.message}` : detail,
    cause,
  });

export const layer = Layer.effect(
  LoomThreadConsult,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const settings = yield* ServerSettings.ServerSettingsService;
    const config = yield* ServerConfig;

    const ask = Effect.fn("LoomThreadConsult.ask")(function* (input: ConsultForkInput) {
      const pi = (yield* settings.getSettings.pipe(
        Effect.mapError(consultError("Could not read the pi settings")),
      )).providers.pi;
      const launchArgs = resolvePiLaunchArgs(pi.launchArgs);
      if (!launchArgs.ok) return yield* new LoomConsultError({ detail: launchArgs.message });
      const launch = buildPiRpcLaunch({
        launchArgs: launchArgs.args,
        // One short-lived turn: always the 5-minute prompt cache.
        environment: { ...process.env, PI_CACHE_RETENTION: "short" },
        mcpSession: undefined,
        extensionPath: undefined,
      });
      const { answer, providerError, forkSessionPath } = yield* Effect.gen(function* () {
        const connection = yield* makePiRpcConnection({
          command: resolveLoomPiBinaryPath(pi.binaryPath),
          args: [
            ...launch.args,
            "--session-dir",
            loomPaths(config).workstreamConsultsDir,
            "--fork",
            input.sessionFile,
          ],
          cwd: config.cwd,
          env: launch.env,
        });
        const forkSessionPath = piRecordString(
          yield* connection.request({ type: "get_state" }),
          "sessionFile",
        );
        yield* connection.request({ type: "prompt", message: composeConsultTurn(input) });
        // The latest assistant message's provider error, so an empty answer can say why.
        let providerError: string | undefined;
        while (true) {
          const event = yield* Queue.take(connection.events);
          if (event["type"] === "agent_settled") break;
          const message = event["message"];
          if (event["type"] === "message_end" && piRecordString(message, "role") === "assistant")
            providerError =
              piRecordString(message, "stopReason") === "error"
                ? piRecordString(message, "errorMessage")
                : undefined;
          // No human is present: cancel any extension dialog instead of stalling.
          if (
            event["type"] === "extension_ui_request" &&
            ["select", "confirm", "input", "editor"].includes(String(event["method"]))
          ) {
            yield* connection.send({
              type: "extension_ui_response",
              id: event["id"],
              cancelled: true,
            });
          }
        }
        const text = yield* connection.request({ type: "get_last_assistant_text" });
        return {
          answer: (piRecordString(text, "text") ?? "").trim(),
          providerError,
          forkSessionPath,
        };
      }).pipe(
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.mapError(consultError("Could not fork and replay the target session")),
      );
      if (answer.length === 0)
        return yield* new LoomConsultError({
          detail:
            providerError === undefined
              ? "The fork finished without an answer."
              : `The fork's model request failed: ${providerError}`,
        });
      return { answer, ...(forkSessionPath === undefined ? {} : { forkSessionPath }) };
    });

    return LoomThreadConsult.of({ ask });
  }),
);
