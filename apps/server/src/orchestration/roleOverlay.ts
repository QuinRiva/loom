// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { PROVIDER_TOOL_PATHS } from "../mcp/toolPaths.ts";

const ROLE_OVERLAY_DIR = "roles";
const DEFAULT_ROLE = "orchestrator";

/** The lifeline tools every workstream thread must keep: the provider-tool
 * extension's full name set (workstream_*, goal_*, consult_thread, …), sourced
 * from the same table the extension is generated from — a tool added there
 * automatically joins this union. */
const LIFELINE_TOOLS: ReadonlyArray<string> = Object.keys(PROVIDER_TOOL_PATHS);

export interface RoleOverlay {
  /** System-prompt overlay text (the markdown body after any frontmatter). */
  readonly prompt?: string;
  /** Skill paths from frontmatter, resolved to absolute paths against projectRoot
   * and passed to pi as repeated `--skill` args (additive to normal discovery). */
  readonly skills?: ReadonlyArray<string>;
  /** Tool-name allowlist from frontmatter, passed to pi as `--tools`. pi applies
   * the allowlist to extension-registered tools too, so the loader auto-unions
   * the workstream + goal extension tool names (PROVIDER_TOOL_PATHS) into any
   * role `tools:` list — a role restricts its working tools without losing its
   * lifeline to the workstream. Role files therefore list only the tools the
   * role actually works with. */
  readonly tools?: ReadonlyArray<string>;
}

export interface RoleSummary {
  readonly name: string;
  /** One-line summary derived from the role file's first non-empty body line. */
  readonly summary: string;
}

/**
 * Minimal frontmatter parser for the two known role keys (`skills`, `tools`).
 * Supports inline arrays (`tools: [read, grep]`) and block lists (`- item`).
 * A file without a leading `---` block is all body, exactly as before.
 */
const parseRoleFile = (
  raw: string,
): { body: string; skills: ReadonlyArray<string>; tools: ReadonlyArray<string> } => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) return { body: raw, skills: [], tools: [] };
  const lists: Record<string, Array<string>> = {};
  const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, "");
  let current: Array<string> | undefined;
  for (const line of match[1]!.split(/\r?\n/)) {
    const key = /^(skills|tools):\s*(.*)$/.exec(line);
    const item = key ? undefined : /^\s*-\s+(.+)$/.exec(line);
    if (key) {
      const inline = key[2]!.trim();
      current = lists[key[1]!] = inline.startsWith("[")
        ? inline
            .replace(/^\[|\]$/g, "")
            .split(",")
            .map(unquote)
            .filter(Boolean)
        : [];
    } else if (item && current) {
      current.push(unquote(item[1]!));
    } else if (line.trim().length > 0) {
      current = undefined; // any other key/content ends the active list
    }
  }
  return { body: raw.slice(match[0].length), skills: lists.skills ?? [], tools: lists.tools ?? [] };
};

/**
 * Resolve a thread role to its overlay, read fresh from
 * `<projectRoot>/roles/<role>.md` at session start (no cache — editable without a
 * rebuild). The file may open with YAML frontmatter carrying `skills` (paths,
 * resolved against projectRoot) and `tools` (pi tool-name allowlist); the rest is
 * the system-prompt overlay. null/empty role → the root orchestrator. A
 * free-string/unknown role whose file is absent yields `undefined` (permissive
 * spawning). Role is slugified to `[a-z0-9-]`, which also blocks path traversal.
 */
/**
 * Enumerate the defined roles (`roles/*.md`), each with a one-line summary
 * derived from the file's first non-empty body line (after any frontmatter).
 * Each role file opens with `You are a <role> sub-thread. <summary>` or `You are
 * the orchestrator: <summary>`; the identity lead-in is trimmed and the
 * substantive remainder used, degrading to the whole first line when the pattern
 * doesn't match. orchestrator is listed first, the rest alphabetically. Reading
 * fresh each call (no cache) mirrors `loadRoleOverlay`.
 */
export const listRoleOverlays = (input: {
  readonly projectRoot: string;
}): ReadonlyArray<RoleSummary> => {
  const dir = NodePath.join(input.projectRoot, ROLE_OVERLAY_DIR);
  let files: ReadonlyArray<string>;
  try {
    files = NodeFS.readdirSync(dir).filter((file) => file.endsWith(".md"));
  } catch {
    return []; // roles dir absent/unreadable → no catalogue
  }
  const summaries = files.flatMap((file) => {
    let raw: string;
    try {
      raw = NodeFS.readFileSync(NodePath.join(dir, file), "utf8");
    } catch {
      return [];
    }
    const firstLine = parseRoleFile(raw)
      .body.split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim();
    if (!firstLine) return [];
    // Strip the identity lead-in; `.replace` returns firstLine unchanged (the
    // graceful fallback) when the pattern doesn't match.
    const summary = firstLine.replace(/^You are (?:a|an|the) .*?(?:sub-thread\.|:)\s*/, "");
    return [{ name: file.slice(0, -3), summary }];
  });
  return summaries.sort((a, b) =>
    a.name === DEFAULT_ROLE ? -1 : b.name === DEFAULT_ROLE ? 1 : a.name.localeCompare(b.name),
  );
};

export const loadRoleOverlay = (input: {
  readonly role: string | null;
  readonly projectRoot: string;
}): RoleOverlay | undefined => {
  const slug = (input.role ?? DEFAULT_ROLE)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  if (slug.length === 0) return undefined;
  try {
    const raw = NodeFS.readFileSync(
      NodePath.join(input.projectRoot, ROLE_OVERLAY_DIR, `${slug}.md`),
      "utf8",
    );
    const { body, skills, tools } = parseRoleFile(raw);
    const prompt = body.trim();
    if (prompt.length === 0 && skills.length === 0 && tools.length === 0) return undefined;
    return {
      ...(prompt.length > 0 ? { prompt } : {}),
      ...(skills.length > 0
        ? { skills: skills.map((skill) => NodePath.resolve(input.projectRoot, skill)) }
        : {}),
      ...(tools.length > 0 ? { tools: [...new Set([...tools, ...LIFELINE_TOOLS])] } : {}),
    };
  } catch {
    return undefined; // ENOENT / unreadable → no overlay (permissive)
  }
};
