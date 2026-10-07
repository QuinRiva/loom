/**
 * Loom's pi extension: one file assembled from named parts and loaded by the
 * composer as the `--extension` before upstream's bridge (DR-13). It reads
 * upstream's `T3_MCP_URL` / `T3_MCP_BEARER_TOKEN` and talks to the two REST
 * survivors beside `/mcp` (P3-3, `loom/http/loomAgentRoutes.ts`). Parts here:
 * `toolProfile` (the session profile applied at `session_start` and re-asserted
 * at every `before_agent_start`, P3-4; `mcp__t3-code__enable_toolset`) and
 * `askUserQuestion` (`mcp__t3-code__ask_user_question` over ask + long-poll),
 * then 3c's `search-guard` and `prompt-debug` (`loomExtensionParts/`).
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
import { DELEGATION_TOOLSET_DIGEST, HUMAN_INPUT_REFUSAL } from "../../../loom/prompt/prose.ts";
import {
  agentToolName,
  DORMANT_TOOLSETS,
  ENABLE_TOOLSET_TOOL,
  HUMAN_INPUT,
  UPSTREAM_WITHHELD_TOOLS,
} from "../../../mcp/toolkits/workstream/families.ts";
import { LOOM_TOOL_PROSE } from "../../../mcp/toolkits/workstream/prose.ts";
import { promptDebugPart } from "./loomExtensionParts/promptDebug.ts";
import { searchGuardPart } from "./loomExtensionParts/searchGuard.ts";
import {
  T3_MCP_BEARER_ENV,
  T3_MCP_URL_ENV,
} from "../../../orchestration-v2/Adapters/piT3McpExtensionSource.ts";

export interface LoomExtensionPart {
  readonly name: string;
  readonly source: string;
}

export const LOOM_EXTENSION_FILENAME = "pi-loom-extension.ts";

/** The session profile `GET /loom/agent/session-profile` returns (seam 5). */
export interface LoomSessionProfile {
  /** The role's active set; empty = no role profile (every registered tool minus the deny-list). */
  readonly activeTools: ReadonlyArray<string>;
  readonly families: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly humanEngaged: boolean;
  readonly hasParent: boolean;
  readonly denyList: ReadonlyArray<string>;
  readonly promptDebugPath: string | null;
}

const json = JSON.stringify;
const proseOf = (tool: "enable_toolset" | "ask_user_question") => {
  const prose = LOOM_TOOL_PROSE[tool];
  return {
    description: prose.description,
    promptSnippet: prose.promptSnippet,
    promptGuidelines: prose.promptGuidelines.split("\n").filter(Boolean),
  };
};

export const TOOLSET_FAMILIES = [
  "delegation",
  "human-input",
  "pull-requests",
  "browser",
  "studio",
  "all",
] as const;

/** Profile, re-assertion and `mcp__t3-code__enable_toolset` (P3-4, P3-5). */
export const toolProfilePart: LoomExtensionPart = {
  name: "toolProfile",
  source: `
const FAMILIES = ${json(DORMANT_TOOLSETS)};
const DENY = ${json(UPSTREAM_WITHHELD_TOOLS)};
const HUMAN_INPUT = ${json(HUMAN_INPUT)};
const DIGESTS = ${json({ delegation: DELEGATION_TOOLSET_DIGEST })};
const REFUSAL = ${json(HUMAN_INPUT_REFUSAL)};
const BROWSER_PREFIXES = ["browser_", ${json(agentToolName("preview_"))}, ${json(agentToolName("t3_preview_"))}];
const enabled = new Set();
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
const humanInputRefused = () => !profile || (profile.hasParent && !profile.humanEngaged);
const apply = () => {
  const deny = new Set(profile.denyList);
  const base = profile.activeTools.length > 0
    ? profile.activeTools
    : pi.getAllTools().map((tool) => tool.name).filter((name) => !deny.has(name) && !HUMAN_INPUT.includes(name));
  pi.setActiveTools([...new Set([...base, ...enabled, ...(profile.humanEngaged ? HUMAN_INPUT : [])])]);
};
pi.on("session_start", async (_event, ext) => {
  if (await refresh(ext?.ui)) apply();
});
// Every turn: a tool upstream's bridge registered late (its session_start retry) is active on
// registration; the profile, this session's enabled families and humanEngaged win again.
pi.on("before_agent_start", async (_event, ext) => {
  if (await refresh(ext?.ui)) apply();
});
const prose = ${json(proseOf("enable_toolset"))};
pi.registerTool({
  name: ${json(ENABLE_TOOLSET_TOOL)},
  label: "Enable Dormant Toolset",
  ...prose,
  parameters: {
    type: "object",
    properties: { family: { type: "string", enum: ${json(TOOLSET_FAMILIES)} } },
    required: ["family"],
    additionalProperties: false,
  },
  // Verified against pi's post-set active list, not against what was asked: a family with
  // nothing activatable throws, because a success-shaped answer sends the model into dead calls.
  async execute(_toolCallId, params) {
    const family = params?.family;
    if (family === "human-input" && humanInputRefused()) throw new Error(REFUSAL);
    const registered = pi.getAllTools().map((tool) => tool.name);
    const deny = new Set(profile?.denyList ?? DENY);
    const requested = family === "all"
      ? registered.filter((name) => !deny.has(name) && !(humanInputRefused() && HUMAN_INPUT.includes(name)))
      : family === "browser"
        ? registered.filter((name) => BROWSER_PREFIXES.some((prefix) => name.startsWith(prefix)))
        : family === "studio"
          ? registered.filter((name) => name.startsWith("studio_"))
          : (FAMILIES[family] ?? []);
    const active = pi.getActiveTools();
    const added = requested.filter((name) => registered.includes(name) && !active.includes(name));
    if (added.length > 0) pi.setActiveTools([...active, ...added]);
    const nowActive = new Set(pi.getActiveTools());
    const verified = requested.filter((name) => nowActive.has(name));
    const failed = requested.filter((name) => !nowActive.has(name));
    if (verified.length === 0) {
      throw new Error(
        "Could not enable the " + family + " toolset: " + (requested.length === 0
          ? "no tool of that family is registered in this pi session"
          : "pi did not activate " + failed.join(", ")) +
        ". The family is unavailable in this session — do not retry it; work without it or report the blocker (${agentToolName("workstream_request_attention")}, or your ${agentToolName("workstream_submit")})."
      );
    }
    for (const name of verified) enabled.add(name);
    const newlyEnabled = added.filter((name) => nowActive.has(name));
    const parts = [newlyEnabled.length > 0
      ? "Enabled the " + family + " toolset (" + newlyEnabled.length + "): " + newlyEnabled.join(", ") + ". Verified active; callable from your next step, with their own guidelines."
      : "The " + family + " toolset (" + verified.length + ") was already active."];
    if (failed.length > 0) parts.push("NOT enabled (not registered in this session): " + failed.join(", ") + ".");
    if (newlyEnabled.length > 0 && DIGESTS[family]) parts.push(DIGESTS[family]);
    return { content: [{ type: "text", text: parts.join("\\n\\n") }], details: undefined };
  },
});
`,
};

/** `mcp__t3-code__ask_user_question` over `POST …/ask` + `GET …/wait` (25 s slices; a dropped poll re-attaches). */
export const askUserQuestionPart: LoomExtensionPart = {
  name: "askUserQuestion",
  source: `
const prose = ${json(proseOf("ask_user_question"))};
pi.registerTool({
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
});
`,
};

export const LOOM_EXTENSION_PARTS: ReadonlyArray<LoomExtensionPart> = [
  toolProfilePart,
  askUserQuestionPart,
  searchGuardPart,
  promptDebugPart,
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
