/**
 * Loom's pi extension: one file assembled from named parts and loaded by the
 * composer as the `--extension` before upstream's bridge (DR-13). It reads
 * upstream's `T3_MCP_URL` / `T3_MCP_BEARER_TOKEN` and talks to the two REST
 * survivors beside `/mcp` (P3-3, `loom/http/loomAgentRoutes.ts`). Parts here:
 * `toolProfile` (the session profile applied at `session_start` and re-asserted
 * at every `before_agent_start`, P3-4, keeping `tool_search` discoveries) and
 * `askUserQuestion` (`mcp__t3-code__ask_user_question` over ask + long-poll),
 * then 3c's `search-guard`, `command-guards` (rewrite or block shell commands agents
 * repeatedly mistype), `pgrep-self-match` (a bash call naming pgrep/pkill that the guard let
 * through runs base64-encoded so its pattern never matches the tool shell's own argv),
 * `prompt-debug`, and `cacheWarmingGate` (no idle cache
 * warming after a successful submit; a 1-hour root's idle keep-alive ping always warms;
 * the resulting plan is reported to `/cache-warming` for the sidebar's cache gauge) and
 * `consultGuard` (a consult fork refuses `edit` / `write`) and `systemHead` (pi's system message
 * moved to the head of each request, so a `tool_search` load appends instead of rewriting the
 * prompt cache) and `backgroundJobs` (`bg_start` / `bg_wait`, a wake when a job exits, the
 * `loom-jobs` status line the adapter reads as a session pin, and a refused submit while a job runs)
 * (`loomExtensionParts/`).
 *
 * A part's `source` is the body of `(pi, ctx) => { … }` with
 * `ctx = { profile(), endpoint, token }`; module-level `loomFetch(ctx, method,
 * path, body?, signal?)` and `pause(ms, signal?)` are in scope. The string
 * imports nothing: pi loads it from the cache dir, outside this package.
 *
 * @module provider/Drivers/Pi/loomExtension
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../../config.ts";
import { HUMAN_INPUT_REFUSAL } from "../../../loom/prompt/prose.ts";
import { agentToolName, HUMAN_INPUT } from "../../../mcp/toolkits/workstream/families.ts";
import { LOOM_TOOL_PROSE } from "../../../mcp/toolkits/workstream/prose.ts";
import { backgroundJobsPart } from "./loomExtensionParts/backgroundJobs.ts";
import { cacheWarmingGatePart } from "./loomExtensionParts/cacheWarmingGate.ts";
import { commandGuardsPart } from "./loomExtensionParts/commandGuards.ts";
import { consultGuardPart } from "./loomExtensionParts/consultGuard.ts";
import { pgrepSelfMatchPart } from "./loomExtensionParts/pgrepSelfMatch.ts";
import { promptDebugPart } from "./loomExtensionParts/promptDebug.ts";
import { searchGuardPart } from "./loomExtensionParts/searchGuard.ts";
import { systemHeadPart } from "./loomExtensionParts/systemHead.ts";
import { T3_MCP_BEARER_ENV, T3_MCP_URL_ENV } from "@t3tools/provider-pi/server/mcpExtensionSource";

export interface LoomExtensionPart {
  readonly name: string;
  readonly source: string;
}

export const LOOM_EXTENSION_FILENAME = "pi-loom-extension.ts";

/** The session profile `GET /loom/agent/session-profile` returns (seam 5). */
export interface LoomSessionProfile {
  /** The role's active set; empty = no role profile (every registered tool minus the deny-list). */
  readonly activeTools: ReadonlyArray<string>;
  readonly humanEngaged: boolean;
  readonly hasParent: boolean;
  readonly denyList: ReadonlyArray<string>;
  readonly promptDebugPath: string | null;
}

const json = JSON.stringify;
const proseOf = (tool: "ask_user_question") => {
  const prose = LOOM_TOOL_PROSE[tool];
  return {
    description: prose.description,
    promptSnippet: prose.promptSnippet,
    promptGuidelines: prose.promptGuidelines.split("\n").filter(Boolean),
  };
};

/**
 * Profile and re-assertion (P3-4) under upstream's deferred exposure: the bridge registers every
 * t3-code tool `deferred`; the role profile (LEAF_CORE + its `toolsets:` families) is activated
 * directly and the rest is reached through pi's `tool_search`. Every turn re-asserts the profile
 * and must keep `tool_search` and every tool a search activated, or discovery is undone.
 */
export const toolProfilePart: LoomExtensionPart = {
  name: "toolProfile",
  source: `
const HUMAN_INPUT = ${json(HUMAN_INPUT)};
let profile;
let warned = false;
const refresh = async (ui) => {
  try {
    profile = await ctx.profile();
    return true;
  } catch (error) {
    if (!warned) {
      warned = true;
      ui?.notify?.("Loom's tool profile is unavailable (" + (error?.message ?? error) + "); this session keeps pi's default tool surface.", "warning");
    }
    return false;
  }
};
// Fails closed: without a profile nobody is known to be reading.
ctx.humanInputRefused = () => !profile || (profile.hasParent && !profile.humanEngaged);
const apply = () => {
  const registered = pi.getAllTools();
  const names = new Set(registered.map((tool) => tool.name));
  const deny = new Set(profile.denyList);
  const allowed = (name) => names.has(name) && !deny.has(name) && !HUMAN_INPUT.includes(name);
  const base = profile.activeTools.length > 0 ? profile.activeTools : [...names];
  // A deferred tool is active only because tool_search (or this function) put it there.
  const active = new Set(pi.getActiveTools());
  const discovered = registered.filter((tool) => tool.exposure === "deferred" && active.has(tool.name)).map((tool) => tool.name);
  ctx.syncHumanInput?.();
  // The background-job tools are active in every profile, like tool_search.
  const wanted = new Set([...[...base, "tool_search", "bg_start", "bg_wait", ...discovered].filter(allowed), ...(ctx.humanInputRefused() ? [] : HUMAN_INPUT)]);
  // pi's order wins for tools already active, newly wanted ones append: pi's <tools> prompt
  // section follows the active order, so a reshuffle alone would patch the prompt for nothing.
  pi.setActiveTools([...new Set([...[...active].filter((name) => wanted.has(name)), ...wanted])]);
};
pi.on("session_start", async (_event, ext) => {
  if (await refresh(ext?.ui)) apply();
});
// Every turn: the profile and humanEngaged win again, but searched-in tools survive.
pi.on("before_agent_start", async (_event, ext) => {
  if (await refresh(ext?.ui)) apply();
});
`,
};

/** `mcp__t3-code__ask_user_question` over `POST …/ask` + `GET …/wait` (25 s slices; a dropped poll re-attaches). */
export const askUserQuestionPart: LoomExtensionPart = {
  name: "askUserQuestion",
  source: `
const prose = ${json(proseOf("ask_user_question"))};
const REFUSAL = ${json(HUMAN_INPUT_REFUSAL)};
// Registered hidden — so tool_search cannot surface it — until a human has written to the
// thread; the profile part's apply() calls syncHumanInput() each turn to re-register it direct.
let askExposure;
const registerAsk = (exposure) => {
  if (askExposure === exposure) return;
  askExposure = exposure;
  pi.registerTool({ ...askTool, exposure });
};
ctx.syncHumanInput = () => registerAsk(ctx.humanInputRefused?.() === false ? "direct" : "hidden");
const askTool = {
  name: ${json(agentToolName("ask_user_question"))},
  label: "Ask User Question",
  ...prose,
  parameters: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: {
          type: "object",
          properties: {
            header: { type: "string", minLength: 1, description: "Short decision title, understandable alone." },
            question: { type: "string", minLength: 1, description: "Markdown body." },
            options: {
              type: "array",
              minItems: 2,
              maxItems: 4,
              items: {
                type: "object",
                properties: {
                  label: { type: "string", minLength: 1, description: "Plain-words outcome. 'Other' and 'Type something.' are reserved." },
                  description: { type: "string", minLength: 1, description: "What this option gains and gives up, not how it works." },
                  recommended: { type: "boolean", description: "Mark exactly one option: your pick and the default on dismissal." },
                },
                required: ["label", "description"],
                additionalProperties: false,
              },
            },
            multiSelect: { type: "boolean", description: "Allow multiple selections. Defaults to false." },
          },
          required: ["header", "question", "options"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  },
  async execute(toolCallId, params, signal) {
    if (ctx.humanInputRefused?.() !== false) throw new Error(REFUSAL);
    const { requestId } = await loomFetch(ctx, "POST", "/user-input/ask", { toolCallId, questions: params?.questions }, signal);
    const wait = "/user-input/" + encodeURIComponent(requestId) + "/wait";
    while (true) {
      let result;
      try {
        result = await loomFetch(ctx, "GET", wait, undefined, signal);
      } catch (error) {
        // The server holds the question; a dropped connection re-attaches. A status is final.
        if (signal?.aborted || error?.status !== undefined) throw error;
        await pause(250, signal);
        continue;
      }
      if (!result.pending) return { content: [{ type: "text", text: result.rendered }], details: undefined };
    }
  },
};
registerAsk("hidden");
`,
};

export const LOOM_EXTENSION_PARTS: ReadonlyArray<LoomExtensionPart> = [
  toolProfilePart,
  askUserQuestionPart,
  searchGuardPart,
  commandGuardsPart,
  pgrepSelfMatchPart,
  promptDebugPart,
  cacheWarmingGatePart,
  consultGuardPart,
  systemHeadPart,
  backgroundJobsPart,
];

export const assembleLoomExtensionSource = (parts: ReadonlyArray<LoomExtensionPart>): string => `\
// Generated by Loom (apps/server/src/provider/Drivers/Pi/loomExtension.ts). Do not edit.
const URL_ENV = ${json(T3_MCP_URL_ENV)};
const TOKEN_ENV = ${json(T3_MCP_BEARER_ENV)};

async function loomFetch(ctx, method, path, body, signal) {
  if (!ctx.endpoint || !ctx.token) throw new Error("Loom's agent routes are unavailable: " + URL_ENV + " or " + TOKEN_ENV + " is missing.");
  const response = await fetch(ctx.endpoint + path, {
    method,
    headers: { authorization: "Bearer " + ctx.token, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  if (!response.ok) {
    const error = new Error(parsed?.message ?? (text || "Loom request " + path + " failed (" + response.status + ")."));
    error.status = response.status;
    throw error;
  }
  return parsed;
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Tool call aborted."));
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("Tool call aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const PARTS = [
${parts.map((part) => `  [${json(part.name)}, (pi, ctx) => {${part.source}}],`).join("\n")}
];

export default function loomExtension(pi) {
  const mcpUrl = process.env[URL_ENV];
  const token = process.env[TOKEN_ENV];
  const ctx = {
    endpoint: mcpUrl ? new URL("/loom/agent", mcpUrl).href : undefined,
    token,
    profile: () => loomFetch(ctx, "GET", "/session-profile"),
  };
  for (const [, part] of PARTS) part(pi, ctx);
}
`;

/** Writes the assembled extension to `<cacheDir>/pi-loom-extension.ts` when its content changed. */
export const materializeLoomExtension = Effect.fn("materializeLoomExtension")(function* (
  cacheDir: string,
  parts: ReadonlyArray<LoomExtensionPart> = LOOM_EXTENSION_PARTS,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(cacheDir, { recursive: true });
  const dest = path.join(cacheDir, LOOM_EXTENSION_FILENAME);
  const source = assembleLoomExtensionSource(parts);
  const existing = yield* fs.readFileString(dest).pipe(Effect.orElseSucceed(() => ""));
  if (existing !== source) yield* fs.writeFileString(dest, source);
  return dest;
});

/** The materialised extension's path, for the composer's `extensions` (3a-5). */
export class LoomExtensionPath extends Context.Service<LoomExtensionPath, string>()(
  "t3/provider/Drivers/Pi/loomExtension/LoomExtensionPath",
) {}

export const LoomExtensionPathLive = Layer.effect(
  LoomExtensionPath,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* materializeLoomExtension(config.providerStatusCacheDir);
  }),
);
