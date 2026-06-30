// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { loadRoleOverlay } from "./roleOverlay.ts";

const fixtureRoot = (): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "role-overlay-"));
  NodeFS.mkdirSync(NodePath.join(root, "roles"));
  NodeFS.writeFileSync(NodePath.join(root, "roles", "orchestrator.md"), "ORCH OVERLAY", "utf8");
  NodeFS.writeFileSync(NodePath.join(root, "roles", "coder.md"), "CODER OVERLAY", "utf8");
  return root;
};

describe("loadRoleOverlay", () => {
  it("defaults a null role to the orchestrator overlay", () => {
    expect(loadRoleOverlay({ role: null, projectRoot: fixtureRoot() })).toBe("ORCH OVERLAY");
  });

  it("loads a named role overlay", () => {
    expect(loadRoleOverlay({ role: "coder", projectRoot: fixtureRoot() })).toBe("CODER OVERLAY");
  });

  it("returns undefined for an unknown role (permissive spawning)", () => {
    expect(loadRoleOverlay({ role: "analyst", projectRoot: fixtureRoot() })).toBeUndefined();
  });

  it("slugifies the role, blocking path traversal", () => {
    // "../coder" → slug "coder" (separators stripped), never escapes roles/.
    expect(loadRoleOverlay({ role: "../coder", projectRoot: fixtureRoot() })).toBe("CODER OVERLAY");
    // A traversal path collapses to a harmless in-dir slug (no `/` survives), so it
    // can only ever resolve a roles/<slug>.md that doesn't exist → undefined.
    expect(
      loadRoleOverlay({ role: "../../etc/passwd", projectRoot: fixtureRoot() }),
    ).toBeUndefined();
  });
});
