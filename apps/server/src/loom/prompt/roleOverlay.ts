// @effect-diagnostics nodeBuiltinImport:off
/**
 * A thread's role: the server's built-in `roles/<role>.md` composed with the
 * project's `.t3code/roles/<role>.md` — prompt overlay, skills, and the
 * active-tool profile the session-profile route serves (out of quarantine for
 * pull 9; names are the prefixed `mcp__t3-code__*` forms from `families.ts`).
 *
 * @module loom/prompt/roleOverlay
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  DORMANT_TOOLSETS,
  ENABLE_TOOLSET_TOOL,
  LEAF_CORE,
} from "../../mcp/toolkits/workstream/families.ts";

const DEFAULT_ROLE = "orchestrator";
const OVERLAY_DIR = NodePath.join(".t3code", "roles");

/** The built-in roles ship with the server: `<repo>/roles`, five levels above
 * this source file, or three above the `dist/` chunk the bundle inlines it into.
 * A release without it is a broken install, so the miss fails at import rather
 * than as a roleless thread at launch. */
const BUILTIN_ROLES_DIR = NodePath.resolve(
  import.meta.dirname,
  import.meta.url.endsWith(".ts") ? "../../../../.." : "../../..",
  "roles",
);
if (!NodeFS.existsSync(BUILTIN_ROLES_DIR)) {
  throw new Error(`built-in roles directory missing: ${BUILTIN_ROLES_DIR}`);
}

/** The lifeline every workstream thread must keep ACTIVE: the leaf-core provider
 * tools (completion, attention, orientation, consultation, task-tree upkeep)
 * plus the escalation path out of a lean profile. The dormant families
 * (delegation, human-input, pull-requests) are unioned only for roles that name them in
 * `toolsets:`; unnamed families stay registered and one mcp__t3-code__enable_toolset away. */
export const LIFELINE_TOOLS: ReadonlyArray<string> = [...LEAF_CORE, ENABLE_TOOLSET_TOOL];

export interface RoleOverlay {
  /** System-prompt overlay text (the markdown body after any frontmatter). */
  readonly prompt?: string;
  /** Skill paths from frontmatter, resolved to absolute paths (built-in paths
   * against the directory holding `roles/`, project paths against the one
   * holding `.t3code/`) and passed to pi as repeated `--skill` args (additive
   * to normal discovery). */
  readonly skills?: ReadonlyArray<string>;
  /** ACTIVE-tool profile from frontmatter. Not an allowlist: pi launches with
   * its full tool registry and the provider-tool extension selects this set as
   * the active tools at session start, so unlisted tools stay registered but
   * dormant (activatable mid-session via `mcp__t3-code__enable_toolset`) while pi's
   * selection-conditioned schemas, snippets and guidelines shrink to the
   * profile. The loader auto-unions the LIFELINE_TOOLS into any role `tools:`
   * list — a role narrows its working tools without losing its lifeline to the
   * workstream — plus the families named in `toolsets:`. Role files therefore
   * list only the tools the role actually works with. Absent → no profile →
   * pi's default active surface (every registered tool). */
  readonly tools?: ReadonlyArray<string>;
  /** EFFECTIVE delegation capability: whether this role's launch surface can
   * spawn/manage children. True when the role declares no tool restriction at
   * all (full surface) or names the `delegation` toolset. The composer keys the
   * roles-catalogue block off it, so a leaf that never spawns doesn't carry the
   * catalogue. A leaf that escalates mid-session gets the catalogue pointer from
   * the `mcp__t3-code__enable_toolset` result instead. */
  readonly delegation: boolean;
}

export interface RoleSummary {
  readonly name: string;
  /** One-line summary derived from the role file's first non-empty body line. */
  readonly summary: string;
}

/**
 * Minimal frontmatter parser for the three known role keys (`skills`, `tools`,
 * `toolsets`). Supports inline arrays (`tools: [read, grep]`, which may wrap
 * across lines in any shape prettier produces — role allowlists are long) and
 * block lists (`- item`). A file without a leading `---` block is all body.
 */
const parseRoleFile = (
  raw: string,
): {
  body: string;
  skills: ReadonlyArray<string>;
  tools: ReadonlyArray<string>;
  toolsets: ReadonlyArray<string>;
} => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw);
  if (!match) return { body: raw, skills: [], tools: [], toolsets: [] };
  const lists: Record<string, Array<string>> = {};
  const unquote = (value: string) => value.trim().replace(/^["']|["']$/g, "");
  let current: Array<string> | undefined;
  // Collapse a multi-line inline list back onto its key's line first — including
  // prettier's canonical form for a long list, which puts the whole bracket
  // block on the lines AFTER the key. Without this, a continuation line reads as
  // "other content", ending the list and silently dropping the entire allowlist.
  const frontmatter = match[1]!.replace(/:\s*\[[^\]]*\]/g, (list) => list.replace(/\s+/g, " "));
  for (const line of frontmatter.split(/\r?\n/)) {
    const key = /^(skills|tools|toolsets):\s*(.*)$/.exec(line);
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
  return {
    body: raw.slice(match[0].length),
    skills: lists.skills ?? [],
    tools: lists.tools ?? [],
    toolsets: lists.toolsets ?? [],
  };
};

/** The project's `.t3code/roles/`: the nearest one at or above `projectRoot`,
 * bounded by the repo top level (the first ancestor holding a `.git` entry — a
 * directory, or a worktree's file). Outside any repo only `projectRoot` itself
 * is read. The nearest directory wins: a role it lacks means no addition, not
 * "keep looking". */
const findOverlayDir = (projectRoot: string): string | undefined => {
  const dirs = [NodePath.resolve(projectRoot)];
  while (dirs.at(-1)! !== NodePath.dirname(dirs.at(-1)!)) dirs.push(NodePath.dirname(dirs.at(-1)!));
  const top = dirs.findIndex((dir) => NodeFS.existsSync(NodePath.join(dir, ".git")));
  return dirs
    .slice(0, top + 1 || 1)
    .map((dir) => NodePath.join(dir, OVERLAY_DIR))
    .find((dir) => NodeFS.existsSync(dir));
};

const readRole = (dir: string | undefined, slug: string) => {
  const file = dir && NodePath.join(dir, `${slug}.md`);
  return file && NodeFS.existsSync(file)
    ? parseRoleFile(NodeFS.readFileSync(file, "utf8"))
    : undefined;
};

/** A role is its built-in followed by the project's addition: bodies joined by
 * one blank line; a non-empty project `tools:`/`toolsets:` replaces the
 * built-in's; `skills:` union, each side resolved against its own root. Either
 * side alone is the whole role; neither → undefined. */
const composeRole = (slug: string, builtinDir: string, overlayDir: string | undefined) => {
  const builtin = readRole(builtinDir, slug);
  const project = readRole(overlayDir, slug);
  if (!builtin && !project) return undefined;
  return {
    prompt: [builtin?.body, project?.body]
      .map((body) => body?.trim() ?? "")
      .filter((body) => body.length > 0)
      .join("\n\n"),
    tools: project?.tools.length ? project.tools : (builtin?.tools ?? []),
    toolsets: project?.toolsets.length ? project.toolsets : (builtin?.toolsets ?? []),
    skills: [
      ...(builtin?.skills ?? []).map((skill) => NodePath.resolve(builtinDir, "..", skill)),
      ...(project?.skills ?? []).map((skill) => NodePath.resolve(overlayDir!, "../..", skill)),
    ],
  };
};

interface RoleLookup {
  readonly projectRoot: string;
  /** Test seam; production always reads the server's own `roles/`. */
  readonly builtinDir?: string;
}

/**
 * Enumerate the defined roles — the union of the built-ins and the project's
 * `.t3code/roles/` — each with a one-line summary from the composed role's first
 * non-empty body line. Each built-in opens with `You are a <role> sub-thread.
 * <summary>` or `You are the orchestrator: <summary>`; the identity lead-in is
 * trimmed and the substantive remainder used, degrading to the whole first line
 * when the pattern doesn't match. orchestrator is listed first, the rest
 * alphabetically. Read fresh each call (no cache), like `loadRoleOverlay`.
 */
export const listRoleOverlays = (input: RoleLookup): ReadonlyArray<RoleSummary> => {
  const builtinDir = input.builtinDir ?? BUILTIN_ROLES_DIR;
  const overlayDir = findOverlayDir(input.projectRoot);
  const names = new Set(
    [builtinDir, overlayDir]
      .flatMap((dir) => (dir === undefined ? [] : NodeFS.readdirSync(dir)))
      .filter((file) => file.endsWith(".md"))
      .map((file) => file.slice(0, -3)),
  );
  const summaries = [...names].flatMap((name) => {
    const firstLine = composeRole(name, builtinDir, overlayDir)
      ?.prompt.split(/\r?\n/)
      .find((line) => line.trim().length > 0)
      ?.trim();
    // `.replace` returns firstLine unchanged (the graceful fallback) when the
    // identity pattern doesn't match.
    return firstLine
      ? [{ name, summary: firstLine.replace(/^You are (?:a|an|the) .*?(?:sub-thread\.|:)\s*/, "") }]
      : [];
  });
  return summaries.sort((a, b) =>
    a.name === DEFAULT_ROLE ? -1 : b.name === DEFAULT_ROLE ? 1 : a.name.localeCompare(b.name),
  );
};

/**
 * Resolve a thread role to its overlay, read fresh at session start (no cache):
 * the server's built-in `roles/<role>.md` composed with the project's
 * `.t3code/roles/<role>.md` (see `composeRole`). A file may open with YAML
 * frontmatter carrying `skills` (paths), `tools` (the active-tool profile) and
 * `toolsets` (dormant families to keep resident); the rest is the system-prompt
 * overlay. null/empty role → the root orchestrator. A free-text/unknown role
 * with neither file yields `undefined` (permissive spawning: no profile, and the
 * composer treats it as delegation-capable). Role is slugified to `[a-z0-9-]`,
 * which also blocks path traversal.
 */
export const loadRoleOverlay = (
  input: RoleLookup & { readonly role: string | null },
): RoleOverlay | undefined => {
  const slug = (input.role ?? DEFAULT_ROLE)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  if (slug.length === 0) return undefined;
  const role = composeRole(
    slug,
    input.builtinDir ?? BUILTIN_ROLES_DIR,
    findOverlayDir(input.projectRoot),
  );
  if (!role) return undefined;
  const { prompt, skills, tools, toolsets } = role;
  if (prompt.length === 0 && skills.length === 0 && tools.length === 0) return undefined;
  // Unknown toolset names are ignored: a typo costs the role that family until
  // the frontmatter is fixed, exactly as an unknown tool name does in pi.
  const resident = toolsets.flatMap(
    (name) => DORMANT_TOOLSETS[name as keyof typeof DORMANT_TOOLSETS] ?? [],
  );
  return {
    ...(prompt.length > 0 ? { prompt } : {}),
    ...(skills.length > 0 ? { skills } : {}),
    ...(tools.length > 0
      ? { tools: [...new Set([...tools, ...LIFELINE_TOOLS, ...resident])] }
      : {}),
    delegation: tools.length === 0 || toolsets.includes("delegation"),
  };
};
