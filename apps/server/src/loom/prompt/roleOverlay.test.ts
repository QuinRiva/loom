// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  DELEGATION as DELEGATION_PROVIDER_TOOLS,
  HISTORY,
  HUMAN_INPUT as HUMAN_INPUT_PROVIDER_TOOLS,
  LEAF_CORE,
  PULL_REQUESTS,
  SCHEDULING,
} from "../../mcp/toolkits/workstream/families.ts";
import { LOOM_TOOL_DEFS } from "../../mcp/toolkits/workstream/defs.ts";
import { listRoleOverlays, loadRoleOverlay } from "./roleOverlay.ts";

/** What the loader auto-unions into every restricted role allowlist. */
const LIFELINE = [...LEAF_CORE];

/** The fixture orchestrator's profile; every role without `tools:` takes it less scheduling. */
const DEFAULT_PROFILE = ["read", "bash", ...LIFELINE, ...DELEGATION_PROVIDER_TOOLS, ...HISTORY];
const ORCH_PROFILE = [...DEFAULT_PROFILE, ...SCHEDULING];

/**
 * `<tmp>/builtin/` stands in for the server's roles (orchestrator with a profile, and a
 * profile-less coder, always present); `<tmp>/repo/` is a git checkout (empty `.git` file, as a
 * worktree carries) with an optional `.t3code/roles/`; `<tmp>/repo/sub/dir` is
 * the project root a thread launches from.
 */
const fixture = (builtin: Record<string, string> = {}, project?: Record<string, string>) => {
  const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "role-overlay-"));
  const builtinDir = NodePath.join(tmp, "builtin");
  const repo = NodePath.join(tmp, "repo");
  const projectRoot = NodePath.join(repo, "sub", "dir");
  const write = (dir: string, files: Record<string, string>) => {
    NodeFS.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      NodeFS.writeFileSync(NodePath.join(dir, name), content, "utf8");
    }
  };
  write(builtinDir, {
    "orchestrator.md":
      "---\ntools: [read, bash]\ntoolsets: [delegation, history, scheduling]\n---\nORCH OVERLAY",
    "coder.md": "CODER OVERLAY",
    ...builtin,
  });
  NodeFS.mkdirSync(projectRoot, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, ".git"), "", "utf8");
  if (project) write(NodePath.join(repo, ".t3code", "roles"), project);
  const lookup = { projectRoot, builtinDir };
  return { tmp, repo, write, lookup };
};

describe("loadRoleOverlay", () => {
  it.each([null, "!!!"])("defaults a role of %s to the orchestrator", (role) => {
    expect(loadRoleOverlay({ role, ...fixture().lookup })).toEqual({
      prompt: "ORCH OVERLAY",
      tools: ORCH_PROFILE,
      delegation: true,
    });
  });

  it("a role without `tools:` takes the orchestrator's profile less scheduling; no frontmatter → the whole file is the prompt", () => {
    expect(loadRoleOverlay({ role: "coder", ...fixture().lookup })).toEqual({
      prompt: "CODER OVERLAY",
      tools: DEFAULT_PROFILE,
      delegation: true,
    });
  });

  it.each([
    ["an unknown (free-text) role", "data-wrangler", {}],
    ["an empty file", "empty", { "empty.md": "   \n" }],
  ])("%s gets the default profile and no prompt", (_case, role, builtin) => {
    expect(loadRoleOverlay({ role, ...fixture(builtin).lookup })).toEqual({
      tools: DEFAULT_PROFILE,
      delegation: true,
    });
  });

  it("slugifies the role, blocking path traversal", () => {
    // "../coder" → slug "coder" (separators stripped), never escapes roles/.
    expect(loadRoleOverlay({ role: "../coder", ...fixture().lookup }).prompt).toBe("CODER OVERLAY");
    // A traversal path collapses to a harmless in-dir slug (no `/` survives), so it
    // can only ever resolve a roles/<slug>.md that doesn't exist → no prompt.
    expect(
      loadRoleOverlay({ role: "../../etc/passwd", ...fixture().lookup }).prompt,
    ).toBeUndefined();
  });

  it("built-in only: parses skills (block list, resolved against the built-in root) and tools (inline list, lifeline-unioned)", () => {
    const { tmp, lookup } = fixture({
      "planner.md": [
        "---",
        "skills:",
        "  - skills/mdx-visual-plan",
        "tools: [read, grep, find, ls]",
        "---",
        "PLANNER OVERLAY",
      ].join("\n"),
    });
    expect(loadRoleOverlay({ role: "planner", ...lookup })).toEqual({
      prompt: "PLANNER OVERLAY",
      skills: [NodePath.join(tmp, "skills", "mdx-visual-plan")],
      tools: ["read", "grep", "find", "ls", ...LIFELINE],
      delegation: false,
    });
  });

  it("auto-unions the leaf lifeline (leaf-core) without duplicating, and nothing more", () => {
    const { lookup } = fixture({
      "assessor.md":
        "---\ntools: [read_full, mcp__t3-code__workstream_submit]\n---\nASSESSOR OVERLAY",
    });
    const overlay = loadRoleOverlay({ role: "assessor", ...lookup });
    expect([...overlay.tools].sort()).toEqual(["read_full", ...LIFELINE].sort());
    // Every lifeline tool present exactly once, even when the role names one itself.
    expect(overlay.tools.filter((tool) => tool === "mcp__t3-code__workstream_submit")).toHaveLength(
      1,
    );
    // The dormant families are NOT resident for a role that doesn't name them.
    for (const dormant of [
      ...DELEGATION_PROVIDER_TOOLS,
      ...HUMAN_INPUT_PROVIDER_TOOLS,
      ...PULL_REQUESTS,
    ]) {
      expect(overlay.tools).not.toContain(dormant);
    }
  });

  it("unions the families named in `toolsets:` and reports the delegation capability", () => {
    const { lookup } = fixture({
      "orchestrator.md": [
        "---",
        "tools: [read, bash]",
        "toolsets: [delegation, human-input, pull-requests]",
        "---",
        "ORCH OVERLAY",
      ].join("\n"),
    });
    const overlay = loadRoleOverlay({ role: "orchestrator", ...lookup });
    expect([...overlay.tools].sort()).toEqual(
      [
        "read",
        "bash",
        ...LIFELINE,
        ...DELEGATION_PROVIDER_TOOLS,
        ...HUMAN_INPUT_PROVIDER_TOOLS,
        ...PULL_REQUESTS,
      ].sort(),
    );
    expect(overlay.delegation).toBe(true);
  });

  it.each(["orchestrator", "planner", "researcher", "reviewer"])(
    "the built-in %s keeps thread search resident in place of pi's session search",
    (role) => {
      const overlay = loadRoleOverlay({ role, projectRoot: fixture().lookup.projectRoot });
      for (const tool of HISTORY) expect(overlay.tools).toContain(tool);
      for (const tool of ["session_search", "session_list", "session_read"])
        expect(overlay.tools).not.toContain(tool);
    },
  );

  it.each([
    "orchestrator",
    "assessor",
    "coder",
    "planner",
    "researcher",
    "reviewer",
    "shipper",
    "data-wrangler",
  ])("only the built-in orchestrator keeps the scheduled-task tools (%s)", (role) => {
    const tools = loadRoleOverlay({ role, projectRoot: fixture().lookup.projectRoot }).tools;
    for (const tool of SCHEDULING)
      expect(tools.includes(tool), `${role} ${tool}`).toBe(role === "orchestrator");
  });

  // The role files' allowlists are long, and `vp check --fix` reformats them:
  // prettier's canonical form for a long flow sequence puts the bracket block on
  // the lines AFTER the key. Both wrap shapes must parse, or a reformat silently
  // drops the whole allowlist and the role falls back to the default profile.
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
    const { lookup } = fixture({
      "shipper.md": ["---", ...frontmatter, "---", "SHIP"].join("\n"),
    });
    const overlay = loadRoleOverlay({ role: "shipper", ...lookup });
    expect([...overlay.tools].sort()).toEqual(
      ["read", "bash", "edit", "write", "fd", "rg", ...LIFELINE].sort(),
    );
  });

  it("parses `toolsets:` as a block list too, and ignores unknown family names", () => {
    const { lookup } = fixture({
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
    const overlay = loadRoleOverlay({ role: "reviewer", ...lookup });
    expect([...overlay.tools].sort()).toEqual(
      ["read", ...LIFELINE, ...HUMAN_INPUT_PROVIDER_TOOLS].sort(),
    );
    // human-input alone is not delegation.
    expect(overlay.delegation).toBe(false);
  });

  it("frontmatter keys are each optional; body-only frontmatter file keeps just the prompt", () => {
    const { tmp, lookup } = fixture({
      "skilled.md": "---\nskills:\n  - skills/one\n  - skills/two\n---\nBODY",
    });
    expect(loadRoleOverlay({ role: "skilled", ...lookup })).toEqual({
      prompt: "BODY",
      skills: [NodePath.join(tmp, "skills", "one"), NodePath.join(tmp, "skills", "two")],
      tools: DEFAULT_PROFILE,
      delegation: true,
    });
  });
});

describe("listRoleOverlays", () => {
  it("derives one-line summaries by trimming the identity lead-in; orchestrator first", () => {
    const { lookup } = fixture({
      "orchestrator.md": "You are the orchestrator: plan, delegate, review.\n\nmore body",
      "coder.md": "You are a coder sub-thread. Produce working, verified code.\n\n- bullet",
      "researcher.md":
        "---\ntools: [read]\n---\nYou are a researcher sub-thread. Return the answer, not the path.",
    });
    expect(listRoleOverlays(lookup)).toEqual([
      { name: "orchestrator", summary: "plan, delegate, review." },
      { name: "coder", summary: "Produce working, verified code." },
      { name: "researcher", summary: "Return the answer, not the path." },
    ]);
  });

  it("falls back to the whole first line when the lead-in pattern doesn't match", () => {
    const { lookup } = fixture({ "weird.md": "Investigate deeply and report.\n\nrest" });
    expect(listRoleOverlays(lookup)).toContainEqual({
      name: "weird",
      summary: "Investigate deeply and report.",
    });
  });

  it("lists the union of built-in and project roles, summarising the composed role", () => {
    const { lookup } = fixture(
      { "coder.md": "You are a coder sub-thread. Produce working code." },
      { "coder.md": "- project bullet", "slack-inbox.md": "You are the inbox: triage Slack." },
    );
    expect(listRoleOverlays(lookup)).toEqual([
      { name: "orchestrator", summary: "ORCH OVERLAY" },
      { name: "coder", summary: "Produce working code." },
      { name: "slack-inbox", summary: "triage Slack." },
    ]);
  });
});

describe("built-in + project composition", () => {
  it("walks up from the project root to the repo's .t3code/roles, and no further", () => {
    const { tmp, repo, write, lookup } = fixture({}, { "coder.md": "PROJECT CODER" });
    const composed = {
      prompt: "CODER OVERLAY\n\nPROJECT CODER",
      tools: DEFAULT_PROFILE,
      delegation: true,
    };
    expect(loadRoleOverlay({ role: "coder", ...lookup })).toEqual(composed);
    expect(loadRoleOverlay({ role: "coder", ...lookup, projectRoot: repo })).toEqual(composed);

    // Above the `.git` entry is outside the repo: never read.
    const { tmp: other, lookup: bare } = fixture();
    write(NodePath.join(other, ".t3code", "roles"), { "coder.md": "ABOVE THE REPO" });
    expect(loadRoleOverlay({ role: "coder", ...bare }).prompt).toBe("CODER OVERLAY");

    // No `.git` anywhere above: only the project root itself is read.
    const loose = NodePath.join(tmp, "loose");
    write(NodePath.join(loose, ".t3code", "roles"), { "coder.md": "LOOSE" });
    NodeFS.mkdirSync(NodePath.join(loose, "inner"));
    expect(loadRoleOverlay({ role: "coder", ...lookup, projectRoot: loose }).prompt).toBe(
      "CODER OVERLAY\n\nLOOSE",
    );
    expect(
      loadRoleOverlay({ role: "coder", ...lookup, projectRoot: NodePath.join(loose, "inner") })
        .prompt,
    ).toBe("CODER OVERLAY");
  });

  it("appends the project body after the built-in's, identity line first", () => {
    const { lookup } = fixture(
      { "coder.md": "You are a coder sub-thread. Ship it.\n\n- built-in bullet\n" },
      { "coder.md": "\n- project bullet\n" },
    );
    expect(loadRoleOverlay({ role: "coder", ...lookup }).prompt).toBe(
      "You are a coder sub-thread. Ship it.\n\n- built-in bullet\n\n- project bullet",
    );
  });

  it("project tools: replace the built-in's (lifeline kept); skills: union, each against its own root", () => {
    const { tmp, repo, lookup } = fixture(
      { "reviewer.md": "---\nskills: [skills/a]\ntools: [read, bash]\n---\nREVIEW" },
      { "reviewer.md": "---\nskills: [skills/b]\ntools: [read_full]\n---\n- extra" },
    );
    expect(loadRoleOverlay({ role: "reviewer", ...lookup })).toEqual({
      prompt: "REVIEW\n\n- extra",
      skills: [NodePath.join(tmp, "skills", "a"), NodePath.join(repo, "skills", "b")],
      tools: ["read_full", ...LIFELINE],
      delegation: false,
    });
  });

  it("a project file without frontmatter keeps the built-in's profile", () => {
    const { lookup } = fixture(
      { "reviewer.md": "---\ntools: [read, bash]\ntoolsets: [human-input]\n---\nREVIEW" },
      { "reviewer.md": "- extra" },
    );
    expect(loadRoleOverlay({ role: "reviewer", ...lookup }).tools).toEqual([
      "read",
      "bash",
      ...LIFELINE,
      ...HUMAN_INPUT_PROVIDER_TOOLS,
    ]);
  });

  it("a project-only role is the whole role, with the default profile when it names no tools", () => {
    const { tmp, lookup } = fixture(
      {},
      { "slack-inbox.md": "---\nskills: [skills/inbox]\n---\nINBOX" },
    );
    expect(loadRoleOverlay({ role: "slack-inbox", ...lookup })).toEqual({
      prompt: "INBOX",
      skills: [NodePath.join(tmp, "repo", "skills", "inbox")],
      tools: DEFAULT_PROFILE,
      delegation: true,
    });
  });

  it("the default profile is the project's composed orchestrator", () => {
    const { lookup } = fixture({}, { "orchestrator.md": "---\ntools: [read_full]\n---\n- extra" });
    expect(loadRoleOverlay({ role: "slack-inbox", ...lookup }).tools).toEqual([
      "read_full",
      ...LIFELINE,
      ...DELEGATION_PROVIDER_TOOLS,
      ...HISTORY,
    ]);
  });
});

describe("the shipped roles/ directory", () => {
  // Real files, default built-in dir; a bare temp root has no overlay.
  const projectRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "role-overlay-shipped-"));
  const names = listRoleOverlays({ projectRoot }).map((role) => role.name);

  it("every built-in parses to a prompt and a tool profile", () => {
    for (const role of names) {
      const overlay = loadRoleOverlay({ role, projectRoot });
      // Non-empty, and no frontmatter leaked into the body (an unclosed `---`).
      expect(overlay.prompt, role).toMatch(/^(?!---)\S/);
      expect(overlay.tools.length, role).toBeGreaterThan(LIFELINE.length);
    }
  });

  // A leaf that searches the spawn tools in sees no roles catalogue; the `role`
  // parameter's closed list is what it picks from, so it must match the files.
  it("matches the built-in roles the spawn tools' `role` parameter lists", () => {
    const spawn = LOOM_TOOL_DEFS.find((def) => def.name === "workstream_spawn")?.parameters as
      | { properties: Record<string, { description: string }> }
      | undefined;
    const listed = /one of the built-in roles ([^;]+);/.exec(
      spawn?.properties.role?.description ?? "",
    )?.[1];
    expect(listed?.split(/, | or /).sort()).toEqual([...names].sort());
  });
});
