// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  DELEGATION_PROVIDER_TOOLS,
  HUMAN_INPUT_PROVIDER_TOOLS,
  LEAF_CORE_PROVIDER_TOOLS,
} from "../mcp/toolPaths.ts";
import { listRoleOverlays, loadRoleOverlay } from "./roleOverlay.ts";

/** What the loader auto-unions into every restricted role allowlist. */
const LIFELINE = [...LEAF_CORE_PROVIDER_TOOLS, "enable_toolset"];

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
      delegation: true,
    });
  });

  it("loads a named role overlay; no frontmatter → the whole file is the prompt", () => {
    // No `tools:` restriction at all → full surface → delegation-capable.
    expect(loadRoleOverlay({ role: "coder", projectRoot: fixtureRoot() })).toEqual({
      prompt: "CODER OVERLAY",
      delegation: true,
    });
  });

  it("returns undefined for an unknown role (permissive spawning)", () => {
    expect(loadRoleOverlay({ role: "analyst", projectRoot: fixtureRoot() })).toBeUndefined();
  });

  it("slugifies the role, blocking path traversal", () => {
    // "../coder" → slug "coder" (separators stripped), never escapes roles/.
    expect(loadRoleOverlay({ role: "../coder", projectRoot: fixtureRoot() })).toEqual({
      prompt: "CODER OVERLAY",
      delegation: true,
    });
    // A traversal path collapses to a harmless in-dir slug (no `/` survives), so it
    // can only ever resolve a roles/<slug>.md that doesn't exist → undefined.
    expect(
      loadRoleOverlay({ role: "../../etc/passwd", projectRoot: fixtureRoot() }),
    ).toBeUndefined();
  });

  it("parses skills (block list, resolved against projectRoot) and tools (inline list, lifeline-unioned)", () => {
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
      tools: ["read", "grep", "find", "ls", ...LIFELINE],
      delegation: false,
    });
  });

  it("auto-unions the leaf lifeline (leaf-core + enable_toolset) without duplicating, and nothing more", () => {
    const root = fixtureRoot({
      "assessor.md": "---\ntools: [read_full, workstream_submit]\n---\nASSESSOR OVERLAY",
    });
    const overlay = loadRoleOverlay({ role: "assessor", projectRoot: root });
    expect([...(overlay?.tools ?? [])].sort()).toEqual(["read_full", ...LIFELINE].sort());
    // Every lifeline tool present exactly once, even when the role names one itself.
    expect(overlay?.tools?.filter((tool) => tool === "workstream_submit")).toHaveLength(1);
    // The dormant families are NOT resident for a role that doesn't name them.
    for (const dormant of [...DELEGATION_PROVIDER_TOOLS, ...HUMAN_INPUT_PROVIDER_TOOLS]) {
      expect(overlay?.tools).not.toContain(dormant);
    }
  });

  it("unions the families named in `toolsets:` and reports the delegation capability", () => {
    const root = fixtureRoot({
      "orchestrator.md": [
        "---",
        "tools: [read, bash]",
        "toolsets: [delegation, human-input]",
        "---",
        "ORCH OVERLAY",
      ].join("\n"),
    });
    const overlay = loadRoleOverlay({ role: "orchestrator", projectRoot: root });
    expect([...(overlay?.tools ?? [])].sort()).toEqual(
      [
        "read",
        "bash",
        ...LIFELINE,
        ...DELEGATION_PROVIDER_TOOLS,
        ...HUMAN_INPUT_PROVIDER_TOOLS,
      ].sort(),
    );
    expect(overlay?.delegation).toBe(true);
  });

  // The role files' allowlists are long, and `vp check --fix` reformats them:
  // prettier's canonical form for a long flow sequence puts the bracket block on
  // the lines AFTER the key. Both wrap shapes must parse, or a reformat silently
  // drops the whole allowlist and the role reverts to every registered tool.
  it.each([
    ["hand-wrapped", ["tools: [read, bash,", "  edit, write,", "  fd, rg]"]],
    [
      "prettier-expanded",
      [
        "tools:",
        "  [",
        "    read,",
        "    bash,",
        "    edit,",
        "    write,",
        "    fd,",
        "    rg,",
        "  ]",
      ],
    ],
  ])("parses a %s inline `tools:` list", (_shape, frontmatter) => {
    const root = fixtureRoot({
      "shipper.md": ["---", ...frontmatter, "---", "SHIP"].join("\n"),
    });
    const overlay = loadRoleOverlay({ role: "shipper", projectRoot: root });
    expect([...(overlay?.tools ?? [])].sort()).toEqual(
      ["read", "bash", "edit", "write", "fd", "rg", ...LIFELINE].sort(),
    );
  });

  it("parses `toolsets:` as a block list too, and ignores unknown family names", () => {
    const root = fixtureRoot({
      "reviewer.md": [
        "---",
        "tools: [read]",
        "toolsets:",
        "  - human-input",
        "  - teleportation",
        "---",
        "REVIEWER OVERLAY",
      ].join("\n"),
    });
    const overlay = loadRoleOverlay({ role: "reviewer", projectRoot: root });
    expect([...(overlay?.tools ?? [])].sort()).toEqual(
      ["read", ...LIFELINE, ...HUMAN_INPUT_PROVIDER_TOOLS].sort(),
    );
    // human-input alone is not delegation.
    expect(overlay?.delegation).toBe(false);
  });

  it("frontmatter keys are each optional; body-only frontmatter file keeps just the prompt", () => {
    const root = fixtureRoot({
      "skilled.md": "---\nskills:\n  - skills/one\n  - skills/two\n---\nBODY",
    });
    expect(loadRoleOverlay({ role: "skilled", projectRoot: root })).toEqual({
      prompt: "BODY",
      skills: [NodePath.join(root, "skills", "one"), NodePath.join(root, "skills", "two")],
      delegation: true,
    });
  });

  it("returns undefined for an unknown (free-text) role — the reactor treats that as capable", () => {
    // Documented pairing with ProviderCommandReactor: `undefined` overlay means
    // no allowlist, so the thread keeps workstream_spawn and the roles catalogue.
    expect(loadRoleOverlay({ role: "data-wrangler", projectRoot: fixtureRoot() })).toBeUndefined();
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
