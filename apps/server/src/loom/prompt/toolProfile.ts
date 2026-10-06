// @effect-diagnostics nodeBuiltinImport:off - a stub over the shipped role files, read per call.
/**
 * The session profile's active set for a thread's role (seam 5). STUB until
 * 3a-5 lands `roleOverlay.ts`: built-in `roles/<role>.md` only (no project
 * `.t3code/roles/` overlay), its `tools:` ∪ the lifeline (leaf core +
 * `enable_toolset`) ∪ the families its `toolsets:` names. A role with no
 * `tools:` has no profile: `[]`, which the extension reads as every registered
 * tool minus the deny-list. 3a-5 provides the real one (re-point in
 * `loom/serverLayers.ts`); null role = the root orchestrator, as V1.
 *
 * @module loom/prompt/toolProfile
 */
import * as Context from "effect/Context";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  DORMANT_TOOLSETS,
  ENABLE_TOOLSET_TOOL,
  LEAF_CORE,
} from "../../mcp/toolkits/workstream/families.ts";

export interface LoomToolProfileShape {
  readonly activeTools: (input: {
    readonly role: string | null;
    /** The thread's checkout, for a project's `.t3code/roles/` (unused by the stub). */
    readonly projectRoot: string | null;
  }) => ReadonlyArray<string>;
}

const BUILTIN_ROLES_DIR = NodePath.resolve(
  import.meta.dirname,
  import.meta.url.endsWith(".ts") ? "../../../../.." : "../../..",
  "roles",
);

const frontmatterList = (frontmatter: string, key: string) =>
  new RegExp(`^${key}:\\s*\\[([^\\]]*)\\]`, "m")
    .exec(frontmatter)?.[1]
    ?.split(",")
    .map((entry) => entry.trim())
    .filter(Boolean) ?? [];

export const builtinRoleToolProfile: LoomToolProfileShape = {
  activeTools: ({ role }) => {
    const slug = (role ?? "orchestrator").toLowerCase().replace(/[^a-z0-9-]/g, "");
    const file = NodePath.join(BUILTIN_ROLES_DIR, `${slug}.md`);
    const frontmatter = NodeFS.existsSync(file)
      ? (/^---\r?\n([\s\S]*?)\r?\n---/.exec(NodeFS.readFileSync(file, "utf8"))?.[1] ?? "")
      : "";
    const tools = frontmatterList(frontmatter, "tools");
    if (tools.length === 0) return [];
    const resident = frontmatterList(frontmatter, "toolsets").flatMap(
      (name) => DORMANT_TOOLSETS[name as keyof typeof DORMANT_TOOLSETS] ?? [],
    );
    return [...new Set([...tools, ...LEAF_CORE, ENABLE_TOOLSET_TOOL, ...resident])];
  },
};

export class LoomToolProfile extends Context.Reference<LoomToolProfileShape>(
  "loom/prompt/LoomToolProfile",
  { defaultValue: () => builtinRoleToolProfile },
) {}
