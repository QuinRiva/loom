// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { listRoleOverlays, loadRoleOverlay } from "./roleOverlay.ts";

const fixtureRoot = (extraFiles: Record<string, string> = {}): string => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "role-overlay-"));
  NodeFS.mkdirSync(NodePath.join(root, "roles"));
  NodeFS.writeFileSync(NodePath.join(root, "roles", "orchestrator.md"), "ORCH OVERLAY", "utf8");
  NodeFS.writeFileSync(NodePath.join(root, "roles", "coder.md"), "CODER OVERLAY", "utf8");
  for (const [name, content] of Object.entries(extraFiles)) {
    NodeFS.writeFileSync(NodePath.join(root, "roles", name), content, "utf8");
  }
  return root;
};

describe("loadRoleOverlay", () => {
  it("defaults a null role to the orchestrator overlay", () => {
    expect(loadRoleOverlay({ role: null, projectRoot: fixtureRoot() })).toEqual({
      prompt: "ORCH OVERLAY",
    });
  });

  it("loads a named role overlay; no frontmatter → the whole file is the prompt", () => {
    expect(loadRoleOverlay({ role: "coder", projectRoot: fixtureRoot() })).toEqual({
      prompt: "CODER OVERLAY",
    });
  });

  it("returns undefined for an unknown role (permissive spawning)", () => {
    expect(loadRoleOverlay({ role: "analyst", projectRoot: fixtureRoot() })).toBeUndefined();
  });

  it("slugifies the role, blocking path traversal", () => {
    // "../coder" → slug "coder" (separators stripped), never escapes roles/.
    expect(loadRoleOverlay({ role: "../coder", projectRoot: fixtureRoot() })).toEqual({
      prompt: "CODER OVERLAY",
    });
    // A traversal path collapses to a harmless in-dir slug (no `/` survives), so it
    // can only ever resolve a roles/<slug>.md that doesn't exist → undefined.
    expect(
      loadRoleOverlay({ role: "../../etc/passwd", projectRoot: fixtureRoot() }),
    ).toBeUndefined();
  });

  it("parses skills (block list, resolved against projectRoot) and tools (inline list)", () => {
    const root = fixtureRoot({
      "planner.md": [
        "---",
        "skills:",
        "  - skills/mdx-visual-plan",
        "tools: [read, grep, find, ls]",
        "---",
        "PLANNER OVERLAY",
      ].join("\n"),
    });
    expect(loadRoleOverlay({ role: "planner", projectRoot: root })).toEqual({
      prompt: "PLANNER OVERLAY",
      skills: [NodePath.join(root, "skills", "mdx-visual-plan")],
      tools: ["read", "grep", "find", "ls"],
    });
  });

  it("frontmatter keys are each optional; body-only frontmatter file keeps just the prompt", () => {
    const root = fixtureRoot({
      "skilled.md": "---\nskills:\n  - skills/one\n  - skills/two\n---\nBODY",
    });
    expect(loadRoleOverlay({ role: "skilled", projectRoot: root })).toEqual({
      prompt: "BODY",
      skills: [NodePath.join(root, "skills", "one"), NodePath.join(root, "skills", "two")],
    });
  });

  it("returns undefined for an empty file", () => {
    const root = fixtureRoot({ "empty.md": "   \n" });
    expect(loadRoleOverlay({ role: "empty", projectRoot: root })).toBeUndefined();
  });
});

describe("listRoleOverlays", () => {
  it("derives one-line summaries by trimming the identity lead-in; orchestrator first", () => {
    const root = fixtureRoot({
      "orchestrator.md": "You are the orchestrator: plan, delegate, review.\n\nmore body",
      "coder.md": "You are a coder sub-thread. Produce working, verified code.\n\n- bullet",
      "researcher.md":
        "---\ntools: [read]\n---\nYou are a researcher sub-thread. Return the answer, not the path.",
    });
    expect(listRoleOverlays({ projectRoot: root })).toEqual([
      { name: "orchestrator", summary: "plan, delegate, review." },
      { name: "coder", summary: "Produce working, verified code." },
      { name: "researcher", summary: "Return the answer, not the path." },
    ]);
  });

  it("falls back to the whole first line when the lead-in pattern doesn't match", () => {
    const root = fixtureRoot({ "weird.md": "Investigate deeply and report.\n\nrest" });
    expect(listRoleOverlays({ projectRoot: root })).toContainEqual({
      name: "weird",
      summary: "Investigate deeply and report.",
    });
  });

  it("returns [] when the roles dir is absent", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "role-overlay-none-"));
    expect(listRoleOverlays({ projectRoot: root })).toEqual([]);
  });
});
