// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const ROLE_OVERLAY_DIR = "roles";
const DEFAULT_ROLE = "orchestrator";

/**
 * Resolve a thread role to its system-prompt overlay, read fresh from
 * `<projectRoot>/roles/<role>.md` at session start (no cache — editable without a
 * rebuild). null/empty role → the root orchestrator. A free-string/unknown role
 * whose file is absent yields `undefined` (permissive spawning). Role is
 * slugified to `[a-z0-9-]`, which also blocks path traversal.
 */
export const loadRoleOverlay = (input: {
  readonly role: string | null;
  readonly projectRoot: string;
}): string | undefined => {
  const slug = (input.role ?? DEFAULT_ROLE)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  if (slug.length === 0) return undefined;
  try {
    const text = NodeFS.readFileSync(
      NodePath.join(input.projectRoot, ROLE_OVERLAY_DIR, `${slug}.md`),
      "utf8",
    ).trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined; // ENOENT / unreadable → no overlay (permissive)
  }
};
