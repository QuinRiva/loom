/**
 * The frozen oracle behind `mcp__t3-code__consult_thread` (ported from V1's
 * `workstreamAsk.ts` onto upstream's pi RPC transport). A throwaway
 * `pi --mode rpc --fork <session file>` process answers ONE question from a
 * read-only copy of a thread's session and is discarded; the target is never
 * resumed or touched. Read-only is structural, not a prompt plea:
 *
 *  - the fork is a SEPARATE session file (pi's fork never writes the source);
 *  - it carries no MCP credential (`buildPiRpcLaunch` strips the T3 bridge
 *    env), so it cannot reach any T3 tool;
 *  - its tools are pi's read-only set (`read, grep, find, ls`).
 *
 * The process runs in the SERVER's cwd, so a thread whose worktree has been
 * deleted still answers (smoke step 20). The session file is the caller's to
 * resolve — always the provider thread's strong `nativeThreadRef`, never a
 * name or path guess. The fork's transcript is kept under
 * `workstream-consults/` for inspection (best-effort; deleted otherwise).
 *
 * @module loom/workstream/consult
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
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

/** One fork turn's bound; forking handles transcript size, so only duration needs one. */
const CONSULT_TIMEOUT_MS = 120_000;

const READONLY_FORK_TOOLS = "read,grep,find,ls";

const READONLY_FORK_SYSTEM_PROMPT =
  "You are a READ-ONLY frozen snapshot of a prior agent session, consulted as an oracle by a peer in the same workstream. Answer the single question that follows using ONLY the knowledge already in this session's context. You cannot modify anything: you have no write/edit/command tools and no workstream tools, and nothing you do affects the original session. If the session's context does not actually resolve the question, say so plainly (e.g. \"This session does not resolve that\") rather than guessing or fabricating an answer.";

/**
 * The consult framing rides the QUESTION TURN, not the system prompt: the fork
 * replays a transcript full of tools it no longer has, and only the most
 * recent text reliably wins over that. It also keeps the fork's prefix
 * byte-identical across consults of one target.
 */
export const composeConsultTurn = (input: { readonly asker: string; readonly question: string }) =>
  `Consult from ${input.asker}, via ${agentToolName("consult_thread")}. What follows is a read-only fork of the session above: a copy of it, frozen at its last turn. The original thread is untouched by anything that happens here, and this fork is discarded once you have answered.

Question:

${input.question}

Answering: reply from the knowledge already in this session's context, addressed to the asker, who sees your reply and nothing else. Your tools here are read-only (read, grep, find, ls); the bash, edit, write and workstream tools this transcript shows you using are gone, so do not narrate work, promise follow-up, or offer to go and do something. You may still read a file to check a detail, but the tree has moved on since this session's last turn, so treat remembered paths and contents as historical. If this session's context does not resolve the question, say so plainly (for example "this session does not resolve that") and say what it does cover; that is a useful answer, not a failure.`;

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
  /** The retained fork transcript, when retention succeeded. */
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
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    /** Moves the fork transcript under `workstream-consults/`, else deletes it. */
    const retain = (forkFile: string) => {
      const destination = path.join(
        loomPaths(config).workstreamConsultsDir,
        path.basename(forkFile),
      );
      return fs.makeDirectory(path.dirname(destination), { recursive: true }).pipe(
        Effect.andThen(fs.rename(forkFile, destination)),
        Effect.as(destination),
        Effect.catch(() => fs.remove(forkFile).pipe(Effect.ignore, Effect.as(undefined))),
      );
    };

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
      let forkFile: string | undefined;
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const connection = yield* makePiRpcConnection({
            command: resolveLoomPiBinaryPath(pi.binaryPath),
            args: [
              ...launch.args,
              "--fork",
              input.sessionFile,
              "--tools",
              READONLY_FORK_TOOLS,
              "--append-system-prompt",
              READONLY_FORK_SYSTEM_PROMPT,
            ],
            cwd: config.cwd,
            env: launch.env,
          });
          forkFile = piRecordString(
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
          return { answer: (piRecordString(text, "text") ?? "").trim(), providerError };
        }).pipe(
          Effect.scoped,
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(consultError("Could not fork and replay the target session")),
          Effect.timeoutOrElse({
            duration: CONSULT_TIMEOUT_MS,
            orElse: () =>
              Effect.fail(
                new LoomConsultError({ detail: "Timed out waiting for the fork to answer." }),
              ),
          }),
        ),
      );
      // The fork transcript is kept (or removed) whether or not the turn answered.
      const forkSessionPath = forkFile === undefined ? undefined : yield* retain(forkFile);
      const { answer, providerError } = yield* exit;
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
