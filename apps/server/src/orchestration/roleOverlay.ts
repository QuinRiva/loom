// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const ROLE_OVERLAY_DIR = "roles";
const DEFAULT_ROLE = "orchestrator";

export interface RoleOverlay {
  /** System-prompt overlay text (the markdown body after any frontmatter). */
  readonly prompt?: string;
  /** Skill paths from frontmatter, resolved to absolute paths against projectRoot
   * and passed to pi as repeated `--skill` args (additive to normal discovery). */
  readonly skills?: ReadonlyArray<string>;
  /** Tool-name allowlist from frontmatter, passed to pi as `--tools`. CAVEAT: pi
   * applies the allowlist to extension-registered tools too, so a list that omits
   * the workstream tool names (workstream_report, workstream_set_lane, …) severs
   * the thread from the workstream. Only use `tools` on a role that either lists
   * those names or is deliberately cut off. */
  readonly tools?: ReadonlyArray<string>;
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
      ...(tools.length > 0 ? { tools } : {}),
    };
  } catch {
    return undefined; // ENOENT / unreadable → no overlay (permissive)
  }
};
