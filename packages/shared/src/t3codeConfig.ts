// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * Raw text of the nearest `.t3code/<name>`, walking up from `cwd` — the one
 * resolution every per-project `.t3code/` config shares (`ship.json`,
 * `links.json`), so a config at the repo root also governs a project rooted in
 * a subdirectory of it. Undefined when no ancestor has the file.
 */
export function readT3codeConfig(cwd: string, name: string): string | undefined {
  for (let dir = NodePath.resolve(cwd); ; dir = NodePath.dirname(dir)) {
    try {
      return NodeFS.readFileSync(NodePath.join(dir, ".t3code", name), "utf8");
    } catch {
      if (NodePath.dirname(dir) === dir) return undefined;
    }
  }
}

/**
 * The project's reference-link rules from `.t3code/links.json`
 * (`{ "links": [{ "pattern": "...", "url": "...$1..." }] }`), in priority order.
 * Missing or malformed → none; never throws.
 */
export function resolveReferenceLinks(
  cwd: string,
): ReadonlyArray<{ readonly pattern: string; readonly url: string }> | undefined {
  try {
    const links = (JSON.parse(readT3codeConfig(cwd, "links.json") ?? "{}") as { links?: unknown })
      .links;
    return Array.isArray(links)
      ? links.filter(
          (link): link is { pattern: string; url: string } =>
            typeof link?.pattern === "string" && typeof link?.url === "string",
        )
      : undefined;
  } catch {
    return undefined;
  }
}
