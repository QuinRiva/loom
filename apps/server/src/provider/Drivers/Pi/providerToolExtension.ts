// @effect-diagnostics nodeBuiltinImport:off
// LOOM-ONLY. Generates the pi provider-tool extension from the typed tool-def
// tables. The emitted `.mjs` is a generic POST-and-print shim: it reads
// T3_WORKSTREAM_ENDPOINT + T3_WORKSTREAM_AUTHORIZATION once, and for each
// serialised def registers a tool whose execute() POSTs to endpoint + def.path,
// prints `result.rendered` (server-rendered text; the single source of truth),
// and honours the per-tool errorMode. All 17 tools' metadata lives as data in
// providerToolDefs.ts — no logic is embedded in the string.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  GOAL_TOOL_DEFS,
  WORKSTREAM_TOOL_DEFS,
  withPath,
  type ProviderToolDef,
} from "./providerToolDefs.ts";

const EXTENSION_FILE = "t3-provider-tools-extension.mjs";
// Legacy per-domain files superseded by the single merged extension above.
const LEGACY_EXTENSION_FILES = ["t3-workstream-spawn-extension.mjs", "t3-goal-task-extension.mjs"];

/**
 * Emit the full extension source for the given tool defs. The defs (with their
 * route paths attached) are serialised as JSON; the runtime is a fixed generic
 * shim that closes over that data. Exported so a test can build → import → drive
 * it with a stub `pi`/`fetch`.
 */
export const buildProviderToolExtensionSource = (defs: ReadonlyArray<ProviderToolDef>): string => {
  const serialised = JSON.stringify(defs.map(withPath), null, 2);
  return `export const TOOL_DEFS = ${serialised};

export default function(pi) {
  const call = async (path, params, signal, errorMode) => {
    const endpoint = process.env.T3_WORKSTREAM_ENDPOINT;
    const authorization = process.env.T3_WORKSTREAM_AUTHORIZATION;
    if (!endpoint || !authorization) {
      if (errorMode === "throw") {
        throw new Error("T3 Workstream tools are not available in this session.");
      }
      return { ok: false, error: { content: [{ type: "text", text: "T3 Workstream tools are not available in this session." }], details: { ok: false, reason: "missing_endpoint" } } };
    }
    const response = await fetch(endpoint + path, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify(params ?? {}),
      signal
    });
    const text = await response.text();
    let result;
    try { result = text ? JSON.parse(text) : null; } catch { result = null; }
    if (!response.ok) {
      const message = result?.message ?? (text || ("T3 Workstream request failed (" + response.status + ")."));
      if (errorMode === "throw") throw new Error(message);
      return { ok: false, error: { content: [{ type: "text", text: message }], details: { ok: false, status: response.status, response: result ?? text } } };
    }
    return { ok: true, result };
  };

  for (const def of TOOL_DEFS) {
    pi.registerTool({
      name: def.name,
      label: def.label,
      description: def.description,
      promptSnippet: def.promptSnippet,
      promptGuidelines: def.promptGuidelines,
      parameters: def.parameters,
      async execute(_id, params, signal) {
        const outcome = await call(def.path, params, signal, def.errorMode);
        if (!outcome.ok) return outcome.error;
        const result = outcome.result ?? {};
        const text = result.rendered ?? def.fallbackText ?? "";
        return {
          content: [{ type: "text", text }],
          details: { ok: true, ...result }
        };
      }
    });
  }
}
`;
};

/**
 * Write the single merged extension file (workstream + goal tools) and return
 * its path. Written unconditionally so edits to the tool defs propagate to
 * existing state dirs. Stale legacy per-domain files are removed
 * opportunistically so the state dir has exactly one source of tool truth.
 */
export function ensurePiProviderToolExtension(stateDir: string): string {
  const extensionDir = NodePath.join(stateDir, "pi-extensions");
  const extensionPath = NodePath.join(extensionDir, EXTENSION_FILE);
  const source = buildProviderToolExtensionSource([...WORKSTREAM_TOOL_DEFS, ...GOAL_TOOL_DEFS]);
  NodeFS.mkdirSync(extensionDir, { recursive: true });
  NodeFS.writeFileSync(extensionPath, source, "utf8");
  for (const legacy of LEGACY_EXTENSION_FILES) {
    NodeFS.rmSync(NodePath.join(extensionDir, legacy), { force: true });
  }
  return extensionPath;
}
