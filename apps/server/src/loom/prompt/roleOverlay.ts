// @effect-diagnostics nodeBuiltinImport:off
/**
 * A thread's role: the built-in `roles/<role>.md` composed with the project's
 * `.t3code/roles/<role>.md`, giving prompt overlay, skills and active-tool profile.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { LEAF_CORE, TOOLSETS } from "../../mcp/toolkits/workstream/families.ts";

const DEFAULT_ROLE = "orchestrator";
const OVERLAY_DIR = NodePath.join(".t3code", "roles");

/** The running server's own checkout (a dev worktree, or the release directory):
 * five levels above this source file, or three above the `dist/` chunk the
 * bundle inlines it into. Built-in roles and repo skills resolve against it. */
export const LOOM_REPO_ROOT = NodePath.resolve(
  import.meta.dirname,
  import.meta.url.endsWith(".ts") ? "../../../../.." : "../../..",
);

/** The built-in roles ship with the server: `<repo>/roles`. A release without it
 * is a broken install, so the miss fails at import rather than as a roleless
 * thread at launch. */
const BUILTIN_ROLES_DIR = NodePath.join(LOOM_REPO_ROOT, "roles");
if (!NodeFS.existsSync(BUILTIN_ROLES_DIR)) {
  throw new Error(`built-in roles directory missing: ${BUILTIN_ROLES_DIR}`);
}

export interface RoleOverlay {
  /** System-prompt overlay text (the markdown body after any frontmatter). */
  readonly prompt?: string;
  /** Skill paths from frontmatter, resolved to absolute paths (built-in paths
   * against the directory holding `roles/`, project paths against the one
   * holding `.t3code/`) and passed to pi as repeated `--skill` args (additive
   * to normal discovery). */
  readonly skills?: ReadonlyArray<string>;
  /** ACTIVE-tool profile, not an allowlist: unlisted tools stay registered but deferred (reachable via
   * `tool_search`). LEAF_CORE and `toolsets:` families are auto-unioned in, so a role lists only
   * the tools it works with. A role that declares no `tools:` takes the orchestrator's profile. */
  readonly tools: ReadonlyArray<string>;
  /** Whether this role can spawn children: its profile keeps the `delegation` toolset. Gates
   * the roles-catalogue block, so a leaf that later finds delegation via `tool_search` sees only the
   * built-in role names on the spawn tools' `role` parameter. */
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

/** The nearest `.t3code/roles/` at or above `projectRoot`, bounded by the repo top level (only
 * `projectRoot` outside a repo). The nearest wins: a role it lacks means no addition. */
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
 * Built-in and project roles, each summarised from its first body line with the `You are a <role>
 * sub-thread.` / `You are the orchestrator:` lead-in trimmed (whole line if unmatched).
 * Orchestrator first, the rest alphabetical; read fresh each call.
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
 * Read fresh at session start; the body is the prompt overlay. No role means the orchestrator. A
 * role without `tools:` (a project role naming none, a free-text role) takes the orchestrator's
 * profile, or pi declares every registered tool. Slugified to `[a-z0-9-]`, blocking traversal.
 */
export const loadRoleOverlay = (
  input: RoleLookup & { readonly role: string | null },
): RoleOverlay => {
  const slug =
    (input.role ?? DEFAULT_ROLE)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "") || DEFAULT_ROLE;
  const builtinDir = input.builtinDir ?? BUILTIN_ROLES_DIR;
  const overlayDir = findOverlayDir(input.projectRoot);
  const role = composeRole(slug, builtinDir, overlayDir);
  const { tools, toolsets } = role?.tools.length
    ? role
    : composeRole(DEFAULT_ROLE, builtinDir, overlayDir)!;
  // Unknown toolset names are ignored: a typo costs the role that family until
  // the frontmatter is fixed, exactly as an unknown tool name does in pi.
  const resident = toolsets.flatMap((name) => TOOLSETS[name as keyof typeof TOOLSETS] ?? []);
  return {
    ...(role?.prompt ? { prompt: role.prompt } : {}),
    ...(role?.skills.length ? { skills: role.skills } : {}),
    tools: [...new Set([...tools, ...LEAF_CORE, ...resident])],
    delegation: toolsets.includes("delegation"),
  };
};
